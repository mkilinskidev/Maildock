import {
  runReceivingOperation,
  validateReceivingOperation,
  type ReceivingOperation,
  type ReceivingOperationBoundary,
  type ReceivingOperationHandlers,
  type ReceivingOperationKind,
  type ReceivingOperationResult,
} from "./receiving-operation";
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
type MailboxRotation = "inbox" | "secondary" | "history";
type Pending = {
  at: number;
  operation: ReceivingOperation;
  resolve: (result: ReceivingOperationResult) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};
type AccountConfig = Omit<ReceivingCoordinatorConfig, "executor">;
type Account = {
  retired?: boolean;
  config: ReceivingCoordinatorConfig;
  timing: ReturnType<typeof receivingTiming>;
  active: boolean;
  freshDue: number;
  retryAt: number;
  retryMs: number;
  historySince?: number;
  initialFreshGranted: boolean;
  wakeGeneration: number;
};
export type ReceivingAdmission = Readonly<{
  account: string;
  kind: ReceivingWorkKind | ReceivingOperationKind;
  protectedHistory: boolean;
  waitMs: number;
  active: number;
  at: number;
}>;

/** Isolated, single-use shared selector. Typed user/maintenance units share the
 * current-priority selection boundary, account locks and global allocations;
 * submitters cannot provide execution callbacks.
 * Caller owns one shared Stage 1 executor and its independent DB capacity. */
