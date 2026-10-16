import {
  RECEIVING_ATTACHMENT_BYTES,
  RECEIVING_ATTACHMENT_LIFETIME_MS,
} from "../domain/receiving-attachment-limits";
import { receivingDiagnosticHandler } from "./receiving-diagnostic";
import { DISPLAY_CONTENT_BYTES } from "../domain/display-content-limits";
import { DEFAULT_ATTACHMENT_LIMITS } from "../domain/attachments";
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
  private attachmentSelection?: Promise<void>;
  private readonly selectedAttachments = new Set<string>();
  private attachmentCursor?: { at: string; id: string };
  private contentSelection?: Promise<void>;
  private readonly selectedContent = new Set<string>();
  private contentCursor?: { at: string; id: string };
  private repairSelection?: Promise<void>;
  private repairCursor = new Map<string, { at: string; id: string }>();
  private readonly selectedRepairs = new Set<string>();
  private moveSelection?: Promise<void>;
  private readonly selectedMoves = new Set<string>();
  private moveCursor?: { at: string; id: string };
  private sentSelection?: Promise<void>;
  private readonly selectedSent = new Set<string>();
  private sentCursor?: { at: string; id: string };

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
      void this.dispatchAttachmentRequests().catch(() => undefined);
      void this.dispatchSentCopies().catch(() => undefined);
      void this.dispatchMoveCommands().catch(() => undefined);
      void this.dispatchRepairs().catch(() => undefined);
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
      operation.kind === "repair" ||
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
            void this.dispatchAttachmentRequests().catch(() => undefined);
            void this.dispatchSentCopies().catch(() => undefined);
            void this.dispatchMoveCommands().catch(() => undefined);
            void this.dispatchRepairs().catch(() => undefined);
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
      await this.dispatchAttachmentRequests();
      await this.dispatchSentCopies();
      await this.dispatchMoveCommands();
      await this.dispatchRepairs();
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

  /** At most four indexed pages, one terminal intent repair per account/pass. */
  dispatchRepairs(): Promise<void> {
    if (this.repairSelection) return this.repairSelection;
    const handler = this.config.operationHandlers?.repair;
    if (
      this.phase !== "owner" ||
      !handler ||
      typeof handler === "function" ||
      !("repair" in handler)
    )
      return Promise.resolve();
    this.repairSelection = (async () => {
      const accounts = new Set<string>();
      for (const kind of [
        "command",
        "content",
        "attachment",
        "sent",
      ] as const) {
        const rows = await this.control(async (db) => {
          await this.validate(db, this.owner!);
          const cursor = this.repairCursor.get(kind);
          const relation = sql.identifier(
            kind === "command"
              ? "message_commands"
              : kind === "content"
                ? "message_contents"
                : kind === "attachment"
                  ? "message_attachments"
                  : "outgoing_messages",
          );
          const key = sql.identifier(kind === "content" ? "message_id" : "id");
          const where =
            kind === "sent"
              ? sql`r.status='sent' and r.sent_copy_policy='maildock' and r.sent_copy_status in ('saving','uncertain')`
              : kind === "command"
                ? sql`r.status in ('pending','executing','failed') and r.source_configuration_binding is not null and (r.status<>'failed' or r.receiving_attempt->>'phase' in ('claimed','uncertain_remote_execution'))`
                : sql`r.status in ('pending','fetching') and r.source_configuration_binding is not null`;
          const after = cursor
            ? sql`and (r.updated_at,r.${key})>(${cursor.at}::timestamptz,${cursor.id}::uuid)`
            : sql``;
          const account =
            kind === "command" || kind === "sent"
              ? sql`c.account_id`
              : sql`m.account_id`;
          const messageJoin =
            kind === "command" || kind === "sent"
              ? sql``
              : sql`left join messages m on m.id=c.message_id`;
          const fields =
            kind === "sent"
              ? sql`r.id,r.account_id,r.updated_at,r.receiving_attempt,r.sent_copy_mailbox_id,r.sent_copy_path`
              : kind === "command"
                ? sql`r.id,r.account_id,r.updated_at,r.receiving_attempt,r.mailbox_id,r.message_id,r.source_uid_validity,r.source_uid,r.source_configuration_binding,r.source_path,r.destination_mailbox_id,r.destination_path,r.action`
                : sql`r.${key} as id,r.updated_at,r.receiving_attempt,r.message_id,r.source_mailbox_id,r.source_uid_validity,r.source_uid,r.source_configuration_binding`;
          const exhausted =
            kind === "content" || kind === "attachment"
              ? sql`coalesce((c.receiving_attempt->>'reads')::integer,0)>=3`
              : sql`coalesce((c.receiving_attempt->>'observations')::integer,0)>=3`;
          const sourceObsolete = sql`c.source_configuration_binding is distinct from a.configuration_version or not maildock_receiving_active_source(a.id,${kind === "command" ? sql`c.mailbox_id` : sql`c.source_mailbox_id`},c.message_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding)`;
          const obsolete =
            kind === "sent"
              ? sql`c.receiving_attempt->>'configuration' is distinct from a.configuration_version::text
              or c.receiving_attempt->'sentRole' is distinct from (select to_jsonb(role_row) from mailbox_roles role_row where role_row.account_id=a.id and role_row.role='sent')
              or not exists(select from mailboxes b join receiving_mailboxes s on s.mailbox_id=b.id where b.id=c.sent_copy_mailbox_id and b.account_id=a.id and b.selectable and b.lifecycle_status='active' and b.remote_path=c.sent_copy_path and s.configuration_binding=a.configuration_version and s.epoch::text=c.receiving_attempt->'scopes'->0->'state'->>'epoch')`
              : kind === "command"
                ? sql`${sourceObsolete} or c.source_path is distinct from (select remote_path from mailboxes where id=c.mailbox_id)
              or (c.action in ('archive','trash') and (
                not maildock_receiving_move_destination(a.id,c.action,c.destination_mailbox_id,c.destination_path)
                or (c.receiving_attempt is not null and c.receiving_attempt->'role' is distinct from (select to_jsonb(role_row) from mailbox_roles role_row where role_row.account_id=a.id and role_row.role=c.action))
                or exists(select from jsonb_array_elements(c.receiving_attempt->'scopes') x left join receiving_mailboxes s on s.mailbox_id=(x->>'mailbox')::uuid where s.epoch::text is distinct from x->'state'->>'epoch' or s.configuration_binding is distinct from a.configuration_version)))`
                : sql`${sourceObsolete} or (c.receiving_attempt is not null and c.receiving_attempt->>'path' is distinct from (select remote_path from mailboxes where id=c.source_mailbox_id))`;
          return db.execute(sql`with candidates as materialized (
            select ${fields},r.${key} as repair_id from ${relation} r where ${where}
              and coalesce(r.receiving_attempt->>'phase','')<>'repair_terminal' ${after} order by r.updated_at,r.${key} limit 32
          ) select c.repair_id,c.updated_at::text as cursor_at,a.id as account_id,a.configuration_version,a.receiving_lifecycle_version,
            (a.enabled and a.removal_requested_at is null and (${exhausted} or ${obsolete})) as eligible
            from candidates c ${messageJoin} join mail_accounts a on a.id=${account} order by c.updated_at,c.repair_id`);
        });
        this.assertCurrent();
        const last = rows.at(-1);
        if (last)
          this.repairCursor.set(kind, {
            at: String(last.cursor_at),
            id: String(last.repair_id),
          });
        else this.repairCursor.delete(kind);
        for (const row of rows) {
          const account = String(row.account_id),
            id = String(row.repair_id),
            key = kind + id;
          if (
            !row.eligible ||
            accounts.has(account) ||
            this.selectedRepairs.has(key)
          )
            continue;
          accounts.add(account);
          this.selectedRepairs.add(key);
          void this.submit({
            kind: "repair",
            repairKind: kind,
            pendingId: id,
            requestId: randomUUID(),
            deadline: performance.now() + 10_000,
            identity: {
              account,
              configurationVersion: BigInt(row.configuration_version as string),
              receivingLifecycleVersion: BigInt(
                row.receiving_lifecycle_version as string,
              ),
            },
          })
            .catch(() => undefined)
            .finally(() => this.selectedRepairs.delete(key));
        }
      }
    })().finally(() => {
      this.repairSelection = undefined;
    });
    return this.repairSelection;
  }

  /** Frozen R02 MOVE intents; keyset pagination includes ineligible identities. */
  dispatchMoveCommands(): Promise<void> {
    if (this.moveSelection) return this.moveSelection;
    const handler = this.config.operationHandlers?.move;
    if (
      this.phase !== "owner" ||
      !this.config.loadOperationConnection ||
      !handler ||
      typeof handler === "function" ||
      !("move" in handler)
    )
      return Promise.resolve();
    this.moveSelection = (async () => {
      const rows = await this.control(async (db) => {
        await this.validate(db, this.owner!);
        const after = this.moveCursor
          ? sql`and (c.updated_at,c.id)>(${this.moveCursor.at}::timestamptz,${this.moveCursor.id}::uuid)`
          : sql``;
        return db.execute(sql`with candidates as materialized (
          select c.id,c.updated_at,c.account_id,c.mailbox_id,c.destination_mailbox_id,c.destination_path,c.action,c.receiving_attempt,c.status,c.source_configuration_binding
          from message_commands c where c.action in ('archive','trash') and c.status in ('pending','executing','failed')
            and c.source_configuration_binding is not null and (c.status='pending' or (c.receiving_attempt->>'phase' in ('claimed','uncertain_remote_execution') and coalesce((c.receiving_attempt->>'observations')::integer,0)<3))
            ${after} order by c.updated_at,c.id limit 32
        ) select c.*,c.updated_at::text as cursor_at,a.configuration_version,a.receiving_lifecycle_version,
          (a.enabled and a.removal_requested_at is null) as account_active,
          b.selectable,b.lifecycle_status,b.remote_path,s.epoch,s.configuration_binding,r.mailbox_id as mapped_destination,
          maildock_receiving_move_destination(c.account_id,c.action,c.destination_mailbox_id,c.destination_path) as destination_available
          from candidates c join mail_accounts a on a.id=c.account_id
          left join mailboxes b on b.id=c.destination_mailbox_id and b.account_id=c.account_id
          left join receiving_mailboxes s on s.mailbox_id=b.id
          left join mailbox_roles r on r.account_id=c.account_id and r.role=c.action order by c.updated_at,c.id`);
      });
      this.assertCurrent();
      const last = rows.at(-1);
      this.moveCursor = last
        ? { at: String(last.cursor_at), id: String(last.id) }
        : undefined;
      const accounts = new Set<string>();
      for (const row of rows) {
        const id = String(row.id),
          account = String(row.account_id);
        if (
          !row.account_active ||
          accounts.has(account) ||
          this.selectedMoves.has(id)
        )
          continue;
        accounts.add(account);
        this.selectedMoves.add(id);
        const available =
          row.destination_available &&
          row.selectable &&
          row.lifecycle_status === "active" &&
          row.remote_path === row.destination_path &&
          row.mapped_destination === row.destination_mailbox_id;
        const current =
          row.configuration_version === row.source_configuration_binding;
        const selected =
          row.epoch && row.configuration_binding === row.configuration_version;
        const marker = row.receiving_attempt as Record<string, unknown> | null;
        const obsolete = !available || !current;
        const operation = obsolete
          ? {
              kind: "repair" as const,
              pendingId: id,
              repairKind: "command" as const,
            }
          : !selected && !marker
            ? {
                kind: "select" as const,
                role: row.action as "archive" | "trash",
              }
            : marker
              ? {
                  kind: "exact-lookup" as const,
                  pendingId: id,
                  lookup: "move" as const,
                }
              : { kind: "move" as const, pendingId: id };
        void this.submit({
          ...operation,
          requestId: randomUUID(),
          deadline: performance.now() + 10_000,
          identity: {
            account,
            mailbox:
              operation.kind === "repair"
                ? undefined
                : String(
                    operation.kind === "select"
                      ? row.destination_mailbox_id
                      : row.mailbox_id,
                  ),
            configurationVersion: BigInt(row.configuration_version as string),
            receivingLifecycleVersion: BigInt(
              row.receiving_lifecycle_version as string,
            ),
          },
        })
          .catch(() => undefined)
          .finally(() => this.selectedMoves.delete(id));
      }
    })().finally(() => {
      this.moveSelection = undefined;
    });
    return this.moveSelection;
  }

  /** Existing outgoing intent, selected in bounded pages. No queue or timer.
   * Unenrolled Sent destinations first use R07 SELECT; never inventory history. */
  dispatchSentCopies(): Promise<void> {
    if (this.sentSelection) return this.sentSelection;
    const handler = this.config.operationHandlers?.append;
    if (
      this.phase !== "owner" ||
      !this.config.loadOperationConnection ||
      !handler ||
      typeof handler === "function" ||
      !("sentCopy" in handler)
    )
      return Promise.resolve();
    this.sentSelection = (async () => {
      const rows = await this.control(async (db) => {
        await this.validate(db, this.owner!);
        const after = this.sentCursor
          ? sql`and (o.updated_at,o.id)>(${this.sentCursor.at}::timestamptz,${this.sentCursor.id}::uuid)`
          : sql``;
        return db.execute(sql`with candidates as materialized (
          select o.id,o.account_id,o.updated_at,o.receiving_attempt,o.sent_copy_status,o.sent_copy_mailbox_id,o.mime_blob_id,
            case when o.mime_blob_id is null then octet_length(o.mime_base64)/4*3 - case when right(o.mime_base64,2)='==' then 2 when right(o.mime_base64,1)='=' then 1 else 0 end end as legacy_upper
          from outgoing_messages o where o.status='sent' and o.sent_copy_policy='maildock'
            and (o.sent_copy_status in ('pending','saving','uncertain') or (o.sent_copy_status='saved' and o.sent_copy_sync_pending))
            and coalesce((o.receiving_attempt->>'observations')::integer,0)<3
            and coalesce(o.receiving_attempt->>'phase','')<>'repair_terminal'
          ${after} order by o.updated_at,o.id limit 32
        ) select o.*,o.updated_at::text as cursor_at,a.configuration_version,a.receiving_lifecycle_version,
          (a.enabled and a.removal_requested_at is null) as account_active,
          b.id as destination,b.remote_path,s.epoch,s.configuration_binding,coalesce(bl.size,o.legacy_upper) as mime_bytes,
          (a.enabled and a.removal_requested_at is null and b.selectable and b.lifecycle_status='active') as eligible
          from candidates o join mail_accounts a on a.id=o.account_id
          left join mailbox_roles role on role.account_id=o.account_id and role.role='sent'
          left join mailboxes b on b.id=case when o.receiving_attempt is null then role.mailbox_id else o.sent_copy_mailbox_id end
          left join receiving_mailboxes s on s.mailbox_id=b.id left join blobs bl on bl.id=o.mime_blob_id
          order by o.updated_at,o.id`);
      });
      this.assertCurrent();
      const last = rows.at(-1);
      this.sentCursor = last
        ? { at: String(last.cursor_at), id: String(last.id) }
        : undefined;
      const accounts = new Set<string>();
      for (const row of rows) {
        const id = String(row.id),
          account = String(row.account_id);
        if (
          row.account_active &&
          !row.receiving_attempt &&
          (!row.eligible ||
            Number(row.mime_bytes) >
              DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes ||
            Number(row.mime_bytes) < 1)
        ) {
          await this.control(async (db) => {
            await this.validate(db, this.owner!);
            const owner = this.owner!;
            await db.execute(
              sql`select maildock_receiving_append_pending_failure(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,${row.configuration_version}::bigint,${row.receiving_lifecycle_version}::bigint,${id}::uuid,${!row.eligible ? "destination_unavailable" : "mime_unavailable"})`,
            );
          });
          continue;
        }
        if (!row.eligible || accounts.has(account) || this.selectedSent.has(id))
          continue;
        accounts.add(account);
        this.selectedSent.add(id);
        const identity = {
          account,
          mailbox: String(row.destination),
          configurationVersion: BigInt(row.configuration_version as string),
          receivingLifecycleVersion: BigInt(
            row.receiving_lifecycle_version as string,
          ),
        };
        const marker = row.receiving_attempt as Record<string, unknown> | null;
        // Original attempted identity cannot be selected/rebound to a replacement.
        if (
          marker &&
          (marker.configuration !== String(identity.configurationVersion) ||
            marker.lifecycle !== String(identity.receivingLifecycleVersion))
        ) {
          this.selectedSent.delete(id);
          continue;
        }
        const selected =
          row.epoch && row.configuration_binding === row.configuration_version;
        const operation = !selected
          ? { kind: "select" as const, role: "sent" as const }
          : marker
            ? {
                kind: "exact-lookup" as const,
                pendingId: id,
                lookup: "sent-copy" as const,
              }
            : {
                kind: "append" as const,
                pendingId: id,
                mimeBytes: Number(row.mime_bytes),
              };
        if (marker && !selected) {
          this.selectedSent.delete(id);
          continue;
        }
        void this.submit({
          ...operation,
          requestId: randomUUID(),
          deadline: performance.now() + 10_000,
          identity,
        })
          .catch(() => undefined)
          .finally(() => this.selectedSent.delete(id));
      }
    })().finally(() => {
      this.sentSelection = undefined;
    });
    return this.sentSelection;
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

  /** Bounded R02 intent discovery on existing elected control opportunities. */
  dispatchAttachmentRequests(): Promise<void> {
    if (this.attachmentSelection) return this.attachmentSelection;
    const handler = this.config.operationHandlers?.["attachment-slice"];
    if (
      this.phase !== "owner" ||
      !this.config.loadOperationConnection ||
      !handler ||
      typeof handler === "function" ||
      !("attachment" in handler)
    )
      return Promise.resolve();
    this.attachmentSelection = (async () => {
      const rows = await this.control(async (db) => {
        await this.validate(db, this.owner!);
        const after = this.attachmentCursor
          ? sql`and (updated_at,id)>(${this.attachmentCursor.at}::timestamptz,${this.attachmentCursor.id}::uuid)`
          : sql``;
        return db.execute(sql`with candidates as materialized (
          select id,message_id,updated_at,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding,receiving_attempt
          from message_attachments where status in ('pending','fetching') and source_configuration_binding is not null
          ${after} order by updated_at,id limit 32
        ) select c.id,c.message_id,c.updated_at::text as cursor_at,c.source_mailbox_id,c.source_configuration_binding,m.account_id,a.receiving_lifecycle_version,
          (a.enabled and a.removal_requested_at is null
            and (c.status='pending' or (c.receiving_attempt->>'phase'='claimed' and coalesce((c.receiving_attempt->>'reads')::integer,1)<3))
            and c.source_configuration_binding=a.configuration_version and c.source_configuration_binding=s.configuration_binding
            and c.source_uid_validity=s.epoch
            and maildock_receiving_visible_resource(c.message_id,c.source_mailbox_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding)) as eligible
          from candidates c left join messages m on m.id=c.message_id
          left join mail_accounts a on a.id=m.account_id left join receiving_mailboxes s on s.mailbox_id=c.source_mailbox_id
          order by c.updated_at,c.id`);
      });
      this.assertCurrent();
      const accounts = new Set<string>();
      const last = rows.at(-1);
      this.attachmentCursor = last
        ? { at: String(last.cursor_at), id: String(last.id) }
        : undefined;
      for (const row of rows) {
        if (row.eligible !== true) continue;
        const id = String(row.id),
          account = String(row.account_id);
        if (accounts.has(account) || this.selectedAttachments.has(id)) continue;
        accounts.add(account);
        this.selectedAttachments.add(id);
        void this.submit({
          kind: "attachment-slice",
          pendingId: id,
          offset: 0,
          maxBytes: RECEIVING_ATTACHMENT_BYTES,
          requestId: randomUUID(),
          deadline: performance.now() + RECEIVING_ATTACHMENT_LIFETIME_MS,
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
          .finally(() => this.selectedAttachments.delete(id));
      }
    })().finally(() => {
      this.attachmentSelection = undefined;
    });
    return this.attachmentSelection;
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
    await this.attachmentSelection?.catch(() => undefined);
    await this.sentSelection?.catch(() => undefined);
    await this.moveSelection?.catch(() => undefined);
    await this.repairSelection?.catch(() => undefined);
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
