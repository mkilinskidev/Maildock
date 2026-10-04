import {
  plainTextDocument,
  richElement,
  richText,
  safeRichStyle,
  safeRichUrl,
  validateRichDocument,
  type RichDocument,
  type RichNode,
} from "./rich-document";

const dropped = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "META",
  "LINK",
  "BASE",
  "SVG",
  "MATH",
  "TEMPLATE",
  "VIDEO",
  "AUDIO",
  "SOURCE",
  "PICTURE",
  "CANVAS",
]);
const blocks = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "TABLE",
  "TR",
  "TD",
  "TH",
]);
/** Traverse an inert DOM. No DOM is mounted, no URL is fetched, no source HTML is retained. */
export function importRichDom(
  document: Document,
  image?: (element: Element) => RichNode | null,
): RichDocument {
  let count = 0;
  function wrap(nodes: RichNode[]) {
    const result: RichNode[] = [];
    let inline: RichNode[] = [];
    const flush = () => {
      if (inline.length) {
        result.push(richElement("paragraph", inline));
        inline = [];
      }
    };
    for (const n of nodes) {
      if (["text", "linebreak", "link", "maildock-image"].includes(n.type))
        inline.push(n);
      else {
        flush();
        result.push(n);
      }
    }
    flush();
    return result;
  }
  function visit(
    dom: Node,
    format = 0,
    inheritedStyle = "",
    depth = 0,
  ): RichNode[] {
    if (++count > 20000 || depth > 32)
      throw new SyntaxError("Pasted content is too large or deeply nested.");
    if (dom.nodeType === 3)
      return dom.textContent
        ? [richText(dom.textContent, format, inheritedStyle)]
        : [];
    if (dom.nodeType !== 1) return [];
    const el = dom as HTMLElement,
      tag = el.tagName;
    if (dropped.has(tag)) return [];
    if (tag === "IMG") {
      if (image) {
        const result = image(el);
        return result ? [result] : [];
      }
      const url = safeRichUrl(el.getAttribute("src") ?? "", true);
      return url
        ? [
            {
              type: "maildock-image",
              version: 1,
              url,
              alt: (el.getAttribute("alt") ?? "Remote image").slice(0, 500),
              width: 480,
            },
          ]
        : [richText("[Image omitted]")];
    }
    if (tag === "BR") return [{ type: "linebreak", version: 1 }];
    if (tag === "HR") return [{ type: "horizontalrule", version: 1 }];
    let f = format;
    if (
      ["B", "STRONG"].includes(tag) ||
      /^(bold|[6-9]00)$/.test(el.style.fontWeight)
    )
      f |= 1;
    if (["I", "EM"].includes(tag) || el.style.fontStyle === "italic") f |= 2;
    if (
      ["S", "STRIKE", "DEL"].includes(tag) ||
      el.style.textDecoration.includes("line-through")
    )
      f |= 4;
    if (tag === "U" || el.style.textDecoration.includes("underline")) f |= 8;
    const size = parseFloat(el.style.fontSize);
    const px = el.style.fontSize.endsWith("pt") ? (size * 4) / 3 : size;
    const chosenSize = Number.isFinite(px)
      ? [10, 12, 14, 16, 18, 24, 32, 48].reduce((a, b) =>
          Math.abs(px - a) < Math.abs(px - b) ? a : b,
        )
      : null;
    const s = safeRichStyle(
      `${inheritedStyle};color:${el.style.color || el.getAttribute("color") || ""};${chosenSize ? `font-size:${chosenSize}px` : ""}`,
    );
    const children = [...el.childNodes].flatMap((child) =>
      visit(child, f, s, depth + 1),
    );
    const align = el.style.textAlign || el.getAttribute("align");
    const extra = {
      format: ["left", "center", "right"].includes(align ?? "") ? align! : "",
      indent: Math.min(
        8,
        Math.max(0, Math.round((parseFloat(el.style.marginLeft) || 0) / 24)),
      ),
    };
    if (tag === "A") {
      const url = safeRichUrl(el.getAttribute("href") ?? "");
      const inline = children.flatMap((n) => n.children ?? [n]);
      return url
        ? [
            richElement("link", inline, {
              url,
              rel: null,
              target: null,
              title: null,
            }),
          ]
        : children;
    }
    if (tag === "UL" || tag === "OL")
      return [
        richElement(
          "list",
          children.filter((n) => n.type === "listitem"),
          {
            ...extra,
            tag: tag.toLowerCase(),
            listType: tag === "OL" ? "number" : "bullet",
            start: Math.min(
              10000,
              Math.max(1, Number(el.getAttribute("start")) || 1),
            ),
          },
        ),
      ];
    if (tag === "LI")
      return [
        richElement("listitem", children, {
          value: Math.min(
            30000,
            Math.max(1, Number(el.getAttribute("value")) || 1),
          ),
          ...extra,
        }),
      ];
    if (tag === "BLOCKQUOTE")
      return [richElement("quote", wrap(children), extra)];
    if (tag === "TABLE")
      return [
        richElement(
          "table",
          children.filter((n) => n.type === "tablerow"),
        ),
      ];
    if (tag === "TR")
      return [
        richElement(
          "tablerow",
          children.filter((n) => n.type === "tablecell"),
        ),
      ];
    if (tag === "TD" || tag === "TH")
      return [
        richElement("tablecell", wrap(children), {
          colSpan: Math.min(
            50,
            Math.max(1, Number(el.getAttribute("colspan")) || 1),
          ),
          rowSpan: Math.min(
            100,
            Math.max(1, Number(el.getAttribute("rowspan")) || 1),
          ),
          headerState: tag === "TH" ? 1 : 0,
          backgroundColor: null,
        }),
      ];
    if (/^H[1-6]$/.test(tag))
      return [
        richElement(
          "heading",
          children.flatMap((n) => n.children ?? [n]),
          {
            ...extra,
            tag: ["H1", "H2", "H3"].includes(tag) ? tag.toLowerCase() : "h3",
          },
        ),
      ];
    if (blocks.has(tag)) {
      if (
        children.some(
          (n) =>
            !["text", "linebreak", "link", "maildock-image"].includes(n.type),
        )
      )
        return wrap(children);
      // Word list markers are normalized instead of retaining Office metadata.
      if (/mso-list\s*:/i.test(el.getAttribute("style") ?? "")) {
        const first = children[0];
        if (first?.type === "text")
          first.text = first.text!.replace(/^\s*(?:[•·\u00b7]|\d+[.)])\s*/, "");
        return [
          richElement(
            "list",
            [richElement("listitem", children, { value: 1 })],
            { tag: "ul", listType: "bullet", start: 1 },
          ),
        ];
      }
      return [richElement("paragraph", children, extra)];
    }
    return children;
  }
  const nodes = wrap([...document.body.childNodes].flatMap((n) => visit(n)));
  return validateRichDocument(
    nodes.length
      ? { version: 1, editor: { root: richElement("root", nodes) } }
      : plainTextDocument(""),
  );
}
