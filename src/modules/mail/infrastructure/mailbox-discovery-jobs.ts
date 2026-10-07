import { PgBoss } from "pg-boss";
import { z } from "zod";

import type { MailboxDiscoveryScheduler } from "../../accounts/application/mailbox-discovery-scheduler";
import type { MailboxDiscoveryService } from "../application/mailbox-discovery-service";
import type { AppConfig } from "../../../shared/infrastructure/config/config";

export const MAILBOX_DISCOVERY_QUEUE = "mailbox-discovery-v1";

const payloadSchema = z.object({
  version: z.literal(1),
  accountId: z.uuid(),
});

async function ensureQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAILBOX_DISCOVERY_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 15 * 60,
    expireInSeconds: 2 * 60,
  });
}

export class PgBossMailboxDiscoveryScheduler implements MailboxDiscoveryScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;

  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-enqueue",
    });
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureQueue(this.boss);
    })();
    return this.started;
  }

  async schedule(accountId: string): Promise<boolean> {
    await this.start();
    const id = await this.boss.send(
      MAILBOX_DISCOVERY_QUEUE,
      { version: 1, accountId },
      { singletonKey: accountId },
    );
    return id !== null;
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.started;
      await this.boss.stop({ graceful: true, timeout: 10_000 });
    }
  }
}

export async function registerMailboxDiscoveryWorker(
  boss: PgBoss,
  service: MailboxDiscoveryService,
  concurrency: number,
): Promise<void> {
  await ensureQueue(boss);
  await boss.work(
    MAILBOX_DISCOVERY_QUEUE,
    { localConcurrency: concurrency },
    async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Mailbox discovery received an empty batch.");
      const payload = payloadSchema.parse(job.data);
      await service.run(payload.accountId);
    },
  );
}
