import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import {
  enqueueSentCopy,
  ensureSentCopyQueue,
  registerSentCopyWorker,
} from "@/modules/mail/infrastructure/sent-copy-jobs";
import type { SentCopyService } from "@/modules/mail/application/sent-copy-service";

describe("durable Sent-copy jobs", () => {
  it("queues only outgoingMessageId and disables queue retries", async () => {
    const boss = { send: vi.fn(), createQueue: vi.fn() };
    await ensureSentCopyQueue(boss as unknown as PgBoss);
    await enqueueSentCopy(boss as unknown as PgBoss, "id");
    expect(boss.send).toHaveBeenCalledExactlyOnceWith(
      "sent-copy-v1",
      { outgoingMessageId: "id" },
      { singletonKey: "id" },
    );
    expect(boss.createQueue).toHaveBeenCalledWith("sent-copy-v1", {
      retryLimit: 0,
      expireInSeconds: 900,
    });
  });
  it("reloads by ID and rejects mailbox, MIME or credential payloads", async () => {
    let callback: (
      batch: { data: unknown }[],
    ) => Promise<void> = async () => {};
    const boss = {
      createQueue: vi.fn(),
      work: vi.fn(async (_queue, _options, worker) => {
        callback = worker;
      }),
    };
    const service = { run: vi.fn() };
    const id = "00000000-0000-4000-8000-000000000001";
    await registerSentCopyWorker(
      boss as unknown as PgBoss,
      service as unknown as SentCopyService,
    );
    await callback([{ data: { outgoingMessageId: id } }]);
    expect(service.run).toHaveBeenCalledExactlyOnceWith(id);
    for (const key of ["mime", "password", "mailboxPath"])
      await expect(
        callback([{ data: { outgoingMessageId: id, [key]: "private" } }]),
      ).rejects.toThrow();
  });
});
