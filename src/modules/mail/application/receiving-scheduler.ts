import {
  receivingTiming,
  runOneReceivingTurn,
  type ReceivingCoordinatorConfig,
} from "./receiving-coordinator";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";

export const RECEIVING_SCHEDULER_DEFAULTS = Object.freeze({
  workers: 2,
  maxAccounts: 128,
  historyWaitMs: 30_000,
  historyTurnMs: 2_000,
  freshWaitGuardMs: 5_000,
});

export type ReceivingWorkKind = "fresh" | "history";
type AccountConfig = Omit<ReceivingCoordinatorConfig, "executor">;
type Account = {
  config: ReceivingCoordinatorConfig;
  timing: ReturnType<typeof receivingTiming>;
  active: boolean;
  freshDue: number;
  retryAt: number;
  retryMs: number;
  historySince?: number;
};
export type ReceivingAdmission = Readonly<{
  account: string;
  kind: ReceivingWorkKind;
  protectedHistory: boolean;
  waitMs: number;
  active: number;
  at: number;
}>;

/** Isolated, single-use shared selector. Future user work belongs at the
 * current-priority selection boundary in select(), under these same allocations;
 * this API deliberately accepts only receiving work, not command callbacks.
 * Caller owns one shared Stage 1 executor and its independent DB capacity. */
export class ReceivingScheduler {
  private readonly accounts: Account[];
  private readonly config;
  private readonly limit: number;
  private readonly cancellation = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private lifetime?: Promise<void>;
  private wake?: () => void;
  private freshCursor = 0;
  private historyCursor = 0;
  private lastProtected = false;
  private protectedActive = false;

  constructor(
    input: Readonly<{
      accounts: readonly AccountConfig[];
      executor: ReceivingExecutor;
      tuning?: Partial<
        Record<keyof typeof RECEIVING_SCHEDULER_DEFAULTS, number>
      >;
      /** Pure synchronous operational gate; never opens a connection. False
       * suppresses history, including exceptions, without suppressing fresh. */
      historyAllowed?: () => boolean;
      /** Synchronous diagnostics, never used as authority or work producers. */
      onAdmission?: (admission: ReceivingAdmission) => void;
    }>,
  ) {
    this.config = {
      ...input,
      tuning: { ...RECEIVING_SCHEDULER_DEFAULTS, ...input.tuning },
    };
    for (const value of Object.values(this.config.tuning))
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error("Invalid receiving scheduler configuration");
    if (
      this.config.tuning.workers > 16 ||
      input.accounts.length > this.config.tuning.maxAccounts ||
      this.config.tuning.historyTurnMs > 10_000
    )
      throw new Error("Receiving scheduler capacity/deadline exceeded");
    const identities = new Set(input.accounts.map((a) => a.account));
    if (identities.size !== input.accounts.length)
      throw new Error("Duplicate receiving account");
    // Each active turn can request at most one DB transaction at a time.
    // Stage 1 permits D executing plus D queued transactions. Conservatively
    // cap whole turns at 2D so even simultaneous publications fit that bound.
    // D remains independently configured; it is neither W nor the app pool.
    this.limit = Math.min(
      this.config.tuning.workers,
      2 * input.executor.capacity,
    );
    this.accounts = input.accounts.map((config) => {
      const timing = receivingTiming(config.timing);
      return {
        config: {
          ...config,
          connection: structuredClone(config.connection),
          owner: { ...config.owner },
          authority: { ...config.authority },
          executor: input.executor,
        },
        timing,
        active: false,
        freshDue: performance.now(),
        retryAt: 0,
        retryMs: timing.retryMs,
      };
    });
  }

  start(): void {
    if (this.lifetime || this.cancellation.signal.aborted)
      throw new Error("Receiving scheduler already started or stopped");
    this.lifetime = this.run();
  }

  async stop(): Promise<void> {
    this.cancellation.abort();
    this.wake?.();
    await this.lifetime;
  }

  get snapshot() {
    return Object.freeze({
      active: this.active.size,
      accounts: this.accounts.length,
      limit: this.limit,
      stopped: this.cancellation.signal.aborted,
    });
  }

  private diagnostic(callback: () => void) {
    // Observers cannot strand allocations or turn an acknowledged commit into
    // a receiving failure. They must remain synchronous and bounded.
    try {
      callback();
    } catch {
      /* diagnostic failure has no scheduling authority */
    }
  }

  private rotate(
    candidates: Account[],
    kind: ReceivingWorkKind,
  ): Account | undefined {
    const cursor = kind === "fresh" ? this.freshCursor : this.historyCursor;
    for (let offset = 0; offset < this.accounts.length; offset++) {
      const index = (cursor + offset) % this.accounts.length;
      const account = this.accounts[index];
      if (!candidates.includes(account)) continue;
      if (kind === "fresh")
        this.freshCursor = (index + 1) % this.accounts.length;
      else this.historyCursor = (index + 1) % this.accounts.length;
      return account;
    }
  }

