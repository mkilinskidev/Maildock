import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { simpleParser } from "mailparser";
import { importRichDom } from "@/modules/mail/domain/rich-import";
import {
  plainTextDocument,
  richElement,
  richText,
  richResourceIds,
  serializeRichDocument,
  validateRichDocument,
  type RichNode,
} from "@/modules/mail/domain/rich-document";
import { buildOutgoingMime } from "@/modules/mail/infrastructure/outgoing-mime";
const id = "00000000-0000-4000-8000-000000000001";
const doc = (...nodes: RichNode[]) => ({
  version: 1,
  editor: { root: richElement("root", nodes) },
});
const paragraph = (...nodes: RichNode[]) => richElement("paragraph", nodes);
describe("bounded rich document boundary", () => {
  it("keeps a maximum-size legacy draft of blank lines restorable without node amplification", () => {
    const text = "\n".repeat(500000);
    const document = validateRichDocument(plainTextDocument(text));
    expect(document.editor.root.children![0].children).toHaveLength(1);
    expect(serializeRichDocument(document).plainText).toBe(text);
  });
  it.each(["", "line\n\nlast\n", "Zażółć gęślą jaźń", "\n\n", "<script>&\"'"])(
    "preserves legacy text and explicit breaks: %j",
    (text) => {
      const body = serializeRichDocument(plainTextDocument(text));
      expect(body.plainText).toBe(text);
      expect(body.html).not.toContain("<script>");
      expect(
        serializeRichDocument(validateRichDocument(plainTextDocument(text))),
      ).toEqual(body);
    },
  );
  it("renders supported formatting, quote, lists, indentation, links, rules and tables deterministically", () => {
    const input = doc(
      richElement("heading", [richText("Title")], {
        tag: "h2",
        format: "center",
      }),
      richElement(
        "paragraph",
        [
          richText("Formatted", 15, "color: #ff0000; font-size: 24px"),
          { type: "linebreak", version: 1 },
          richElement("link", [richText("OpenAI")], {
            url: "https://openai.com/",
          }),
        ],
        { indent: 2, format: "right" },
      ),
      richElement(
        "list",
        [
          richElement("listitem", [richText("One")], { value: 3 }),
          richElement("listitem", [richText("Two")], { value: 4 }),
        ],
        { tag: "ol", listType: "number", start: 3 },
      ),
      richElement(
        "list",
        [richElement("listitem", [richText("Bullet")], { value: 1 })],
        { tag: "ul", listType: "bullet", start: 1 },
      ),
      richElement("quote", [paragraph(richText("Quoted"))]),
      { type: "horizontalrule", version: 1 },
      richElement("table", [
        richElement("tablerow", [
          richElement("tablecell", [paragraph(richText("Cell"))], {
            headerState: 1,
            colSpan: 2,
            rowSpan: 1,
          }),
        ]),
      ]),
    );
    const out = serializeRichDocument(input);
    expect(serializeRichDocument(input)).toEqual(out);
    expect(out.html).toContain(
      "<u><s><em><strong>Formatted</strong></em></s></u>",
    );
    expect(out.html).toContain("text-align:center");
    expect(out.html).toContain("margin-left:48px");
    expect(out.html).toContain("color: #ff0000; font-size: 24px");
    expect(out.html).toContain("<th");
    expect(out.plainText).toContain("OpenAI <https://openai.com/>");
    expect(out.plainText).toContain("3. One\n4. Two");
    expect(out.plainText).toContain("- Bullet");
    expect(out.plainText).toContain("> Quoted");
    expect(out.plainText).toContain("--------------------");
    expect(out.plainText).toContain("    Formatted");
  });
  it.each([
    "javascript:alert(1)",
    "file:///a",
    "blob:https://example.com/a",
    "data:image/png;base64,AAAA",
    "cid:evil",
    "https://user:password@example.com/a",
  ])("rejects dangerous image URL %s", (url) => {
    expect(() =>
      validateRichDocument(
        doc(
          paragraph({
            type: "maildock-image",
            version: 1,
            url,
            alt: "",
            width: 480,
          }),
        ),
      ),
    ).toThrow();
    expect(() =>
      validateRichDocument(
        doc(paragraph(richElement("link", [richText("click")], { url }))),
      ),
    ).toThrow();
  });
  it("rejects versions, unknown nodes, header-like CIDs, arbitrary styles and malformed children", () => {
    for (const value of [
      { ...doc(paragraph()), version: 2 },
      doc({ type: "script", version: 1 }),
      doc(paragraph(richText("bad", 16))),
      doc(
        paragraph(richText("bad", 0, "background:url(https://evil.example)")),
      ),
      doc(
        paragraph({
          type: "maildock-image",
          version: 1,
          resourceId: id,
          contentId: "injected",
        } as RichNode),
      ),
      doc(
        richElement("list", [paragraph()], {
          tag: "ol",
          listType: "number",
          start: 1,
        }),
      ),
    ])
      expect(() => validateRichDocument(value)).toThrow();
  });
  it("rejects excessive bytes, nodes, recursion and amplification", () => {
    expect(() =>
      validateRichDocument(plainTextDocument("x".repeat(2_000_001))),
    ).toThrow();
    expect(() =>
      validateRichDocument(
        doc(...Array.from({ length: 20001 }, () => paragraph())),
      ),
    ).toThrow();
    let deep = paragraph(richText("end"));
    for (let i = 0; i < 35; i++) deep = richElement("quote", [deep]);
    expect(() => validateRichDocument(doc(deep))).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateRichDocument(cycle)).toThrow();
    expect(() =>
      serializeRichDocument(
        doc(
          ...Array.from({ length: 4 }, () =>
            paragraph(richText("&".repeat(200000))),
          ),
        ),
      ),
    ).toThrow("Generated");
  });
  it("requires an authoritative inline map but retains remote URLs without fetching", () => {
    const input = doc(
      paragraph(
        {
          type: "maildock-image",
          version: 1,
          resourceId: id,
          alt: "Screenshot",
          width: 320,
        },
        {
          type: "maildock-image",
          version: 1,
          url: "https://unreachable.invalid/image.png",
          alt: "Remote",
          width: 480,
        },
      ),
    );
    expect([...richResourceIds(validateRichDocument(input))]).toEqual([id]);
    expect(() => serializeRichDocument(input)).toThrow("unavailable");
    expect(() =>
      serializeRichDocument(input, new Map([[id, "evil\r\nheader"]])),
    ).toThrow();
    const body = serializeRichDocument(
      input,
      new Map([[id, `${id}@maildock.invalid`]]),
    );
    expect(body.html).toContain(`src="cid:${id}@maildock.invalid"`);
    expect(body.html).toContain('src="https://unreachable.invalid/image.png"');
    expect(body.plainText).toContain("[Image: Screenshot]");
  });
});
describe("controlled HTML import", () => {
  it.each([
    '<div><p><b>Web</b> <i>italic</i><br><a href="https://example.com">link</a></p><ul><li>list</li></ul></div>',
    '<div class="gmail_quote"><blockquote><p style="color:#ff0000;font-size:18px;text-align:center">Gmail <u>underline</u></p></blockquote></div>',
    '<p class="MsoNormal" style="mso-list:l0 level1 lfo1"><span>• </span><b>Word</b></p><table><tr><td colspan="2"><p>table</p></td></tr></table>',
  ])("preserves useful common formatting %s", (html) => {
    const dom = new JSDOM(html);
    try {
      const input = importRichDom(dom.window.document);
      const output = serializeRichDocument(input);
      expect(output.plainText).not.toBe("");
      expect(output.html).toContain("<");
      expect(output.html).not.toMatch(/class=|mso-|gmail_/);
      if (html.includes("table")) expect(output.html).toContain("<table");
      if (html.includes("Gmail")) {
        expect(output.html).toContain("<blockquote");
        expect(output.html).toContain("text-align:center");
      }
      if (html.includes("Web")) expect(output.html).toContain("<ul");
    } finally {
      dom.window.close();
    }
  });
  it("drops active content, dangerous links and resource CSS without executing anything", () => {
    const dom = new JSDOM(
      '<script>bad()</script><iframe src="https://evil.invalid"></iframe><object>secret</object><embed><form>form</form><style>@import "https://evil.invalid"</style><p onclick="bad()" style="color:#123456;background:url(https://evil.invalid);font-size:18px">Safe<a href="javascript:bad()">link</a><img src="data:image/svg+xml,bad"></p>',
    );
    try {
      const out = serializeRichDocument(importRichDom(dom.window.document));
      expect(out.html).not.toMatch(
        /script|iframe|object|embed|form|onClick|onclick|javascript:|url\(|evil\.invalid|data:/,
      );
      expect(out.plainText).toContain("Safe");
      expect(out.html).toContain("color:");
    } finally {
      dom.window.close();
    }
  });
});
describe("actual rich outgoing MIME", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  it.each(["plain", "inline", "inline-and-pdf"])(
    "parses %s structure, disposition, Unicode and threading",
    async (kind) => {
      const embedded = kind !== "plain";
      const input = doc(
        paragraph(
          richText("Zażółć gęślą jaźń", 1),
          richElement("link", [richText("OpenAI")], {
            url: "https://openai.com/",
          }),
          ...(embedded
            ? [
                {
                  type: "maildock-image",
                  version: 1,
                  resourceId: id,
                  alt: "Screenshot",
                  width: 480,
                },
              ]
            : []),
        ),
      );
      const body = serializeRichDocument(
        input,
        new Map([[id, `${id}@maildock.invalid`]]),
      );
      const mime = await buildOutgoingMime({
        from: { address: "owner@example.com" },
        to: [{ address: "to@example.com" }],
        cc: [],
        subject: "Cześć",
        ...body,
        messageId: "<stable@maildock.invalid>",
        createdAt: new Date("2026-10-01T10:00:00Z"),
        inReplyTo: "<parent@example.com>",
        references: ["<parent@example.com>"],
        attachments: embedded
          ? [
              {
                filename: "screenshot.png",
                contentType: "image/png",
                content: png,
                inline: true,
                contentId: `${id}@maildock.invalid`,
              },
              ...(kind === "inline-and-pdf"
                ? [
                    {
                      filename: "file.pdf",
                      contentType: "application/pdf",
                      content: Buffer.from("%PDF-1.4"),
                      inline: false,
                    },
                  ]
                : []),
            ]
          : [],
      });
      const parsed = await simpleParser(mime, {
        skipImageLinks: true,
        skipHtmlToText: true,
        skipTextToHtml: true,
      });
      expect(parsed.html).toBe(body.html);
      expect(parsed.text?.trimEnd()).toBe(body.plainText);
      expect(parsed.subject).toBe("Cześć");
      expect(parsed.messageId).toBe("<stable@maildock.invalid>");
      expect(parsed.inReplyTo).toBe("<parent@example.com>");
      expect(parsed.references).toBe("<parent@example.com>");
      expect(parsed.bcc).toBeUndefined();
      const contentType = parsed.headers.get("content-type") as {
        value: string;
      };
      // Nodemailer places text/plain beside multipart/related(html + CID) inside alternative.
      expect(contentType.value).toBe(
        kind === "inline-and-pdf" ? "multipart/mixed" : "multipart/alternative",
      );
      expect(parsed.attachments).toHaveLength(
        kind === "plain" ? 0 : kind === "inline" ? 1 : 2,
      );
      if (embedded) {
        expect(parsed.attachments[0].contentDisposition).toBe("inline");
        expect(parsed.attachments[0].cid).toBe(`${id}@maildock.invalid`);
        expect(parsed.attachments[0].content).toEqual(png);
      }
      if (kind === "inline-and-pdf")
        expect(parsed.attachments[1].contentDisposition).toBe("attachment");
    },
  );
});
