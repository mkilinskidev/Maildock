import { DraftConflictError } from "../domain/draft";
import { z } from "zod";
import { threading } from "../domain/reply-forward";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  readVerifiedBlob,
  type BlobStorage,
} from "../../../shared/application/blob-storage";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  safeFilename,
  safeContentType,
  type AttachmentLimits,
} from "../domain/attachments";
import { registerBlob, storedBlob } from "./attachment-service";
import { loadOutgoingMime } from "./outgoing-mime-storage";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  drafts,
  draftAttachments,
  mailAccounts,
  outgoingMessages,
  messages,
  mailboxMessages,
  mailboxes,
  blobs,
  stagedAttachments,
  messageAttachments,
  outgoingMessageAttachments,
} from "../../../shared/infrastructure/database/schema";
import type { AccountsService } from "../../accounts/application/accounts-service";
import type {
  MailProvider,
  SmtpDeliveryResult,
} from "../../accounts/domain/mail-provider";
import {
  composeInput,
  parseOutgoingAddresses,
  UNCERTAIN_SEND,
} from "../domain/outgoing-message";
import { buildOutgoingMime } from "../infrastructure/outgoing-mime";
import type { OutgoingLock } from "../infrastructure/outgoing-lock";
import {
  plainTextDocument,
  richResourceIds,
  serializeRichDocument,
} from "../domain/rich-document";
import { isSafeRaster } from "../infrastructure/render-email-document";

export class OutgoingValidationError extends Error {}
export class OutgoingMessageService {
  constructor(
    private readonly db: Database,
    private readonly enqueue: (id: string) => Promise<void>,
    private readonly accounts?: AccountsService,
    private readonly provider?: MailProvider,
    private readonly lock?: OutgoingLock,
    private readonly enqueueSentCopy?: (id: string) => Promise<void>,
    private readonly storage?: BlobStorage,
    private readonly limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
  ) {}

