import {
  bestEffortDiagnostic,
  safeJobHandler,
} from "../../../shared/infrastructure/logging/diagnostics";
import type { Logger } from "pino";
import { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";

import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import type {
  BackfillRunResult,
  BackfillSyncService,
} from "../application/backfill-sync-service";
import { MailboxBusyError } from "./mailbox-lock";
import { higherPriorityWork, interactiveFetchWaiting } from "./sync-admission";
import {
  MAILBOX_BACKFILL_SYNC_QUEUE,
  MAILBOX_DELTA_SYNC_QUEUE,
  MAILBOX_RECENT_SYNC_QUEUE,
} from "./sync-queues";
import { HISTORY_DEFER_SECONDS } from "../application/inbox-first-policy";

export { MAILBOX_BACKFILL_SYNC_QUEUE };
const payloadSchema = z
  .object({ version: z.literal(1), accountId: z.uuid(), mailboxId: z.uuid() })
  .strict();

export async function ensureBackfillQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAILBOX_BACKFILL_SYNC_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 900,
  });
}

export async function enqueueBackfill(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  frontier?: string | null,
  startAfter?: number,
): Promise<boolean> {
  return enqueueBackfillKey(
    boss,
    accountId,
    mailboxId,
    `${mailboxId}:${frontier ?? "initial"}`,
    startAfter,
  );
}

function enqueueBackfillKey(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  singletonKey: string,
  startAfter?: number,
): Promise<boolean> {
  return enqueueCoalescedSync(
    boss,
    MAILBOX_BACKFILL_SYNC_QUEUE,
    { version: 1, accountId, mailboxId },
    { singletonKey, ...(startAfter === undefined ? {} : { startAfter }) },
    { accountId, mailboxId, kind: "history" },
  );
}

/** Why a history job stopped early; diagnostics only, never payload data. */
export type BackfillYieldReason =
  "command" | "own-fresh" | "fresh" | "interactive" | "gate-error";

/**
 * History outranks nothing. Order of checks = order of urgency. Any queued
 * fresh run of this mailbox (also a delayed retry or busy continuation),
 * account-scoped commands and fresh work (higherPriorityWork, "history"), and
 * live interactive fetching of the account (interactiveFetchWaiting).
 */
export async function backfillYieldReason(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
): Promise<BackfillYieldReason | null> {
  const [recent, delta] = await Promise.all([
    boss.findJobs(MAILBOX_RECENT_SYNC_QUEUE, { key: mailboxId, queued: true }),
    boss.findJobs(MAILBOX_DELTA_SYNC_QUEUE, { key: mailboxId, queued: true }),
  ]);
  const work = await higherPriorityWork(boss, accountId, mailboxId, "history");
  if (work === "command") return "command";
  if (recent.length > 0 || delta.length > 0) return "own-fresh";
  if (work === "fresh") return "fresh";
  if (await interactiveFetchWaiting(boss, accountId)) return "interactive";
  return null;
}

export async function registerBackfillWorker(
  boss: PgBoss,
  service: BackfillSyncService,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
  logger?: Logger,
): Promise<void> {
  await ensureBackfillQueue(boss);
  await boss.work(
    MAILBOX_BACKFILL_SYNC_QUEUE,
    { localConcurrency: 1, includeMetadata: true },
    safeJobHandler("backfill-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Backfill received an empty batch.");
      const payload = payloadSchema.parse(job.data);
      const { accountId, mailboxId } = payload;
      const key =
        (job as { singletonKey?: string | null }).singletonKey ??
        `${mailboxId}:initial`;
      const yields = () => backfillYieldReason(boss, accountId, mailboxId);
      // Yield before any progress commits a delayed successor with the same key
      // (stately keeps it behind this active run); the checkpoint is unchanged
      // and the poller still repairs a crash before this send.
      const successor = () =>
        enqueueBackfillKey(
          boss,
          accountId,
          mailboxId,
          key,
          HISTORY_DEFER_SECONDS,
        );
      if (await yields()) {
        await successor();
        return;
      }
      let result: BackfillRunResult | undefined;
      let reason: BackfillYieldReason | null = null;
      let detectedAt: number | undefined;
      try {
        await withLock(mailboxId, async () => {
          reason = await yields();
          if (reason) return;
          // Asked by the provider between committed sub-batches, under the lock.
          // An unreadable signal stops the run: history never continues blind.
          result = await service.run(accountId, mailboxId, async () => {
            reason = await yields().catch(() => "gate-error" as const);
            if (reason) detectedAt = performance.now();
            return reason !== null;
          });
        });
      } catch (error) {
        if (!(error instanceof MailboxBusyError)) throw error;
      }
      if (result?.outcome === "yielded") {
        const { frontier } = result;
        // The provider ended normally and the lock is released. A successor
        // keyed by the new durable frontier (the key the poller derives) waits
        // HISTORY_DEFER_SECONDS: progress was made, so this is no hot loop.
        // A failed send fails this job; its retry and the poller resume from
        // the durable frontier, never from the payload.
        bestEffortDiagnostic(() =>
          logger?.info(
            {
              event: "mail.backfill_yielded",
              reason,
              frontier,
              ...(detectedAt === undefined
                ? {}
                : { releaseMs: Math.round(performance.now() - detectedAt) }),
            },
            "History yielded to more urgent work",
          ),
        );
        await enqueueBackfill(
          boss,
          accountId,
          mailboxId,
          frontier,
          HISTORY_DEFER_SECONDS,
        );
        return;
      }
      if (!result) {
        // Yield under the lock or busy mailbox: nothing ran.
        await successor();
        return;
      }
      // The active singleton still owns its key. A fresh key permits exactly one
      // continuation; the poller repairs a crash between commit and enqueue.
      if (result.outcome === "progressed")
        await enqueueBackfill(boss, accountId, mailboxId, result.frontier, 5);
    }),
  );
}

export class BackfillPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly database: Database,
    private readonly boss: PgBoss,
  ) {}
  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      60_000,
    );
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.database
        .select({
          accountId: mailboxes.accountId,
          mailboxId: mailboxes.id,
          frontier: mailboxes.backfillFrontierUid,
        })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.enabled, true),
            eq(mailboxes.selectable, true),
            eq(mailboxes.lifecycleStatus, "active"),
            eq(mailboxes.recentSyncStatus, "success"),
            ne(mailboxes.backfillStatus, "complete"),
          ),
        );
      for (const row of rows)
        await enqueueBackfill(
          this.boss,
          row.accountId,
          row.mailboxId,
          row.frontier?.toString(),
        );
    } finally {
      this.running = false;
    }
  }
}
