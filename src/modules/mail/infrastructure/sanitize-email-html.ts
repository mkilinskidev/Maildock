import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

export const EMAIL_HTML_POLICY = "email-html-v1";

const forbiddenTags = [
  "script",
  "iframe",
  "frame",
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
  "style",
  "svg",
  "math",
  "video",
  "audio",
  "source",
  "picture",
  "track",
  "canvas",
  "template",
  "img",
];

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function sanitizeEmailHtml(input: string): {
  html: string;
  remoteContentBlocked: boolean;
} {
  // No jsdom resource loader is enabled. The raw tree is inspected only for a
  // privacy indicator; it is never returned or persisted.
  const remoteContentBlocked =
    /<(?:img|source|video|audio|link|iframe|frame|object|embed)\b|\b(?:srcset|poster|background)\s*=|url\s*\(/i.test(
      input,
    );
  const window = new JSDOM("").window;
  try {
    const purifier = DOMPurify(window);
    const clean = purifier.sanitize(input, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: forbiddenTags,
      FORBID_ATTR: [
        "style",
        "srcdoc",
        "src",
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
    });
    const document = window.document;
    document.body.innerHTML = clean;
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (element.tagName === "A" && attribute.name === "href") continue;
        // Keep inert presentation attributes only. In particular, URL bearing
        // attributes and DOM clobbering identifiers never survive.
        if (
          !["colspan", "rowspan", "align", "dir", "title", "alt"].includes(
            attribute.name,
          )
        )
          element.removeAttribute(attribute.name);
      }
      if (element.tagName === "A") {
        const href = element.getAttribute("href");
        const safe = href && safeLink(href);
        if (safe) element.setAttribute("href", safe);
        else element.removeAttribute("href");
      }
    }
    return { html: document.body.innerHTML, remoteContentBlocked };
  } finally {
    window.close();
  }
}
