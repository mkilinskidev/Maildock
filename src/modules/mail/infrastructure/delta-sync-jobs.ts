import type { Logger } from "pino";
import { observeSyncDelivery } from "./sync-diagnostics";
import { imapJobRevision, assertImapJob } from "./receive-job-policy";
import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";

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
    accountRevision: z.string().regex(/^[1-9][0-9]*$/),
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
  return enqueueCoalescedSync(
    boss,
    MAILBOX_DELTA_SYNC_QUEUE,
    {
      version: 1,
      accountId,
      mailboxId,
      reason,
      accountRevision: await imapJobRevision(boss, accountId),
    },
    { singletonKey: mailboxId, priority: 10 },
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
  logger?: Pick<Logger, "debug">,
): Promise<void> {
  await ensureDeltaQueue(boss);
  await boss.work(
    MAILBOX_DELTA_SYNC_QUEUE,
    { localConcurrency: Math.max(2, concurrency), includeMetadata: true },
    safeJobHandler("delta-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Delta sync received an empty batch.");
      const payload = payloadSchema.parse(job.data);
      await observeSyncDelivery(
        logger,
        job,
        {
          accountId: payload.accountId,
          mailboxId: payload.mailboxId,
          transport: "imap",
          phase: "delta",
          reason: payload.reason,
        },
        async () => {
          await assertImapJob(boss, payload);
          await withLock(payload.mailboxId, () =>
            service.run(
              payload.accountId,
              payload.mailboxId,
              payload.reason,
              payload.accountRevision,
            ),
          );
        },
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
            eq(mailAccounts.providerType, "imap_smtp"),
            or(
              eq(mailAccounts.authMethod, "password"),
              eq(mailAccounts.oauthStatus, "connected"),
            ),
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
