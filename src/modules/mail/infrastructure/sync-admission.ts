import type { PgBoss } from "pg-boss";
import { createRequire } from "node:module";
import type { Logger } from "pino";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";
import { synchronizationPriority } from "../domain/synchronization-policy";
import { GMAIL_HISTORY_PENDING_HIGH_WATER } from "./gmail-sync-repository";
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
// Unknown discovery remains conservative; durable Gmail drain work supplies
// its actual next class, including the same lower-class allowance as the service.
export const syncCandidatesSql = `
with candidates as (
  select j.id, j.name, j.data->>'accountId' as account_id,
    j.data->>'mailboxId' as mailbox_id,
    greatest(j.created_on,j.start_after) as eligible_at,
    case when j.name='mailbox-backfill-sync-v1' then 2
      when j.name='gmail-account-sync-v1' then
        case when s.baseline_history_id is null or s.status='reconcile_required' then 0
          when s.history_run_id is not null then
            case when (not s.history_pages_complete and not s.history_drain_due
              and not exists(select 1 from public.gmail_sync_work cap_work where cap_work.account_id=s.account_id
                and cap_work.run_id=s.history_run_id and cap_work.purpose='history' and cap_work.status<>'complete'
                offset ${GMAIL_HISTORY_PENDING_HIGH_WATER - 1} limit 1))
              or (s.history_pages_complete and s.history_discovered_at<=now()-interval '60 seconds') then 0
              else coalesce((
                select w.priority_class from public.gmail_sync_work w
                where w.account_id=s.account_id and w.account_revision=s.account_revision and w.status<>'complete'
                  and ((w.run_id=s.history_run_id and w.purpose='history')
                    or (w.run_id=s.inventory_run_id and w.purpose='inventory'))
                  and exists(select 1 from public.gmail_sync_work h where h.account_id=s.account_id
                    and h.run_id=s.history_run_id and h.purpose='history' and h.status<>'complete')
                order by case when w.priority_class>0 and (s.priority_burst>=8
                    or (s.priority_burst>0 and exists(select 1 from public.gmail_sync_work aged
                      where aged.account_id=s.account_id and aged.status<>'complete' and aged.priority_class>0
                        and (aged.run_id=s.history_run_id or aged.run_id=s.inventory_run_id)
                        and aged.created_at<=now()-interval '60 seconds')))
                  then 0 else w.priority_class+1 end,
                  case when w.priority_class>0 and w.priority_class<>s.last_lower_priority then 0 else 1 end,
                  w.priority_class, w.created_at limit 1
              ),0) end
          when s.inventory_run_id is not null then
            case when s.history_discovered_at<=now()-interval '60 seconds' then 0 else 2 end
          else 0 end
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
  -- Build the current-mailbox set once; a correlated CTE scan is quadratic
  -- in the backlog when many backfill jobs have no current-work sibling.
  select * from candidates c where c.class<>2 or c.mailbox_id is null or c.mailbox_id not in(
    select distinct mailbox_id from candidates where class<2 and mailbox_id is not null)
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
    if (!queue || !sql.includes("started_on")) return execute(sql, values);
    const marker = `WHERE j.name = '${queue}'`;
    if (
      !sql.includes(marker) ||
      !sql.includes("next AS (") ||
      !/\bLIMIT 1\b/.test(sql) ||
      !sql.includes("started_on = pgboss.job_now()") ||
      !sql.includes("active_job.policy = 'stately'")
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
        // The installed pg-boss patch checks live stately rows and retains its
        // unique active-key index. Its cached singleton list can lag completion
        // by a monitor/cache cycle; it must not veto the global selected head.
        // Keep the parameter typed/bound while removing only that advisory hint.
        sql
          .replace(
            /COALESCE\(j\.singleton_key, ''\) <> ALL\((\$\d+::text\[\])\)/,
            "($1 IS NULL OR TRUE)",
          )
          .replace(marker, `${marker} AND j.id=$${values.length + 1}::uuid`),
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
    select id,clock_timestamp() from public.mail_accounts where id::text=$1 for key share
    on conflict(account_id) do update set last_admitted_at=excluded.last_admitted_at`,
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
