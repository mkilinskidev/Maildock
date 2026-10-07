import { and, eq, inArray, or } from "drizzle-orm";
import type { BlobStorage } from "../../../shared/application/blob-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "../domain/attachments";
import { loadOutgoingMime } from "./outgoing-mime-storage";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxRoles,
  outgoingMessages,
} from "../../../shared/infrastructure/database/schema";
import type { AccountsService } from "../../accounts/application/accounts-service";
import type {
  MailProvider,
  ProviderImapAccount,
  SentCopyIdentity,
} from "../../accounts/domain/mail-provider";
import type { OutgoingLock } from "../infrastructure/outgoing-lock";
import { resolveMappedMailbox } from "./mailbox-role-service";

export const SENT_COPY_FAILED =
  "Message sent, but the copy could not be saved to Sent.";
export const SENT_COPY_UNCERTAIN =
  "Message sent, but Maildock could not confirm whether the Sent copy was saved.";
type Outgoing = typeof outgoingMessages.$inferSelect;

export class SentCopyService {
  constructor(
    private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly provider: MailProvider,
    private readonly lock: OutgoingLock,
    private readonly enqueue: (id: string) => Promise<void>,
    private readonly sync: (
      accountId: string,
      mailboxId: string,
      initial: boolean,
    ) => Promise<boolean>,
    private readonly storage?: BlobStorage,
    private readonly maxMimeBytes = DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
  ) {}

  async repair() {
    const rows = await this.db
      .select({ id: outgoingMessages.id })
      .from(outgoingMessages)
      .where(
        and(
          eq(outgoingMessages.status, "sent"),
          or(
            inArray(outgoingMessages.sentCopyStatus, ["pending", "saving"]),
            eq(outgoingMessages.sentCopySyncPending, true),
          ),
        ),
      )
      .orderBy(outgoingMessages.createdAt)
      .limit(100);
    for (const row of rows) await this.enqueue(row.id).catch(() => undefined);
  }

