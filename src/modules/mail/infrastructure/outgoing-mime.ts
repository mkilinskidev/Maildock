import { validMessageId } from "../domain/reply-forward";
import MailComposer from "nodemailer/lib/mail-composer";
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
}): Promise<Buffer> {
  if (
    (message.inReplyTo && !validMessageId(message.inReplyTo)) ||
    (message.references &&
      (message.references.length > 30 ||
        message.references.join(" ").length > 4000 ||
        message.references.some((id) => !validMessageId(id))))
  )
    throw new Error("Invalid threading headers.");
  const mime = await new MailComposer({
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
  })
    .compile()
    .build();
  if (mime.length > 1_000_000) throw new Error("Message is too large.");
  return mime;
}
