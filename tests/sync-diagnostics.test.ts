import { describe, expect, it, vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";
import {
  observeSyncDelivery,
  SyncLockContentionError,
} from "@/modules/mail/infrastructure/sync-diagnostics";

const identity = {
  accountId: "account",
  mailboxId: "mailbox",
  transport: "imap",
  phase: "delta",
  reason: "idle",
} as const;
describe("bounded synchronization diagnostics", () => {
  it("excludes retry backoff from eligibility wait and does not copy payload secrets", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const debug = vi.fn();
    const job = {
      createdOn: new Date(now - 60000),
      startAfter: new Date(now - 2000),
      retryCount: 1,
      data: { accessToken: "secret", body: "private" },
    } as unknown as JobWithMetadata;
    try {
      expect(
        await observeSyncDelivery({ debug }, job, identity, async () => 42),
      ).toBe(42);
      expect(debug.mock.calls[0][0]).toMatchObject({
        ...identity,
        queueWaitMs: 2000,
        retryCount: 1,
        outcome: "returned",
        blockedReason: null,
      });
      expect(JSON.stringify(debug.mock.calls)).not.toMatch(
        /secret|private|accessToken/,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("reports typed lock contention without changing the thrown error", async () => {
    const debug = vi.fn();
    const error = new SyncLockContentionError("private server detail");
    await expect(
      observeSyncDelivery(
        { debug },
        {} as JobWithMetadata,
        identity,
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(debug.mock.calls[0][0]).toMatchObject({
      outcome: "failed",
      blockedReason: "lock_contention",
      queueWaitMs: null,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      "private server detail",
    );
  });
  it("logging failure cannot turn a committed delivery into a failure", async () => {
    const debug = () => {
      throw new Error("output failed");
    };
    await expect(
      observeSyncDelivery(
        { debug },
        {} as JobWithMetadata,
        identity,
        async () => "committed",
      ),
    ).resolves.toBe("committed");
  });
});