export class ReceivingScheduler {
  private readonly accounts: Account[];
  private readonly config;
  private readonly limit: number;
  private readonly historyLimit: number;
  private activeHistory = 0;
  private readonly cancellation = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private lifetime?: Promise<void>;
  private wake?: () => void;
  private freshCursor = 0;
  private historyCursor = 0;
  private readonly mailboxCursors = new Map<
    string,
    Record<MailboxRotation, string> & { lastInbox: boolean }
  >();
  private readonly lastAccount: Partial<Record<ReceivingWorkKind, string>> = {};
  private lastProtected = false;
  private protectedActive = false;
  private readonly pending: Pending[] = [];
  private readonly activeIdentities = new Set<string>();
  private lastUser = false;
  private readonly requests = new Set<string>();

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
      /** Elected lifecycle validates DB ownership before allocating a turn. */
      beforeAdmission?: () => Promise<boolean>;
      operations?: Readonly<{
        boundary: ReceivingOperationBoundary;
        handlers: ReceivingOperationHandlers;
      }>;
      /** Elected lifetimes reserve one aggregate SQL admission for control. */
      controlHeadroom?: boolean;
    }>,
  ) {
    this.config = {
      ...input,
      operations: input.operations
        ? {
            ...input.operations,
            handlers: Object.freeze({ ...input.operations.handlers }),
          }
        : undefined,
      tuning: { ...RECEIVING_SCHEDULER_DEFAULTS, ...input.tuning },
    };
    for (const value of Object.values(this.config.tuning))
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error("Invalid receiving scheduler configuration");
    if (
      this.config.tuning.workers > 16 ||
      this.config.tuning.maxAccounts > 128 ||
      new Set(input.accounts.map((a) => a.account)).size >
        this.config.tuning.maxAccounts ||
      this.config.tuning.historyTurnMs > 10_000
    )
      throw new Error("Receiving scheduler capacity/deadline exceeded");
    const identities = new Set(
      input.accounts.map((a) => `${a.account}:${a.mailbox}`),
    );
    if (identities.size !== input.accounts.length)
      throw new Error("Duplicate receiving mailbox");
    this.validateMembership(input.accounts);
    // Each active turn can request at most one DB transaction at a time.
    // D executing plus D queued permits 2D-1 data admissions and one serialized
    // control request. This reserves aggregate headroom, not a running lane.
    this.limit = Math.min(
      this.config.tuning.workers,
      2 * input.executor.capacity -
        ((input.controlHeadroom ?? !!input.operations) ? 1 : 0),
    );
    // History has only two seconds INCLUDING network and SQL queue time.
    // While it runs, bound data to D so a third publication cannot consume
    // that lifetime waiting behind two others. Keep excess work in selection,
    // before its deadline begins; current/user-only rotation retains 2D-1.
    this.historyLimit =
      (input.controlHeadroom ?? !!input.operations)
        ? Math.min(this.limit, input.executor.capacity)
        : this.limit;
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
        initialFreshGranted: false,
        wakeGeneration: 0,
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
    if (!this.lifetime) {
      for (const pending of this.pending.splice(0)) {
        this.requests.delete(pending.operation.requestId);
        pending.cleanup();
        pending.reject(new Error("Receiving owner retired"));
      }
    }
    await this.lifetime;
  }

  /** Bounded local hint; neither completion nor durable demand acknowledgment. */
  notify(accountId: string, mailboxId?: string): void {
    if (this.cancellation.signal.aborted) return;
    for (const account of this.accounts.filter(
      (a) =>
        a.config.account === accountId &&
        (!mailboxId || a.config.mailbox === mailboxId),
    )) {
      account.wakeGeneration++;
      account.freshDue = performance.now();
    }
    this.wake?.();
  }

  /** Refresh only captured membership, preserving healthy fairness/backoff state.
   * Retired active allocations keep C until their original work has settled. */
  reconcileAccounts(configs: readonly AccountConfig[]): void {
    this.validateMembership(configs);
    const membership = new Map(
      configs.map((c) => [`${c.account}:${c.mailbox}`, c]),
    );
    for (const current of this.accounts) {
      const next = membership.get(
        `${current.config.account}:${current.config.mailbox}`,
      );
      current.retired =
        !next ||
        next.mailbox !== current.config.mailbox ||
        next.configurationVersion !== current.config.configurationVersion ||
        next.receivingLifecycleVersion !==
          current.config.receivingLifecycleVersion;
    }
    for (let i = this.accounts.length - 1; i >= 0; i--)
      if (this.accounts[i].retired && !this.accounts[i].active)
        this.accounts.splice(i, 1);
    const retained = new Set(
      this.accounts.map((a) => `${a.config.account}:${a.config.mailbox}`),
    );
    for (const config of configs) {
      if (retained.has(`${config.account}:${config.mailbox}`)) continue;
      const timing = receivingTiming(config.timing);
      this.accounts.push({
        config: {
          ...config,
          connection: structuredClone(config.connection),
          executor: this.config.executor,
        },
        timing,
        active: false,
        freshDue: performance.now(),
        retryAt: 0,
        retryMs: timing.retryMs,
        initialFreshGranted: false,
        wakeGeneration: 0,
      });
    }
    for (const id of this.mailboxCursors.keys())
      if (!configs.some((c) => c.account === id))
        this.mailboxCursors.delete(id);
    this.wake?.();
  }

  private validateMembership(configs: readonly AccountConfig[]) {
    const counts = new Map<string, number>();
    const identities = new Set<string>();
    for (const config of configs) {
      counts.set(config.account, (counts.get(config.account) ?? 0) + 1);
      identities.add(`${config.account}:${config.mailbox}`);
    }
    if (
      counts.size > this.config.tuning.maxAccounts ||
      identities.size !== configs.length ||
      [...counts.values()].some((n) => n > 128)
    )
      throw new Error("Receiving candidate capacity exceeded");
  }

  /** Typed bounded memory admission, never a second executing route. */
  submit(operation: ReceivingOperation): Promise<ReceivingOperationResult> {
    try {
      validateReceivingOperation(operation);
      if (
        this.cancellation.signal.aborted ||
        !this.config.operations?.handlers[operation.kind]
      )
        throw new Error("Receiving operation unavailable");
      if (
        this.pending.length + this.active.size >=
        this.config.tuning.maxAccounts
      )
        throw new Error("Receiving pending capacity exceeded");
      if (this.requests.has(operation.requestId))
        throw new Error("Duplicate receiving request");
    } catch (error) {
      return Promise.reject(error);
    }
    // Capture caller-owned input while keeping AbortSignal out of cloning.
    const copy = structuredClone({ ...operation, signal: undefined });
    Object.freeze(copy.identity);
    if (copy.diagnosticConnection) {
      Object.freeze(copy.diagnosticConnection.credential);
      Object.freeze(copy.diagnosticConnection);
    }
    const captured = Object.freeze({
      ...copy,
      signal: operation.signal,
    }) as ReceivingOperation;
    return new Promise<ReceivingOperationResult>((resolve, reject) => {
      this.requests.add(operation.requestId);
      const cancel = () => {
        const index = this.pending.indexOf(pending);
        if (index < 0) return; // active operation retains capacity until settlement
        this.pending.splice(index, 1);
        this.requests.delete(operation.requestId);
        pending.cleanup();
        reject(new Error("Receiving pending operation cancelled or expired"));
        this.wake?.();
      };
      const timer = setTimeout(
        cancel,
        Math.max(0, operation.deadline - performance.now()),
      );
      const pending: Pending = {
        at: performance.now(),
        operation: captured,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          operation.signal?.removeEventListener("abort", cancel);
        },
      };
      this.pending.push(pending);
      operation.signal?.addEventListener("abort", cancel, { once: true });
      if (operation.signal?.aborted) cancel();
      this.wake?.();
    });
  }

  private identity(operation: ReceivingOperation) {
    return "account" in operation.identity
      ? operation.identity.account
      : `ephemeral:${operation.identity.ephemeral}`;
  }

  get snapshot() {
    return Object.freeze({
      active: this.active.size,
      pending: this.pending.length,
      accounts: new Set(this.accounts.map((a) => a.config.account)).size,
      mailboxes: this.accounts.length,
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
    // INBOX gets the first current opportunity, then one rotating secondary
    // opportunity even while INBOX continuously has new UIDs. History keeps
    // its existing independent age/protection and SQL admission policy.
    if (
      this.accounts.some(
        (a) => a.config.mailboxPath && a.config.mailboxPath !== "INBOX",
      )
    ) {
      // Rotate accounts before choosing that account's mailbox category. A
      // different account's INBOX completion must not consume its secondary
      // opportunity, and each category retains its own mailbox UUID cursor.
      const ids = [...new Set(candidates.map((a) => a.config.account))].sort();
      const id =
        ids.find((value) => value > (this.lastAccount[kind] ?? "")) ?? ids[0];
      if (!id) return;
      this.lastAccount[kind] = id;
      candidates = candidates.filter((a) => a.config.account === id);
      const cursors = this.mailboxCursors.get(id) ?? {
        inbox: "",
        secondary: "",
        history: "",
        lastInbox: false,
      };
      if (kind === "fresh") {
        const inbox = candidates.filter(
          (a) => !a.config.mailboxPath || a.config.mailboxPath === "INBOX",
        );
        const secondary = candidates.filter(
          (a) => a.config.mailboxPath && a.config.mailboxPath !== "INBOX",
        );
        candidates =
          inbox.length && (!cursors.lastInbox || !secondary.length)
            ? inbox
            : secondary.length
              ? secondary
              : inbox;
      }
      const rotation: MailboxRotation =
        kind === "history"
          ? "history"
          : candidates[0]?.config.mailboxPath &&
              candidates[0].config.mailboxPath !== "INBOX"
            ? "secondary"
            : "inbox";
      const ordered = candidates.toSorted((a, b) =>
        a.config.mailbox.localeCompare(b.config.mailbox),
      );
      const chosen =
        ordered.find((a) => a.config.mailbox > cursors[rotation]) ?? ordered[0];
      cursors[rotation] = chosen.config.mailbox;
      if (kind === "fresh") cursors.lastInbox = rotation === "inbox";
      this.mailboxCursors.set(id, cursors);
      candidates = [chosen];
    }
    const cursor = kind === "fresh" ? this.freshCursor : this.historyCursor;
    for (let offset = 0; offset < this.accounts.length; offset++) {
      const index = (cursor + offset) % this.accounts.length;
      const account = this.accounts[index];
      if (!candidates.includes(account)) continue;
      if (kind === "fresh") {
        this.freshCursor = (index + 1) % this.accounts.length;
      } else this.historyCursor = (index + 1) % this.accounts.length;
      return account;
    }
  }

  private select(now: number) {
    const available = this.accounts.filter(
      (a) =>
        !a.retired &&
        !a.active &&
        !this.activeIdentities.has(a.config.account) &&
        a.retryAt <= now,
    );
    const fresh = available.filter((a) => a.freshDue <= now);
    // Grant each runnable startup account its first current opportunity before
    // any ordinary or protected history. Admission, not successful completion,
    // satisfies the barrier: an unavailable account enters its own backoff.
    const startup = fresh.filter(
      (a) =>
        !a.initialFreshGranted &&
        (!a.config.mailboxPath || a.config.mailboxPath === "INBOX"),
    );
    if (startup.length)
      return {
        account: this.rotate(startup, "fresh")!,
        kind: "fresh" as const,
        protectedHistory: false,
      };
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
    const hasUser = this.pending.some(
      (p) =>
        !this.activeIdentities.has(this.identity(p.operation)) &&
        !this.accounts.some(
          (a) => a.config.account === this.identity(p.operation) && a.active,
        ),
    );
    // Protected history precedes current/user rotation and retains the accepted
    // age, fresh-wait guard, tie rotation and no-consecutive-exception rules.
    if (
      (fresh.length || hasUser) &&
      !this.lastProtected &&
      !this.protectedActive &&
      protectedCandidates.length
    ) {
      if (this.active.size >= this.historyLimit) return;
      const oldestHistorySince = Math.min(
        ...protectedCandidates.map((a) => a.historySince!),
      );
      return {
        account: this.rotate(
          protectedCandidates.filter(
            (a) => a.historySince === oldestHistorySince,
          ),
          "history",
        )!,
        kind: "history" as const,
        protectedHistory: true,
      };
    }
    const pending = this.pending.find(
      (p) =>
        !this.activeIdentities.has(this.identity(p.operation)) &&
        !this.accounts.some(
          (a) => a.config.account === this.identity(p.operation) && a.active,
        ),
    );
    if (pending && (!fresh.length || !this.lastUser)) return { pending };
    if (fresh.length)
      return {
        account: this.rotate(fresh, "fresh")!,
        kind: "fresh" as const,
        protectedHistory: false,
      };
    if (history.length) {
      if (this.active.size >= this.historyLimit) return;
      return {
        account: this.rotate(history, "history")!,
        kind: "history" as const,
        protectedHistory: false,
      };
    }
  }

  private admit(
    selection: NonNullable<ReturnType<ReceivingScheduler["select"]>>,
  ) {
    if (selection.pending) {
      this.admitOperation(selection.pending);
      return;
    }
    const { account, kind, protectedHistory } = selection;
    if (kind === "history") this.activeHistory++;
    this.lastUser = false;
    const wakeGeneration = account.wakeGeneration;
    const at = performance.now();
    account.active = true;
    this.activeIdentities.add(account.config.account);
    if (kind === "fresh") account.initialFreshGranted = true;
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
        if (kind === "fresh" || turn.identityTransition)
          account.freshDue =
            turn.moreFresh || account.wakeGeneration !== wakeGeneration
              ? now
              : now + account.timing.pollMs;
        account.retryMs = account.timing.retryMs;
        account.retryAt = 0;
        account.historySince =
          turn.state.historyBefore > 1n
            ? kind === "history"
              ? now
              : (account.historySince ?? now)
            : undefined;
        if (turn.identityTransition) {
          // Replacement is a recovery boundary. Even an aged history exception
          // must wait for this identity's first current opportunity.
          account.initialFreshGranted = false;
          account.historySince = undefined;
        }
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
          account.initialFreshGranted = false;
          account.retryMs = Math.min(account.timing.maxRetryMs, retry * 2);
          this.diagnostic(() => account.config.onError?.(error, retry));
        }
      } finally {
        this.activeIdentities.delete(account.config.account);
        if (kind === "history") this.activeHistory--;
        if (protectedHistory) this.protectedActive = false;
        this.wake?.();
      }
    });
    this.active.add(task);
    this.diagnostic(() => this.config.onAdmission?.(admission));
  }

  private admitOperation(pending: Pending) {
    this.pending.splice(this.pending.indexOf(pending), 1);
    pending.cleanup();
    const operation = pending.operation;
    const identity = this.identity(operation);
    this.activeIdentities.add(identity);
    this.lastUser = true;
    if (!this.accounts.some((a) => a.freshDue <= performance.now()))
      this.lastProtected = false;
    const at = performance.now();
    const task = Promise.resolve().then(async () => {
      try {
        const { boundary, handlers } = this.config.operations!;
        const result = await runReceivingOperation(
          operation,
          boundary,
          handlers[operation.kind]!,
          this.cancellation.signal,
        );
        pending.resolve(result);
      } catch (error) {
        pending.reject(error);
      } finally {
        this.requests.delete(operation.requestId);
        this.activeIdentities.delete(identity);
        this.active.delete(task);
        this.wake?.();
      }
    });
    this.active.add(task);
    this.diagnostic(() =>
      this.config.onAdmission?.({
        account: identity,
        kind: operation.kind,
        protectedHistory: false,
        waitMs: at - pending.at,
        active: this.active.size,
        at,
      }),
    );
  }

  private get dataLimit() {
    return this.activeHistory ? this.historyLimit : this.limit;
  }

  private async wait() {
    const now = performance.now();
    const next = Math.min(
      ...this.accounts
        .filter(
          (a) =>
            !a.retired &&
            !a.active &&
            !this.activeIdentities.has(a.config.account),
        )
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
      if (this.active.size < this.dataLimit && Number.isFinite(next))
        timer = setTimeout(done, Math.max(1, next - now));
      if (this.cancellation.signal.aborted) done();
    });
  }

  private async run() {
    while (!this.cancellation.signal.aborted) {
      while (
        !this.cancellation.signal.aborted &&
        this.active.size < this.dataLimit
      ) {
        const selection = this.select(performance.now());
        if (!selection) break;
        if (this.config.beforeAdmission) {
          let allowed = false;
          try {
            allowed = await this.config.beforeAdmission();
          } catch {
            // Failed/unknown authority is fail-closed, not account backoff.
          }
          if (!allowed) this.cancellation.abort();
          if (this.cancellation.signal.aborted) break;
        }
        // Cancellation/deadline may remove a queued unit during renewal.
        // Never splice another request or revive the removed selection.
        if (
          selection.account?.retired ||
          (selection.pending && !this.pending.includes(selection.pending))
        )
          continue;
        this.admit(selection);
      }
      if (!this.cancellation.signal.aborted) await this.wait();
    }
    for (const pending of this.pending.splice(0)) {
      this.requests.delete(pending.operation.requestId);
      pending.cleanup();
      pending.reject(new Error("Receiving owner retired"));
    }
    await Promise.all(this.active);
  }
}
