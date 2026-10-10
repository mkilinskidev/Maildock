import { receiveJobRevision, assertReceiveJob } from "./receive-job-policy";
import { StaleAccountWorkError } from "../../accounts/domain/receive-transport";
import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { AttachmentService } from "../application/attachment-service";

export const ATTACHMENT_QUEUE = "attachment-fetch-v1";
export const attachmentJob = z
  .object({
    attachmentId: z.uuid(),
    accountId: z.uuid(),
    accountRevision: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export async function ensureAttachmentQueue(boss: PgBoss) {
  await boss.createQueue(ATTACHMENT_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 900,
  });
}
export async function enqueueAttachment(boss: PgBoss, id: string) {
  const result = await boss
    .getDb()
    .executeSql(
      "select account_id from public.message_attachments where id = $1",
      [id],
    );
  const accountId = result.rows[0]?.account_id;
  if (!accountId) throw new StaleAccountWorkError();
  const accountRevision = await receiveJobRevision(boss, accountId);
  await boss.send(
    ATTACHMENT_QUEUE,
    { attachmentId: id, accountId, accountRevision },
    { singletonKey: id },
  );
}
export class PgBossAttachmentScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-attachment-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
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
  await boss.work(
    ATTACHMENT_QUEUE,
    { localConcurrency: 2 },
    safeJobHandler("attachment", async (batch) => {
      const payload = attachmentJob.parse(batch[0]?.data);
      await assertReceiveJob(boss, payload);
      await service.run(
        payload.attachmentId,
        payload.accountRevision,
        payload.accountId,
      );
    }),
  );
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
