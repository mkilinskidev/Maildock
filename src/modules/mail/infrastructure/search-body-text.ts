import { JSDOM } from "jsdom";
import postcss from "postcss";

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
