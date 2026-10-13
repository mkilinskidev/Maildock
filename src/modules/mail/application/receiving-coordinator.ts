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
type Config = Readonly<{
  connection: ProviderConnection;
  executor: ReceivingExecutor;
  owner: ReceivingOwner;
  account: string;
  mailbox: string;
  authority: Readonly<{
    assertCurrent: () => void;
    /** Isolated integration supplies renewal using Stage 1's lease row/owner.
     * Must lock, recheck DB-clock expiry and refuse to revive a fenced owner.
     * Runs inside a bounded Stage 1 transaction, before opening IMAP. */
    renew: (db: ReceivingDatabase, owner: ReceivingOwner) => Promise<void>;
  }>;
  timing?: Partial<Record<keyof typeof RECEIVING_COORDINATOR_DEFAULTS, number>>;
  createClient?: Parameters<typeof fetchInboxMetadataWindow>[3];
  /** Synchronous diagnostics only; authoritative progress is in PostgreSQL. */
  onTurn?: (kind: "fresh" | "history", turn: Turn) => void;
  onError?: (error: unknown, retryMs: number) => void;
}>;

/** Unwired, single-use account/INBOX lifetime. Serial loop owns C=1 and each
 * adapter invocation destroys its client before admitting PostgreSQL writes.
 * Caller owns the supplied executor; stop cancels only this lifetime's scopes. */
export class ReceivingCoordinator {
  private readonly config: Config;
  private readonly timing;
  private readonly cancellation = new AbortController();
  private lifetime?: Promise<void>;
  private state?: ReceivingState;
  private freshDue = 0;

  constructor(config: Config) {
    this.config = {
      ...config,
      connection: structuredClone(config.connection),
      owner: { ...config.owner },
      authority: { ...config.authority },
    };
    this.timing = { ...RECEIVING_COORDINATOR_DEFAULTS, ...config.timing };
    for (const value of Object.values(this.timing))
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error("Invalid receiving coordinator timing");
    if (
      this.timing.operationMs > 10_000 ||
      this.timing.maxRetryMs < this.timing.retryMs
    )
      throw new Error("Invalid receiving coordinator deadline/backoff");
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

  private assertCurrent = () => {
    if (this.cancellation.signal.aborted)
      throw new Error("Receiving coordinator stopped");
    this.config.authority.assertCurrent();
  };

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
        this.assertCurrent();
        const deadline = performance.now() + this.timing.operationMs;
        await this.config.executor.transaction(
          async (db) => {
            this.assertCurrent();
            await this.config.authority.renew(db, this.config.owner);
            this.assertCurrent();
          },
          {
            deadline: Math.min(deadline, performance.now() + 2000),
            signal: this.cancellation.signal,
          },
        );
        this.assertCurrent();
        const turn = await receiveInboxTurn(
          {
            ...this.config,
            options: {
              kind,
              deadline,
              signal: this.cancellation.signal,
              assertCurrent: this.assertCurrent,
            },
          },
          this.config.createClient,
        );
        this.state = turn.state;
        if (kind === "fresh")
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
