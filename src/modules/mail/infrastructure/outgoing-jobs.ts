import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { OutgoingMessageService } from "../application/outgoing-message-service";

export const OUTGOING_QUEUE = "outgoing-message-v1";
export async function ensureOutgoingQueue(boss: PgBoss) {
  await boss.createQueue(OUTGOING_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 900,
  });
}
export async function enqueueOutgoing(boss: PgBoss, id: string) {
  await boss.send(
    OUTGOING_QUEUE,
    { outgoingMessageId: id },
    { singletonKey: id },
  );
}
export class PgBossOutgoingScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-outgoing-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }
  async enqueue(id: string) {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureOutgoingQueue(this.boss);
    })().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    await this.started;
    await enqueueOutgoing(this.boss, id);
  }
}
export async function registerOutgoingWorker(
  boss: PgBoss,
  service: OutgoingMessageService,
) {
  await ensureOutgoingQueue(boss);
  await boss.work(
    OUTGOING_QUEUE,
    { localConcurrency: 4 },
    safeJobHandler("outgoing", async (batch) => {
      const { outgoingMessageId } = z
        .object({ outgoingMessageId: z.uuid() })
        .strict()
        .parse(batch[0]?.data);
      await service.run(outgoingMessageId);
    }),
  );
}
export class OutgoingPoller {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(private readonly service: OutgoingMessageService) {}
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
    if (this.polling) return;
    this.polling = true;
    try {
      await this.service.repair();
    } finally {
      this.polling = false;
    }
  }
}
