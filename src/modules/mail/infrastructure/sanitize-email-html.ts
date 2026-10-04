import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import postcss from "postcss";

export const EMAIL_HTML_POLICY = "email-html-v2";
const forbiddenTags = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "meta",
  "base",
  "link",
  "svg",
  "math",
  "video",
  "audio",
  "source",
  "picture",
  "track",
  "canvas",
  "template",
];
const presentation = new Set([
  "colspan",
  "rowspan",
  "align",
  "valign",
  "dir",
  "title",
  "alt",
  "width",
  "height",
  "bgcolor",
  "color",
  "face",
  "size",
  "cellpadding",
  "cellspacing",
  "border",
  "class",
  "style",
]);
const cssProperties =
  /^(?:color|background-color|font(?:-family|-size|-weight|-style|-variant)?|line-height|text-(?:align|decoration|transform|indent)|letter-spacing|word-spacing|white-space|vertical-align|display|border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?|border-collapse|border-spacing|border-radius|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|(?:min-|max-)?(?:width|height)|table-layout|overflow(?:-wrap|-x|-y)?|word-break|list-style-type)$/i;

export function safeEmailLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function remoteImageUrl(value: string): string | null {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function normalizeContentId(value: string): string {
  // Preserve the case-sensitive local identifier; domain names are insensitive.
  const id = value.trim().replace(/^<|>$/g, "").trim();
  const at = id.lastIndexOf("@");
  return at < 0 ? id : id.slice(0, at + 1) + id.slice(at + 1).toLowerCase();
}
export function cidReference(value: string): string | null {
  if (!/^cid:/i.test(value)) return null;
  try {
    return normalizeContentId(decodeURIComponent(value.slice(4))) || null;
  } catch {
    return null;
  }
}

function cssReferencesNetwork(input: string): boolean {
  const decoded = input
    .replace(
      /\\([0-9a-f]{1,6})\s?|\\(.)/gi,
      (_match, hex: string | undefined, character: string | undefined) =>
        hex
          ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff))
          : (character ?? ""),
    )
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\b/i.test(decoded)) return true;
  for (const match of decoded.matchAll(/url\s*\(\s*['"]?([^)'"]+)/gi)) {
    const value = match[1]!.trim();
    if (value && !/^(?:cid:|data:|#)/i.test(value)) return true;
  }
  return false;
}

function safeCss(input: string, inline: boolean): string {
  try {
    const root = postcss.parse(inline ? `x{${input}}` : input);
    root.walkAtRules((rule) => {
      // All resource-loading rules, including imports and fonts, are discarded.
      if (
        rule.name.toLowerCase() !== "media" ||
        !/^[a-z0-9\s():.,\/-]+$/i.test(rule.params)
      )
        rule.remove();
    });
    root.walkRules((rule) => {
      if (!/^[a-z0-9\s.#,:>*+~()[\]="'_-]+$/i.test(rule.selector))
        rule.remove();
    });
    root.walkDecls((decl) => {
      // No escapes/comments/functions other than numeric color functions. This
      // deliberately excludes CSS URL obfuscation, variables and legacy behavior.
      if (
        !cssProperties.test(decl.prop) ||
        /[\\@{}<>]|\/\*|(?:url|image|expression|var|attr)\s*\(/i.test(
          decl.value,
        ) ||
        /(?:^|[^a-z-])(?:[a-z-]+)\s*\(/i.test(
          decl.value.replace(/(?:rgba?|hsla?)\([\d\s.,%+/-]*\)/gi, ""),
        )
      )
        decl.remove();
    });
    if (inline)
      return root.first?.type === "rule"
        ? root.first.nodes.map((n) => n.toString()).join(";")
        : "";
    root.walkComments((comment) => {
      comment.remove();
    });
    return root.toString();
  } catch {
    return "";
  }
}

/** Stored HTML is inert. Sanitization and privacy filtering are separate steps.
 * Parse without resource loading -> DOMPurify -> restrictive CSS/attribute
 * rewriting -> DOMPurify again. Only generated resource attributes may be
 * activated by renderEmailDocument; stored HTML is never directly rendered.
 */
export function sanitizeEmailHtml(input: string): {
  html: string;
  remoteContentBlocked: boolean;
} {
  const window = new JSDOM("").window;
  try {
    const purifier = DOMPurify(window);
    const config = {
      USE_PROFILES: { html: true },
      ADD_TAGS: ["style"],
      FORBID_TAGS: forbiddenTags,
      SANITIZE_DOM: true,
      SANITIZE_NAMED_PROPS: true,
      ALLOW_DATA_ATTR: false,
      FORCE_BODY: true,
      FORBID_ATTR: [
        "srcdoc",
        "srcset",
        "poster",
        "background",
        "formaction",
        "action",
        "ping",
        "target",
        "id",
        "name",
      ],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    };
    const raw = new JSDOM(input);
    let remoteContentBlocked = false;
    const rawDocument = raw.window.document;
    // Removed markup is still a blocked resource for the privacy notice.
    for (const el of rawDocument.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        if (
          ["src", "srcset", "poster", "background", "data"].includes(
            attr.name,
          ) &&
          /(?:https?:)?\/\//i.test(attr.value)
        )
          remoteContentBlocked = true;
        if (
          attr.name === "href" &&
          el.tagName === "LINK" &&
          /(?:https?:)?\/\//i.test(attr.value)
        )
          remoteContentBlocked = true;
        if (attr.name === "style" && cssReferencesNetwork(attr.value))
          remoteContentBlocked = true;
      }
      if (el.tagName === "STYLE" && cssReferencesNetwork(el.textContent ?? ""))
        remoteContentBlocked = true;
    }
    // Preserve body presentation through an ordinary isolated wrapper, and
    // include head style blocks in the sanitized fragment (never raw head tags).
    const wrapper = rawDocument.createElement("div");
    for (const attr of [...rawDocument.body.attributes])
      if (presentation.has(attr.name))
        wrapper.setAttribute(attr.name, attr.value);
    const legacyColors = [
      rawDocument.body.getAttribute("bgcolor")
        ? `background-color:${rawDocument.body.getAttribute("bgcolor")}`
        : "",
      rawDocument.body.getAttribute("text")
        ? `color:${rawDocument.body.getAttribute("text")}`
        : "",
    ]
      .filter(Boolean)
      .join(";");
    if (legacyColors)
      wrapper.setAttribute(
        "style",
        `${legacyColors};${wrapper.getAttribute("style") ?? ""}`,
      );
    wrapper.innerHTML = rawDocument.body.innerHTML;
    const sourceHtml =
      [...rawDocument.head.querySelectorAll("style")]
        .map((s) => s.outerHTML)
        .join("") +
      (wrapper.attributes.length ? wrapper.outerHTML : wrapper.innerHTML);
    raw.window.close();
    const fragment = purifier.sanitize(sourceHtml, {
      ...config,
      RETURN_DOM_FRAGMENT: true,
    });
    for (const element of fragment.querySelectorAll("*")) {
      const source =
        element.tagName === "IMG" ? element.getAttribute("src") : null;
      for (const attribute of [...element.attributes]) {
        if (element.tagName === "A" && attribute.name === "href") continue;
        if (!presentation.has(attribute.name))
          element.removeAttribute(attribute.name);
      }
      if (element.hasAttribute("style"))
        element.setAttribute(
          "style",
          safeCss(element.getAttribute("style")!, true),
        );
      if (element.tagName === "STYLE")
        element.textContent = safeCss(element.textContent ?? "", false);
      if (element.tagName === "A") {
        const href = safeEmailLink(element.getAttribute("href") ?? "");
        if (href) element.setAttribute("href", href);
        else element.removeAttribute("href");
      }
      if (source) {
        const remote = remoteImageUrl(source),
          cid = cidReference(source);
        if (remote) {
          element.setAttribute("data-maildock-remote", remote);
          remoteContentBlocked = true;
        } else if (cid) element.setAttribute("data-maildock-cid", cid);
      }
    }
    const container = window.document.createElement("div");
    container.append(fragment);
    // Only our two generated inert attributes survive the final sanitizer.
    const html = purifier.sanitize(container.innerHTML, {
      ...config,
      ADD_ATTR: ["data-maildock-remote", "data-maildock-cid"],
      ADD_URI_SAFE_ATTR: ["data-maildock-remote", "data-maildock-cid"],
    });
    const usability = new JSDOM(html);
    usability.window.document
      .querySelectorAll("style")
      .forEach((s) => s.remove());
    const usable =
      !!usability.window.document.body.textContent?.trim() ||
      !!usability.window.document.querySelector(
        "img[data-maildock-cid],img[data-maildock-remote]",
      );
    usability.window.close();
    return { html: usable ? html : "", remoteContentBlocked };
  } finally {
    window.close();
  }
}
