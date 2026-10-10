import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
  type MailProvider,
} from "../../accounts/domain/mail-provider";
import { StaleAccountWorkError } from "../../accounts/domain/receive-transport";
import type {
  ImapSliceLimits,
  ImapSyncProgress,
} from "../../accounts/domain/imap-sync-slice";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailboxes,
  mailAccounts,
  mailboxMessages,
} from "../../../shared/infrastructure/database/schema";
import { assertImapPublication } from "../infrastructure/receive-publication-fence";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";
import type { MessageService } from "./message-service";
import type { ApplicationEventService } from "../../diagnostics/application/application-event-service";

/** One delivery owns one slice. Progress follows persistence; replay is idempotent. */
export class ImapSliceSyncService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly provider: MailProvider,
    private readonly messages: MessageService,
    private readonly limits: ImapSliceLimits,
    private readonly initialDays: number,
    private readonly logger?: Pick<Logger, "debug">,
    private readonly events?: ApplicationEventService,
  ) {}

  async run(
    accountId: string,
    mailboxId: string,
    phase: "recent" | "delta",
    revision?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const [mailbox] = await this.database
      .select()
      .from(mailboxes)
      .where(
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
      )
      .limit(1);
    const [enabled] = await this.database
      .select({ enabled: mailAccounts.enabled })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId))
      .limit(1);
    if (
      !mailbox ||
      !enabled?.enabled ||
      mailbox.receiveTransport !== "imap" ||
      !mailbox.selectable ||
      mailbox.lifecycleStatus !== "active" ||
      (phase === "delta" && mailbox.recentSyncStatus !== "success")
    )
      return false;
    if (
      phase === "recent" &&
      mailbox.recentSyncStatus === "success" &&
      !mailbox.imapRecentProgress
    )
      return false;
    const account = await this.accounts.getProviderImapAccountForWork(
      accountId,
      revision,
    );
    const started = Date.now();
    let processed = 0;
    let saved: ImapSyncProgress | undefined;
    const progressValues = (value: ImapSyncProgress | null) =>
      phase === "recent"
        ? { imapRecentProgress: value }
        : { imapDeltaProgress: value };
    const diagnostic = (event: string, extra: object = {}) =>
      bestEffortDiagnostic(() =>
        this.logger?.debug(
          { event, accountId, mailboxId, phase, ...extra },
          "IMAP synchronization slice",
        ),
      );
    const check = () => signal?.throwIfAborted();
    diagnostic("mail.imap_slice_started");
    const write = async (value: ImapSyncProgress) => {
      check();
      await this.database.transaction(async (tx) => {
        await assertImapPublication(tx, accountId, account.revision);
        const updated = await tx
          .update(mailboxes)
          .set({
            ...progressValues(value),
            ...(phase === "recent"
              ? { recentSyncStatus: "running" as const, recentSyncError: null }
              : {
                  deltaSyncStatus: "running" as const,
                  deltaSyncError: null,
                  deltaUidValidity: BigInt(value.uidValidity),
                  deltaLastSeenUid: BigInt(value.cursor),
                }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mailboxes.id, mailboxId),
              eq(mailboxes.recentSyncUidValidity, BigInt(value.uidValidity)),
            ),
          )
          .returning({ id: mailboxes.id });
        if (!updated.length) throw new MailboxEpochChangedError();
      });
      saved = value;
    };
    try {
      check();
      const more = await this.provider.synchronizeMailboxSlice!(
        account,
        mailbox.remotePath,
        phase,
        this.limits,
        {
          selected: async (epoch, frontier, modseq) => {
            check();
            let value: ImapSyncProgress | undefined;
            let reset = false;
            await this.database.transaction(async (tx) => {
              await assertImapPublication(tx, accountId, account.revision);
              const [current] = await tx
                .select()
                .from(mailboxes)
                .where(eq(mailboxes.id, mailboxId))
                .for("update");
              if (!current) throw new StaleAccountWorkError();
              const observed = BigInt(epoch);
              reset =
                (current.recentSyncUidValidity !== null &&
                  current.recentSyncUidValidity !== observed) ||
                (current.deltaUidValidity !== null &&
                  current.deltaUidValidity !== observed);
              if (reset) {
                await tx
                  .delete(mailboxMessages)
                  .where(eq(mailboxMessages.mailboxId, mailboxId));
                await tx
                  .update(mailboxes)
                  .set({
                    uidValidity: observed,
                    recentSyncUidValidity: observed,
                    recentSyncStatus: "not_started",
                    recentSyncCutoff: null,
                    recentSyncMessageCount: 0,
                    imapRecentProgress: null,
                    imapDeltaProgress: null,
                    deltaUidValidity: null,
                    deltaLastSeenUid: null,
                    deltaHighestModseq: null,
                    deltaSyncStatus: "not_started",
                    backfillUidValidity: null,
                    backfillFrontierUid: null,
                    backfillStatus: "not_started",
                    backfillCompletedAt: null,
                    uidValidityChangedAt: new Date(),
                    uidValidityChangeCount: sql`${mailboxes.uidValidityChangeCount} + 1`,
                    updatedAt: new Date(),
                  })
                  .where(eq(mailboxes.id, mailboxId));
              }
              if (reset && phase === "delta") return;
              const resume = reset
                ? null
                : current[
                    phase === "recent"
                      ? "imapRecentProgress"
                      : "imapDeltaProgress"
                  ];
              if (
                resume &&
                resume.revision === account.revision &&
                resume.uidValidity === epoch
              ) {
                value = resume;
              } else {
                const [local] = await tx
                  .select({ uid: mailboxMessages.uid })
                  .from(mailboxMessages)
                  .where(
                    and(
                      eq(mailboxMessages.mailboxId, mailboxId),
                      eq(mailboxMessages.uidValidity, observed),
                    ),
                  )
                  .orderBy(desc(mailboxMessages.uid))
                  .limit(1);
                const cutoff = new Date();
                cutoff.setUTCDate(cutoff.getUTCDate() - this.initialDays);
                cutoff.setUTCHours(0, 0, 0, 0);
                const empty =
                  phase === "delta" &&
                  current.deltaUidValidity === null &&
                  current.recentSyncMessageCount === 0;
                if (empty && !current.recentSyncCutoff)
                  throw new Error("Recent cutoff unavailable.");
                value = {
                  revision: account.revision!,
                  uidValidity: epoch,
                  frontier,
                  cursor:
                    phase === "recent" || empty
                      ? "0"
                      : (current.deltaLastSeenUid?.toString() ??
                        local?.uid?.toString() ??
                        "0"),
                  phase: "messages",
                  localCursor: "0",
                  highestModseq: modseq,
                  messageCount: 0,
                  cutoff:
                    phase === "recent"
                      ? cutoff.toISOString()
                      : empty
                        ? current.recentSyncCutoff!.toISOString()
                        : null,
                };
                // No moving UIDNEXT or MODSEQ after this initial, durable horizon.
              }
              await tx
                .update(mailboxes)
                .set({
                  uidValidity: observed,
                  recentSyncUidValidity: observed,
                  ...progressValues(value!),
                  ...(phase === "recent"
                    ? {
                        recentSyncStartedAt: new Date(),
                        recentSyncStatus: "running" as const,
                        recentSyncError: null,
                      }
                    : {
                        deltaSyncStartedAt: new Date(),
                        deltaUidValidity: observed,
                        deltaSyncStatus: "running" as const,
                        deltaSyncError: null,
                      }),
                  updatedAt: new Date(),
                })
                .where(eq(mailboxes.id, mailboxId));
            });
            if (reset && phase === "delta")
              throw new MailboxEpochChangedError();
            saved = value!;
            diagnostic("mail.imap_slice_resumed", {
              cursor: value!.cursor,
              localCursor: value!.localCursor,
              frontier: value!.frontier,
              recoveryReason: reset ? "uidvalidity_reset" : "durable_progress",
            });
            return value!;
          },
          messages: async (batch) => {
            check();
            await this.messages.persistBatch(
              accountId,
              mailboxId,
              BigInt(saved!.uidValidity),
              batch,
              undefined,
              undefined,
              phase === "delta" && saved!.cutoff === null,
              account.revision,
            );
            processed += batch.length;
          },
          localUids: async (after, through, limit) => {
            const rows = await this.database
              .select({ uid: mailboxMessages.uid })
              .from(mailboxMessages)
              .where(
                and(
                  eq(mailboxMessages.mailboxId, mailboxId),
                  eq(mailboxMessages.uidValidity, BigInt(saved!.uidValidity)),
                  gt(mailboxMessages.uid, BigInt(after)),
                  lte(mailboxMessages.uid, BigInt(through)),
                ),
              )
              .orderBy(mailboxMessages.uid)
              .limit(limit);
            return rows.map((row) => row.uid!.toString());
          },
          flags: async (batch) => {
            check();
            await this.database.transaction(async (tx) => {
              await assertImapPublication(tx, accountId, account.revision);
              for (const item of batch)
                await tx
                  .update(mailboxMessages)
                  .set({
                    flags: [...item.flags],
                    modseq: item.modseq ? BigInt(item.modseq) : null,
                    lastSynchronizedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(mailboxMessages.mailboxId, mailboxId),
                      eq(
                        mailboxMessages.uidValidity,
                        BigInt(saved!.uidValidity),
                      ),
                      eq(mailboxMessages.uid, BigInt(item.uid)),
                      item.modseq
                        ? sql`(${mailboxMessages.modseq} is null or ${mailboxMessages.modseq} <= ${BigInt(item.modseq)})`
                        : undefined,
                    ),
                  );
            });
            processed += batch.length;
          },
          removed: async (uids) => {
            if (!uids.length) return;
            check();
            await this.database.transaction(async (tx) => {
              await assertImapPublication(tx, accountId, account.revision);
              const [current] = await tx
                .select({ epoch: mailboxes.recentSyncUidValidity })
                .from(mailboxes)
                .where(eq(mailboxes.id, mailboxId))
                .for("update");
              if (current?.epoch !== BigInt(saved!.uidValidity))
                throw new MailboxEpochChangedError();
              await tx
                .delete(mailboxMessages)
                .where(
                  and(
                    eq(mailboxMessages.mailboxId, mailboxId),
                    eq(mailboxMessages.uidValidity, BigInt(saved!.uidValidity)),
                    inArray(mailboxMessages.uid, uids.map(BigInt)),
                  ),
                );
            });
            processed += uids.length;
          },
          checkpoint: write,
          completed: async (value, observation) => {
            check();
            await this.database.transaction(async (tx) => {
              await assertImapPublication(tx, accountId, account.revision);
              const now = new Date();
              const updated = await tx
                .update(mailboxes)
                .set({
                  ...progressValues(null),
                  ...(phase === "recent"
                    ? {
                        recentSyncStatus: "success" as const,
                        recentSyncError: null,
                        recentSyncCutoff: new Date(value.cutoff!),
                        recentSyncMessageCount: value.messageCount,
                        recentSyncCompletedAt: now,
                        lastSuccessfulRecentSyncAt: now,
                        backfillStatus:
                          mailbox.backfillUidValidity ===
                            BigInt(value.uidValidity) &&
                          mailbox.backfillStatus === "complete"
                            ? ("complete" as const)
                            : ("pending" as const),
                      }
                    : {
                        uidNext: BigInt(observation.uidNext),
                        reportedMessageCount: BigInt(observation.messageCount),
                        reportedUnseenCount: BigInt(observation.unseenCount),
                        deltaUidValidity: BigInt(value.uidValidity),
                        deltaLastSeenUid: BigInt(value.cursor),
                        deltaHighestModseq: value.highestModseq
                          ? BigInt(value.highestModseq)
                          : null,
                        highestModseq: value.highestModseq
                          ? BigInt(value.highestModseq)
                          : null,
                        deltaSyncStatus: "success" as const,
                        deltaSyncError: null,
                        deltaSyncCompletedAt: now,
                        lastSuccessfulDeltaSyncAt: now,
                      }),
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(mailboxes.id, mailboxId),
                    eq(
                      mailboxes.recentSyncUidValidity,
                      BigInt(value.uidValidity),
                    ),
                  ),
                )
                .returning({ id: mailboxes.id });
              if (!updated.length) throw new MailboxEpochChangedError();
            });
            saved = value;
            if (phase === "recent")
              await this.events?.record("mail.recent_sync_completed", {
                accountId,
                mailboxId,
                details: { mailboxPath: mailbox.remotePath },
              });
          },
        },
        signal,
      );
      diagnostic("mail.imap_slice_completed", {
        messagesProcessed: processed,
        durationMs: Date.now() - started,
        continuationReason: more ? "bounded_work" : "complete",
        cursor: saved?.cursor,
        localCursor: saved?.localCursor,
        frontier: saved?.frontier,
      });
      return more;
    } catch (error) {
      diagnostic("mail.imap_slice_recovery", {
        messagesProcessed: processed,
        durationMs: Date.now() - started,
        recoveryReason:
          error instanceof MailboxEpochChangedError
            ? "uidvalidity_reset"
            : signal?.aborted
              ? "cancellation"
              : "retry",
      });
      if (error instanceof MailboxEpochChangedError) {
        // A STATUS epoch change also requires fresh recent authority on retry.
        await this.database.transaction(async (tx) => {
          await assertImapPublication(tx, accountId, account.revision);
          await tx
            .update(mailboxes)
            .set({
              imapRecentProgress: null,
              imapDeltaProgress: null,
              recentSyncStatus: "not_started",
              deltaSyncStatus: "not_started",
              updatedAt: new Date(),
            })
            .where(eq(mailboxes.id, mailboxId));
        });
        if (phase === "delta") {
          await this.messages.requestRecentSync(accountId, mailboxId);
          return false;
        }
      }
      if (
        !(error instanceof StaleAccountWorkError) &&
        !(error instanceof MailboxEpochChangedError) &&
        !signal?.aborted
      ) {
        const failure =
          error instanceof MailProviderOperationError
            ? error.message
            : "IMAP synchronization failed.";
        await this.database.transaction(async (tx) => {
          await assertImapPublication(tx, accountId, account.revision);
          await tx
            .update(mailboxes)
            .set(
              phase === "recent"
                ? {
                    recentSyncStatus: "failed",
                    recentSyncError: failure,
                    updatedAt: new Date(),
                  }
                : {
                    deltaSyncStatus: "failed",
                    deltaSyncError: failure,
                    updatedAt: new Date(),
                  },
            )
            .where(eq(mailboxes.id, mailboxId));
        });
      }
      throw error;
    }
  }
}