  async create(
    input: unknown,
    draft?: { id: string; expectedRevision: number },
  ) {
    let id: string = randomUUID();
    let resultStatus = "queued";
    const createdAt = new Date();
    const messageId = `<${randomUUID()}@maildock.invalid>`;
    await this.db.transaction(async (tx) => {
      if (draft) {
        const [row] = await tx
          .select()
          .from(drafts)
          .where(eq(drafts.id, draft.id))
          .for("update");
        if (!row) throw new DraftConflictError();
        if (row.status === "consumed" && row.outgoingMessageId) {
          id = row.outgoingMessageId;
          const [existing] = await tx
            .select()
            .from(outgoingMessages)
            .where(eq(outgoingMessages.id, id));
          resultStatus = existing.status;
          return;
        }
        if (row.status !== "active" || row.revision !== draft.expectedRevision)
          throw new DraftConflictError();
        const selection = await tx
          .select()
          .from(draftAttachments)
          .where(eq(draftAttachments.draftId, row.id))
          .orderBy(draftAttachments.position);
        input = {
          accountId: row.accountId,
          to: row.to,
          cc: row.cc,
          bcc: row.bcc,
          subject: row.subject,
          plainText: row.plainText,
          richDocument: row.richDocument ?? plainTextDocument(row.plainText),
          ...(row.source ? { source: row.source } : {}),
          attachments: selection.map((a) => ({
            id: a.id,
            kind: a.blobId ? "draft" : "incoming",
            inline: a.inline,
          })),
        };
      }
      let values;
      try {
        const schema = draft
          ? composeInput.extend({
              attachments: z.array(
                z.object({
                  id: z.uuid(),
                  kind: z.enum(["draft", "incoming"]),
                  inline: z.boolean().default(false),
                }),
              ),
            })
          : composeInput;
        const parsed = schema.parse(input);
        values = {
          ...parsed,
          to: parseOutgoingAddresses(parsed.to),
          cc: parseOutgoingAddresses(parsed.cc),
          bcc: parseOutgoingAddresses(parsed.bcc),
        };
        const count = values.to.length + values.cc.length + values.bcc.length;
        if (count < 1 || count > 100) throw Error();
      } catch {
        throw new OutgoingValidationError(
          "Check the recipients, subject and message size. At least one valid recipient is required.",
        );
      }
      const [account] = await tx
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, values.accountId))
        .for("share");
      if (
        !account?.enabled ||
        !account.smtpHost ||
        (account.authMethod === "oauth2" && account.oauthStatus !== "connected")
      )
        throw new OutgoingValidationError(
          "Select an enabled, configured sending account.",
        );
      const { source, attachments: selection, ...snapshot } = values;
      snapshot.richDocument =
        snapshot.richDocument ?? plainTextDocument(snapshot.plainText);
      const referenced = richResourceIds(snapshot.richDocument);
      if (
        selection.length > 100 ||
        new Set(selection.map((a) => a.id)).size !== selection.length
      )
        throw new OutgoingValidationError("Invalid resource selection.");
      if (referenced.size && !draft)
        throw new OutgoingValidationError(
          "Inline resources require a durable draft.",
        );
      const resourceCids = new Map<string, string>();
      let thread = {
        inReplyTo: null as string | null,
        references: [] as string[],
      };
      if (source) {
        const [original] = await tx
          .select({ message: messages })
          .from(messages)
          .innerJoin(
            mailboxMessages,
            eq(mailboxMessages.messageId, messages.id),
          )
          .innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId))
          .where(
            and(
              eq(messages.id, source.messageId),
              eq(messages.accountId, source.accountId),
              eq(mailboxes.accountId, source.accountId),
              eq(mailboxes.id, source.mailboxId),
            ),
          )
          .for("share");
        if (!original)
          throw new OutgoingValidationError(
            "The source message is unavailable in this account and mailbox.",
          );
        thread = threading(original.message, source.mode);
      }
      if (!this.storage)
        throw new OutgoingValidationError("Attachment storage is unavailable.");
      const attachments: {
        blobId: string;
        filename: string;
        contentType: string;
        size: number;
        sha256: string;
        content: Buffer;
        inline: boolean;
        contentId: string | null;
        resourceId: string;
      }[] = [];
      let total = 0;
      for (const selected of selection) {
        let blob, filename, contentType;
        let contentId: string | null = null;
        if (selected.inline !== referenced.has(selected.id))
          throw new OutgoingValidationError(
            "Invalid inline resource relationship.",
          );
        if (selected.kind === "draft" && draft) {
          const [saved] = await tx
            .select({ a: draftAttachments, blob: blobs })
            .from(draftAttachments)
            .innerJoin(blobs, eq(blobs.id, draftAttachments.blobId))
            .where(
              and(
                eq(draftAttachments.draftId, draft.id),
                eq(draftAttachments.id, selected.id),
              ),
            );
          if (!saved)
            throw new OutgoingValidationError("Draft attachment unavailable.");
          blob = saved.blob;
          filename = saved.a.filename;
          contentType = saved.a.contentType;
          if (saved.a.inline !== selected.inline)
            throw new OutgoingValidationError("Invalid resource disposition.");
          contentId = saved.a.contentId;
        } else if (selected.kind === "staged") {
          const [staged] = await tx
            .select({ staged: stagedAttachments, blob: blobs })
            .from(stagedAttachments)
            .innerJoin(blobs, eq(blobs.id, stagedAttachments.blobId))
            .where(
              and(
                eq(stagedAttachments.id, selected.id),
                eq(stagedAttachments.status, "ready"),
              ),
            )
            .for("update");
          if (!staged || staged.staged.expiresAt <= createdAt)
            throw new OutgoingValidationError(
              "A staged attachment is unavailable or expired.",
            );
          ({ blob } = staged);
          filename = staged.staged.filename;
          contentType = staged.staged.contentType;
          await tx
            .update(stagedAttachments)
            .set({ status: "consumed" })
            .where(eq(stagedAttachments.id, selected.id));
        } else {
          if (source?.mode !== "forward")
            throw new OutgoingValidationError(
              "Incoming attachments require a Forward source.",
            );
          const [incoming] = await tx
            .select({ attachment: messageAttachments, blob: blobs })
            .from(messageAttachments)
            .innerJoin(blobs, eq(blobs.id, messageAttachments.blobId))
            .where(
              and(
                eq(messageAttachments.id, selected.id),
                eq(messageAttachments.messageId, source.messageId),
                eq(messageAttachments.status, "ready"),
                eq(messageAttachments.visible, true),
              ),
            )
            .for("share");
          if (!incoming)
            throw new OutgoingValidationError(
              "A forwarded attachment is not ready. Prepare it or remove it before sending.",
            );
          ({ blob } = incoming);
          filename = incoming.attachment.filename;
          contentType = incoming.attachment.contentType;
        }
        total += blob.size;
        if (
          total > this.limits.maxOutgoingAttachmentBytes ||
          blob.size > this.limits.maxAttachmentBytes
        )
          throw new OutgoingValidationError(
            "Selected attachments exceed the configured size limit.",
          );
        let content;
        try {
          content = await readVerifiedBlob(
            this.storage,
            storedBlob(blob),
            this.limits.maxAttachmentBytes,
          );
        } catch {
          throw new OutgoingValidationError(
            "An attachment blob is missing or failed its integrity check.",
          );
        }
        attachments.push({
          blobId: blob.id,
          filename: safeFilename(filename),
          contentType: safeContentType(contentType),
          size: blob.size,
          sha256: blob.sha256,
          content,
          inline: selected.inline,
          contentId,
          resourceId: selected.id,
        });
        if (selected.inline) {
          if (
            !contentId ||
            !/^[0-9a-f-]{36}@maildock\.invalid$/.test(contentId) ||
            !isSafeRaster(content, contentType)
          )
            throw new OutgoingValidationError(
              "Inline image is invalid or corrupt.",
            );
          resourceCids.set(selected.id, contentId);
        }
      }
      const body = serializeRichDocument(snapshot.richDocument, resourceCids);
      snapshot.plainText = body.plainText;
      let from;
      let mime: Buffer;
      try {
        const addresses = parseOutgoingAddresses(account.email);
        if (
          addresses.length !== 1 ||
          /[\x00-\x1f\x7f]/.test(account.senderDisplayName) ||
          account.senderDisplayName.length > 200
        )
          throw Error();
        from = {
          address: addresses[0].address,
          name: account.senderDisplayName,
        };
        mime = await buildOutgoingMime({
          ...snapshot,
          html: body.html,
          ...thread,
          from,
          messageId,
          createdAt,
          attachments,
          maxMimeBytes: this.limits.maxOutgoingMimeBytes,
        });
      } catch {
        throw new OutgoingValidationError(
          "The sending identity is invalid or the message is too large.",
        );
      }
      const mimeBlob = await this.storage.put(
        Readable.from([mime]),
        this.limits.maxOutgoingMimeBytes,
      );
      const mimeBlobId = await registerBlob(tx, mimeBlob);
      await tx.insert(outgoingMessages).values({
        ...snapshot,
        html: body.html,
        ...thread,
        id,
        from,
        messageId,
        createdAt,
        mimeBlobId,
        status: "queued",
        sentCopyPolicy: account.sentCopyPolicy,
      });
      if (attachments.length)
        await tx.insert(outgoingMessageAttachments).values(
          attachments.map((attachment, position) => ({
            blobId: attachment.blobId,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
            sha256: attachment.sha256,
            inline: attachment.inline,
            contentId: attachment.contentId,
            resourceId: attachment.resourceId,
            outgoingMessageId: id,
            position,
          })),
        );
      if (draft)
        await tx
          .update(drafts)
          .set({
            status: "consumed",
            outgoingMessageId: id,
            updatedAt: new Date(),
          })
          .where(eq(drafts.id, draft.id));
    });
    // The row is the source of truth; a queue outage leaves a repairable message.
    await this.enqueue(id).catch(() => undefined);
    return { id, status: resultStatus };
  }

  async status(id: string) {
    const [row] = await this.db
      .select({
        id: outgoingMessages.id,
        accountId: outgoingMessages.accountId,
        status: outgoingMessages.status,
        error: outgoingMessages.error,
        smtpAcceptedAt: outgoingMessages.smtpAcceptedAt,
        rejectedCount: outgoingMessages.rejectedCount,
        sentCopyStatus: outgoingMessages.sentCopyStatus,
        sentCopyError: outgoingMessages.sentCopyError,
      })
      .from(outgoingMessages)
      .where(eq(outgoingMessages.id, id));
    return row ?? null;
  }

  async repair() {
    if (!this.lock) throw Error("Outgoing lock is required.");
    const rows = await this.db
      .select({ id: outgoingMessages.id, status: outgoingMessages.status })
      .from(outgoingMessages)
      .where(
        and(
          inArray(outgoingMessages.status, ["queued", "sending"]),
          lte(outgoingMessages.nextAttemptAt, sql`now()`),
        ),
      )
      .limit(100);
    for (const row of rows) {
      if (row.status === "sending")
        await this.lock(row.id, (db) => this.recoverSending(row.id, db));
      else await this.enqueue(row.id).catch(() => undefined);
    }
  }

  private async recoverSending(id: string, db: Database) {
    await db
      .update(outgoingMessages)
      .set({
        status: "uncertain",
        error: UNCERTAIN_SEND,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outgoingMessages.id, id),
          eq(outgoingMessages.status, "sending"),
        ),
      );
  }

  async run(id: string) {
    if (!this.lock || !this.accounts || !this.provider?.deliverMessage)
      throw Error("Outgoing worker dependencies are required.");
    // Credential resolution (including OAuth refresh) uses the account service's
    // pool. Do it before reserving the outgoing lock connection to avoid pool
    // starvation, even with a one-connection pool. No SMTP happens here.
    const [candidate] = await this.db
      .select()
      .from(outgoingMessages)
      .where(eq(outgoingMessages.id, id));
    if (!candidate || !["queued", "sending"].includes(candidate.status)) return;
    let account:
      | Awaited<ReturnType<AccountsService["getProviderSmtpAccountForWork"]>>
      | undefined;
    let accountFailed = false;
    if (candidate.status === "queued") {
      try {
        account = await this.accounts.getProviderSmtpAccountForWork(
          candidate.accountId,
        );
      } catch {
        accountFailed = true;
      }
    }
    await this.lock(id, async (db) => {
      const [row] = await db
        .select()
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, id));
      if (!row) return;
      if (row.status === "sending") {
        await this.recoverSending(id, db);
        return;
      }
      if (row.status !== "queued") return;
      // Account authority is rechecked immediately before the durable claim.
      const [currentAccount] = await db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, row.accountId));
      if (
        accountFailed ||
        !currentAccount?.enabled ||
        !currentAccount.smtpHost ||
        (currentAccount.authMethod === "oauth2" &&
          currentAccount.oauthStatus !== "connected")
      ) {
        await db
          .update(outgoingMessages)
          .set({
            status: "failed",
            error:
              "The sending account is disabled or its credentials are unavailable.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(outgoingMessages.id, id),
              eq(outgoingMessages.status, "queued"),
            ),
          );
        return;
      }
      if (!account) return; // Another attempt just returned to queued; poll again.
      let mime: Buffer;
      try {
        mime = await loadOutgoingMime(
          db,
          this.storage,
          row,
          this.limits.maxOutgoingMimeBytes,
        );
      } catch {
        await db
          .update(outgoingMessages)
          .set({
            status: "failed",
            error:
              "The immutable message could not be loaded from storage. No SMTP delivery was attempted.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(outgoingMessages.id, id),
              eq(outgoingMessages.status, "queued"),
            ),
          );
        return;
      }
      const [claimed] = await db
        .update(outgoingMessages)
        .set({
          status: "sending",
          attempts: sql`${outgoingMessages.attempts} + 1`,
          startedAt: new Date(),
          updatedAt: new Date(),
          error: null,
        })
        .where(
          and(
            eq(outgoingMessages.id, id),
            eq(outgoingMessages.status, "queued"),
            lte(outgoingMessages.nextAttemptAt, sql`now()`),
          ),
        )
        .returning();
      if (!claimed) return;
      // Autocommit above finishes before any network delivery. Any subsequent
      // exception/crash leaves sending, which recovery never resubmits.
      let result: SmtpDeliveryResult;
      try {
        result = await this.provider!.deliverMessage!(
          account,
          {
            from: row.from.address,
            to: [
              ...new Set(
                [...row.to, ...row.cc, ...row.bcc].map(
                  (address) => address.address,
                ),
              ),
            ],
          },
          mime,
        );
      } catch {
        result = { outcome: "uncertain" };
      }
      const now = new Date();
      const update =
        result.outcome === "accepted"
          ? {
              status: "sent",
              sentCopyStatus:
                row.sentCopyPolicy === "maildock" ? "pending" : "not_required",
              smtpAcceptedAt: now,
              acceptedCount: result.acceptedCount,
              rejectedCount: result.rejectedCount,
              error: result.rejectedCount
                ? "Message sent, but some recipients were rejected by SMTP."
                : null,
            }
          : result.outcome === "uncertain"
            ? { status: "uncertain", error: UNCERTAIN_SEND }
            : {
                status:
                  result.retryable && claimed.attempts < 3
                    ? "queued"
                    : "failed",
                error: result.message,
                nextAttemptAt: sql`now() + ${claimed.attempts * 30} * interval '1 second'`,
              };
      await db
        .update(outgoingMessages)
        .set({ ...update, updatedAt: now })
        .where(
          and(
            eq(outgoingMessages.id, id),
            eq(outgoingMessages.status, "sending"),
          ),
        );
      if (result.outcome === "accepted" && row.sentCopyPolicy === "maildock")
        await this.enqueueSentCopy?.(id).catch(() => undefined);
    });
  }
}
