import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ReceivingOwner } from "../../../shared/infrastructure/database/receiving-authority";
import type {
  ReceivingDatabase,
  ReceivingExecutor,
} from "../../../shared/infrastructure/database/receiving-executor";
import type { ReceivingCoordinatorConfig } from "./receiving-coordinator";
import type { ReceivingWakeTarget } from "./receiving-demand";
import { ReceivingScheduler } from "./receiving-scheduler";

type Candidate = Readonly<{
  account: string;
  mailbox: string;
  /** Snapshot hints only. Every turn reloads F/E under Stage 1 locks. Startup
   * grants fresh even for quiet/history-only accounts to repair missed hints. */
  due: boolean;
  historyPending: boolean;
}>;
type Account = Omit<
  ReceivingCoordinatorConfig,
  "executor" | "owner" | "authority"
>;
type SchedulerInput = ConstructorParameters<typeof ReceivingScheduler>[0];

/** Unwired Stage 4B lifetime. One shared selector per elected generation.
 * A lost lifetime is terminal; restart constructs a new actor and reloads DB.
 * Stage 4C owns worker registration, readiness and periodic election retries. */
export class ElectedReceivingCoordinator implements ReceivingWakeTarget {
  private phase: "follower" | "acquiring" | "owner" | "lost" | "stopped" =
    "follower";
  private readonly actor = randomUUID();
  private owner?: ReceivingOwner;
  private scheduler?: ReceivingScheduler;
  private readonly cancellation = new AbortController();
  private expiresAt = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private election?: Promise<boolean>;
  private renewal?: Promise<boolean>;
  private retirement?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly ttlMs: number;

  constructor(
    private readonly config: Readonly<{
      executor: ReceivingExecutor;
      leaseMs?: number;
      maxAccounts?: number;
      /** Resolve credentials/config from this bounded DB snapshot. No IMAP or
       * network work; callback receives only the revocable Stage 1 SQL scope. */
      loadAccount: (
        db: ReceivingDatabase,
        candidate: Candidate,
      ) => Promise<Account>;
      tuning?: SchedulerInput["tuning"];
      historyAllowed?: SchedulerInput["historyAllowed"];
      onAdmission?: SchedulerInput["onAdmission"];
    }>,
  ) {
    this.ttlMs = config.leaseMs ?? 30_000;
    const max = config.maxAccounts ?? 128;
    if (
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 100 ||
      this.ttlMs > 60_000 ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > 128
    )
      throw new Error("Invalid receiving election configuration");
  }

  get snapshot() {
    return Object.freeze({
      phase: this.phase,
      owner: this.owner ? { ...this.owner } : undefined,
      scheduler: this.scheduler?.snapshot,
    });
  }

  private budget() {
    return {
      deadline: performance.now() + Math.min(2000, this.ttlMs),
      signal: this.cancellation.signal,
    };
  }

  private assertCurrent = () => {
    if (
      this.phase !== "owner" ||
      this.cancellation.signal.aborted ||
      performance.now() >= this.expiresAt
    ) {
      this.lose();
      throw new Error("Receiving coordinator ownership lost");
    }
  };

