import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import {
  enqueueOutgoing,
  ensureOutgoingQueue,
  registerOutgoingWorker,
} from "@/modules/mail/infrastructure/outgoing-jobs";
import type { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";

describe("outgoing pg-boss boundary", () => {
  it("queues only the ID with no transport-managed retries", async () => {
    const boss = { send: vi.fn(), createQueue: vi.fn() };
    await ensureOutgoingQueue(boss as unknown as PgBoss);
    await enqueueOutgoing(boss as unknown as PgBoss, "id");
    expect(boss.send).toHaveBeenCalledWith(
      "outgoing-message-v1",
      { outgoingMessageId: "id" },
      { singletonKey: "id" },
    );
    expect(boss.createQueue).toHaveBeenCalledWith("outgoing-message-v1", {
      retryLimit: 0,
      expireInSeconds: 900,
    });
  });
  it("loads outgoing state by ID and rejects extra job fields", async () => {
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
    await registerOutgoingWorker(
      boss as unknown as PgBoss,
      service as unknown as OutgoingMessageService,
    );
    await callback([{ data: { outgoingMessageId: id } }]);
    expect(service.run).toHaveBeenCalledWith(id);
    await expect(
      callback([{ data: { outgoingMessageId: id, mime: "private" } }]),
    ).rejects.toThrow();
  });
});
