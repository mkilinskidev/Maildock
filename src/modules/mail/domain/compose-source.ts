import type { AttachmentView } from "./attachments";
import { z } from "zod";
import type { RichDocument } from "./rich-document";

export const composeMode = z.enum(["reply", "reply_all", "forward"]);
export type ComposeMode = z.infer<typeof composeMode>;
export const sourceContext = z
  .object({
    accountId: z.uuid(),
    mailboxId: z.uuid(),
    messageId: z.uuid(),
    mode: composeMode,
  })
  .strict();
export type SourceContext = z.infer<typeof sourceContext>;
export type ComposePrefill = {
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  plainText: string;
  richDocument?: RichDocument;
  source: SourceContext;
  attachmentsOmitted: boolean;
  attachments?: AttachmentView[];
};
