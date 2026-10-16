import { afterEach, expect, it, vi } from "vitest";
import type { ReceivingCoordinatorConfig } from "@/modules/mail/application/receiving-coordinator";
import { runOneReceivingTurn } from "@/modules/mail/application/receiving-coordinator";
import { ReceivingScheduler } from "@/modules/mail/application/receiving-scheduler";
import type { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";

vi.mock(
  "@/modules/mail/application/receiving-coordinator",
  async (original) => ({
    ...(await original<object>()),
    runOneReceivingTurn: vi.fn(),
  }),
);

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("keeps the third W4/D2 publication outside its operation lifetime until data capacity retires", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const state = {
    epoch: 7n,
    revision: 1n,
    freshThrough: 1000n,
    historyBefore: 1001n,
    reconcileAfter: 0n,
  };
  const result = { state, count: 0, moreFresh: false };
  const publications: { at: number; deadline: number; release: () => void }[] =
    [];
  const cancelled: string[] = [];
  vi.mocked(runOneReceivingTurn).mockImplementation(
    async (config, kind, deadline, signal) => {
      if (kind === "fresh") return result;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          cancelled.push(config.account);
          reject(new Error("Fixture cancelled"));
        };
        signal.addEventListener("abort", cancel, { once: true });
        publications.push({
          at: performance.now(),
          deadline,
          release: () => {
            signal.removeEventListener("abort", cancel);
            resolve();
          },
        });
      });
      return result;
    },
  );
  const accounts = Array.from({ length: 5 }, (_, index) => ({
    account: `account-${index}`,
    mailbox: `mailbox-${index}`,
    connection: {},
    owner: {},
    authority: {},
    timing: { operationMs: 4000, pollMs: 5000 },
  })) as Omit<ReceivingCoordinatorConfig, "executor">[];
  const scheduler = new ReceivingScheduler({
    accounts,
    executor: { capacity: 2 } as ReceivingExecutor,
    controlHeadroom: true,
    tuning: { workers: 4 },
  });
  scheduler.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    // Two SQL publications are held. The original 2D-1 admission starts a
    // third lifetime here, spending its two-second budget in the SQL queue.
    expect(publications).toHaveLength(2);
    expect(scheduler.snapshot.active).toBe(2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(publications).toHaveLength(2);
    publications[0].release();
    await vi.advanceTimersByTimeAsync(0);
    expect(publications).toHaveLength(3);
    expect(publications[2].at).toBe(1100);
    expect(publications[2].deadline - publications[2].at).toBe(2000);
    expect(publications[2].deadline).toBeGreaterThan(publications[0].deadline);
  } finally {
    await scheduler.stop();
  }
  expect(cancelled).toHaveLength(2);
  expect(scheduler.snapshot.active).toBe(0);
});

it.each([false, true])(
  "rotates INBOX and every secondary independently under continuously due work (mixed accounts=%s)",
  async (mixed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const active = new Set<string>();
    const seen: string[] = [];
    const pending: (() => void)[] = [];
    const result = {
      state: {
        epoch: 7n,
        revision: 1n,
        freshThrough: 1n,
        historyBefore: 1n,
        reconcileAfter: 0n,
      },
      count: 0,
      moreFresh: true,
    };
    vi.mocked(runOneReceivingTurn).mockImplementation(
      async (config, _kind, _deadline, signal) => {
        expect(active.has(config.account)).toBe(false);
        active.add(config.account);
        seen.push(config.mailbox);
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            active.delete(config.account);
            reject(Error("Fixture cancelled"));
          };
          signal.addEventListener("abort", cancel, { once: true });
          pending.push(() => {
            signal.removeEventListener("abort", cancel);
            active.delete(config.account);
            resolve();
          });
        });
        return result;
      },
    );
    const accounts = [
      { account: "account-a", mailbox: "a-2", mailboxPath: "INBOX" },
      { account: "account-a", mailbox: "a-1", mailboxPath: "CustomA" },
      { account: "account-a", mailbox: "a-3", mailboxPath: "CustomB" },
      ...(mixed
        ? [{ account: "account-b", mailbox: "b-2", mailboxPath: "INBOX" }]
        : []),
    ].map((c) => ({ ...c, connection: {}, owner: {}, authority: {} })) as Omit<
      ReceivingCoordinatorConfig,
      "executor"
    >[];
    const scheduler = new ReceivingScheduler({
      accounts,
      executor: { capacity: 2 } as ReceivingExecutor,
      controlHeadroom: true,
      tuning: { workers: mixed ? 2 : 1 },
    });
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 32; i++) {
        expect(pending.length).toBeGreaterThan(0);
        pending.shift()!();
        await vi.advanceTimersByTimeAsync(0);
      }
      for (const config of accounts)
        expect(
          seen.filter((m) => m === config.mailbox).length,
          config.mailbox,
        ).toBeGreaterThanOrEqual(3);
    } finally {
      await scheduler.stop();
    }
    expect(scheduler.snapshot.active).toBe(0);
    expect(active.size).toBe(0);
  },
);
