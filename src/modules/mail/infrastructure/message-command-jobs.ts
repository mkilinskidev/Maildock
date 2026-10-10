import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { MessageCommandService } from "../application/message-command-service";

export const MESSAGE_COMMAND_QUEUE = "message-command-v1";
export async function ensureMessageCommandQueue(boss: PgBoss) {
  await boss.createQueue(MESSAGE_COMMAND_QUEUE, {
    retryLimit: 4,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 900,
  });
}
export async function enqueueMessageCommand(boss: PgBoss, id: string) {
  await boss.send(MESSAGE_COMMAND_QUEUE, { commandId: id });
}
export class PgBossMessageCommandScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-command-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }
  async enqueue(id: string) {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureMessageCommandQueue(this.boss);
    })();
    await this.started;
    await enqueueMessageCommand(this.boss, id);
  }
}
export async function registerMessageCommandWorker(
  boss: PgBoss,
  service: MessageCommandService,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
) {
  await ensureMessageCommandQueue(boss);
  await boss.work(
    MESSAGE_COMMAND_QUEUE,
    { localConcurrency: 4 },
    safeJobHandler("message-command", async (batch) => {
      const id = z
        .object({ commandId: z.uuid() })
        .parse(batch[0]?.data).commandId;
      const mailboxId = await service.mailboxId(id);
      if (mailboxId) await withLock(mailboxId, () => service.run(id));
      else await service.run(id);
    }),
  );
}
export class MessageCommandPoller {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly boss: PgBoss,
    private readonly service: MessageCommandService,
  ) {}
  async start() {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      30_000,
    );
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  private async poll() {
    for (const id of await this.service.pendingIds())
      await enqueueMessageCommand(this.boss, id);
  }
}
