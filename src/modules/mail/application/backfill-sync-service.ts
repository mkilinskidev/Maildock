import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";

import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
  type MailProvider,
} from "../../accounts/domain/mail-provider";
import type { Database } from "../../../shared/infrastructure/database/database";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import type { MessageService } from "./message-service";

/**
 * UIDs per committed history sub-batch inside one job range (default 500).
 * Below the fresh FETCH batch (MAILDOCK_MESSAGE_FETCH_BATCH_SIZE, default 150),
 * so a yielding backfill holds the mailbox lock for at most one FETCH of this
 * size plus one transaction after urgent work appears.
 */
export const BACKFILL_SUB_BATCH_UIDS = 100;

/**
 * - completed: the frontier reached 0 (history complete);
 * - progressed: the job range was fully committed, frontier > 0 remains;
 * - yielded: at least one sub-batch committed, then the caller asked to stop;
 * - ineligible: nothing to do (disabled, not ready, complete, epoch reset).
 * A failure throws; yielding is never a failure.
 */
export type BackfillRunResult =
  | Readonly<{ outcome: "completed" | "ineligible" }>
  | Readonly<{ outcome: "progressed" | "yielded"; frontier: string }>;

export class BackfillSyncService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly provider: MailProvider,
    private readonly messages: MessageService,
    private readonly chunkSize: number,
    private readonly logger?: Logger,
    private readonly subBatchSize = BACKFILL_SUB_BATCH_UIDS,
  ) {}

  /**
   * shouldYield is asked only between committed sub-batches. It must not
   * throw: an unreadable signal is reported as true by the caller.
   */
  async run(
    accountId: string,
    mailboxId: string,
    shouldYield?: () => Promise<boolean>,
  ): Promise<BackfillRunResult> {
    const [row] = await this.database
      .select({ mailbox: mailboxes, enabled: mailAccounts.enabled })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .where(
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
      )
      .limit(1);
    if (
      !row ||
      !row.enabled ||
      !row.mailbox.selectable ||
      row.mailbox.lifecycleStatus !== "active" ||
      row.mailbox.recentSyncStatus !== "success" ||
      row.mailbox.recentSyncUidValidity === null
    )
      return { outcome: "ineligible" };
    const mailbox = row.mailbox;
    if (
      mailbox.backfillUidValidity === mailbox.recentSyncUidValidity &&
      mailbox.backfillStatus === "complete"
    )
      return { outcome: "ineligible" };
    if (!this.provider.synchronizeBackfillMailbox)
      throw new Error("Backfill provider is unavailable.");
    let frontier: bigint | undefined;
    let yielded = false;
    let boundary = performance.now();
    const epoch = mailbox.recentSyncUidValidity!;
    try {
      const account =
        await this.accounts.getProviderImapAccountForWork(accountId);
      await this.provider.synchronizeBackfillMailbox(
        account,
        {
          remotePath: mailbox.remotePath,
          frontier:
            mailbox.backfillUidValidity === epoch
              ? (mailbox.backfillFrontierUid?.toString() ?? null)
              : null,
          chunkSize: this.chunkSize,
          subBatchSize: this.subBatchSize,
        },
        {
          selected: async (observed, initialFrontier) => {
            if (BigInt(observed) !== epoch)
              throw new MailboxEpochChangedError();
            frontier = BigInt(initialFrontier);
            await this.database
              .update(mailboxes)
              .set({
                backfillUidValidity: epoch,
                backfillFrontierUid: frontier,
                backfillStatus: "running",
                backfillError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(mailboxes.id, mailboxId),
                  eq(mailboxes.recentSyncUidValidity, epoch),
                ),
              );
            boundary = performance.now();
          },
          chunk: async (batch, nextFrontier) => {
            if (frontier === undefined)
              throw new Error("Mailbox epoch was not selected.");
            // One atomic transaction: messages plus CAS frontier -> next.
            await this.messages.persistBatch(
              accountId,
              mailboxId,
              epoch,
              batch,
              undefined,
              {
                frontier,
                nextFrontier: BigInt(nextFrontier),
              },
            );
            const before = frontier;
            frontier = BigInt(nextFrontier);
            const now = performance.now();
            // Counts and UID bounds only: no message UIDs, names or account data.
            const durationMs = Math.round(now - boundary);
            bestEffortDiagnostic(() =>
              this.logger?.debug(
                {
                  event: "mail.backfill_sub_batch_committed",
                  frontierBefore: before.toString(),
                  frontierAfter: nextFrontier,
                  messages: batch.length,
                  durationMs,
                },
                "History sub-batch committed",
              ),
            );
            boundary = now;
          },
          shouldYield: async () => {
            yielded = shouldYield ? await shouldYield() : false;
            return yielded;
          },
        },
      );
      if (frontier === undefined) return { outcome: "ineligible" };
      if (frontier === 0n) return { outcome: "completed" };
      return {
        outcome: yielded ? "yielded" : "progressed",
        frontier: frontier.toString(),
      };
    } catch (error) {
      if (error instanceof MailboxEpochChangedError) {
        await this.database
          .update(mailboxes)
          .set({
            backfillUidValidity: null,
            backfillFrontierUid: null,
            backfillStatus: "not_started",
            backfillError: null,
            updatedAt: new Date(),
          })
          .where(eq(mailboxes.id, mailboxId));
        await this.messages.requestRecentSync(accountId, mailboxId);
        return { outcome: "ineligible" };
      }
      await this.database
        .update(mailboxes)
        .set({
          backfillStatus: "failed",
          backfillError:
            error instanceof MailProviderOperationError
              ? error.message
              : "Historical message synchronization failed.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.backfillUidValidity, epoch),
          ),
        );
      throw error;
    }
  }
}
