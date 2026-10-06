import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { ContentScheduler } from "../application/content-scheduler";
import type { MessageContentService } from "../application/message-content-service";

export const MESSAGE_CONTENT_QUEUE = "message-content-fetch-v1";
const payload = z
  .object({
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
    messageId: z.uuid(),
  })
  .strict();

export async function ensureContentQueue(boss: PgBoss) {
  await boss.createQueue(MESSAGE_CONTENT_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 900,
  });
}

export class PgBossContentScheduler implements ContentScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-content-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }
  private start() {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureContentQueue(this.boss);
    })();
    return this.started;
  }
  async schedule(accountId: string, mailboxId: string, messageId: string) {
    await this.start();
    return (
      (await this.boss.send(
        MESSAGE_CONTENT_QUEUE,
        { version: 1, accountId, mailboxId, messageId },
        { singletonKey: `${mailboxId}:${messageId}` },
      )) !== null
    );
  }
}

export async function registerContentWorker(
  boss: PgBoss,
  service: MessageContentService,
) {
  await ensureContentQueue(boss);
  await boss.work(
    MESSAGE_CONTENT_QUEUE,
    { localConcurrency: 1 },
    safeJobHandler("message-content", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Content fetch received an empty batch.");
      const request = payload.parse(job.data);
      await service.run(
        request.accountId,
        request.mailboxId,
        request.messageId,
      );
    }),
  );
}
