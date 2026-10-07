import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import type { RemoteMimePart } from "@/modules/accounts/domain/mail-provider";
import { discoverAttachments } from "@/modules/mail/domain/attachments";
import { decodeAttachment } from "@/modules/accounts/infrastructure/decode-attachment";
import { buildOutgoingMime } from "@/modules/mail/infrastructure/outgoing-mime";
import { attachmentJob } from "@/modules/mail/infrastructure/attachment-jobs";

export function part(
  partId: string | null,
  values: Partial<RemoteMimePart> = {},
): RemoteMimePart {
  return {
    part: partId,
    type: "application/pdf",
    disposition: "attachment",
    filename: "invoice.pdf",
    encoding: "base64",
    size: "100",
    contentId: null,
    parameters: {},
    dispositionParameters: {},
    children: [],
    ...values,
  };
}
describe("attachment MIME foundations", () => {
  it("retains duplicate filenames, missing names, exact part identity and inline CID metadata, excluding body alternatives", () => {
    const parts = discoverAttachments(
      part(null, {
        type: "multipart/mixed",
        disposition: null,
        filename: null,
        children: [
          part("1", { type: "text/plain", disposition: null, filename: null }),
          part("2", { type: "text/html", disposition: null, filename: null }),
          part("3"),
          part("4"),
          part("5", { filename: null }),
          part("6", {
            type: "image/png",
            disposition: "inline",
            contentId: "<logo>",
            filename: null,
          }),
        ],
      }),
    );
    expect(parts.map((p) => p.partId)).toEqual(["3", "4", "5", "6"]);
    expect(parts[0].filename).toBe(parts[1].filename);
    expect(parts[2].filename).toBeNull();
    expect(parts[3]).toMatchObject({
      contentId: "<logo>",
      inline: true,
      visible: false,
    });
  });
  it("supports single-part attached files, attached messages and malformed metadata conservatively", () => {
    expect(discoverAttachments(part(null))[0].partId).toBe("1");
    expect(discoverAttachments(part("../1"))).toEqual([]);
    expect(
      discoverAttachments(part("1", { size: "untrusted" }))[0].declaredSize,
    ).toBeNull();
    expect(
      discoverAttachments(
        part("2", { type: "message/rfc822", children: [part("2.1")] }),
      ).map((p) => p.partId),
    ).toEqual(["2"]);
    expect(
      discoverAttachments(
        part(null, { type: "text/plain", filename: null, disposition: null }),
      ),
    ).toEqual([]);
  });
  it.each(["base64", "quoted-printable", "8bit"])(
    "preserves exact binary/text charset bytes across every chunk boundary: %s",
    async (encoding) => {
      const original = Buffer.from([0, 255, 61, 10, 13, 128, 120]);
      const encoded =
        encoding === "base64"
          ? original.toString("base64")
          : encoding === "quoted-printable"
            ? "=00=FF=3D=0A=0D=\r\n=80x"
            : original.toString("latin1");
      const chunks: Buffer[] = [];
      for await (const bytes of decodeAttachment(
        Readable.from(
          [...Buffer.from(encoded, "latin1")].map((n) => Buffer.from([n])),
        ),
        encoding,
      ))
        chunks.push(Buffer.from(bytes));
      expect(Buffer.concat(chunks)).toEqual(original);
    },
  );
  it("rejects unsupported transfer encoding and truncated base64", async () => {
    for (const [value, encoding] of [
      ["QQ", "base64"],
      ["@", "base64"],
      ["data", "unknown"],
    ]) {
      await expect(async () => {
        for await (const bytes of decodeAttachment(
          Readable.from([Buffer.from(value)]),
          encoding,
        )) {
          expect(bytes).toBeDefined();
        }
      }).rejects.toThrow();
    }
  });
  it("accepts only an attachment ID in durable jobs", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(attachmentJob.parse({ attachmentId: id })).toEqual({
      attachmentId: id,
    });
    for (const field of [
      "uid",
      "mailbox",
      "filename",
      "credential",
      "storageKey",
    ])
      expect(() =>
        attachmentJob.parse({ attachmentId: id, [field]: "secret" }),
      ).toThrow();
  });
  const message = {
    from: { address: "from@example.com" },
    to: [{ address: "to@example.com" }],
    cc: [],
    subject: "Files",
    plainText: "Body",
    messageId: "<fixed@example.com>",
    createdAt: new Date(0),
    inReplyTo: "<original@example.com>",
    references: ["<parent@example.com>"],
  };
  it("creates ordered multipart attachments with Unicode names and exact bytes, preserving IDs, Date, threading and Bcc omission", async () => {
    const attachments = [
      {
        filename: "Zażółć.pdf",
        contentType: "application/pdf",
        content: Buffer.from([0, 255, 128]),
      },
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        content: Buffer.from("second"),
      },
    ];
    const raw = await buildOutgoingMime({ ...message, attachments });
    const parsed = await simpleParser(raw);
    expect(raw.toString()).toContain("multipart/mixed");
    expect(parsed.attachments.map((a) => a.filename)).toEqual(
      attachments.map((a) => a.filename),
    );
    expect(parsed.attachments.map((a) => a.content)).toEqual(
      attachments.map((a) => a.content),
    );
    expect(parsed.text?.trim()).toBe("Body");
    expect(parsed.messageId).toBe(message.messageId);
    expect(parsed.date).toEqual(message.createdAt);
    expect(parsed.inReplyTo).toBe(message.inReplyTo);
    expect(parsed.references).toBe("<parent@example.com>");
    expect(parsed.bcc).toBeUndefined();
  });
  it("enforces final MIME size including base64 overhead before publication", async () => {
    await expect(
      buildOutgoingMime({
        ...message,
        attachments: [
          {
            filename: "x",
            contentType: "application/octet-stream",
            content: Buffer.alloc(1000),
          },
        ],
        maxMimeBytes: 1200,
      }),
    ).rejects.toThrow("size limit");
  });
});
