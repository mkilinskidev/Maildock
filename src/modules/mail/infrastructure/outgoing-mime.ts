import { validMessageId } from "../domain/reply-forward";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Readable } from "node:stream";
import { BlobLimitError } from "../../../shared/application/blob-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "../domain/attachments";
import type { OutgoingAddress } from "../domain/outgoing-message";

export async function buildOutgoingMime(message: {
  from: OutgoingAddress;
  to: OutgoingAddress[];
  cc: OutgoingAddress[];
  subject: string;
  plainText: string;
  messageId: string;
  createdAt: Date;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Buffer }[];
  maxMimeBytes?: number;
}): Promise<Buffer> {
  if (
    (message.inReplyTo && !validMessageId(message.inReplyTo)) ||
    (message.references &&
      (message.references.length > 30 ||
        message.references.join(" ").length > 4000 ||
        message.references.some((id) => !validMessageId(id))))
  )
    throw new Error("Invalid threading headers.");
  const compiled = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    text: {
      content: Buffer.from(message.plainText, "utf8"),
      contentTransferEncoding: "base64",
    },
    date: message.createdAt,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references?.length ? message.references : undefined,
    textEncoding: "base64",
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      contentDisposition: "attachment",
      contentTransferEncoding: "base64",
    })),
  }).compile();
  const source = compiled.createReadStream() as Readable;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (
      size >
      (message.maxMimeBytes ?? DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes)
    )
      throw new BlobLimitError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
