import { assertImapPublication } from "../infrastructure/receive-publication-fence";
import {
  MailTransportRouter,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";
import type { ApplicationEventService } from "../../diagnostics/application/application-event-service";
import { randomUUID } from "node:crypto";
import { ConversationService } from "./conversation-service";
import { persistAttachmentMetadata } from "./attachment-metadata";

import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailProviderOperationError,
  type MailProvider,
  type RemoteMessageMetadata,
} from "../../accounts/domain/mail-provider";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailboxMessages,
  mailAccounts,
  mailboxes,
  messages,
  messageContents,
  instanceState,
  notificationEvents,
  messageCommands,
  outgoingMessages,
} from "../../../shared/infrastructure/database/schema";
import type { RecentSyncScheduler } from "./recent-sync-scheduler";
import type { DeltaReason } from "./delta-sync-service";

export class MailboxNotSynchronizableError extends Error {
  constructor(message = "Mailbox is missing or not selectable.") {
    super(message);
    this.name = "MailboxNotSynchronizableError";
  }
}

export class MailboxNotFoundError extends Error {
  constructor() {
    super("Mailbox not found for this account.");
    this.name = "MailboxNotFoundError";
  }
}

export type MessageListItem = Readonly<{
  id: string;
  subject: string | null;
  from: readonly Readonly<{ name?: string; address?: string }>[];
  date: string;
  seen: boolean;
  flagged: boolean;
  size: string;
  hasAttachments: boolean;
  accountId?: string;
  accountName?: string;
  mailboxId?: string | null;
  snippet?: string | null;
  conversationId?: string;
  messageCount?: number;
  conversationMessageCount?: number;
}>;

export type MessagePage = Readonly<{
  items: readonly MessageListItem[];
  nextCursor: string | null;
}>;

function sanitizedSyncError(error: unknown): string {
  if (error instanceof MailProviderOperationError) return error.message;
  if (error instanceof MailboxNotSynchronizableError) return error.message;
  return "Recent message synchronization failed.";
}

