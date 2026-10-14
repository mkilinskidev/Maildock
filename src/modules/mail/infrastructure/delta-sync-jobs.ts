import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import {
  requestReceivingWake,
  enqueueReceivingWake,
} from "./receiving-wake-jobs";
import { ReceivingDemand } from "../application/receiving-demand";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

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

export const MAILBOX_DELTA_SYNC_QUEUE = "mailbox-delta-sync-v1";
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
): Promise<boolean> {
  const demand = await requestReceivingWake(boss, accountId, mailboxId);
  if (!demand.accepted || demand.inbox) return demand.accepted;
  return enqueueCoalescedSync(
    boss,
    MAILBOX_DELTA_SYNC_QUEUE,
    { version: 1, accountId, mailboxId, reason },
    { singletonKey: mailboxId, priority: 10 },
  );
}

export class PgBossDeltaSyncScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  private readonly demand: ReceivingDemand;

  constructor(config: Pick<AppConfig, "databaseUrl">, database: Database) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-delta-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
    this.demand = new ReceivingDemand(database, async (accountId) => {
      await this.start();
      return enqueueReceivingWake(this.boss, accountId);
    });
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureDeltaQueue(this.boss);
    })().catch((error) => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  async schedule(
    accountId: string,
    mailboxId: string,
    reason: DeltaReason,
  ): Promise<boolean> {
    const demand = await this.demand.record(accountId, mailboxId);
    if (!demand.accepted) return false;
    if (demand.inbox) {
      await this.demand.deliver(accountId);
      return true;
    }
    await this.start();
    return enqueueCoalescedSync(
      this.boss,
      MAILBOX_DELTA_SYNC_QUEUE,
      { version: 1, accountId, mailboxId, reason },
      { singletonKey: mailboxId, priority: 10 },
    );
  }
}

export async function registerDeltaWorker(
  boss: PgBoss,
  service: DeltaSyncService,
  concurrency: number,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
): Promise<void> {
  await ensureDeltaQueue(boss);
  await boss.work(
    MAILBOX_DELTA_SYNC_QUEUE,
    { localConcurrency: concurrency },
    safeJobHandler("delta-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Delta sync received an empty batch.");
      const payload = payloadSchema.parse(job.data);
      await withLock(payload.mailboxId, () =>
        service.run(payload.accountId, payload.mailboxId, payload.reason),
      );
    }),
  );
}

export class DeltaPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly boss: PgBoss,
    private readonly intervalSeconds: number,
  ) {}

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      this.intervalSeconds * 1000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
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
        );
      for (const item of eligible)
        await enqueueDelta(this.boss, item.accountId, item.mailboxId, "poll");
    } finally {
      this.running = false;
    }
  }
}