  private armExpiry(started: number) {
    // Database extends expiry after its lock. Using request START plus TTL is
    // conservative, including delayed replies. Never trust local wall time.
    this.expiresAt = started + this.ttlMs;
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => this.lose(),
      Math.max(0, this.expiresAt - performance.now()),
    );
  }

  private lose() {
    if (this.phase === "lost" || this.phase === "stopped") return;
    this.phase = "lost";
    this.cancellation.abort();
    clearTimeout(this.expiry);
    clearTimeout(this.heartbeat);
    // stop() aborts adapter sockets and transaction scopes synchronously, then
    // awaits local retirement. PostgreSQL locks still establish server order.
    this.retirement = this.scheduler?.stop() ?? Promise.resolve();
  }

  elect(): Promise<boolean> {
    if (this.phase === "acquiring") return this.election!;
    if (this.phase !== "follower") return Promise.resolve(false);
    this.phase = "acquiring";
    this.election = this.acquire();
    return this.election;
  }

  private async acquire(): Promise<boolean> {
    const started = performance.now();
    try {
      const generation = await this.config.executor.transaction(async (db) => {
        const [row] = await db.execute(
          sql`select maildock_receiving_acquire(${this.actor}::uuid,${this.ttlMs}) as generation`,
        );
        return row.generation === null
          ? null
          : BigInt(row.generation as string);
      }, this.budget());
      if (generation === null) {
        if (!this.cancellation.signal.aborted) this.phase = "follower";
        return false;
      }
      this.owner = { actor: this.actor, generation };
      if (this.cancellation.signal.aborted) return false;
      this.phase = "owner";
      this.armExpiry(started);
      this.assertCurrent();
      const owner = this.owner;
      const accounts = await this.config.executor.transaction(async (db) => {
        await this.validate(db, owner);
        const max = this.config.maxAccounts ?? 128;
        const rows = await db.execute(sql`
          select a.id as account, m.id as mailbox,
            (a.receiving_due_at<=clock_timestamp() or m.receiving_due_at<=clock_timestamp()
              or s.mailbox_id is null) as due,
            coalesce(s.history_before>1,false) as history_pending
          from mail_accounts a join mailboxes m on m.account_id=a.id
          left join receiving_mailboxes s on s.mailbox_id=m.id
          where a.enabled and m.remote_path='INBOX' and m.selectable and m.lifecycle_status='active'
          order by a.id limit ${max + 1}`);
        if (rows.length > max)
          throw new Error("Receiving candidate capacity exceeded");
        const result: Account[] = [];
        for (const row of rows) {
          this.assertCurrent();
          const candidate = {
            account: row.account as string,
            mailbox: row.mailbox as string,
            due: row.due === true,
            historyPending: row.history_pending === true,
          };
          const account = await this.config.loadAccount(db, candidate);
          if (
            account.account !== candidate.account ||
            account.mailbox !== candidate.mailbox
          )
            throw new Error("Receiving candidate identity mismatch");
          result.push(account);
        }
        return result;
      }, this.budget());
      this.assertCurrent();
      this.scheduler = new ReceivingScheduler({
        ...this.config,
        accounts: accounts.map((account) => ({
          ...account,
          owner,
          authority: {
            assertCurrent: this.assertCurrent,
            renew: (db, current) => this.validate(db, current),
          },
        })),
        beforeAdmission: () => this.renew(),
      });
      this.scheduler.start();
      this.scheduleHeartbeat();
      return true;
    } catch (error) {
      this.lose();
      throw error; // Uncertain acquisition expires; never blindly reacquire.
    }
  }

  private async validate(db: ReceivingDatabase, owner: ReceivingOwner) {
    this.assertCurrent();
    const [row] = await db.execute(sql`
      select maildock_receiving_validate(${owner.actor}::uuid,${owner.generation}::bigint) as live`);
    if (row.live !== true) {
      this.lose();
      throw new Error("Receiving coordinator fenced by PostgreSQL");
    }
    this.assertCurrent();
  }

  renew(): Promise<boolean> {
    if (this.renewal) return this.renewal;
    if (this.phase !== "owner") return Promise.resolve(false);
    this.renewal = this.extend().finally(() => {
      this.renewal = undefined;
    });
    return this.renewal;
  }

  private async extend() {
    const started = performance.now();
    try {
      this.assertCurrent();
      const owner = this.owner!;
      const live = await this.config.executor.transaction(async (db) => {
        const [row] = await db.execute(
          sql`select maildock_receiving_renew(${owner.actor}::uuid,${owner.generation}::bigint,${this.ttlMs}) as live`,
        );
        return row.live === true;
      }, this.budget());
      this.assertCurrent(); // Delayed reply cannot revive a locally retired term.
      if (!live || started + this.ttlMs <= performance.now()) {
        this.lose();
        return false;
      }
      this.armExpiry(started);
      return true;
    } catch {
      this.lose();
      return false;
    }
  }

  private scheduleHeartbeat() {
    if (this.phase !== "owner") return;
    this.heartbeat = setTimeout(
      () => {
        void this.renew().then((live) => {
          if (live) this.scheduleHeartbeat();
        });
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
  }

  async notify(accountId: string): Promise<void> {
    if (this.phase !== "owner") return; // Follower ACK leaves DB demand intact.
    if (await this.renew()) this.scheduler?.notify(accountId);
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown() {
    this.lose();
    await this.election?.catch(() => undefined);
    await this.renewal;
    await this.retirement;
    // Release only AFTER socket/SQL retirement. Unknown server COMMIT still
    // conflicts with this UPDATE lock; failure leaves lease expiry as fallback.
    if (this.owner) {
      const owner = this.owner;
      await this.config.executor.transaction(
        async (db) => {
          await db.execute(
            sql`select maildock_receiving_release(${owner.actor}::uuid,${owner.generation}::bigint)`,
          );
        },
        { deadline: performance.now() + 2000 },
      );
    }
    this.phase = "stopped";
  }
}