  async run(id: string) {
    const [candidate] = await this.db
      .select()
      .from(outgoingMessages)
      .where(eq(outgoingMessages.id, id));
    if (
      !candidate ||
      candidate.status !== "sent" ||
      candidate.sentCopyPolicy !== "maildock" ||
      !["pending", "saving", "saved"].includes(candidate.sentCopyStatus)
    )
      return;
    // Account/OAuth resolution must not consume another connection while the
    // outgoing session lock holds a reserved pool connection.
    let account: ProviderImapAccount | undefined;
    if (candidate.sentCopyStatus !== "saved") {
      try {
        account = await this.accounts.getProviderImapAccountForWork(
          candidate.accountId,
        );
      } catch {
        /* Fail a fresh copy; recover an in-flight copy as uncertain. */
      }
    }
    await this.lock(id, async (db) => {
      const [row] = await db
        .select()
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, id));
      if (!row || row.status !== "sent" || row.sentCopyPolicy !== "maildock")
        return;
      if (row.sentCopyStatus === "saved") {
        await this.requestSync(db, row);
        return;
      }
      if (!["pending", "saving"].includes(row.sentCopyStatus)) return;
      const [owner] = await db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, row.accountId));
      if (!account || !owner?.enabled) {
        await this.finish(
          db,
          row,
          row.sentCopyStatus === "saving" ? "uncertain" : "failed",
        );
        return;
      }
      if (row.sentCopyStatus === "saving") {
        // Never resolve a new role destination for an already attempted APPEND.
        const destination = await this.attemptedDestination(db, row);
        if (!destination || !this.provider.findSentCopy) {
          await this.finish(db, row, "uncertain");
          return;
        }
        let found;
        try {
          found = await this.provider.findSentCopy(
            account,
            row.sentCopyPath!,
            row.messageId,
          );
        } catch {
          found = { outcome: "uncertain" as const };
        }
        if (found.outcome === "found") {
          await this.saved(db, row, found);
          await this.requestSync(db, {
            ...row,
            sentCopyStatus: "saved",
            sentCopySyncPending: true,
          });
        } else await this.finish(db, row, "uncertain");
        return;
      }
      const [mapping] = await db
        .select()
        .from(mailboxRoles)
        .where(
          and(
            eq(mailboxRoles.accountId, row.accountId),
            eq(mailboxRoles.role, "sent"),
          ),
        );
      const candidates = await db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.accountId, row.accountId));
      const destination = resolveMappedMailbox(
        row.accountId,
        "sent",
        mapping,
        candidates,
      );
      if (!destination || !this.provider.appendMessage) {
        await this.finish(
          db,
          row,
          "failed",
          "Message sent, but the Sent mailbox is unavailable. Check System folders → Sent.",
        );
        return;
      }
      let mime: Buffer;
      try {
        mime = await loadOutgoingMime(db, this.storage, row, this.maxMimeBytes);
      } catch {
        await this.finish(db, row, "failed");
        return;
      }
      const [claimed] = await db
        .update(outgoingMessages)
        .set({
          sentCopyStatus: "saving",
          sentCopyMailboxId: destination.id,
          sentCopyPath: destination.remotePath,
          sentCopyStartedAt: new Date(),
          sentCopyError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(outgoingMessages.id, id),
            eq(outgoingMessages.status, "sent"),
            eq(outgoingMessages.sentCopyStatus, "pending"),
          ),
        )
        .returning();
      if (!claimed) return;
      let result;
      try {
        result = await this.provider.appendMessage(
          account,
          {
            remotePath: claimed.sentCopyPath!,
            flags: ["\\Seen"],
            internalDate: row.smtpAcceptedAt ?? row.createdAt,
          },
          mime,
        );
      } catch {
        result = { outcome: "uncertain" as const };
      }
      if (result.outcome === "saved") {
        await this.saved(db, claimed, result);
        await this.requestSync(db, {
          ...claimed,
          sentCopyStatus: "saved",
          sentCopySyncPending: true,
        });
      } else await this.finish(db, claimed, result.outcome);
    });
  }

  private async attemptedDestination(db: Database, row: Outgoing) {
    if (!row.sentCopyMailboxId || !row.sentCopyPath) return null;
    const [mailbox] = await db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.id, row.sentCopyMailboxId),
          eq(mailboxes.accountId, row.accountId),
        ),
      );
    return mailbox?.selectable &&
      mailbox.lifecycleStatus === "active" &&
      mailbox.remotePath === row.sentCopyPath
      ? mailbox
      : null;
  }

  private async finish(
    db: Database,
    row: Outgoing,
    status: "failed" | "uncertain",
    error = status === "failed" ? SENT_COPY_FAILED : SENT_COPY_UNCERTAIN,
  ) {
    await db
      .update(outgoingMessages)
      .set({
        sentCopyStatus: status,
        sentCopyError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outgoingMessages.id, row.id),
          eq(outgoingMessages.status, "sent"),
          eq(outgoingMessages.sentCopyStatus, row.sentCopyStatus),
        ),
      );
  }

  private async saved(db: Database, row: Outgoing, identity: SentCopyIdentity) {
    await db
      .update(outgoingMessages)
      .set({
        sentCopyStatus: "saved",
        sentCopySavedAt: new Date(),
        sentCopyError: null,
        sentCopySyncPending: true,
        sentCopyUidValidity: identity.uidValidity
          ? BigInt(identity.uidValidity)
          : null,
        sentCopyUid: identity.uid ? BigInt(identity.uid) : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outgoingMessages.id, row.id),
          eq(outgoingMessages.status, "sent"),
          eq(outgoingMessages.sentCopyStatus, "saving"),
        ),
      );
  }

  private async requestSync(db: Database, row: Outgoing) {
    if (!row.sentCopySyncPending) return;
    const destination = await this.attemptedDestination(db, row);
    if (!destination) return;
    const [owner] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, row.accountId));
    if (!owner?.enabled) return;
    try {
      const queued = await this.sync(
        row.accountId,
        destination.id,
        destination.recentSyncStatus !== "success",
      );
      if (queued)
        await db
          .update(outgoingMessages)
          .set({ sentCopySyncPending: false, updatedAt: new Date() })
          .where(
            and(
              eq(outgoingMessages.id, row.id),
              eq(outgoingMessages.sentCopyStatus, "saved"),
            ),
          );
    } catch {
      /* The durable sync-pending marker survives queue/DB failure. */
    }
  }
}
