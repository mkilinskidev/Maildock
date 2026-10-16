import { JSDOM } from "jsdom";
import postcss from "postcss";
import { EmailHtmlResourceLimitError } from "./email-html-resource-budget";

const ignoredTags = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "HEAD",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SVG",
  "MATH",
]);
const blockTags = new Set([
  "BR",
  "P",
  "DIV",
  "LI",
  "TR",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TD",
  "BLOCKQUOTE",
]);

/** Derive search text from the sanitized tree without parsing serialized HTML again. */
export function searchBodyTextFromElement(
  plain: string | null,
  root: Element,
): string {
  if (plain?.trim()) return plain;
  const hidden = new Set<Element>();
  let visibilityRules = 0;
  for (const style of root.querySelectorAll("style")) {
    try {
      postcss.parse(style.textContent ?? "").walkRules((rule) => {
        if (
          rule.nodes.some(
            (node) =>
              node.type === "decl" &&
              ((node.prop.toLowerCase() === "display" &&
                node.value
                  .replace(/\s*!important/i, "")
                  .trim()
                  .toLowerCase() === "none") ||
                (node.prop.toLowerCase() === "visibility" &&
                  /^(hidden|collapse)/i.test(node.value))),
          )
        ) {
          visibilityRules++;
          if (visibilityRules > 128)
            throw new EmailHtmlResourceLimitError(
              "128 CSS visibility rule limit",
            );
          try {
            const document = root.ownerDocument;
            if (root.matches(rule.selector)) hidden.add(root);
            document.querySelectorAll(rule.selector).forEach((el) => {
              if (el === root || el.contains(root)) hidden.add(root);
              else if (root.contains(el)) hidden.add(el);
            });
          } catch {
            /* Unsupported selector is inert. */
          }
        }
      });
    } catch {
      /* Malformed CSS is not searchable text. */
    }
  }

  const pieces: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      pieces.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (
      ignoredTags.has(element.tagName) ||
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true" ||
      hidden.has(element)
    )
      return;
    const style = (element.getAttribute("style") ?? "").toLowerCase();
    if (
      /(?:^|;)\s*display\s*:\s*none\b/.test(style) ||
      /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\b/.test(style)
    )
      return;
    const block = blockTags.has(element.tagName);
    if (block) pieces.push(" ");
    for (const child of element.childNodes) visit(child);
    if (block) pieces.push(" ");
  };
  visit(root);
  return pieces.join("").replace(/\s+/g, " ").trim();
}

/** Parse inert local HTML only; JSDOM has neither scripts nor resource loading enabled. */
export function searchBodyText(
  plain: string | null,
  html: string | null,
): string {
  if (plain?.trim()) return plain;
  if (!html) return "";
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    // Remove CSS-hidden elements before discarding styles. No browser layout or network.
    for (const style of document.querySelectorAll("style")) {
      try {
        postcss.parse(style.textContent ?? "").walkRules((rule) => {
          if (
            rule.nodes.some(
              (node) =>
                node.type === "decl" &&
                ((node.prop.toLowerCase() === "display" &&
                  node.value
                    .replace(/\s*!important/i, "")
                    .trim()
                    .toLowerCase() === "none") ||
                  (node.prop.toLowerCase() === "visibility" &&
                    /^(hidden|collapse)/i.test(node.value))),
            )
          ) {
            try {
              document
                .querySelectorAll(rule.selector)
                .forEach((el) => el.remove());
            } catch {
              /* Unsupported selector is inert. */
            }
          }
        });
      } catch {
        /* Malformed CSS is not searchable text. */
      }
    }
    document
      .querySelectorAll(
        "script,style,template,noscript,head,iframe,object,embed,svg,math,[hidden],[aria-hidden='true']",
      )
      .forEach((el) => el.remove());
    for (const el of document.querySelectorAll<HTMLElement>("[style]")) {
      if (
        el.style.display === "none" ||
        ["hidden", "collapse"].includes(el.style.visibility)
      )
        el.remove();
    }
    document
      .querySelectorAll("br,p,div,li,tr,h1,h2,h3,h4,h5,h6,td,blockquote")
      .forEach((el) => {
        el.prepend(document.createTextNode(" "));
        el.append(document.createTextNode(" "));
      });
    return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  } finally {
    dom.window.close();
  }
}
