import type { Logger } from "pino";
import { observeSyncDelivery } from "./sync-diagnostics";
import { imapJobRevision, assertImapJob } from "./receive-job-policy";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { z } from "zod";
import { and, eq, ne, or } from "drizzle-orm";

import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import type { BackfillSyncService } from "../application/backfill-sync-service";
import { MAILBOX_DELTA_SYNC_QUEUE } from "./delta-sync-jobs";
import { MAILBOX_RECENT_SYNC_QUEUE } from "./recent-sync-jobs";

export const MAILBOX_BACKFILL_SYNC_QUEUE = "mailbox-backfill-sync-v1";
function hasEligibleWork(jobs: JobWithMetadata<unknown>[]): boolean {
  return jobs.some(
    (job) =>
      !job.blocked &&
      (!job.startAfter || job.startAfter.getTime() <= Date.now()),
  );
}
const payloadSchema = z
  .object({
    accountRevision: z.string().regex(/^[1-9][0-9]*$/),
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
  })
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
): Promise<boolean> {
  return enqueueCoalescedSync(
    boss,
    MAILBOX_BACKFILL_SYNC_QUEUE,
    {
      version: 1,
      accountId,
      mailboxId,
      accountRevision: await imapJobRevision(boss, accountId),
    },
    { singletonKey: `${mailboxId}:${frontier ?? "initial"}`, priority: -10 },
  );
}

export async function registerBackfillWorker(
  boss: PgBoss,
  service: BackfillSyncService,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
  logger?: Pick<Logger, "debug">,
  concurrency = 2,
): Promise<void> {
  await ensureBackfillQueue(boss);
  await boss.work(
    MAILBOX_BACKFILL_SYNC_QUEUE,
    { localConcurrency: Math.max(2, concurrency), includeMetadata: true },
    safeJobHandler("backfill-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Backfill received an empty batch.");
      const payload = payloadSchema.parse(job.data);
      await observeSyncDelivery(
        logger,
        job,
        {
          accountId: payload.accountId,
          mailboxId: payload.mailboxId,
          transport: "imap",
          phase: "backfill",
          reason: "unknown",
        },
        async () => {
          await assertImapJob(boss, payload);
          const [recent, delta] = await Promise.all([
            boss.findJobs(MAILBOX_RECENT_SYNC_QUEUE, {
              key: payload.mailboxId,
              queued: true,
            }),
            boss.findJobs(MAILBOX_DELTA_SYNC_QUEUE, {
              key: payload.mailboxId,
              queued: true,
            }),
          ]);
          if (hasEligibleWork(recent) || hasEligibleWork(delta)) return;
          let more: string | null = null;
          await withLock(payload.mailboxId, async () => {
            const [recent, delta] = await Promise.all([
              boss.findJobs(MAILBOX_RECENT_SYNC_QUEUE, {
                key: payload.mailboxId,
                queued: true,
              }),
              boss.findJobs(MAILBOX_DELTA_SYNC_QUEUE, {
                key: payload.mailboxId,
                queued: true,
              }),
            ]);
            if (hasEligibleWork(recent) || hasEligibleWork(delta)) return;
            more = await service.run(
              payload.accountId,
              payload.mailboxId,
              payload.accountRevision,
            );
          });
          // The active singleton still owns its key. A fresh key permits exactly one
          // continuation; the poller repairs a crash between commit and enqueue.
          if (more)
            await enqueueCoalescedSync(
              boss,
              MAILBOX_BACKFILL_SYNC_QUEUE,
              payload,
              {
                singletonKey: `${payload.mailboxId}:${more}`,
                priority: -10,
                startAfter: 5,
              },
            );
        },
      );
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
            eq(mailAccounts.providerType, "imap_smtp"),
            or(
              eq(mailAccounts.authMethod, "password"),
              eq(mailAccounts.oauthStatus, "connected"),
            ),
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
