import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  syncEventSchema,
  refusalSchema,
  type SyncEvent,
  type SyncPhase,
  type SyncRefusal,
} from "../domain/sync-observability";

export type DiagnosticExecutor = (
  statement: string,
  parameters: unknown[],
) => Promise<unknown>;
export function diagnosticExecutor(
  db: Pick<Database, "execute">,
): DiagnosticExecutor {
  return (statement, parameters) =>
    db.execute(
      sql.join(
        statement
          .split(/(\$\d+)/)
          .filter(Boolean)
          .map((part) =>
            /^\$\d+$/.test(part)
              ? sql`${parameters[Number(part.slice(1)) - 1]}`
              : sql.raw(part),
          ),
        sql.raw(""),
      ),
    );
}

/** One row per account, at most 80 events younger than 24h; no content or IDs. */
export class SyncObservationStore {
  readonly token = randomUUID();
  private phase: SyncPhase = "credentials";
  private priority: number | null = null;
  get currentPhase() {
    return this.phase;
  }
  constructor(
    private readonly execute: DiagnosticExecutor,
    private readonly accountId: string,
    private readonly revision: string,
  ) {}
  async record(
    kind: SyncEvent["kind"],
    values: Partial<
      Pick<SyncEvent, "count" | "newMessages" | "readChanges">
    > = {},
    options: {
      running?: boolean;
      refusal?: SyncRefusal;
      check?: boolean;
      materialized?: boolean;
    } = {},
  ) {
    try {
      const event = syncEventSchema.parse({
        at: new Date().toISOString(),
        kind,
        phase: this.phase,
        priority: this.priority,
        ...values,
      });
      const refusalResult = refusalSchema.safeParse(options.refusal);
      const refusal = refusalResult.success ? refusalResult.data : null;
      await this.execute(
        `insert into public.sync_observations(account_id,account_revision,operation_token,phase,priority,active_until,events,last_check_at,last_materialized_at,last_refusal)
        select id,work_revision,$3::uuid,$4,$5::int,case when $7 then now()+interval '180 seconds' else null end,jsonb_build_array($6::jsonb),case when $8 then now() end,case when $9 then now() end,$10::jsonb
        from public.mail_accounts where id=$1::uuid and work_revision=$2::bigint
        on conflict(account_id) do update set account_revision=excluded.account_revision,
        operation_token=case when $7 then excluded.operation_token else sync_observations.operation_token end,
        phase=case when $7 then excluded.phase else sync_observations.phase end,
        priority=case when $7 then excluded.priority else sync_observations.priority end,
        active_until=case when $7 or sync_observations.operation_token=$3::uuid then excluded.active_until else sync_observations.active_until end,
        last_check_at=case when sync_observations.account_revision<>excluded.account_revision then excluded.last_check_at else coalesce(excluded.last_check_at,sync_observations.last_check_at) end,
        last_materialized_at=case when sync_observations.account_revision<>excluded.account_revision then excluded.last_materialized_at else coalesce(excluded.last_materialized_at,sync_observations.last_materialized_at) end,
        last_refusal=case when sync_observations.account_revision<>excluded.account_revision then excluded.last_refusal else coalesce(excluded.last_refusal,sync_observations.last_refusal) end,
        events=(select coalesce(jsonb_agg(e order by ord),'[]'::jsonb) from (select e,ord from jsonb_array_elements(case when sync_observations.account_revision=excluded.account_revision then sync_observations.events else '[]'::jsonb end || excluded.events) with ordinality as entries(e,ord) where (e->>'at')::timestamptz>now()-interval '24 hours' order by ord desc limit 80) retained)`,
        [
          this.accountId,
          this.revision,
          this.token,
          this.phase,
          this.priority,
          JSON.stringify(event),
          options.running ?? false,
          options.check ?? false,
          options.materialized ?? false,
          refusal ? JSON.stringify(refusal) : null,
        ],
      );
    } catch {
      // Diagnostics must never fail mail work. The read API reports missing evidence.
    }
  }
  async start(phase: SyncPhase, priority: number | null) {
    this.phase = phase;
    this.priority = priority;
    await this.record("started", {}, { running: true });
  }
  async admitted(priority: number | null) {
    this.priority = priority;
    await this.record("admitted", {}, { running: true });
  }
  async finish(kind: SyncEvent["kind"] = "yield") {
    await this.record(kind);
  }
}
