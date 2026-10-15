import { receivingDiagnosticHandler } from "./receiving-diagnostic";
import { DISPLAY_CONTENT_BYTES } from "../domain/display-content-limits";
import type {
  ReceivingOperation,
  ReceivingOperationHandlers,
  ReceivingOperationBoundary,
  ReceivingDiagnosticRequest,
  ReceivingOperationResult,
} from "./receiving-operation";
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
  bootstrap: boolean;
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
  private readonly controlQueue: {
    run: () => Promise<void>;
    renewal: boolean;
  }[] = [];
  private controlActive = false;
  private flagSelection?: Promise<void>;
  private readonly selectedFlags = new Set<string>();
  private contentSelection?: Promise<void>;
  private readonly selectedContent = new Set<string>();
  private contentCursor?: { at: string; id: string };

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
      diagnosticEndpoint?: string;
      operationHandlers?: ReceivingOperationHandlers;
      /** External credential work. Called only after DB scope settlement. */
      resolveOperationConnection?: (
        operation: ReceivingOperation,
        connection: Account["connection"] & {
          receivingLifecycleVersion?: bigint;
        },
      ) => Promise<Account["connection"]>;
      createOperationClient?: ReceivingOperationBoundary["createClient"];
      /** DB-only captured configuration loader, also supports pre-mailbox bootstrap. */
      loadOperationConnection?: (
        db: ReceivingDatabase,
        account: string,
        configurationVersion: bigint,
      ) => Promise<Account["connection"]>;
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

  submit(operation: ReceivingOperation): Promise<ReceivingOperationResult> {
    if (this.phase !== "owner")
      return Promise.reject(new Error("Receiving owner unavailable"));
    try {
      this.assertCurrent();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.scheduler)
      return Promise.reject(new Error("Receiving owner unavailable"));
    return this.scheduler.submit(operation);
  }

  diagnose(
    request: ReceivingDiagnosticRequest,
  ): Promise<ReceivingOperationResult> {
    if (
      this.phase !== "owner" ||
      request.expectedOwner.actor !== this.owner?.actor ||
      request.expectedOwner.generation !== this.owner?.generation
    )
      return Promise.reject(
        new Error("Receiving diagnostic owner unavailable"),
      );
    return this.submit({
      kind: "diagnostic",
      requestId: request.requestId,
      identity: request.identity,
      deadline: request.deadline,
      signal: request.signal,
      diagnosticConnection: request.connection,
    });
  }

  /** One serialized control admission: renewal, validation and membership share
   * the single reserved position. Waiting here creates no executor admission. */
  private control<T>(
    work: (db: ReceivingDatabase) => Promise<T>,
    options: { deadline: number; signal?: AbortSignal } = this.budget(),
    renewal = false,
  ): Promise<T> {
    if (this.controlQueue.length >= (this.config.maxAccounts ?? 128))
      return Promise.reject(new Error("Receiving control capacity exceeded"));
    return new Promise<T>((resolve, reject) => {
      this.controlQueue.push({
        renewal,
        run: async () => {
          try {
            resolve(await this.config.executor.transaction(work, options));
          } catch (error) {
            reject(error);
          }
        },
      });
      this.drainControl();
    });
  }

  private drainControl() {
    if (this.controlActive || !this.controlQueue.length) return;
    const priority = this.controlQueue.findIndex((item) => item.renewal);
    const [item] = this.controlQueue.splice(priority < 0 ? 0 : priority, 1);
    this.controlActive = true;
    void item.run().finally(() => {
      this.controlActive = false;
      this.drainControl();
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
      const generation = await this.control(async (db) => {
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
      const accounts = await this.control(async (db) => {
        await this.validate(db, owner);
        const max = this.config.maxAccounts ?? 128;
        const rows = await db.execute(sql`
          select a.id as account, a.configuration_version, a.receiving_lifecycle_version, m.id as mailbox,
            (a.receiving_due_at<=clock_timestamp() or m.receiving_due_at<=clock_timestamp()
              or s.mailbox_id is null) as due,
            coalesce(s.history_before>1,false) as history_pending
          from mail_accounts a left join mailboxes m on m.account_id=a.id and m.remote_path='INBOX'
          left join receiving_mailboxes s on s.mailbox_id=m.id
          where a.enabled and (m.id is null or (m.selectable and m.lifecycle_status='active'))
          order by a.id limit ${max + 1}`);
        if (rows.length > max)
          throw new Error("Receiving candidate capacity exceeded");
        const result: Account[] = [];
        for (const row of rows) {
          this.assertCurrent();
          const candidate = {
            account: row.account as string,
            mailbox: (row.mailbox as string | null) ?? randomUUID(),
            bootstrap: row.mailbox === null,
            due: row.due === true,
            historyPending: row.history_pending === true,
          };
          const account = await this.config.loadAccount(db, candidate);
          if (
            account.account !== candidate.account ||
            account.mailbox !== candidate.mailbox
          )
            throw new Error("Receiving candidate identity mismatch");
          const version = BigInt(row.configuration_version as string);
          result.push({
            ...account,
            bootstrap: candidate.bootstrap,
            configurationVersion: version,
            receivingLifecycleVersion: BigInt(
              row.receiving_lifecycle_version as string,
            ),
          });
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
            renew: async (db, current) => {
              await this.validate(db, current);
              await this.validateConfiguration(
                db,
                account.account,
                account.configurationVersion!,
                account.bootstrap ? undefined : account.mailbox,
              );
            },
          },
        })),
        beforeAdmission: () => this.renew(),
        controlHeadroom: true,
        operations: {
          handlers: {
            diagnostic: receivingDiagnosticHandler,
            ...this.config.operationHandlers,
          },
          boundary: {
            owner,
            executor: this.config.executor,
            assertCurrent: this.assertCurrent,
            validate: (operation) => this.operationConnection(operation),
            createClient: this.config.createOperationClient,
          },
        },
      });
      if (this.config.diagnosticEndpoint)
        await this.advertiseDiagnosticEndpoint(this.config.diagnosticEndpoint);
      this.scheduler.start();
      this.scheduleHeartbeat();
      void this.dispatchFlagCommands().catch(() => undefined);
      void this.dispatchContentRequests().catch(() => undefined);
      return true;
    } catch (error) {
      this.lose();
      throw error; // Uncertain acquisition expires; never blindly reacquire.
    }
  }

  private async validateConfiguration(
    db: ReceivingDatabase,
    account: string,
    version: bigint,
    mailbox?: string,
  ) {
    const rows = await db.execute(sql`
      select a.configuration_version,a.receiving_lifecycle_version from mail_accounts a
      where a.id=${account}::uuid and a.enabled and a.configuration_version=${version}::bigint
        and (${mailbox ?? null}::uuid is null or exists (
          select 1 from mailboxes m where m.id=${mailbox ?? null}::uuid and m.account_id=a.id
            and m.selectable and m.lifecycle_status='active')) for share`);
    if (rows.length !== 1)
      throw new Error("Receiving configuration or lifecycle changed");
    this.assertCurrent();
    return BigInt(rows[0].receiving_lifecycle_version as string);
  }

  private async operationConnection(operation: ReceivingOperation) {
    const captured: Account["connection"] & {
      receivingLifecycleVersion?: bigint;
    } = await this.control(
      async (db) => {
        await this.validate(db, this.owner!);
        const identity = operation.identity;
        if ("ephemeral" in identity)
          return structuredClone(operation.diagnosticConnection!);
        const receivingLifecycleVersion = await this.validateConfiguration(
          db,
          identity.account,
          identity.configurationVersion,
          identity.mailbox,
        );
        if (
          identity.receivingLifecycleVersion !== undefined &&
          identity.receivingLifecycleVersion !== receivingLifecycleVersion
        )
          throw new Error("Receiving captured lifecycle changed");
        if (operation.diagnosticConnection)
          return {
            ...structuredClone(operation.diagnosticConnection),
            receivingLifecycleVersion,
          };
        if (!this.config.loadOperationConnection)
          throw new Error(
            "Receiving operation configuration loader unavailable",
          );
        const connection = await this.config.loadOperationConnection(
          db,
          identity.account,
          identity.configurationVersion,
        );
        this.assertCurrent();
        return { ...structuredClone(connection), receivingLifecycleVersion };
      },
      {
        deadline: Math.min(operation.deadline, performance.now() + 2000),
        signal: this.cancellation.signal,
      },
    );
    if (
      !this.config.resolveOperationConnection ||
      operation.diagnosticConnection
    )
      return captured;
    const connection = await this.config.resolveOperationConnection(
      operation,
      captured,
    );
    if (operation.signal?.aborted || performance.now() >= operation.deadline)
      throw new Error("Credential resolution expired");
    await this.control(
      async (db) => {
        await this.validate(db, this.owner!);
        if ("account" in operation.identity) {
          const lifecycle = await this.validateConfiguration(
            db,
            operation.identity.account,
            operation.identity.configurationVersion,
            operation.identity.mailbox,
          );
          if (lifecycle !== captured.receivingLifecycleVersion)
            throw new Error("Receiving credential lifecycle changed");
        }
      },
      {
        deadline: Math.min(operation.deadline, performance.now() + 2000),
        signal: this.cancellation.signal,
      },
    );
    this.assertCurrent();
    return {
      ...connection,
      receivingLifecycleVersion: captured.receivingLifecycleVersion,
    };
  }

  async advertiseDiagnosticEndpoint(endpoint: string | null) {
    this.assertCurrent();
    return this.control(async (db) => {
      const [row] =
        await db.execute(sql`select maildock_receiving_diagnostic_endpoint(
        ${this.owner!.actor}::uuid,${this.owner!.generation}::bigint,${endpoint}) as live`);
      if (row.live !== true) throw new Error("Diagnostic advertisement fenced");
    });
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
      const live = await this.control(
        async (db) => {
          const [row] = await db.execute(
            sql`select maildock_receiving_renew(${owner.actor}::uuid,${owner.generation}::bigint,${this.ttlMs}) as live`,
          );
          return row.live === true;
        },
        this.budget(),
        true,
      );
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
          if (live) {
            this.scheduleHeartbeat();
            void this.dispatchFlagCommands().catch(() => undefined);
            void this.dispatchContentRequests().catch(() => undefined);
          }
        });
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
  }

  async notify(accountId: string): Promise<void> {
    if (this.phase !== "owner") return; // Follower ACK leaves DB demand intact.
    if (await this.renew()) {
      this.scheduler?.notify(accountId);
      await this.dispatchFlagCommands();
      await this.dispatchContentRequests();
    }
  }

  /** One bounded durable selection on the existing control opportunities. The
   * selector still owns admission/fairness; this is neither a queue nor a timer.
   * R16 will bind this isolated elected lifetime to the production worker. */
  dispatchFlagCommands(): Promise<void> {
    if (this.flagSelection) return this.flagSelection;
    if (
      this.phase !== "owner" ||
      !this.config.loadOperationConnection ||
      !this.config.operationHandlers?.store ||
      typeof this.config.operationHandlers.store === "function" ||
      !("flags" in this.config.operationHandlers.store) ||
      !this.config.operationHandlers["exact-lookup"] ||
      typeof this.config.operationHandlers["exact-lookup"] === "function" ||
      !("flags" in this.config.operationHandlers["exact-lookup"])
    )
      return Promise.resolve();
    this.flagSelection = (async () => {
      const rows = await this.control(async (db) => {
        await this.validate(db, this.owner!);
        return db.execute(sql`
          select c.id,c.account_id,c.mailbox_id,c.status,c.source_configuration_binding,a.receiving_lifecycle_version
          from message_commands c join mail_accounts a on a.id=c.account_id
          join mailboxes b on b.id=c.mailbox_id join receiving_mailboxes s on s.mailbox_id=b.id
          where a.enabled and a.removal_requested_at is null and b.selectable and b.lifecycle_status='active'
            and c.action in ('mark_read','mark_unread','flag','unflag')
            and (c.status='pending' or (c.status in ('executing','failed')
              and c.receiving_attempt->>'phase' in ('claimed','uncertain_remote_execution')
              and coalesce((c.receiving_attempt->>'observations')::integer,0)<3))
            and c.source_configuration_binding=a.configuration_version
            and c.source_configuration_binding=s.configuration_binding
            and c.source_uid_validity=s.epoch and c.source_path=b.remote_path
            and maildock_receiving_active_source(c.account_id,c.mailbox_id,c.message_id,
              c.source_uid_validity,c.source_uid,c.source_configuration_binding)
          order by c.created_at,c.id limit 32`);
      });
      this.assertCurrent();
      const accounts = new Set<string>();
      for (const row of rows) {
        const id = String(row.id),
          account = String(row.account_id);
        if (accounts.has(account) || this.selectedFlags.has(id)) continue;
        accounts.add(account);
        this.selectedFlags.add(id);
        void this.submit({
          kind: row.status === "pending" ? "store" : "exact-lookup",
          pendingId: id,
          requestId: randomUUID(),
          deadline: performance.now() + 10_000,
          identity: {
            account,
            mailbox: String(row.mailbox_id),
            configurationVersion: BigInt(
              row.source_configuration_binding as string,
            ),
            receivingLifecycleVersion: BigInt(
              row.receiving_lifecycle_version as string,
            ),
          },
        })
          .catch(() => undefined)
          .finally(() => this.selectedFlags.delete(id));
      }
    })().finally(() => {
      this.flagSelection = undefined;
    });
    return this.flagSelection;
  }

  /** Bounded R02 intent discovery on existing elected control opportunities. */
  dispatchContentRequests(): Promise<void> {
    if (this.contentSelection) return this.contentSelection;
    const handler = this.config.operationHandlers?.["content-slice"];
    if (
      this.phase !== "owner" ||
      !this.config.loadOperationConnection ||
      !handler ||
      typeof handler === "function" ||
      !("content" in handler)
    )
      return Promise.resolve();
    this.contentSelection = (async () => {
      const rows = await this.control(async (db) => {
        await this.validate(db, this.owner!);
        const after = this.contentCursor
          ? sql`and (updated_at,message_id)>(${this.contentCursor.at}::timestamptz,${this.contentCursor.id}::uuid)`
          : sql``;
        return db.execute(sql`with candidates as materialized (
          select message_id,updated_at,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding,receiving_attempt
          from message_contents where status in ('pending','fetching') and source_configuration_binding is not null
          ${after} order by updated_at,message_id limit 32
        ) select c.message_id,c.updated_at::text as cursor_at,c.source_mailbox_id,c.source_configuration_binding,m.account_id,a.receiving_lifecycle_version,
          (a.enabled and a.removal_requested_at is null
            and (c.status='pending' or (c.receiving_attempt->>'phase'='claimed' and coalesce((c.receiving_attempt->>'reads')::integer,1)<3))
            and c.source_configuration_binding=a.configuration_version and c.source_configuration_binding=s.configuration_binding
            and c.source_uid_validity=s.epoch
            and maildock_receiving_visible_resource(c.message_id,c.source_mailbox_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding)) as eligible
          from candidates c left join messages m on m.id=c.message_id
          left join mail_accounts a on a.id=m.account_id left join receiving_mailboxes s on s.mailbox_id=c.source_mailbox_id
          order by c.updated_at,c.message_id`);
      });
      this.assertCurrent();
      const accounts = new Set<string>();
      const last = rows.at(-1);
      this.contentCursor = last
        ? { at: String(last.cursor_at), id: String(last.message_id) }
        : undefined;
      for (const row of rows) {
        if (row.eligible !== true) continue;
        const id = String(row.message_id),
          account = String(row.account_id);
        if (accounts.has(account) || this.selectedContent.has(id)) continue;
        accounts.add(account);
        this.selectedContent.add(id);
        void this.submit({
          kind: "content-slice",
          pendingId: id,
          offset: 0,
          maxBytes: DISPLAY_CONTENT_BYTES,
          requestId: randomUUID(),
          deadline: performance.now() + 10_000,
          identity: {
            account,
            mailbox: String(row.source_mailbox_id),
            configurationVersion: BigInt(
              row.source_configuration_binding as string,
            ),
            receivingLifecycleVersion: BigInt(
              row.receiving_lifecycle_version as string,
            ),
          },
        })
          .catch(() => undefined)
          .finally(() => this.selectedContent.delete(id));
      }
    })().finally(() => {
      this.contentSelection = undefined;
    });
    return this.contentSelection;
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown() {
    this.lose();
    await this.election?.catch(() => undefined);
    await this.renewal;
    await this.flagSelection?.catch(() => undefined);
    await this.contentSelection?.catch(() => undefined);
    await this.retirement;
    // Release only AFTER socket/SQL retirement. Unknown server COMMIT still
    // conflicts with this UPDATE lock; failure leaves lease expiry as fallback.
    if (this.owner) {
      const owner = this.owner;
      await this.control(
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
