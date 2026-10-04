import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { AttachmentService } from "../application/attachment-service";

export const ATTACHMENT_QUEUE = "attachment-fetch-v1";
export const attachmentJob = z.object({ attachmentId: z.uuid() }).strict();
export async function ensureAttachmentQueue(boss: PgBoss) {
  await boss.createQueue(ATTACHMENT_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 900,
  });
}
export async function enqueueAttachment(boss: PgBoss, id: string) {
  await boss.send(ATTACHMENT_QUEUE, { attachmentId: id }, { singletonKey: id });
}
export class PgBossAttachmentScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-attachment-enqueue",
    });
  }
  async enqueue(id: string) {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureAttachmentQueue(this.boss);
    })().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    await this.started;
    await enqueueAttachment(this.boss, id);
  }
}
export async function registerAttachmentWorker(
  boss: PgBoss,
  service: AttachmentService,
) {
  await ensureAttachmentQueue(boss);
  await boss.work(ATTACHMENT_QUEUE, { localConcurrency: 2 }, async (batch) => {
    const { attachmentId } = attachmentJob.parse(batch[0]?.data);
    await service.run(attachmentId);
  });
}
export class AttachmentPoller {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(private readonly service: AttachmentService) {}
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
