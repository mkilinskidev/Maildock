import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { z } from "zod";
import { and, eq, isNull, ne, asc, sql } from "drizzle-orm";
import { enqueueRecent } from "./recent-sync-jobs";
import { MailboxBusyError } from "./mailbox-lock";
import { higherPriorityWorkWaiting } from "./sync-admission";
import { MAILBOX_DELTA_SYNC_QUEUE } from "./sync-queues";
import {
  FRESH_DEFER_SECONDS,
  freshLanes,
  INBOX_FRESH_PRIORITY,
} from "../application/inbox-first-policy";

import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import type {
  DeltaReason,
  DeltaSyncService,
} from "../application/delta-sync-service";

export { MAILBOX_DELTA_SYNC_QUEUE };
const payloadSchema = z
  .object({
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
    reason: z.enum(["idle", "poll", "manual", "post-discovery"]),
  })
  .strict();

export async function ensureDeltaQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAILBOX_DELTA_SYNC_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 900,
  });
}

export async function enqueueDelta(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  reason: DeltaReason,
  startAfter?: number,
): Promise<boolean> {
  return enqueueCoalescedSync(
    boss,
    MAILBOX_DELTA_SYNC_QUEUE,
    { version: 1, accountId, mailboxId, reason },
    {
      singletonKey: mailboxId,
      ...(startAfter === undefined ? {} : { startAfter }),
    },
    { accountId, mailboxId, kind: "fresh" },
  );
}

export class PgBossDeltaSyncScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;

  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-delta-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureDeltaQueue(this.boss);
    })();
    return this.started;
  }

  async schedule(
    accountId: string,
    mailboxId: string,
    reason: DeltaReason,
  ): Promise<boolean> {
    await this.start();
    return enqueueDelta(this.boss, accountId, mailboxId, reason);
  }
}

export async function registerDeltaWorker(
  boss: PgBoss,
  service: DeltaSyncService,
  concurrency: number,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
): Promise<void> {
  await ensureDeltaQueue(boss);
  const handler = safeJobHandler("delta-sync", async (batch) => {
    const job = batch[0];
    if (!job) throw new Error("Delta sync received an empty batch.");
    const payload = payloadSchema.parse(job.data);
    const { accountId, mailboxId, reason } = payload;
    // Commit the successor before acknowledging; send failure keeps retry.
    const successor = () =>
      enqueueDelta(boss, accountId, mailboxId, reason, FRESH_DEFER_SECONDS);
    const yields = () =>
      higherPriorityWorkWaiting(boss, accountId, mailboxId, "fresh");
    if (await yields()) {
      await successor();
      return;
    }
    let yielded = false;
    try {
      await withLock(mailboxId, async () => {
        if (await yields()) {
          yielded = true;
          return;
        }
        if (job.signal)
          await service.run(accountId, mailboxId, reason, job.signal);
        else await service.run(accountId, mailboxId, reason);
      });
    } catch (error) {
      // Busy means nothing ran: requeue shortly instead of burning backoff.
      if (!(error instanceof MailboxBusyError)) throw error;
      yielded = true;
    }
    if (yielded) await successor();
  });
  // One slot of the existing budget is reserved for INBOX (priority filter), so
  // long deltas of other folders cannot occupy every slot. Total unchanged.
  const lanes = freshLanes(concurrency);
  await boss.work(
    MAILBOX_DELTA_SYNC_QUEUE,
    { localConcurrency: lanes.general },
    handler,
  );
  if (lanes.inbox)
    await boss.work(
      MAILBOX_DELTA_SYNC_QUEUE,
      { localConcurrency: lanes.inbox, minPriority: INBOX_FRESH_PRIORITY },
      handler,
    );
}

export class DeltaPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  private inboxTimer?: ReturnType<typeof setInterval>;
  private repairingInbox = false;

  constructor(
    private readonly database: Database,
    private readonly boss: PgBoss,
    private readonly intervalSeconds: number,
    private readonly inboxRepairSeconds = 30,
  ) {}

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      this.intervalSeconds * 1000,
    );
    this.inboxTimer = setInterval(
      () => void this.repairInitialInbox().catch(() => undefined),
      this.inboxRepairSeconds * 1000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.inboxTimer) clearInterval(this.inboxTimer);
  }

  private initialRecentRows(inboxOnly: boolean) {
    return this.database
      .select({ accountId: mailboxes.accountId, mailboxId: mailboxes.id })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .where(
        and(
          eq(mailAccounts.enabled, true),
          eq(mailboxes.selectable, true),
          eq(mailboxes.lifecycleStatus, "active"),
          isNull(mailboxes.lastSuccessfulRecentSyncAt),
          ne(mailboxes.recentSyncStatus, "success"),
          inboxOnly ? sql`upper(${mailboxes.remotePath}) = 'INBOX'` : undefined,
        ),
      )
      .orderBy(
        sql`case when upper(${mailboxes.remotePath}) = 'INBOX' then 0 else 1 end`,
        asc(mailboxes.firstDiscoveredAt),
      );
  }

  /**
   * Bounded fast path: only INBOX rows without a successful initial recent and
   * without a live job. Other folders keep the regular poll interval; delta
   * freshness is unchanged (IDLE and the regular poll).
   */
  private async repairInitialInbox(): Promise<void> {
    if (this.repairingInbox) return;
    this.repairingInbox = true;
    try {
      for (const item of await this.initialRecentRows(true))
        await enqueueRecent(
          this.boss,
          item.accountId,
          item.mailboxId,
          "repair",
        );
    } finally {
      this.repairingInbox = false;
    }
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Reuse the existing poller: initial recent has durable mailbox state even
      // if discovery enqueue failed or a worker died while deferring a folder.
      // enqueueRecent preserves every live queued/retry/active job.
      const initial = await this.initialRecentRows(false);
      const recoveryFailures: unknown[] = [];
      for (const item of initial) {
        try {
          await enqueueRecent(
            this.boss,
            item.accountId,
            item.mailboxId,
            "repair",
          );
        } catch (error) {
          recoveryFailures.push(error);
        }
      }
      const eligible = await this.database
        .select({ accountId: mailboxes.accountId, mailboxId: mailboxes.id })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.enabled, true),
            eq(mailboxes.selectable, true),
            eq(mailboxes.lifecycleStatus, "active"),
            eq(mailboxes.recentSyncStatus, "success"),
          ),
        )
        // Priority already orders the queue; INBOX first also keeps enqueue
        // order and failure isolation INBOX-first.
        .orderBy(
          sql`case when upper(${mailboxes.remotePath}) = 'INBOX' then 0 else 1 end`,
          asc(mailboxes.remotePath),
        );
      for (const item of eligible)
        await enqueueDelta(this.boss, item.accountId, item.mailboxId, "poll");
      if (recoveryFailures.length)
        throw new AggregateError(
          recoveryFailures,
          "Initial recent recovery failed.",
        );
    } finally {
      this.running = false;
    }
  }
}
