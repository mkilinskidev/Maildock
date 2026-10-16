import { DisplayContentLimitError } from "@/modules/mail/domain/display-content-limits";

/** Structural budgets for HTML processed in the receiving and reader paths. */
export const EMAIL_HTML_RESOURCE_BUDGET = Object.freeze({
  maxInputBytes: 5 * 1024 * 1024,
  maxElements: 24_000,
  maxNestingDepth: 256,
  maxAttributesPerElement: 128,
  maxTotalAttributes: 100_000,
  maxAttributeValueBytes: 64 * 1024,
  maxStyleBytes: 256 * 1024,
  maxStyleBlocks: 64,
});

const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const rawTextElements = new Set(["script", "style", "textarea", "title"]);
const optionalEndOnStart = new Map([
  ["p", new Set(["p"])],
  ["li", new Set(["li"])],
  ["dt", new Set(["dt", "dd"])],
  ["dd", new Set(["dt", "dd"])],
  ["tr", new Set(["tr"])],
  ["td", new Set(["td", "th"])],
  ["th", new Set(["td", "th"])],
  ["option", new Set(["option"])],
]);

export class EmailHtmlResourceLimitError extends DisplayContentLimitError {
  constructor(readonly limit: string) {
    super(
      undefined,
      `Message HTML exceeds the safe processing budget (${limit}).`,
    );
    this.name = "EmailHtmlResourceLimitError";
  }
}

function isSpace(code: number) {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function findTagEnd(input: string, start: number) {
  let quote = 0;
  for (let i = start; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) quote = code;
    else if (code === 62) return i;
  }
  return input.length - 1;
}

function closesRawText(input: string, from: number, name: string) {
  for (let i = from; i < input.length - name.length - 2; i++) {
    if (
      input.charCodeAt(i) === 60 &&
      input.charCodeAt(i + 1) === 47 &&
      matchesAsciiLowercase(input, i + 2, name) &&
      (isSpace(input.charCodeAt(i + 2 + name.length)) ||
        input.charCodeAt(i + 2 + name.length) === 62)
    )
      return i;
  }
  return input.length;
}

function matchesAsciiLowercase(input: string, start: number, expected: string) {
  for (let offset = 0; offset < expected.length; offset++) {
    let code = input.charCodeAt(start + offset);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== expected.charCodeAt(offset)) return false;
  }
  return true;
}

function popThrough(stack: string[], name: string) {
  const index = stack.lastIndexOf(name);
  if (index >= 0) stack.length = index;
}

/**
 * Count bounded HTML structure before constructing a DOM. The scanner handles
 * quoted attributes, comments and HTML raw-text elements without decoding
 * entities or materializing token/node arrays.
 */
