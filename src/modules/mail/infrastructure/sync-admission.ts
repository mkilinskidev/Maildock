import type { PgBoss } from "pg-boss";
import { createRequire } from "node:module";
import type { Logger } from "pino";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";
import { synchronizationPriority } from "../domain/synchronization-policy";
type IDatabase = ReturnType<PgBoss["getDb"]>;
const pgBossVersion = (
  createRequire(import.meta.url)("pg-boss/package.json") as { version: string }
).version;

export const SYNC_QUEUES = [
  "mailbox-discovery-v1",
  "mailbox-recent-sync-v1",
  "mailbox-delta-sync-v1",
  "mailbox-backfill-sync-v1",
  "gmail-account-sync-v1",
] as const;

// Eligibility is evaluated at admission, including old jobs and account phase changes.
// Gmail P0 means conservative account-current work, not decoded INBOX history.
export const syncCandidatesSql = `
with candidates as (
  select j.id, j.name, j.data->>'accountId' as account_id,
    j.data->>'mailboxId' as mailbox_id,
    greatest(j.created_on,j.start_after) as eligible_at,
    case when j.name='mailbox-backfill-sync-v1' then 2
      when j.name='gmail-account-sync-v1' then
        case when s.baseline_history_id is not null and s.status<>'reconcile_required'
          and s.inventory_run_id is not null and s.history_run_id is null then 2 else 0 end
      when j.name='mailbox-discovery-v1' then 0
      when upper(m.remote_path)='INBOX' then 0 else 1 end as class,
    a.last_admitted_at
  from pgboss.job j
  left join public.mailboxes m on m.id::text=j.data->>'mailboxId'
  left join public.gmail_account_sync_state s on s.account_id::text=j.data->>'accountId'
  left join public.sync_account_admission a on a.account_id::text=j.data->>'accountId'
  where j.name=any($1::text[]) and j.state<'active' and not j.blocked and j.start_after<=now()
    and (j.name<>'gmail-account-sync-v1' or s.next_attempt_at is null or s.next_attempt_at<=now())
    and not exists(select 1 from pgboss.job busy where busy.name=any($1::text[])
      and busy.state='active' and busy.data->>'accountId'=j.data->>'accountId')
    and not exists(select 1 from pgboss.job retry where retry.name=j.name
      and retry.singleton_key=j.singleton_key and retry.state='retry' and retry.id<>j.id)
), eligible as (
  select * from candidates c where c.class<>2 or c.mailbox_id is null or not exists(
    select 1 from candidates higher where higher.mailbox_id=c.mailbox_id and higher.class<2)
), capacity as (
  select count(*) as active,
    count(*) filter(where j.priority<100) as lower_active
  from pgboss.job j
  where j.name=any($1::text[]) and j.state='active'
), policy as (
  select p.*, exists(select 1 from eligible where class=0) as p0_waiting,
    exists(select 1 from eligible where class>0 and eligible_at<=now()-interval '60 seconds')
      or p.p0_admissions>=8 as lower_due
  from public.sync_admission_policy p where id=1
)
select e.*, p.lower_due as lower_allowance from eligible e cross join capacity cap cross join policy p
where cap.active<$2 and (e.class=0 or cap.lower_active<$2-1)
  and (e.class=0 or not p.p0_waiting or p.lower_due)
order by
  case when p.lower_due and e.class>0 then 0 when e.class=0 then 1 else 2 end,
  case when e.class>0 and e.class<>p.last_lower_class then 0 else 1 end,
  e.last_admitted_at nulls first, e.eligible_at, e.account_id, e.id
limit 1`;

/**
 * Wrap the supported pg-boss database adapter, retaining its own fetch/settlement,
 * singleton checks, retries and expiry. The one pinned SQL insertion point is
 * verified by real-queue tests; unknown fetch shapes fail closed.
 */
