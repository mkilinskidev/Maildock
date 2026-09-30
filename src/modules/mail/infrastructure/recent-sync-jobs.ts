import { PgBoss } from "pg-boss";
import { z } from "zod";

import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { MessageService } from "../application/message-service";
import type { RecentSyncScheduler } from "../application/recent-sync-scheduler";

export const MAILBOX_RECENT_SYNC_QUEUE = "mailbox-recent-sync-v1";

export const recentSyncPayloadSchema = z
  .object({
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
  })
  .strict();

async function ensureQueue(boss: PgBoss): Promise<void> {
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
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureQueue(this.boss);
    })();
    return this.started;
  }

  async schedule(accountId: string, mailboxId: string): Promise<boolean> {
    await this.start();
    const id = await this.boss.send(
      MAILBOX_RECENT_SYNC_QUEUE,
      { version: 1, accountId, mailboxId },
      { singletonKey: mailboxId },
    );
    return id !== null;
  }
}

export async function registerRecentSyncWorker(
  boss: PgBoss,
  service: MessageService,
  concurrency: number,
  withLock: (
    mailboxId: string,
    work: () => Promise<void>,
  ) => Promise<void> = async (_mailboxId, work) => work(),
): Promise<void> {
  await ensureQueue(boss);
  await boss.work(
    MAILBOX_RECENT_SYNC_QUEUE,
    { localConcurrency: concurrency },
    async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Recent sync received an empty batch.");
      const payload = recentSyncPayloadSchema.parse(job.data);
      await withLock(payload.mailboxId, () =>
        service.runRecentSync(payload.accountId, payload.mailboxId),
      );
    },
  );
}
