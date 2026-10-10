import type { Logger } from "pino";
import { observeSyncDelivery } from "./sync-diagnostics";
import { imapJobRevision, assertImapJob } from "./receive-job-policy";
import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { enqueueImapContinuation } from "./imap-slice-continuation";
import { z } from "zod";

import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { MessageService } from "../application/message-service";
import type { RecentSyncScheduler } from "../application/recent-sync-scheduler";

export const MAILBOX_RECENT_SYNC_QUEUE = "mailbox-recent-sync-v1";

export const recentSyncPayloadSchema = z
  .object({
    accountRevision: z.string().regex(/^[1-9][0-9]*$/),
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
  })
  .strict();

export async function ensureRecentQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAILBOX_RECENT_SYNC_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 15 * 60,
    expireInSeconds: 15 * 60,
  });
}

export class PgBossRecentSyncScheduler implements RecentSyncScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;

  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-message-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureRecentQueue(this.boss);
    })();
    return this.started;
  }

  async schedule(accountId: string, mailboxId: string): Promise<boolean> {
    await this.start();
    return enqueueRecent(this.boss, accountId, mailboxId);
  }
}

export async function enqueueRecent(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
): Promise<boolean> {
  return enqueueCoalescedSync(
    boss,
    MAILBOX_RECENT_SYNC_QUEUE,
    {
      version: 1,
      accountId,
      mailboxId,
      accountRevision: await imapJobRevision(boss, accountId),
    },
    { singletonKey: mailboxId, priority: 10 },
  );
}

export async function registerRecentSyncWorker(
  boss: PgBoss,
  service: MessageService,
  concurrency: number,
  withLock: (
    mailboxId: string,
    work: () => Promise<void>,
  ) => Promise<void> = async (_mailboxId, work) => work(),
  logger?: Pick<Logger, "debug">,
): Promise<void> {
  await ensureRecentQueue(boss);
  await boss.work(
    MAILBOX_RECENT_SYNC_QUEUE,
    { localConcurrency: Math.max(2, concurrency), includeMetadata: true },
    safeJobHandler("recent-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Recent sync received an empty batch.");
      const payload = recentSyncPayloadSchema.parse(job.data);
      await observeSyncDelivery(
        logger,
        job,
        {
          accountId: payload.accountId,
          mailboxId: payload.mailboxId,
          transport: "imap",
          phase: "recent",
          reason: "unknown",
        },
        async () => {
          await assertImapJob(boss, payload);
          let more: boolean | void = false;
          await withLock(payload.mailboxId, async () => {
            more = await service.runRecentSync(
              payload.accountId,
              payload.mailboxId,
              payload.accountRevision,
              job.signal,
            );
          });
          job.signal?.throwIfAborted();
          if (more)
            await enqueueImapContinuation(
              boss,
              MAILBOX_RECENT_SYNC_QUEUE,
              payload,
              logger,
            );
        },
      );
    }),
  );
}
