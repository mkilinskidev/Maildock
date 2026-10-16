import { ImapFlow } from "imapflow";
import type { ProviderConnection } from "../../accounts/domain/mail-provider";
import type { fetchInboxMetadataWindow } from "../../accounts/infrastructure/imap-metadata-window";
import type {
  ReceivingOwner,
  ReceivingState,
} from "../../../shared/infrastructure/database/receiving-authority";
import type {
  ReceivingDatabase,
  ReceivingExecutor,
} from "../../../shared/infrastructure/database/receiving-executor";
import { receiveInboxTurn } from "./receiving-inbox-turn";

export const RECEIVING_COORDINATOR_DEFAULTS = Object.freeze({
  pollMs: 15_000,
  operationMs: 10_000,
  retryMs: 1_000,
  maxRetryMs: 30_000,
});
type Turn = Awaited<ReturnType<typeof receiveInboxTurn>>;
export type ReceivingCoordinatorConfig = Readonly<{
  connection: ProviderConnection;
  resolveConnection?: (budget: {
    deadline: number;
    signal: AbortSignal;
  }) => Promise<ProviderConnection>;
  executor: ReceivingExecutor;
  owner: ReceivingOwner;
  account: string;
  configurationVersion?: bigint;
  receivingLifecycleVersion?: bigint;
  bootstrap?: boolean;
  mailbox: string;
  authority: Readonly<{
    assertCurrent: () => void;
    /** Locked DB-clock authority check before opening IMAP. Stage 3 fixtures
     * also renew here; Stage 4B renews at shared scheduler admission and uses
     * this callback only to validate the same term under a SHARE lock. */
    renew: (db: ReceivingDatabase, owner: ReceivingOwner) => Promise<void>;
  }>;
  timing?: Partial<Record<keyof typeof RECEIVING_COORDINATOR_DEFAULTS, number>>;
  createClient?: Parameters<typeof fetchInboxMetadataWindow>[3];
  /** Synchronous diagnostics only; authoritative progress is in PostgreSQL. */
  onTurn?: (kind: "fresh" | "history", turn: Turn) => void;
  onError?: (error: unknown, retryMs: number) => void;
}>;

export function receivingTiming(timing?: ReceivingCoordinatorConfig["timing"]) {
  const result = { ...RECEIVING_COORDINATOR_DEFAULTS, ...timing };
  for (const value of Object.values(result))
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new Error("Invalid receiving coordinator timing");
  if (result.operationMs > 10_000 || result.maxRetryMs < result.retryMs)
    throw new Error("Invalid receiving coordinator deadline/backoff");
  return result;
}

/** One reusable operation; admission belongs exclusively to its caller. No
 * autonomous loop, callback-created connection or retained interval here. */
export async function runOneReceivingTurn(
  config: ReceivingCoordinatorConfig,
  kind: "fresh" | "history",
  deadline: number,
  signal: AbortSignal,
) {
  const assertCurrent = () => {
    if (signal.aborted || performance.now() >= deadline)
      throw new Error("Receiving turn stopped or expired");
    config.authority.assertCurrent();
  };
  assertCurrent();
  await config.executor.transaction(
    async (db) => {
      assertCurrent();
      await config.authority.renew(db, config.owner);
      assertCurrent();
    },
    { deadline: Math.min(deadline, performance.now() + 2000), signal },
  );
  assertCurrent();
  const connection = config.resolveConnection
    ? await config.resolveConnection({ deadline, signal })
    : config.connection;
  assertCurrent();
  let constructed = false;
  return receiveInboxTurn(
    {
      ...config,
      connection,
      pollMs: receivingTiming(config.timing).pollMs,
      options: { kind, deadline, signal, assertCurrent },
    },
    (options) => {
      assertCurrent();
      if (constructed)
        throw new Error("Receiving turn cannot open another socket");
      constructed = true;
      return (config.createClient ?? ((opts) => new ImapFlow(opts)))(options);
    },
  );
}

/** Unwired, single-use account/INBOX lifetime. Serial loop owns C=1 and each
 * adapter invocation destroys its client before admitting PostgreSQL writes.
 * Caller owns the supplied executor; stop cancels only this lifetime's scopes. */
export class ReceivingCoordinator {
  private readonly config: ReceivingCoordinatorConfig;
  private readonly timing;
  private readonly cancellation = new AbortController();
  private lifetime?: Promise<void>;
  private state?: ReceivingState;
  private freshDue = 0;

  constructor(config: ReceivingCoordinatorConfig) {
    this.config = {
      ...config,
      connection: structuredClone(config.connection),
      owner: { ...config.owner },
      authority: { ...config.authority },
    };
    this.timing = receivingTiming(config.timing);
  }

  start(): void {
    if (this.lifetime || this.cancellation.signal.aborted)
      throw new Error(
        "Receiving coordinator lifetime already started or stopped",
      );
    this.lifetime = this.run();
  }

  async stop(): Promise<void> {
    this.cancellation.abort();
    await this.lifetime;
  }

  private async wait(ms: number) {
    const signal = this.cancellation.signal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private async run() {
    let retry: number = this.timing.retryMs;
    while (!this.cancellation.signal.aborted) {
      const kind = performance.now() >= this.freshDue ? "fresh" : "history";
      if (
        kind === "history" &&
        (!this.state || this.state.historyBefore === 1n)
      ) {
        await this.wait(this.freshDue - performance.now());
        continue;
      }
      try {
        const deadline = performance.now() + this.timing.operationMs;
        const turn = await runOneReceivingTurn(
          this.config,
          kind,
          deadline,
          this.cancellation.signal,
        );
        this.state = turn.state;
        if (kind === "fresh" || turn.identityTransition)
          this.freshDue = turn.moreFresh
            ? 0
            : performance.now() + this.timing.pollMs;
        retry = this.timing.retryMs;
        this.config.onTurn?.(kind, turn);
      } catch (error) {
        if (this.cancellation.signal.aborted) break;
        // Unknown COMMIT, initialization and network failures all force locked
        // recovery and current-first selection, never blind interval replay.
        this.freshDue = 0;
        this.config.onError?.(error, retry);
        await this.wait(retry);
        retry = Math.min(this.timing.maxRetryMs, retry * 2);
      }
    }
  }
}
