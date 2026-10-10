import { simpleParser } from "mailparser";
import type {
  GmailMessage,
  GmailPart,
  GmailClient,
} from "../../accounts/infrastructure/gmail-client";
import {
  decodeBase64Url,
  GmailApiError,
} from "../../accounts/infrastructure/gmail-client";
import type { RemoteMimePart } from "../../accounts/domain/mail-provider";
import { selectDisplayParts } from "../domain/display-parts";

export function gmailHeader(part: GmailPart, name: string) {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value;
}
export function gmailParts(root?: GmailPart): GmailPart[] {
  const out: GmailPart[] = [];
  function visit(p: GmailPart, depth: number) {
    if (depth > 30 || out.length >= 1000)
      throw new GmailApiError("invalid_response");
    out.push(p);
    for (const child of p.parts ?? []) visit(child, depth + 1);
  }
  if (root) visit(root, 0);
  return out;
}
export function gmailStructure(root?: GmailPart): RemoteMimePart | null {
  if (!root) return null;
  gmailParts(root);
  function convert(p: GmailPart): RemoteMimePart {
    const disposition = gmailHeader(p, "content-disposition");
    const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(
      gmailHeader(p, "content-type") ?? "",
    )?.[1];
    return {
      part: p.partId,
      type: p.mimeType.toLowerCase(),
      filename: p.filename || null,
      disposition: disposition?.split(";")[0].trim().toLowerCase() ?? null,
      contentId: gmailHeader(p, "content-id")?.replace(/^<|>$/g, "") ?? null,
      encoding: null,
      size: p.body?.size?.toString() ?? null,
      parameters: charset ? { charset } : {},
      dispositionParameters: {},
      children: (p.parts ?? []).map(convert),
    };
  }
  return convert(root);
}
export async function gmailEnvelope(message: GmailMessage) {
  const headers = message.payload?.headers ?? [];
  // Header values are data; prevent CRLF injection into the synthetic parser input.
  const source =
    headers
      .map(
        (h) =>
          `${h.name.replace(/[\r\n:]/g, "")}: ${h.value.replace(/[\r\n]+/g, " ")}`,
      )
      .join("\r\n") + "\r\n\r\n";
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const addresses = (value: typeof parsed.from | typeof parsed.to) =>
    (Array.isArray(value) ? value : value ? [value] : []).flatMap((v) =>
      Array.isArray(v?.value)
        ? v.value.map((a) => ({
            name: a.name || undefined,
            address: a.address,
          }))
        : [],
    );
  return {
    subject: parsed.subject ?? null,
    rfcMessageId: parsed.messageId ?? null,
    sentAt:
      parsed.date && Number.isFinite(parsed.date.getTime())
        ? parsed.date
        : null,
    from: addresses(parsed.from),
    sender: addresses(parsed.headers.get("sender") as typeof parsed.from),
    replyTo: addresses(parsed.replyTo),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    inReplyTo: parsed.inReplyTo ?? null,
    references: Array.isArray(parsed.references)
      ? parsed.references.join(" ")
      : (parsed.references ?? null),
  };
}
export async function gmailPartBytes(
  client: GmailClient,
  messageId: string,
  p: GmailPart,
  limit: number,
) {
  if ((p.body?.size ?? 0) > limit) throw new GmailApiError("invalid_response");
  const data =
    p.body?.data ??
    (p.body?.attachmentId
      ? (await client.attachment(messageId, p.body.attachmentId)).data
      : "");
  return decodeBase64Url(data, limit);
}
export async function gmailDisplay(
  client: GmailClient,
  message: GmailMessage,
  limit: number,
) {
  let plainText: string | null = null;
  let html: string | null = null;
  const parts = gmailParts(message.payload);
  // Reuse the application's alternative/mixed/related branch selection.
  for (const selected of selectDisplayParts(
    gmailStructure(message.payload),
    "gmail",
  )) {
    const p = parts.find((p) => p.partId === selected.part);
    if (!p) throw new GmailApiError("invalid_response");
    const bytes = await gmailPartBytes(client, message.id, p, limit);
    const charset =
      /charset\s*=\s*"?([^";\s]+)/i.exec(
        gmailHeader(p, "content-type") ?? "",
      )?.[1] ?? "utf-8";
    let text: string;
    try {
      text = new TextDecoder(charset).decode(bytes);
    } catch {
      throw new GmailApiError("invalid_response");
    }
    if (Buffer.byteLength(text) > limit)
      throw new GmailApiError("invalid_response");
    if (p.mimeType === "text/html") html = text;
    else plainText = text;
  }
  return { plainText, html };
}
