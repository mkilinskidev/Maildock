import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  blobs,
  messageAttachments,
} from "../../../shared/infrastructure/database/schema";
import type { RemoteMimePart } from "../../accounts/domain/mail-provider";
import { discoverAttachments } from "../domain/attachments";

type Db = Pick<Database, "insert">;
export async function persistAttachmentMetadata(
  db: Db,
  messageId: string,
  accountId: string,
  mailboxId: string,
  uidValidity: bigint,
  uid: bigint,
  structure: RemoteMimePart | null | undefined,
) {
  const parts = discoverAttachments(structure);
  if (!parts.length) return;
  // The known original placement is frozen. Do not remap cached parts to another epoch.
  await db
    .insert(messageAttachments)
    .values(
      parts.map((part) => ({
        ...part,
        id: randomUUID(),
        messageId,
        accountId,
        sourceAccountId: accountId,
        sourceMailboxId: mailboxId,
        sourceUidValidity: uidValidity,
        sourceUid: uid,
      })),
    )
    .onConflictDoNothing({
      target: [messageAttachments.messageId, messageAttachments.partId],
    });
}

export async function listAttachmentMetadata(db: Database, messageId: string) {
  const rows = await db
    .select({ attachment: messageAttachments, size: blobs.size })
    .from(messageAttachments)
    .leftJoin(blobs, eq(blobs.id, messageAttachments.blobId))
    .where(eq(messageAttachments.messageId, messageId))
    .orderBy(messageAttachments.partId);
  return rows.map(({ attachment: a, size }) => ({
    id: a.id,
    filename: a.filename,
    type: a.contentType,
    size: size?.toString() ?? a.declaredSize?.toString() ?? null,
    inline: a.inline,
    visible: a.visible,
    status: a.status,
    error: a.error,
  }));
}