function cutoffDate(days: number, now = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

function messageValues(
  accountId: string,
  remote: RemoteMessageMetadata,
  now: Date,
) {
  const envelope = remote.envelope;
  return {
    accountId,
    providerMessageId: remote.providerEmailId ?? null,
    rfcMessageId: envelope.messageId ?? null,
    subject: envelope.subject ?? null,
    sentAt: envelope.date ? new Date(envelope.date) : null,
    internalDate: new Date(remote.internalDate),
    size: BigInt(remote.size),
    from: envelope.from,
    sender: envelope.sender,
    replyTo: envelope.replyTo,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    inReplyTo: envelope.inReplyTo ?? null,
    references: envelope.references ?? null,
    mimeStructure: remote.mimeStructure ?? null,
    hasAttachments: remote.hasAttachments,
    updatedAt: now,
  };
}

function encodeCursor(date: Date, id: string): string {
  return Buffer.from(JSON.stringify([date.toISOString(), id]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): [Date, string] {
  const parsed: unknown = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  )
    throw new Error("Invalid cursor.");
  const date = new Date(parsed[0]);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid cursor.");
  return [date, parsed[1]];
}

export class MessageService {
  constructor(
    private readonly database: Database,
    private readonly accounts?: AccountsService,
    private readonly provider?: MailProvider,
    private readonly config?: Pick<
      AppConfig,
      "initialSyncDays" | "messageFetchBatchSize"
    >,
    private readonly scheduler?: RecentSyncScheduler,
    private readonly deltaScheduler?: {
      schedule(
        accountId: string,
        mailboxId: string,
        reason: DeltaReason,
      ): Promise<boolean>;
    },
    private readonly backfillScheduler?: {
      schedule(accountId: string, mailboxId: string): Promise<boolean>;
    },
    private readonly events?: ApplicationEventService,
  ) {}

  async requestSync(accountId: string, mailboxId: string): Promise<boolean> {
    const mailbox = await this.ownedMailbox(accountId, mailboxId);
    if (
      mailbox.recentSyncStatus !== "success" ||
      mailbox.recentSyncUidValidity === null
    )
      return this.requestRecentSync(accountId, mailboxId);
    if (!mailbox.selectable || mailbox.lifecycleStatus !== "active")
      throw new MailboxNotSynchronizableError();
    const [account] = await this.database
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId))
      .limit(1);
    if (!account?.enabled)
      throw new MailboxNotSynchronizableError(
        "Disabled mail accounts cannot synchronize messages.",
      );
    if (account) new MailTransportRouter().requireImap(account);
    if (!this.deltaScheduler)
      throw new Error("Delta sync scheduler is unavailable.");
    return this.deltaScheduler.schedule(accountId, mailboxId, "manual");
  }

  async requestRecentSync(
    accountId: string,
    mailboxId: string,
  ): Promise<boolean> {
    const mailbox = await this.ownedMailbox(accountId, mailboxId);
    if (!mailbox.selectable || mailbox.lifecycleStatus !== "active")
      throw new MailboxNotSynchronizableError();
    const [account] = await this.database
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId))
      .limit(1);
    if (!account?.enabled)
      throw new MailboxNotSynchronizableError(
        "Disabled mail accounts cannot synchronize messages.",
      );
    if (account) new MailTransportRouter().requireImap(account);
    if (!this.scheduler)
      throw new Error("Recent sync scheduler is unavailable.");
    const now = new Date();
    try {
      const scheduled = await this.scheduler.schedule(accountId, mailboxId);
      await this.database
        .update(mailboxes)
        .set({
          recentSyncStatus: "pending",
          recentSyncError: null,
          recentSyncRequestedAt: now,
          updatedAt: now,
        })
        .where(eq(mailboxes.id, mailboxId));
      return scheduled;
    } catch (error) {
      if (error instanceof StaleAccountWorkError) throw error;
      await this.database
        .update(mailboxes)
        .set({
          recentSyncStatus: "failed",
          recentSyncError:
            "Recent message synchronization could not be scheduled.",
          updatedAt: now,
        })
        .where(eq(mailboxes.id, mailboxId));
      throw error;
    }
  }

  async runRecentSync(
    accountId: string,
    mailboxId: string,
    expectedRevision?: string,
  ): Promise<void> {
    if (!this.accounts || !this.provider || !this.config)
      throw new Error("Recent sync worker dependencies are unavailable.");
    const startedAt = new Date();
    try {
      const mailbox = await this.ownedMailbox(accountId, mailboxId);
      if (!mailbox.selectable || mailbox.lifecycleStatus !== "active")
        throw new MailboxNotSynchronizableError();
      await this.database
        .update(mailboxes)
        .set({
          recentSyncStatus: "running",
          recentSyncError: null,
          recentSyncStartedAt: startedAt,
          updatedAt: startedAt,
        })
        .where(eq(mailboxes.id, mailboxId));
      const account = await this.accounts.getProviderImapAccountForWork(
        accountId,
        expectedRevision,
      );
      const cutoff = cutoffDate(this.config.initialSyncDays, startedAt);
      let selectedUidValidity: bigint | undefined;
      const result = await this.provider.synchronizeRecentMailbox(
        account,
        {
          remotePath: mailbox.remotePath,
          cutoff,
          batchSize: this.config.messageFetchBatchSize,
        },
        {
          selected: async (value) => {
            const observed = BigInt(value);
            await this.database.transaction(async (tx) => {
              await assertImapPublication(tx, accountId, account.revision);
              const [current] = await tx
                .select()
                .from(mailboxes)
                .where(eq(mailboxes.id, mailboxId))
                .limit(1);
              if (!current || current.accountId !== accountId)
                throw new MailboxNotFoundError();
              if (
                current.recentSyncUidValidity !== null &&
                current.recentSyncUidValidity !== observed
              ) {
                await tx
                  .delete(mailboxMessages)
                  .where(eq(mailboxMessages.mailboxId, mailboxId));
              }
              const changed =
                current.recentSyncUidValidity !== null &&
                current.recentSyncUidValidity !== observed;
              await tx
                .update(mailboxes)
                .set({
                  uidValidity: observed,
                  recentSyncUidValidity: observed,
                  ...(changed
                    ? {
                        deltaUidValidity: null,
                        deltaLastSeenUid: null,
                        deltaHighestModseq: null,
                        deltaSyncStatus: "not_started",
                        deltaSyncError: null,
                        backfillUidValidity: null,
                        backfillFrontierUid: null,
                        backfillStatus: "not_started",
                        backfillError: null,
                        backfillCompletedAt: null,
                      }
                    : {}),
                  ...(changed
                    ? {
                        uidValidityChangedAt: new Date(),
                        uidValidityChangeCount:
                          current.uidValidityChangeCount + 1,
                      }
                    : {}),
                  updatedAt: new Date(),
                })
                .where(eq(mailboxes.id, mailboxId));
            });
            selectedUidValidity = observed;
          },
          batch: async (batch) => {
            if (selectedUidValidity === undefined)
              throw new Error("Mailbox UIDVALIDITY was not selected.");
            await this.persistBatch(
              accountId,
              mailboxId,
              selectedUidValidity,
              batch,
              undefined,
              undefined,
              false,
              account.revision,
            );
          },
        },
      );
      const completedAt = new Date();
      await this.database.transaction(async (tx) => {
        await assertImapPublication(tx, accountId, account.revision);
        await tx
          .update(mailboxes)
          .set({
            recentSyncStatus: "success",
            recentSyncError: null,
            recentSyncCutoff: cutoff,
            recentSyncMessageCount: result.messageCount,
            recentSyncCompletedAt: completedAt,
            lastSuccessfulRecentSyncAt: completedAt,
            backfillStatus:
              mailbox.backfillUidValidity === BigInt(result.uidValidity) &&
              mailbox.backfillStatus === "complete"
                ? "complete"
                : "pending",
            updatedAt: completedAt,
          })
          .where(eq(mailboxes.id, mailboxId));
      });
      await this.events?.record("mail.recent_sync_completed", {
        accountId,
        mailboxId,
        details: { mailboxPath: mailbox.remotePath },
      });
      if (this.backfillScheduler)
        await this.backfillScheduler.schedule(accountId, mailboxId);
    } catch (error) {
      if (error instanceof StaleAccountWorkError) throw error;
      const failedAt = new Date();
      await this.database
        .update(mailboxes)
        .set({
          recentSyncStatus: "failed",
          recentSyncError: sanitizedSyncError(error),
          recentSyncCompletedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(
          and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
        );
      await this.events?.record("mail.recent_sync_failed", {
        accountId,
        mailboxId,
        details: {
          category:
            error instanceof MailProviderOperationError
              ? error.category
              : "internal_error",
        },
      });
      throw error;
    }
  }

  async persistBatch(
    accountId: string,
    mailboxId: string,
    uidValidity: bigint,
    batch: readonly RemoteMessageMetadata[],
    throughUid?: bigint,
    backfillProgress?: { frontier: bigint; nextFrontier: bigint },
    deltaArrival = false,
    revision?: string,
  ): Promise<void> {
    if (batch.length === 0 && !backfillProgress) return;
    await this.database.transaction(async (tx) => {
      // Offline metadata projection is also used by local maintenance. Receive
      // workers always pass their captured account revision.
      if (revision !== undefined)
        await assertImapPublication(tx, accountId, revision);
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(
          and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
        )
        .for("update");
      if (!mailbox) throw new MailboxNotFoundError();
      const publishArrival =
        deltaArrival &&
        !backfillProgress &&
        mailbox.recentSyncStatus === "success" &&
        mailbox.recentSyncUidValidity === uidValidity &&
        mailbox.deltaUidValidity === uidValidity;
      const synchronizedAt = new Date();
      for (const remote of batch) {
        const uid = BigInt(remote.uid);
        const [placement] = await tx
          .select()
          .from(mailboxMessages)
          .where(
            and(
              eq(mailboxMessages.mailboxId, mailboxId),
              eq(mailboxMessages.uidValidity, uidValidity),
              eq(mailboxMessages.uid, uid),
            ),
          )
          .limit(1);
        if (placement) {
          const staleFlags =
            remote.modseq !== undefined &&
            placement.modseq !== null &&
            BigInt(remote.modseq) < placement.modseq;
          await tx
            .update(mailboxMessages)
            .set({
              ...(staleFlags
                ? {}
                : {
                    flags: [...remote.flags],
                    modseq: remote.modseq ? BigInt(remote.modseq) : null,
                  }),
              lastSynchronizedAt: synchronizedAt,
              updatedAt: synchronizedAt,
            })
            .where(eq(mailboxMessages.id, placement.id));
          await tx
            .update(messages)
            .set(messageValues(accountId, remote, synchronizedAt))
            .where(eq(messages.id, placement.messageId));
          await persistAttachmentMetadata(
            tx,
            placement.messageId,
            accountId,
            mailboxId,
            uidValidity,
            uid,
            remote.mimeStructure,
          );
          continue;
        }
        const messageId = randomUUID();
        await tx.insert(messages).values({
          id: messageId,
          ...messageValues(accountId, remote, synchronizedAt),
          createdAt: synchronizedAt,
        });
        await persistAttachmentMetadata(
          tx,
          messageId,
          accountId,
          mailboxId,
          uidValidity,
          uid,
          remote.mimeStructure,
        );
        await tx.insert(mailboxMessages).values({
          accountId,
          id: randomUUID(),
          mailboxId,
          messageId,
          uidValidity,
          uid,
          modseq: remote.modseq ? BigInt(remote.modseq) : null,
          flags: [...remote.flags],
          firstSynchronizedAt: synchronizedAt,
          lastSynchronizedAt: synchronizedAt,
          createdAt: synchronizedAt,
          updatedAt: synchronizedAt,
        });
        if (publishArrival) {
          // Known command destinations use UID/epoch. Servers without COPYUID
          // (including uncertain outcomes) use the source's metadata identity.
          const [command] = await tx
            .select({ id: messageCommands.id })
            .from(messageCommands)
            .innerJoin(messages, eq(messages.id, messageCommands.messageId))
            .where(
              and(
                eq(messageCommands.accountId, accountId),
                eq(messages.accountId, accountId),
                eq(messageCommands.destinationMailboxId, mailboxId),
                sql`${messageCommands.startedAt} is not null`,
                or(
                  and(
                    eq(messageCommands.destinationUidValidity, uidValidity),
                    eq(messageCommands.destinationUid, uid),
                  ),
                  and(
                    sql`${messageCommands.destinationUid} is null`,
                    or(
                      remote.providerEmailId
                        ? eq(messages.providerMessageId, remote.providerEmailId)
                        : sql`false`,
                      remote.envelope.messageId
                        ? eq(messages.rfcMessageId, remote.envelope.messageId)
                        : sql`false`,
                      and(
                        sql`${messages.providerMessageId} is null`,
                        sql`${messages.rfcMessageId} is null`,
                        eq(
                          messages.internalDate,
                          new Date(remote.internalDate),
                        ),
                        eq(messages.size, BigInt(remote.size)),
                        sql`${messages.subject} is not distinct from ${remote.envelope.subject ?? null}`,
                        sql`${messages.from} = ${JSON.stringify(remote.envelope.from)}::jsonb`,
                      ),
                    ),
                  ),
                ),
              ),
            )
            .limit(1);
          const [outgoing] = await tx
            .select({ id: outgoingMessages.id })
            .from(outgoingMessages)
            .where(
              and(
                eq(outgoingMessages.accountId, accountId),
                or(
                  remote.envelope.messageId
                    ? eq(outgoingMessages.messageId, remote.envelope.messageId)
                    : sql`false`,
                  and(
                    eq(outgoingMessages.sentCopyMailboxId, mailboxId),
                    eq(outgoingMessages.sentCopyUidValidity, uidValidity),
                    eq(outgoingMessages.sentCopyUid, uid),
                  ),
                ),
              ),
            )
            .limit(1);
          if (!command && !outgoing) {
            await tx
              .insert(instanceState)
              .values({ id: 1 })
              .onConflictDoNothing();
            const [state] = await tx
              .update(instanceState)
              .set({
                notificationSequence: sql`${instanceState.notificationSequence} + 1`,
              })
              .where(eq(instanceState.id, 1))
              .returning({ sequence: instanceState.notificationSequence });
            const sender = remote.envelope.from[0] ?? remote.envelope.sender[0];
            await tx
              .insert(notificationEvents)
              .values({
                sequence: state.sequence,
                accountId,
                mailboxId,
                messageId,
                uidValidity,
                uid,
                sender: (
                  sender?.name ||
                  sender?.address ||
                  "Unknown sender"
                ).slice(0, 256),
                subject: (remote.envelope.subject ?? "(No subject)").slice(
                  0,
                  512,
                ),
                createdAt: synchronizedAt,
              })
              .onConflictDoNothing();
            await tx
              .delete(notificationEvents)
              .where(
                lt(
                  notificationEvents.createdAt,
                  sql`now() - interval '7 days'`,
                ),
              );
          }
        }
      }
      if (throughUid !== undefined)
        await tx
          .update(mailboxes)
          .set({ deltaLastSeenUid: throughUid, updatedAt: synchronizedAt })
          .where(
            and(
              eq(mailboxes.id, mailboxId),
              eq(mailboxes.deltaUidValidity, uidValidity),
            ),
          );
      if (backfillProgress) {
        const advanced = await tx
          .update(mailboxes)
          .set({
            backfillFrontierUid: backfillProgress.nextFrontier,
            backfillStatus:
              backfillProgress.nextFrontier === 0n ? "complete" : "pending",
            backfillCompletedAt:
              backfillProgress.nextFrontier === 0n ? synchronizedAt : null,
            backfillError: null,
            updatedAt: synchronizedAt,
          })
          .where(
            and(
              eq(mailboxes.id, mailboxId),
              eq(mailboxes.backfillUidValidity, uidValidity),
              eq(mailboxes.backfillFrontierUid, backfillProgress.frontier),
              eq(mailboxes.recentSyncUidValidity, uidValidity),
            ),
          )
          .returning({ id: mailboxes.id });
        if (advanced.length !== 1)
          throw new Error(
            "Historical mailbox checkpoint changed during persistence.",
          );
      }
    });
  }

  async list(
    accountId: string,
    mailboxId: string,
    pageSize = 50,
    cursor?: string,
  ): Promise<MessagePage> {
    await this.ownedMailbox(accountId, mailboxId);
    const conversations = new ConversationService(this.database);
    if (await conversations.enabled())
      return conversations.list(accountId, mailboxId, pageSize, cursor);
    const limit = Math.min(Math.max(pageSize, 1), 100);
    const cursorValue = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.database
      .select({
        message: {
          id: messages.id,
          subject: messages.subject,
          from: messages.from,
          internalDate: messages.internalDate,
          size: messages.size,
          hasAttachments: messages.hasAttachments,
          snippet: sql<string | null>`left(${messageContents.plainText}, 160)`,
        },
        placement: mailboxMessages,
      })
      .from(mailboxMessages)
      .innerJoin(messages, eq(messages.id, mailboxMessages.messageId))
      .leftJoin(
        messageContents,
        and(
          eq(messageContents.messageId, messages.id),
          eq(messageContents.status, "ready"),
        ),
      )
      .where(
        and(
          eq(mailboxMessages.mailboxId, mailboxId),
          eq(messages.accountId, accountId),
          eq(mailboxMessages.actionHidden, false),
          cursorValue
            ? or(
                lt(messages.internalDate, cursorValue[0]),
                and(
                  eq(messages.internalDate, cursorValue[0]),
                  lt(messages.id, cursorValue[1]),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(messages.internalDate), desc(messages.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ message, placement }) => ({
        id: message.id,
        subject: message.subject,
        from: message.from,
        date: message.internalDate.toISOString(),
        seen: placement.flags.includes("\\Seen"),
        flagged: placement.flags.includes("\\Flagged"),
        size: message.size.toString(),
        hasAttachments: message.hasAttachments,
        snippet: message.snippet,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.message.internalDate, last.message.id)
          : null,
    };
  }

  async listAllInboxes(pageSize = 50, cursor?: string): Promise<MessagePage> {
    const conversations = new ConversationService(this.database);
    if (await conversations.enabled())
      return conversations.list("", "", pageSize, cursor, true);
    const limit = Math.min(Math.max(pageSize, 1), 100);
    let after: [Date, string] | undefined;
    try {
      after = cursor ? decodeCursor(cursor) : undefined;
      if (after && !/^[0-9a-f-]{36}$/i.test(after[1])) throw Error();
    } catch {
      throw Error("Invalid cursor.");
    }
    const rows = await this.database.execute(sql`
      SELECT m.*, a.display_name AS account_name, p.mailbox_id, p.flags, left(c.plain_text, 160) AS snippet
      FROM messages m JOIN mailbox_messages p ON p.message_id = m.id
      JOIN mailboxes b ON b.id = p.mailbox_id AND b.account_id = m.account_id
      JOIN mail_accounts a ON a.id = m.account_id
      LEFT JOIN message_contents c ON c.message_id = m.id AND c.status = 'ready'
      WHERE a.enabled AND b.selectable AND b.lifecycle_status = 'active'
        AND upper(b.remote_path) = 'INBOX' AND NOT p.action_hidden
        ${after ? sql`AND (m.internal_date, m.id) < (${after[0].toISOString()}::timestamptz, ${after[1]}::uuid)` : sql``}
      ORDER BY m.internal_date DESC, m.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: String(r.id),
        accountId: String(r.account_id),
        accountName: String(r.account_name),
        mailboxId: String(r.mailbox_id),
        subject: r.subject as string | null,
        from: r.from as MessageListItem["from"],
        date: new Date(r.internal_date as string).toISOString(),
        seen: (r.flags as string[]).includes("\\Seen"),
        flagged: (r.flags as string[]).includes("\\Flagged"),
        size: String(r.size),
        hasAttachments: Boolean(r.has_attachments),
        snippet: r.snippet as string | null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(
              new Date(last.internal_date as string),
              String(last.id),
            )
          : null,
    };
  }

  private async ownedMailbox(accountId: string, mailboxId: string) {
    const [mailbox] = await this.database
      .select()
      .from(mailboxes)
      .where(
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
      )
      .limit(1);
    if (!mailbox) throw new MailboxNotFoundError();
    return mailbox;
  }
}