  private select(now: number) {
    const available = this.accounts.filter(
      (a) => !a.active && a.retryAt <= now,
    );
    const fresh = available.filter((a) => a.freshDue <= now);
    let healthy = true;
    try {
      healthy = this.config.historyAllowed?.() ?? true;
    } catch {
      healthy = false;
    }
    const history = healthy
      ? available.filter((a) => a.historySince !== undefined)
      : [];
    const oldestDue = Math.min(
      ...this.accounts
        .filter((a) => a.retryAt <= now && a.freshDue <= now)
        .map((a) => a.freshDue),
    );
    const protectedCandidates = history.filter(
      (a) =>
        now - a.historySince! >= this.config.tuning.historyWaitMs &&
        now -
          oldestDue +
          Math.min(a.timing.operationMs, this.config.tuning.historyTurnMs) <=
          this.config.tuning.freshWaitGuardMs,
    );
    // Narrow current-priority boundary: future user work must be selected here,
    // never admitted by a parallel callback or another account loop.
    if (
      fresh.length &&
      !this.lastProtected &&
      !this.protectedActive &&
      protectedCandidates.length
    ) {
      return {
        account: this.rotate(protectedCandidates, "history")!,
        kind: "history" as const,
        protectedHistory: true,
      };
    }
    if (fresh.length)
      return {
        account: this.rotate(fresh, "fresh")!,
        kind: "fresh" as const,
        protectedHistory: false,
      };
    if (history.length)
      return {
        account: this.rotate(history, "history")!,
        kind: "history" as const,
        protectedHistory: false,
      };
  }

  private admit(
    selection: NonNullable<ReturnType<ReceivingScheduler["select"]>>,
  ) {
    const { account, kind, protectedHistory } = selection;
    const at = performance.now();
    account.active = true;
    if (protectedHistory) {
      this.lastProtected = true;
      this.protectedActive = true;
    } else if (kind === "fresh") this.lastProtected = false;
    const operationMs =
      kind === "history"
        ? Math.min(account.timing.operationMs, this.config.tuning.historyTurnMs)
        : account.timing.operationMs;
    const admission: ReceivingAdmission = {
      account: account.config.account,
      kind,
      protectedHistory,
      waitMs:
        at - (kind === "fresh" ? account.freshDue : account.historySince!),
      active: this.active.size + 1,
      at,
    };
    if (kind === "history") account.historySince = at;
    // Microtask starts after the promise has been registered. Allocation stays
    // owned through IMAP/DB cancellation and local resource retirement.
    const task = Promise.resolve().then(async () => {
      try {
        const turn = await runOneReceivingTurn(
          account.config,
          kind,
          at + operationMs,
          this.cancellation.signal,
        );
        const now = performance.now();
        if (kind === "fresh")
          account.freshDue = turn.moreFresh ? now : now + account.timing.pollMs;
        account.retryMs = account.timing.retryMs;
        account.retryAt = 0;
        account.historySince =
          turn.state.historyBefore > 1n
            ? kind === "history"
              ? now
              : (account.historySince ?? now)
            : undefined;
        account.active = false;
        this.active.delete(task);
        this.diagnostic(() => account.config.onTurn?.(kind, turn));
      } catch (error) {
        account.active = false;
        this.active.delete(task);
        if (!this.cancellation.signal.aborted) {
          const retry = account.retryMs;
          account.freshDue = performance.now();
          account.retryAt = account.freshDue + retry;
          // Recovery must observe fresh before old history becomes eligible.
          account.historySince = undefined;
          account.retryMs = Math.min(account.timing.maxRetryMs, retry * 2);
          this.diagnostic(() => account.config.onError?.(error, retry));
        }
      } finally {
        if (protectedHistory) this.protectedActive = false;
        this.wake?.();
      }
    });
    this.active.add(task);
    this.diagnostic(() => this.config.onAdmission?.(admission));
  }

  private async wait() {
    const now = performance.now();
    const next = Math.min(
      ...this.accounts
        .filter((a) => !a.active)
        .map((a) => Math.max(a.retryAt, a.freshDue)),
    );
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      this.wake = done;
      // If all slots are held, only settlement can make admission possible.
      if (this.active.size < this.limit && Number.isFinite(next))
        timer = setTimeout(done, Math.max(1, next - now));
      if (this.cancellation.signal.aborted) done();
    });
  }

  private async run() {
    while (!this.cancellation.signal.aborted) {
      while (
        !this.cancellation.signal.aborted &&
        this.active.size < this.limit
      ) {
        const selection = this.select(performance.now());
        if (!selection) break;
        this.admit(selection);
      }
      if (!this.cancellation.signal.aborted) await this.wait();
    }
    await Promise.all(this.active);
  }
}