export function installSyncAdmission(
  boss: PgBoss,
  capacity: number,
  logger?: Pick<Logger, "debug">,
): () => void {
  if (pgBossVersion !== "12.33.7")
    throw new Error("Sync admission requires validated pg-boss 12.33.7.");
  const db = boss.getDb();
  if (!db.beginTransaction)
    throw new Error("Sync admission requires transactions.");
  const execute = db.executeSql.bind(db);
  const begin = db.beginTransaction.bind(db);
  const original = db.executeSql;
  const lastDeferralLog = new Map<string, number>();
  db.executeSql = async (sql, values = []) => {
    const queue = SYNC_QUEUES.find((name) =>
      sql.includes(`j.name = '${name}'`),
    );
    if (!queue || !sql.includes("started_on = pgboss.job_now()"))
      return execute(sql, values);
    const marker = `WHERE j.name = '${queue}'`;
    if (
      !sql.includes(marker) ||
      !sql.includes("next AS (") ||
      !sql.includes("LIMIT 1")
    )
      throw new Error("Unsupported pg-boss synchronization fetch shape.");
    const tx = await begin();
    try {
      // Separate statement after acquiring authority: READ COMMITTED sees the
      // previous process's claim. A snapshot group count alone is insufficient.
      const lock = await tx.db.executeSql(
        "select pg_try_advisory_xact_lock(hashtextextended('maildock-sync-admission',0)) as acquired",
      );
      if (!lock.rows[0]?.acquired) {
        await tx.commit();
        return { rows: [] };
      }
      const selected = await tx.db.executeSql(syncCandidatesSql, [
        [...SYNC_QUEUES],
        Math.max(2, capacity),
      ]);
      const next = selected.rows[0];
      if (!next || next.name !== queue) {
        await tx.commit();
        if (next && Date.now() - (lastDeferralLog.get(queue) ?? 0) >= 60_000) {
          lastDeferralLog.set(queue, Date.now());
          bestEffortDiagnostic(() =>
            logger?.debug(
              {
                event: "mail.sync_admission_deferred",
                queue,
                blockedReason: "fairness_deferral",
                selectedQueue: next.name,
                priorityClass: `P${next.class}`,
              },
              "Synchronization admission deferred",
            ),
          );
        }
        return { rows: [] };
      }
      const result = await tx.db.executeSql(
        sql.replace(marker, `${marker} AND j.id=$${values.length + 1}::uuid`),
        [...values, next.id],
      );
      if (result.rows.length) {
        await tx.db.executeSql(
          "update pgboss.job set priority=$2 where id=$1 and name=$3",
          [
            next.id,
            next.class === 0 ? 100 : next.class === 1 ? 10 : -10,
            queue,
          ],
        );
        await recordAdmission(tx.db, next.account_id, next.class);
      }
      await tx.commit();
      if (result.rows.length)
        bestEffortDiagnostic(() =>
          logger?.debug(
            {
              event: "mail.sync_admission",
              accountId: next.account_id,
              mailboxId: next.mailbox_id,
              queue,
              priorityClass: synchronizationPriority({
                currentChange: next.class !== 2,
                affectsInbox: next.class === 0,
              }),
              lowerPriorityAllowance: next.class > 0 && next.lower_allowance,
              queueWaitMs: Math.max(
                0,
                Date.now() - new Date(next.eligible_at).getTime(),
              ),
              policy: "account_rotation_reserved_p0",
            },
            "Synchronization admitted",
          ),
        );
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  };
  return () => {
    db.executeSql = original;
  };
}

async function recordAdmission(
  db: IDatabase,
  account: string,
  priority: number,
) {
  await db.executeSql(
    `insert into public.sync_account_admission(account_id,last_admitted_at)
    values($1,clock_timestamp()) on conflict(account_id) do update set last_admitted_at=excluded.last_admitted_at`,
    [account],
  );
  // Admissions rather than claimed productive slices give lower classes an
  // earlier allowance on skips/failures; success diagnostics do not imply progress.
  await db.executeSql(
    `update public.sync_admission_policy set
    p0_admissions=case when $1=0 then least(p0_admissions+1,8) else 0 end,
    last_lower_class=case when $1=0 then last_lower_class else $1 end where id=1`,
    [priority],
  );
}
