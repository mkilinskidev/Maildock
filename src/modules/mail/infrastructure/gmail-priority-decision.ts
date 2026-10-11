import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { GMAIL_HISTORY_PENDING_HIGH_WATER } from "./gmail-sync-repository";

// Shared by admission's set-based summary and the authority-holding worker.
// Aliases w/s refer to work/state; stale revisions and unrelated runs never
// supply fairness age, counts or evidence that history is still pending.
export const gmailPendingScopeSql = `w.account_id=s.account_id and w.account_revision=s.account_revision
  and s.history_run_id is not null and w.status<>'complete'
  and ((w.run_id=s.history_run_id and w.purpose='history')
    or (w.run_id=s.inventory_run_id and w.purpose='inventory'))`;
export const gmailPendingColumnsSql = `
  count(*) filter(where w.priority_class=0)::int as p0,
  count(*) filter(where w.priority_class=1)::int as p1,
  count(*) filter(where w.priority_class=2)::int as p2,
  count(*) filter(where w.purpose='history')::int as history_pending,
  min(w.created_at) filter(where w.priority_class>0) as lower_oldest`;

// Aliases s/p/sync_account refer to state, its summary and the live account.
// One database statement clock supplies both 60-second decisions. An admitted
// class is a snapshot; the worker rechecks it after credentials/authority.
export const gmailPriorityDecisionSql = `
select choice.action,
  case when choice.action in ('inventory','inventory_clock') then 2
    when choice.action<>'drain' then 0
    when fairness.lower_due and coalesce(p.p1,0)+coalesce(p.p2,0)>0 then
      case when s.last_lower_priority=1 and coalesce(p.p2,0)>0 then 2
        when s.last_lower_priority=2 and coalesce(p.p1,0)>0 then 1
        when coalesce(p.p1,0)>0 then 1 else 2 end
    when coalesce(p.p0,0)>0 then 0 when coalesce(p.p1,0)>0 then 1 else 2 end as priority_class,
  fairness.lower_due, coalesce(p.p0,0) as p0, coalesce(p.p1,0) as p1, coalesce(p.p2,0) as p2
from lateral(select coalesce(s.priority_burst>=8 or
  (s.priority_burst>0 and p.lower_oldest<=statement_timestamp()-interval '60 seconds'),false) as lower_due) fairness
cross join lateral(select case
  when s.baseline_history_id is null or s.status='reconcile_required'
    or s.account_revision is distinct from sync_account.work_revision then 'bootstrap'
  when s.history_run_id is not null then case
    when s.history_pages_complete and s.history_discovered_at<=statement_timestamp()-interval '60 seconds' then 'history_probe'
    when (s.history_drain_due or s.history_pages_complete or coalesce(p.history_pending,0)>=${GMAIL_HISTORY_PENDING_HIGH_WATER})
      and coalesce(p.history_pending,0)>0 then 'drain'
    when not s.history_pages_complete then 'history_discover' else 'history_checkpoint' end
  when s.inventory_run_id is not null then case
    when s.history_discovered_at is null then 'inventory_clock'
    when s.history_discovered_at<=statement_timestamp()-interval '60 seconds' then 'history_start'
    else 'inventory' end
  else 'history_start' end as action) choice`;

export type GmailPriorityDecision = {
  action:
    | "bootstrap"
    | "inventory"
    | "inventory_clock"
    | "history_start"
    | "history_probe"
    | "history_discover"
    | "history_checkpoint"
    | "drain";
  priority_class: number;
  lower_due: boolean;
  p0: number;
  p1: number;
  p2: number;
};

export async function readGmailPriorityDecision(
  db: Database,
  accountId: string,
): Promise<GmailPriorityDecision> {
  const [decision] = await db.execute<GmailPriorityDecision>(sql`
    select decision.* from public.gmail_account_sync_state s
    join public.mail_accounts sync_account on sync_account.id=s.account_id
    cross join lateral(select ${sql.raw(gmailPendingColumnsSql)}
      from public.gmail_sync_work w where ${sql.raw(gmailPendingScopeSql)}) p
    cross join lateral(${sql.raw(gmailPriorityDecisionSql)}) decision
    where s.account_id=${accountId}::uuid`);
  if (!decision) throw new Error("Gmail priority state is unavailable.");
  return decision;
}
