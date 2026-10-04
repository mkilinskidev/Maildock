import { z } from "zod";

export const RICH_LIMITS = {
  documentBytes: 2_000_000,
  htmlBytes: 3_000_000,
  textBytes: 2_000_000,
  nodes: 20_000,
  depth: 32,
  inline: 50,
  remote: 100,
} as const;
export type RichNode = {
  type: string;
  version: number;
  children?: RichNode[];
  text?: string;
  format?: number | string;
  style?: string;
  detail?: number;
  mode?: string;
  direction?: "ltr" | "rtl" | null;
  indent?: number;
  textFormat?: number;
  textStyle?: string;
  tag?: string;
  listType?: string;
  start?: number;
  value?: number;
  checked?: boolean;
  url?: string;
  rel?: string | null;
  target?: string | null;
  title?: string | null;
  resourceId?: string;
  alt?: string;
  width?: number;
  colSpan?: number;
  rowSpan?: number;
  headerState?: number;
  backgroundColor?: string | null;
  verticalAlign?: string;
  height?: number;
  colWidths?: number[];
  signatureId?: string;
  fingerprint?: string;
};
export type RichDocument = { version: 1; editor: { root: RichNode } };
export function safeRichUrl(value: string, image = false): string | null {
  if (value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (image
      ? ["http:", "https:"]
      : ["http:", "https:", "mailto:"]
    ).includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const color =
  /^(?:#[0-9a-f]{3,8}|[a-z]{1,20}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;
export function safeRichStyle(value: string): string {
  const declarations = new Map<string, string>();
  value.split(";").forEach((part) => {
    const [key, ...rest] = part.split(":");
    const v = rest.join(":").trim();
    const k = key.trim().toLowerCase();
    if (
      (k === "color" && color.test(v)) ||
      (k === "font-size" && /^(?:10|12|14|16|18|24|32|48)px$/.test(v))
    )
      declarations.set(k, v);
  });
  return [...declarations].map(([k, v]) => `${k}: ${v}`).join("; ");
}
const style = z
  .string()
  .max(200)
  .refine(
    (v) =>
      !v ||
      safeRichStyle(v).replace(/\s/g, "") ===
        v.replace(/\s/g, "").replace(/;$/, ""),
  );
const base = { version: z.literal(1) };
const element = {
  ...base,
  children: z.lazy(() => z.array(node)),
  direction: z.enum(["ltr", "rtl"]).nullable().default(null),
  format: z.enum(["", "left", "center", "right"]).default(""),
  indent: z.number().int().min(0).max(8).default(0),
  textFormat: z.number().int().min(0).max(15).optional(),
  textStyle: style.optional(),
};
const node: z.ZodType<RichNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...element, type: z.literal("root") }).strict(),
    z
      .object({
        ...element,
        type: z.literal("paragraph"),
        textFormat: z.number().int().min(0).max(15).default(0),
        textStyle: style.default(""),
      })
      .strict(),
    z
      .object({
        ...element,
        type: z.literal("heading"),
        tag: z.enum(["h1", "h2", "h3"]),
      })
      .strict(),
    z.object({ ...element, type: z.literal("quote") }).strict(),
    z
      .object({
        ...element,
        type: z.literal("maildock-signature"),
        signatureId: z.uuid(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    z
      .object({
        ...element,
        type: z.literal("list"),
        listType: z.enum(["bullet", "number"]),
        tag: z.enum(["ul", "ol"]),
        start: z.number().int().min(1).max(10000),
      })
      .strict(),
    z
      .object({
        ...element,
        type: z.literal("listitem"),
        value: z.number().int().min(1).max(30000),
        checked: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...element,
        type: z.literal("link"),
        url: z.string().refine((v) => !!safeRichUrl(v)),
        rel: z.literal(null).optional(),
        target: z.literal(null).optional(),
        title: z.string().max(200).nullable().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("text"),
        text: z
          .string()
          .max(500000)
          .refine((s) => !s.includes("\0")),
        format: z.number().int().min(0).max(15),
        style,
        mode: z.literal("normal"),
        detail: z.literal(0),
      })
      .strict(),
    z.object({ ...base, type: z.literal("linebreak") }).strict(),
    z.object({ ...base, type: z.literal("horizontalrule") }).strict(),
    z
      .object({
        ...base,
        type: z.literal("maildock-image"),
        resourceId: z.uuid().optional(),
        url: z
          .string()
          .refine((v) => !!safeRichUrl(v, true))
          .optional(),
        alt: z.string().max(500),
        width: z.number().int().min(16).max(640).default(480),
      })
      .strict()
      .refine((v) => !!v.resourceId !== !!v.url),
    z
      .object({
        ...element,
        type: z.literal("table"),
        colWidths: z.array(z.number().min(16).max(640)).max(50).optional(),
      })
      .strict(),
    z
      .object({
        ...element,
        type: z.literal("tablerow"),
        height: z.number().min(1).max(1000).optional(),
      })
      .strict(),
    z
      .object({
        ...element,
        type: z.literal("tablecell"),
        colSpan: z.number().int().min(1).max(50),
        rowSpan: z.number().int().min(1).max(100),
        headerState: z.number().int().min(0).max(3),
        width: z.number().min(16).max(640).optional(),
        backgroundColor: z.string().regex(color).nullable().optional(),
        verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
      })
      .strict(),
  ]),
);

export function validateRichDocument(input: unknown): RichDocument {
  // Walk before recursive schema parsing or stringify, including non-JSON callers.
  const stack: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let count = 0,
    strings = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > RICH_LIMITS.nodes * 20 || depth > RICH_LIMITS.depth * 2 + 6)
      throw new SyntaxError("Rich document exceeds structural limits.");
    if (typeof value === "string") strings += value.length;
    if (strings > RICH_LIMITS.documentBytes)
      throw new SyntaxError("Rich document is too large.");
    if (value && typeof value === "object") {
      if (Array.isArray(value) && value.length > RICH_LIMITS.nodes)
        throw new SyntaxError("Rich document has too many children.");
      const values = Object.values(value);
      if (!Array.isArray(value) && values.length > 32)
        throw new SyntaxError("Invalid rich document object.");
      for (const child of values)
        stack.push({ value: child, depth: depth + 1 });
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(input)).length >
    RICH_LIMITS.documentBytes
  )
    throw new SyntaxError("Rich document is too large.");
  const doc = z
    .object({
      version: z.literal(1),
      editor: z.object({ root: node }).strict(),
    })
    .strict()
    .parse(input);
  let nodes = 0,
    images = 0,
    remote = 0,
    tableArea = 0;
  function visit(n: RichNode, depth: number, parent?: string) {
    // Lexical aggregates transient typing metadata on containers. Formatting is
    // represented by text nodes; retaining this cache would cause restore-only saves.
    if (n.type !== "paragraph") {
      delete n.textFormat;
      delete n.textStyle;
    }
    if (++nodes > RICH_LIMITS.nodes || depth > RICH_LIMITS.depth)
      throw new SyntaxError("Rich document exceeds structural limits.");
    if ((n.type === "root") !== (parent === undefined))
      throw new SyntaxError("Invalid rich document root.");
    if (n.type === "maildock-signature" && parent !== "root")
      throw new SyntaxError("Automatic signatures must be root blocks.");
    if (
      parent === "maildock-signature" &&
      ["text", "linebreak", "link", "maildock-image"].includes(n.type)
    )
      throw new SyntaxError("Invalid signature block.");
    if (
      parent === "root" &&
      [
        "text",
        "linebreak",
        "link",
        "listitem",
        "tablecell",
        "tablerow",
        "maildock-image",
      ].includes(n.type)
    )
      throw new SyntaxError("Invalid root child.");
    if (
      (n.type === "listitem" && parent !== "list") ||
      (n.type === "tablerow" && parent !== "table") ||
      (n.type === "tablecell" && parent !== "tablerow")
    )
      throw new SyntaxError("Invalid rich document structure.");
    if (
      (parent === "list" && n.type !== "listitem") ||
      (parent === "table" && n.type !== "tablerow") ||
      (parent === "tablerow" && n.type !== "tablecell")
    )
      throw new SyntaxError("Invalid rich document children.");
    if (
      ["paragraph", "heading", "link"].includes(parent ?? "") &&
      !["text", "linebreak", "link", "maildock-image"].includes(n.type)
    )
      throw new SyntaxError("Invalid inline content.");
    if (parent === "link" && n.type === "link")
      throw new SyntaxError("Nested links are unsupported.");
    if (n.type === "list" && (n.listType === "number") !== (n.tag === "ol"))
      throw new SyntaxError("Invalid list type.");
    if (n.type === "maildock-image") {
      if (n.url) remote++;
      else images++;
    }
    if (
      n.type === "tablecell" &&
      (tableArea += n.colSpan! * n.rowSpan!) > 50000
    )
      throw new SyntaxError("Table content exceeds the supported size.");
    n.children?.forEach((child) => visit(child, depth + 1, n.type));
  }
  visit(doc.editor.root, 0);
  if (!doc.editor.root.children?.length)
    doc.editor.root.children = [
      richElement("paragraph", [], { textFormat: 0, textStyle: "" }),
    ];
  if (images > RICH_LIMITS.inline || remote > RICH_LIMITS.remote)
    throw new SyntaxError("Too many inline images.");
  return doc as RichDocument;
}
export const richDocumentSchema = z.unknown().transform((v, ctx) => {
  try {
    return validateRichDocument(v);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Invalid or oversized rich document.",
    });
    return z.NEVER;
  }
});
export function richElement(
  type: string,
  children: RichNode[],
  extra: Partial<RichNode> = {},
): RichNode {
  return {
    type,
    version: 1,
    children,
    direction: null,
    format: "",
    indent: 0,
    ...extra,
  };
}
export function richText(text: string, format = 0, style = ""): RichNode {
  return {
    type: "text",
    version: 1,
    text,
    format,
    style,
    detail: 0,
    mode: "normal",
  };
}
export function plainTextDocument(text: string): RichDocument {
  // Embedded newlines preserve even pathological legacy drafts without turning
  // 500,000 blank lines into 500,000 nodes. The serializer emits explicit BRs.
  const normalized = text.replace(/\r\n?/g, "\n");
  const children = normalized ? [richText(normalized)] : [];
  return {
    version: 1,
    editor: { root: richElement("root", [richElement("paragraph", children)]) },
  };
}
export function richResourceIds(doc: RichDocument): Set<string> {
  const ids = new Set<string>();
  function visit(n: RichNode) {
    if (n.resourceId) ids.add(n.resourceId);
    n.children?.forEach(visit);
  }
  visit(doc.editor.root);
  return ids;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function serializeRichDocument(
  input: unknown,
  resources: ReadonlyMap<string, string> = new Map(),
) {
  const doc = validateRichDocument(input);
  function html(n: RichNode): string {
    if (n.type === "text") {
      let out = escape(n.text!).replace(/\n/g, "<br>");
      const f = n.format as number;
      for (const [bit, tag] of [
        [1, "strong"],
        [2, "em"],
        [4, "s"],
        [8, "u"],
      ] as const)
        if (f & bit) out = `<${tag}>${out}</${tag}>`;
      return n.style
        ? `<span style="${escape(safeRichStyle(n.style))}">${out}</span>`
        : out;
    }
    if (n.type === "linebreak") return "<br>";
    if (n.type === "horizontalrule") return "<hr>";
    if (n.type === "maildock-image") {
      const cid = n.resourceId ? resources.get(n.resourceId) : null;
      if (
        n.resourceId &&
        (!cid || !/^[0-9a-f-]{36}@maildock\.invalid$/.test(cid))
      )
        throw new SyntaxError("Inline image resource is unavailable.");
      return `<img src="${escape(cid ? `cid:${cid}` : safeRichUrl(n.url!, true)!)}" alt="${escape(n.alt!)}" width="${n.width}" style="max-width:100%;height:auto">`;
    }
    const body = (n.children ?? []).map(html).join("");
    if (n.type === "root") return body;
    const tag = (
      {
        paragraph: "p",
        heading: n.tag,
        quote: "blockquote",
        "maildock-signature": "div",
        list: n.tag,
        listitem: "li",
        link: "a",
        table: "table",
        tablerow: "tr",
        tablecell: n.headerState ? "th" : "td",
      } as Record<string, string>
    )[n.type];
    const styles = [
      n.format ? `text-align:${n.format}` : "",
      n.indent ? `margin-left:${n.indent * 24}px` : "",
      n.type === "paragraph" ? "white-space:pre-wrap" : "",
      n.type === "table" ? "border-collapse:collapse" : "",
      n.type === "tablecell" ? "border:1px solid #cccccc;padding:4px" : "",
    ]
      .filter(Boolean)
      .join(";");
    const attrs = `${styles ? ` style="${styles}"` : ""}${n.direction ? ` dir="${n.direction}"` : ""}${n.type === "link" ? ` href="${escape(safeRichUrl(n.url!)!)}"` : ""}${n.type === "list" && n.tag === "ol" ? ` start="${n.start}"` : ""}${n.type === "tablecell" ? ` colspan="${n.colSpan}" rowspan="${n.rowSpan}"` : ""}`;
    return `<${tag}${attrs}>${body || (n.type === "paragraph" ? "<br>" : "")}</${tag}>`;
  }
  function text(n: RichNode): string {
    if (n.type === "text") return n.text!;
    if (n.type === "linebreak") return "\n";
    if (n.type === "horizontalrule") return "\n--------------------\n";
    if (n.type === "maildock-image")
      return `[Image: ${n.alt || "inline image"}]`;
    const children = n.children ?? [];
    if (n.type === "root") return children.map(text).join("\n\n");
    if (n.type === "list")
      return children
        .map(
          (child, i) =>
            `${n.tag === "ol" ? `${(n.start ?? 1) + i}.` : "-"} ${text(child).replace(/\n/g, "\n  ")}`,
        )
        .join("\n");
    if (n.type === "table") return children.map(text).join("\n");
    if (n.type === "tablerow") return children.map(text).join("\t");
    const body = children
      .map(text)
      .join(
        ["quote", "tablecell", "maildock-signature"].includes(n.type)
          ? "\n"
          : "",
      );
    if (n.type === "quote")
      return body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    if (n.type === "link")
      return body === n.url ? body : `${body} <${safeRichUrl(n.url!)!}>`;
    return n.indent
      ? body
          .split("\n")
          .map((line) => `${"  ".repeat(n.indent!)}${line}`)
          .join("\n")
      : body;
  }
  const generatedHtml = html(doc.editor.root),
    plainText = text(doc.editor.root);
  if (
    new TextEncoder().encode(generatedHtml).length > RICH_LIMITS.htmlBytes ||
    new TextEncoder().encode(plainText).length > RICH_LIMITS.textBytes ||
    plainText.length > 500000
  )
    throw new SyntaxError("Generated message body is too large.");
  return { html: generatedHtml, plainText };
}
