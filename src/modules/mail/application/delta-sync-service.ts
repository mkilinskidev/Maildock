import {
  withPerformance,
  measureStage,
} from "../../../shared/infrastructure/logging/performance";
import type { ApplicationEventService } from "../../diagnostics/application/application-event-service";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";

import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
  type MailProvider,
  type RemoteFlagDelta,
  type RemoteMessageMetadata,
} from "../../accounts/domain/mail-provider";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailboxMessages,
  mailboxes,
  mailAccounts,
} from "../../../shared/infrastructure/database/schema";
import type { MessageService } from "./message-service";

export type DeltaReason = "idle" | "poll" | "manual" | "post-discovery";

export class DeltaSyncService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly provider: MailProvider,
    private readonly messages: MessageService,
    private readonly batchSize: number,
    private readonly logger?: Logger,
    private readonly events?: ApplicationEventService,
  ) {}

  async run(
    accountId: string,
    mailboxId: string,
    reason: DeltaReason,
  ): Promise<void> {
    return withPerformance("delta", () =>
      this.runImpl(accountId, mailboxId, reason),
    );
  }
  private async runImpl(
    accountId: string,
    mailboxId: string,
    reason: DeltaReason,
  ): Promise<void> {
    const [mailbox] = await this.database
      .select()
      .from(mailboxes)
      .where(
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
      )
      .limit(1);
    const [accountRow] = await this.database
      .select({
        enabled: mailAccounts.enabled,
      })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId))
      .limit(1);
    if (
      !mailbox ||
      !accountRow?.enabled ||
      !mailbox.selectable ||
      mailbox.lifecycleStatus !== "active" ||
      mailbox.recentSyncStatus !== "success"
    )
      return;
    const context = {
      accountId,
      mailboxId,
    };
    const startedAt = new Date();
    await this.database
      .update(mailboxes)
      .set({
        deltaSyncStatus: "running",
        deltaSyncError: null,
        deltaSyncStartedAt: startedAt,
        updatedAt: startedAt,
      })
      .where(eq(mailboxes.id, mailboxId));
    let epoch: bigint | undefined;
    let newCount = 0;
    let changedCount = 0;
    let removedCount = 0;
    let lastSeen = 0n;
    let emptyBootstrap = false;
    try {
      const account = await measureStage("credentials", () =>
        this.accounts.getProviderImapAccountForWork(accountId),
      );
      if (!this.provider.synchronizeDeltaMailbox)
        throw new Error("Delta provider is unavailable.");
      await this.provider.synchronizeDeltaMailbox(
        account,
        mailbox.remotePath,
        this.batchSize,
        {
          selected: async (value) => {
            epoch = BigInt(value);
            const [current] = await this.database
              .select()
              .from(mailboxes)
              .where(eq(mailboxes.id, mailboxId))
              .limit(1);
            if (
              !current ||
              current.recentSyncUidValidity !== epoch ||
              (current.deltaUidValidity !== null &&
                current.deltaUidValidity !== epoch)
            ) {
              await this.database.transaction(async (tx) => {
                await tx
                  .delete(mailboxMessages)
                  .where(eq(mailboxMessages.mailboxId, mailboxId));
                await tx
                  .update(mailboxes)
                  .set({
                    uidValidity: epoch,
                    recentSyncUidValidity: epoch,
                    recentSyncStatus: "not_started",
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
                    uidValidityChangedAt: new Date(),
                    uidValidityChangeCount: sql`${mailboxes.uidValidityChangeCount} + 1`,
                    updatedAt: new Date(),
                  })
                  .where(eq(mailboxes.id, mailboxId));
              });
              throw new MailboxEpochChangedError();
            }
            const selectedEpoch = epoch;
            const local = await this.database
              .select({ uid: mailboxMessages.uid })
              .from(mailboxMessages)
              .where(
                and(
                  eq(mailboxMessages.mailboxId, mailboxId),
                  eq(mailboxMessages.uidValidity, selectedEpoch),
                ),
              );
            emptyBootstrap =
              current.deltaUidValidity === null &&
              current.recentSyncMessageCount === 0;
            if (emptyBootstrap && !current.recentSyncCutoff)
              throw new Error("Recent-window cutoff is unavailable.");
            lastSeen =
              current.deltaLastSeenUid ??
              local.reduce((max, row) => (row.uid > max ? row.uid : max), 0n);
            if (current.deltaUidValidity === null && !emptyBootstrap) {
              await this.database
                .update(mailboxes)
                .set({
                  deltaUidValidity: epoch,
                  deltaLastSeenUid: lastSeen,
                  deltaHighestModseq: null,
                  updatedAt: new Date(),
                })
                .where(eq(mailboxes.id, mailboxId));
            }
            return {
              lastSeenUid: lastSeen.toString(),
              highestModseq:
                current.deltaUidValidity === epoch
                  ? (current.deltaHighestModseq?.toString() ?? null)
                  : null,
              localUids: local.map((row) => row.uid.toString()),
              ...(emptyBootstrap
                ? { emptyBootstrapCutoff: current.recentSyncCutoff! }
                : {}),
            };
          },
          advanceUid: async (uid) => {
            if (epoch === undefined)
              throw new Error("Mailbox epoch was not selected.");
            lastSeen = BigInt(uid);
            await this.database
              .update(mailboxes)
              .set({
                deltaUidValidity: epoch,
                deltaLastSeenUid: lastSeen,
                updatedAt: new Date(),
              })
              .where(eq(mailboxes.id, mailboxId));
            emptyBootstrap = false;
          },
          newBatch: async (
            batch: readonly RemoteMessageMetadata[],
            throughUid: string,
          ) => {
            if (epoch === undefined)
              throw new Error("Mailbox epoch was not selected.");
            const next = BigInt(throughUid);
            await this.messages.persistBatch(
              accountId,
              mailboxId,
              epoch,
              batch,
              emptyBootstrap ? undefined : next,
              undefined,
              !emptyBootstrap,
            );
            lastSeen = next;
            newCount += batch.length;
          },
          flagsBatch: async (changes: readonly RemoteFlagDelta[]) => {
            if (epoch === undefined)
              throw new Error("Mailbox epoch was not selected.");
            const currentEpoch = epoch;
            await this.database.transaction(async (tx) => {
              for (const change of changes) {
                const [existing] = await tx
                  .select({
                    id: mailboxMessages.id,
                    modseq: mailboxMessages.modseq,
                  })
                  .from(mailboxMessages)
                  .where(
                    and(
                      eq(mailboxMessages.mailboxId, mailboxId),
                      eq(mailboxMessages.uidValidity, currentEpoch),
                      eq(mailboxMessages.uid, BigInt(change.uid)),
                    ),
                  )
                  .limit(1);
                if (!existing) continue;
                if (
                  change.modseq &&
                  existing.modseq !== null &&
                  existing.modseq > BigInt(change.modseq)
                )
                  continue;
                await tx
                  .update(mailboxMessages)
                  .set({
                    flags: [...change.flags],
                    modseq: change.modseq ? BigInt(change.modseq) : null,
                    lastSynchronizedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(eq(mailboxMessages.id, existing.id));
                changedCount++;
              }
            });
          },
          removed: async (uids: readonly string[]) => {
            if (epoch === undefined || !uids.length) return;
            const gone = await this.database
              .delete(mailboxMessages)
              .where(
                and(
                  eq(mailboxMessages.mailboxId, mailboxId),
                  eq(mailboxMessages.uidValidity, epoch),
                  inArray(mailboxMessages.uid, uids.map(BigInt)),
                ),
              )
              .returning({ id: mailboxMessages.id });
            removedCount += gone.length;
          },
          completed: async (observation) => {
            const completedAt = new Date();
            await this.database
              .update(mailboxes)
              .set({
                uidNext: BigInt(observation.uidNext),
                reportedMessageCount: BigInt(observation.messageCount),
                reportedUnseenCount:
                  observation.unseenCount === null
                    ? null
                    : BigInt(observation.unseenCount),
                highestModseq:
                  observation.highestModseq === null
                    ? null
                    : BigInt(observation.highestModseq),
                deltaHighestModseq:
                  observation.highestModseq === null
                    ? null
                    : BigInt(observation.highestModseq),
                deltaSyncStatus: "success",
                deltaSyncError: null,
                deltaSyncCompletedAt: completedAt,
                lastSuccessfulDeltaSyncAt: completedAt,
                updatedAt: completedAt,
              })
              .where(
                and(
                  eq(mailboxes.id, mailboxId),
                  eq(mailboxes.deltaUidValidity, epoch!),
                ),
              );
          },
        },
      );
      this.logger?.info(
        {
          event: "mail.delta_sync_completed",
          ...context,
          reason,
          durationMs: Date.now() - startedAt.valueOf(),
          newCount,
          changedCount,
          removedCount,
          lastSeenUid: lastSeen.toString(),
        },
        "Mailbox delta synchronization completed",
      );
      return;
    } catch (error) {
      if (error instanceof MailboxEpochChangedError) {
        await this.events?.record("mail.epoch_reset", {
          accountId,
          mailboxId,
          details: {
            mailboxPath: mailbox.remotePath,
            uidValidity: epoch?.toString(),
          },
        });
        await this.messages.requestRecentSync(accountId, mailboxId);
        return;
      }
      const failedAt = new Date();
      const failureMessage =
        error instanceof MailProviderOperationError
          ? error.message
          : "Mailbox delta synchronization failed.";
      await this.database
        .update(mailboxes)
        .set({
          deltaSyncStatus: "failed",
          deltaSyncError: failureMessage,
          deltaSyncCompletedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(mailboxes.id, mailboxId));
      this.logger?.warn(
        {
          event: "mail.delta_sync_failed",
          ...context,
          reason,
          category:
            error instanceof MailProviderOperationError
              ? error.category
              : "internal_error",
        },
        "Mailbox delta synchronization failed",
      );
      if (
        mailbox.deltaSyncStatus !== "failed" ||
        mailbox.deltaSyncError !== failureMessage
      )
        await this.events?.record("mail.sync_failed", {
          accountId,
          mailboxId,
          details: {
            mailboxPath: mailbox.remotePath,
            category:
              error instanceof MailProviderOperationError
                ? error.category
                : "internal_error",
          },
        });
      throw error;
    }
  }
}