export function assertEmailHtmlResourceBudget(input: string) {
  const budget = EMAIL_HTML_RESOURCE_BUDGET;
  if (Buffer.byteLength(input, "utf8") > budget.maxInputBytes)
    throw new EmailHtmlResourceLimitError("5 MiB input limit");

  const stack: string[] = [];
  let elements = 0,
    totalAttributes = 0,
    styleBytes = 0,
    styleBlocks = 0,
    cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf("<", cursor);
    if (open < 0) break;
    if (input.startsWith("<!--", open)) {
      const close = input.indexOf("-->", open + 4);
      cursor = close < 0 ? input.length : close + 3;
      continue;
    }

    let position = open + 1,
      closing = false;
    if (input[position] === "/") {
      closing = true;
      position++;
    }
    const nameStart = position;
    while (
      position < input.length &&
      ((input.charCodeAt(position) >= 65 && input.charCodeAt(position) <= 90) ||
        (input.charCodeAt(position) >= 97 &&
          input.charCodeAt(position) <= 122) ||
        (input.charCodeAt(position) >= 48 &&
          input.charCodeAt(position) <= 57) ||
        input[position] === ":" ||
        input[position] === "-")
    )
      position++;
    const firstCode = input.charCodeAt(nameStart);
    if (
      position === nameStart ||
      !(
        (firstCode >= 65 && firstCode <= 90) ||
        (firstCode >= 97 && firstCode <= 122)
      )
    ) {
      cursor = open + 1;
      continue;
    }
    const name = input.slice(nameStart, position).toLowerCase();
    const tagEnd = findTagEnd(input, position);
    if (tagEnd < position) break;
    cursor = tagEnd + 1;

    if (closing) {
      popThrough(stack, name);
      continue;
    }

    elements++;
    if (elements > budget.maxElements)
      throw new EmailHtmlResourceLimitError("24,000 element limit");

    let attributes = 0,
      scan = position,
      lastNonSpace = tagEnd;
    while (lastNonSpace >= position && isSpace(input.charCodeAt(lastNonSpace)))
      lastNonSpace--;
    const selfClosing = input[lastNonSpace] === "/";

    while (scan < tagEnd) {
      while (scan < tagEnd && isSpace(input.charCodeAt(scan))) scan++;
      if (scan >= tagEnd || input[scan] === "/") break;
      const attributeStart = scan;
      while (
        scan < tagEnd &&
        !isSpace(input.charCodeAt(scan)) &&
        input[scan] !== "=" &&
        input[scan] !== "/"
      )
        scan++;
      if (scan === attributeStart) {
        scan++;
        continue;
      }
      const attributeName = input.slice(attributeStart, scan).toLowerCase();
      attributes++;
      totalAttributes++;
      if (attributes > budget.maxAttributesPerElement)
        throw new EmailHtmlResourceLimitError(
          "128 attributes per element limit",
        );
      if (totalAttributes > budget.maxTotalAttributes)
        throw new EmailHtmlResourceLimitError("100,000 total attributes limit");
      while (scan < tagEnd && isSpace(input.charCodeAt(scan))) scan++;

      let valueStart = scan,
        valueEnd = scan;
      if (input[scan] === "=") {
        scan++;
        while (scan < tagEnd && isSpace(input.charCodeAt(scan))) scan++;
        const quote = input.charCodeAt(scan);
        if (quote === 34 || quote === 39) {
          valueStart = ++scan;
          while (scan < tagEnd && input.charCodeAt(scan) !== quote) scan++;
          valueEnd = scan;
          if (scan < tagEnd) scan++;
        } else {
          valueStart = scan;
          while (scan < tagEnd && !isSpace(input.charCodeAt(scan))) scan++;
          valueEnd = scan;
        }
      }
      const valueBytes = Buffer.byteLength(
        input.slice(valueStart, valueEnd),
        "utf8",
      );
      if (valueBytes > budget.maxAttributeValueBytes)
        throw new EmailHtmlResourceLimitError("64 KiB attribute value limit");
      if (attributeName === "style") {
        styleBytes += valueBytes;
        if (styleBytes > budget.maxStyleBytes)
          throw new EmailHtmlResourceLimitError("256 KiB CSS limit");
      }
    }

    const implicitClosures = optionalEndOnStart.get(name);
    if (implicitClosures) {
      for (const closable of implicitClosures) {
        if (stack.includes(closable)) {
          const index = Math.max(
            ...[...implicitClosures].map((tag) => stack.lastIndexOf(tag)),
          );
          if (index >= 0) stack.length = index;
          break;
        }
      }
    }
    if (!selfClosing && !voidElements.has(name)) {
      stack.push(name);
      if (stack.length > budget.maxNestingDepth)
        throw new EmailHtmlResourceLimitError("256 levels of nesting limit");
    }

    if (name === "style") {
      styleBlocks++;
      if (styleBlocks > budget.maxStyleBlocks)
        throw new EmailHtmlResourceLimitError("64 style block limit");
    }
    if (rawTextElements.has(name)) {
      const close = closesRawText(input, cursor, name);
      if (name === "style") {
        styleBytes += Buffer.byteLength(input.slice(cursor, close), "utf8");
        if (styleBytes > budget.maxStyleBytes)
          throw new EmailHtmlResourceLimitError("256 KiB CSS limit");
      }
      cursor = close;
    }
  }
}
