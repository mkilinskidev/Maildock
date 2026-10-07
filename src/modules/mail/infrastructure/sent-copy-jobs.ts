import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { SentCopyService } from "../application/sent-copy-service";

export const SENT_COPY_QUEUE = "sent-copy-v1";
export async function ensureSentCopyQueue(boss: PgBoss) {
  await boss.createQueue(SENT_COPY_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 900,
  });
}
export async function enqueueSentCopy(boss: PgBoss, id: string) {
  await boss.send(
    SENT_COPY_QUEUE,
    { outgoingMessageId: id },
    { singletonKey: id },
  );
}
export async function registerSentCopyWorker(
  boss: PgBoss,
  service: SentCopyService,
) {
  await ensureSentCopyQueue(boss);
  await boss.work(SENT_COPY_QUEUE, { localConcurrency: 4 }, async (batch) => {
    const { outgoingMessageId } = z
      .object({ outgoingMessageId: z.uuid() })
      .strict()
      .parse(batch[0]?.data);
    await service.run(outgoingMessageId);
  });
}
export class SentCopyPoller {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(private readonly service: SentCopyService) {}
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
