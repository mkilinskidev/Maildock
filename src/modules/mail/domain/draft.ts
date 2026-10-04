import { z } from "zod";
import { sourceContext } from "./compose-source";
import type { SourceContext } from "./compose-source";
import type { AttachmentView } from "./attachments";
import { richDocumentSchema, type RichDocument } from "./rich-document";
export class DraftConflictError extends Error {
  constructor() {
    super(
      "This draft changed in another tab, was sent, or was discarded. Reopen it from Local drafts before continuing.",
    );
  }
}
export const draftFields = z.object({
  accountId: z.uuid(),
  to: z.string().max(8000),
  cc: z.string().max(8000).default(""),
  bcc: z.string().max(8000).default(""),
  subject: z.string().max(998),
  plainText: z.string().max(500000).default(""),
  richDocument: richDocumentSchema.optional(),
  attachments: z
    .array(
      z
        .object({
          id: z.uuid(),
          kind: z.enum(["staged", "incoming", "draft"]),
          inline: z.boolean().default(false),
        })
        .strict(),
    )
    .max(100)
    .default([])
    .refine((items) => new Set(items.map((a) => a.id)).size === items.length),
});
export const draftCreate = draftFields
  .extend({ id: z.uuid(), source: sourceContext.optional() })
  .strict();
export const draftUpdate = draftFields
  .extend({ expectedRevision: z.number().int().positive() })
  .strict();
export const draftRevision = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export type DraftView = {
  recovery?: boolean;
  id: string;
  accountId: string;
  composeMode: string;
  source: SourceContext | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  plainText: string;
  richDocument?: RichDocument | null;
  revision: number;
  status: string;
  outgoingMessageId: string | null;
  attachments: (AttachmentView & { kind: "staged" | "incoming" | "draft" })[];
};
