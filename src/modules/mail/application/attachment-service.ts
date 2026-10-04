import {
  SAFE_INLINE_IMAGE_TYPES,
  isSafeRaster,
} from "../infrastructure/render-email-document";
import { normalizeContentId } from "../infrastructure/sanitize-email-html";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  draftAttachments,
  blobs,
  mailAccounts,
  mailboxes,
  mailboxMessages,
  messages,
  messageAttachments,
  stagedAttachments,
} from "../../../shared/infrastructure/database/schema";
import {
  BlobLimitError,
  readVerifiedBlob,
  type BlobStorage,
  type StoredBlob,
} from "../../../shared/application/blob-storage";
import {
  safeFilename,
  safeContentType,
  discoverAttachments,
  type AttachmentLimits,
} from "../domain/attachments";
import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailboxEpochChangedError,
  type MailProvider,
} from "../../accounts/domain/mail-provider";
import type { OutgoingLock } from "../infrastructure/outgoing-lock";

export class AttachmentUnavailableError extends Error {}
export async function registerBlob(
  db: Pick<Database, "insert">,
  blob: StoredBlob,
) {
  const id = randomUUID();
  await db
    .insert(blobs)
    .values({ id, storageKey: blob.key, size: blob.size, sha256: blob.sha256 });
  return id;
}
export function storedBlob(row: typeof blobs.$inferSelect): StoredBlob {
  return { key: row.storageKey, size: row.size, sha256: row.sha256 };
}

export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly storage: BlobStorage,
    private readonly limits: AttachmentLimits,
    private readonly enqueue: (id: string) => Promise<void>,
    private readonly accounts?: AccountsService,
    private readonly provider?: MailProvider,
    private readonly lock?: OutgoingLock,
    private readonly reconcile?: (
      accountId: string,
      mailboxId: string,
    ) => Promise<unknown>,
  ) {}

  private async lookup(db: Database, id: string) {
    const [row] = await db
      .select({
        attachment: messageAttachments,
        message: messages,
        account: mailAccounts,
        mailbox: mailboxes,
        placement: mailboxMessages,
        blob: blobs,
      })
      .from(messageAttachments)
      .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .leftJoin(
        mailboxes,
        and(
          eq(mailboxes.id, messageAttachments.sourceMailboxId),
          eq(mailboxes.accountId, messages.accountId),
        ),
      )
      .leftJoin(
        mailboxMessages,
        and(
          eq(mailboxMessages.mailboxId, messageAttachments.sourceMailboxId),
          eq(mailboxMessages.messageId, messages.id),
          eq(mailboxMessages.uidValidity, messageAttachments.sourceUidValidity),
          eq(mailboxMessages.uid, messageAttachments.sourceUid),
        ),
      )
      .leftJoin(blobs, eq(blobs.id, messageAttachments.blobId))
      .where(eq(messageAttachments.id, id));
    if (!row)
      throw new AttachmentUnavailableError("Attachment is unavailable.");
    return row;
  }
  async status(id: string) {
    const row = await this.lookup(this.db, id);
    return {
      id,
      filename: row.attachment.filename,
      type: row.attachment.contentType,
      size:
        row.blob?.size.toString() ??
        row.attachment.declaredSize?.toString() ??
        null,
      status: row.attachment.status,
      error: row.attachment.error,
    };
  }
  async request(id: string) {
    const row = await this.lookup(this.db, id);
    if (!row.account.enabled)
      throw new AttachmentUnavailableError("This account is disabled.");
    if (row.attachment.status === "ready" && row.blob) {
      try {
        await readVerifiedBlob(
          this.storage,
          storedBlob(row.blob),
          this.limits.maxAttachmentBytes,
        );
        return;
      } catch {
        /* Missing/corrupt cache is repairable from the authoritative placement. */
      }
    }
    if (
      !row.placement ||
      !row.mailbox?.selectable ||
      row.mailbox.lifecycleStatus !== "active"
    )
      throw new AttachmentUnavailableError(
        "The source mailbox placement is unavailable.",
      );
    await this.db
      .update(messageAttachments)
      .set({
        status: "pending",
        blobId: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageAttachments.id, id),
          eq(messageAttachments.status, row.attachment.status),
          inArray(messageAttachments.status, [
            "not_fetched",
            "failed",
            "ready",
          ]),
          row.attachment.blobId
            ? eq(messageAttachments.blobId, row.attachment.blobId)
            : isNull(messageAttachments.blobId),
        ),
      );
    // Pending DB state survives a queue outage and is repaired by the poller.
    await this.enqueue(id).catch(() => undefined);
  }
  async download(id: string) {
    const row = await this.lookup(this.db, id);
    if (row.attachment.status !== "ready" || !row.blob)
      throw new AttachmentUnavailableError(
        "Attachment is not ready. Prepare it first.",
      );
    return {
      bytes: await readVerifiedBlob(
        this.storage,
        storedBlob(row.blob),
        this.limits.maxAttachmentBytes,
      ),
      filename: row.attachment.filename,
    };
  }
  async inlineResource(
    messageId: string,
    attachmentId: string,
    contentId: string,
  ) {
    const row = await this.lookup(this.db, attachmentId);
    if (
      row.attachment.messageId !== messageId ||
      !row.attachment.contentId ||
      normalizeContentId(row.attachment.contentId) !== contentId ||
      !SAFE_INLINE_IMAGE_TYPES.has(row.attachment.contentType)
    )
      throw new AttachmentUnavailableError("Inline resource is unavailable.");
    const result = await this.download(attachmentId);
    if (!isSafeRaster(result.bytes, row.attachment.contentType))
      throw new AttachmentUnavailableError("Inline image format is invalid.");
    return { ...result, type: row.attachment.contentType };
  }
  async upload(
    source: AsyncIterable<Uint8Array>,
    filename: string | null,
    contentType: string | null,
  ) {
    const blob = await this.storage.put(source, this.limits.maxAttachmentBytes);
    const id = randomUUID();
    const name = safeFilename(filename),
      type = safeContentType(contentType);
    await this.db.transaction(async (tx) => {
      const blobId = await registerBlob(tx, blob);
      await tx.insert(stagedAttachments).values({
        id,
        blobId,
        filename: name,
        contentType: type,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      });
    });
    return {
      id,
      filename: name,
      type,
      size: blob.size.toString(),
      status: "ready",
      error: null,
    };
  }
  async removeStaged(id: string) {
    const rows = await this.db
      .update(stagedAttachments)
      .set({ status: "removed" })
      .where(
        and(
          eq(stagedAttachments.id, id),
          eq(stagedAttachments.status, "ready"),
        ),
      )
      .returning({ id: stagedAttachments.id });
    if (!rows.length)
      throw new AttachmentUnavailableError("Staged attachment is unavailable.");
    // Keep physical bytes: all durable references must be checked by future GC.
  }
  async repair() {
    const rows = await this.db
      .select({ id: messageAttachments.id })
      .from(messageAttachments)
      .where(inArray(messageAttachments.status, ["pending", "fetching"]))
      .limit(100);
    for (const row of rows) await this.enqueue(row.id).catch(() => undefined);
  }
  async run(id: string) {
    if (!this.lock || !this.accounts || !this.provider?.fetchAttachment)
      throw Error("Attachment worker dependencies are required.");
    // Resolve OAuth before reserving a connection, including one-connection pools.
    const candidate = await this.lookup(this.db, id);
    if (
      candidate.attachment.status === "ready" ||
      !["pending", "fetching"].includes(candidate.attachment.status)
    )
      return;
    let account:
      | Awaited<ReturnType<AccountsService["getProviderImapAccountForWork"]>>
      | undefined;
    try {
      account = await this.accounts.getProviderImapAccountForWork(
        candidate.account.id,
      );
    } catch {
      /* Persist safe failure inside lock. */
    }
    let stale = false;
    await this.lock(id, async (db) => {
      const row = await this.lookup(db, id);
      if (
        row.attachment.status === "ready" ||
        !["pending", "fetching"].includes(row.attachment.status)
      )
        return;
      try {
        if (
          !account ||
          !row.account.enabled ||
          !row.placement ||
          !row.mailbox?.selectable ||
          row.mailbox.lifecycleStatus !== "active"
        )
          throw new AttachmentUnavailableError(
            "The source account or mailbox placement is unavailable.",
          );
        if (
          row.mailbox.recentSyncUidValidity !==
            row.attachment.sourceUidValidity ||
          (row.mailbox.uidValidity !== null &&
            row.mailbox.uidValidity !== row.attachment.sourceUidValidity)
        ) {
          stale = true;
          throw new AttachmentUnavailableError(
            "Mailbox UIDVALIDITY changed. Synchronize the mailbox again.",
          );
        }
        if (
          !discoverAttachments(row.message.mimeStructure).some(
            (p) => p.partId === row.attachment.partId,
          )
        )
          throw new AttachmentUnavailableError(
            "The source MIME part is unavailable.",
          );
        await db
          .update(messageAttachments)
          .set({ status: "fetching", error: null, updatedAt: new Date() })
          .where(eq(messageAttachments.id, id));
        const blob = await this.provider!.fetchAttachment!(
          account,
          {
            remotePath: row.mailbox.remotePath,
            uid: row.attachment.sourceUid.toString(),
            expectedUidValidity: row.attachment.sourceUidValidity.toString(),
            partId: row.attachment.partId,
            maxBytes: this.limits.maxAttachmentBytes,
          },
          (stream) => this.storage.put(stream, this.limits.maxAttachmentBytes),
        );
        // The lock owns a reserved session, whose postgres-js client has no
        // transaction API. Publish metadata first, then the authoritative ready
        // transition using autocommit on that same session. Failure leaves an
        // unreferenced complete blob, never a partially written attachment.
        const blobId = await registerBlob(db, blob);
        await db
          .update(messageAttachments)
          .set({ status: "ready", blobId, error: null, updatedAt: new Date() })
          .where(eq(messageAttachments.id, id));
        await db
          .update(draftAttachments)
          .set({ blobId })
          .where(
            and(eq(draftAttachments.id, id), isNull(draftAttachments.blobId)),
          );
      } catch (error) {
        if (error instanceof MailboxEpochChangedError) stale = true;
        const reason =
          error instanceof AttachmentUnavailableError ||
          error instanceof BlobLimitError
            ? error.message
            : "Attachment could not be fetched. Retry preparation.";
        await db
          .update(messageAttachments)
          .set({
            status: "failed",
            blobId: null,
            error: reason,
            updatedAt: new Date(),
          })
          .where(eq(messageAttachments.id, id));
      }
    });
    if (stale && candidate.mailbox)
      await this.reconcile?.(candidate.account.id, candidate.mailbox.id).catch(
        () => undefined,
      );
  }
}
