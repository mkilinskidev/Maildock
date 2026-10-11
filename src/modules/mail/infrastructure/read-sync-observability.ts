import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  currentSyncStatus,
  refusalSchema,
  syncEventSchema,
  syncPhases,
  type SyncDiagnostics,
  type SyncPhase,
} from "../domain/sync-observability";
import { gmailQuotaConfig } from "./gmail-quota";

type Snapshot = {
  sampled_at: Date;
  enabled: boolean;
  receive_transport: string;
  oauth_status: string;
  auth_method: string;
  status: string | null;
  error_category: string | null;
  next_attempt_at: Date | null;
  inbox_synced_at: Date | null;
  inbox_started_at: Date | null;
  recent_ready: boolean | null;
  phase: SyncPhase | null;
  priority: number | null;
  active_until: Date | null;
  last_check_at: Date | null;
  last_materialized_at: Date | null;
  last_refusal: unknown;
  events: unknown[] | null;
  p0: number;
  p1: number;
  p2: number;
  queued: boolean;
  executing: boolean;
  retry_at: Date | null;
  lock_held: boolean;
  imap_check_at: Date | null;
  imap_error: boolean;
  command_pending: boolean;
};
const iso = (value: Date | string | null) =>
  value ? new Date(value).toISOString() : null;

export async function readSyncObservability(
  db: Database,
  accountId: string,
  imapIntervalSeconds: number,
): Promise<SyncDiagnostics | null> {
  // One snapshot query; no scheduler/provider calls. Only current revision/runs count.
  const [s] = await db.execute<Snapshot>(sql`
    select statement_timestamp() as sampled_at,a.enabled,a.receive_transport,a.oauth_status,a.auth_method,
      g.status,g.error_category,g.next_attempt_at,g.inbox_synced_at,g.inbox_started_at,g.recent_ready,
      o.phase,o.priority,o.active_until,o.last_check_at,o.last_materialized_at,o.last_refusal,o.events,
      coalesce(p.p0,0)::int as p0,coalesce(p.p1,0)::int as p1,coalesce(p.p2,0)::int as p2,
      q.queued,q.executing,q.retry_at,m.imap_check_at,m.imap_error,
      exists(select 1 from public.message_commands c where c.account_id=a.id and c.account_revision=a.work_revision and c.status in ('pending','executing')) as command_pending,
      exists(select 1 from pg_locks l where l.locktype='advisory' and l.granted and l.objsubid=1
        and l.classid=((hashtextextended('gmail-account:'||a.id::text,0)>>32)&4294967295)::oid
        and l.objid=(hashtextextended('gmail-account:'||a.id::text,0)&4294967295)::oid) as lock_held
    from public.mail_accounts a
    left join public.gmail_account_sync_state g on g.account_id=a.id and g.account_revision=a.work_revision
    left join public.sync_observations o on o.account_id=a.id and o.account_revision=a.work_revision
    left join lateral(select count(*) filter(where priority_class=0) as p0,count(*) filter(where priority_class=1) as p1,count(*) filter(where priority_class=2) as p2
      from public.gmail_sync_work w where w.account_id=a.id and w.account_revision=a.work_revision and w.status<>'complete'
        and ((w.run_id=g.history_run_id and w.purpose='history') or (w.run_id=g.inventory_run_id and w.purpose='inventory'))) p on true
    left join lateral(select coalesce(bool_or(j.state<'active'),false) as queued,coalesce(bool_or(j.state='active'),false) as executing,
      min(j.start_after) filter(where j.state='retry' and j.start_after>now()) as retry_at
      from pgboss.job j where j.name in ('gmail-account-sync-v1','mailbox-recent-sync-v1','mailbox-delta-sync-v1','mailbox-backfill-sync-v1','mailbox-discovery-v1')
        and j.state<'completed' and j.data->>'accountId'=a.id::text and j.data->>'accountRevision'=a.work_revision::text) q on true
    left join lateral(select max(greatest(last_successful_recent_sync_at,last_successful_delta_sync_at)) as imap_check_at,
      coalesce(bool_or((recent_sync_status='failed' and (last_successful_delta_sync_at is null or recent_sync_completed_at>last_successful_delta_sync_at)) or delta_sync_status='failed'),false) as imap_error
      from public.mailboxes b where b.account_id=a.id and upper(b.remote_path)='INBOX' and b.lifecycle_status='active') m on true
    where a.id=${accountId}::uuid`);
  if (!s) return null;
  const now = new Date(s.sampled_at).getTime();
  const gmail = s.receive_transport === "gmail";
  const intervalMs = gmail ? 60_000 : imapIntervalSeconds * 1000;
  const lastCheckAt = iso(
    gmail ? s.inbox_synced_at : (s.last_check_at ?? s.imap_check_at),
  );
  const due = lastCheckAt ? Date.parse(lastCheckAt) + intervalMs : null;
  // A running multi-page observation remains due immediately.
  const nextCheckAt =
    !gmail || s.inbox_started_at || !due
      ? null
      : new Date(
          Math.max(
            due,
            s.next_attempt_at ? new Date(s.next_attempt_at).getTime() : 0,
            s.retry_at ? new Date(s.retry_at).getTime() : 0,
          ),
        ).toISOString();
  const active = !!s.active_until && new Date(s.active_until).getTime() > now;
  const refusal = refusalSchema.safeParse(s.last_refusal);
  const deadlines = [s.next_attempt_at, s.retry_at]
    .filter((v): v is Date => !!v)
    .map((v) => new Date(v).getTime());
  const deadline = deadlines.length
    ? new Date(Math.max(...deadlines)).toISOString()
    : null;
  const status = currentSyncStatus({
    now,
    enabled: s.enabled,
    executing: s.executing || active,
    queued: s.queued,
    lastCheckAt,
    dueAt: s.inbox_started_at
      ? null
      : gmail
        ? nextCheckAt
        : due && due > now
          ? new Date(due).toISOString()
          : null,
    deadline,
    errorCategory: s.error_category,
    lockHeld: gmail && s.lock_held,
    commandPending: gmail && s.command_pending,
    retryQueued: !!s.retry_at,
    persistentError:
      (s.auth_method === "oauth2" && s.oauth_status !== "connected") ||
      (gmail
        ? ["blocked", "reconcile_required"].includes(s.status ?? "")
        : s.imap_error),
    intervalMs,
  });
  const quota: SyncDiagnostics["quota"] = [];
  if (gmail) {
    const limits = gmailQuotaConfig.parse(process.env);
    const rows = await db.execute<{ scope: string; used: string }>(sql`
      select case when b.kind='day' then 'project_day' when b.scope='project' then 'project_minute' else 'user_minute' end as scope,sum(b.units)::text as used
      from public.gmail_quota_buckets b join public.mail_accounts a on a.id=${accountId}::uuid
      where ((b.kind='second' and b.bucket>=floor(extract(epoch from statement_timestamp()))::bigint-60)
        or (b.kind='day' and b.bucket=floor(extract(epoch from statement_timestamp())/86400)::bigint))
        and (b.scope='project' or b.scope='user:'||encode(sha256(convert_to(a.oauth_home_account_id,'UTF8')),'hex'))
      group by 1`);
    for (const [scope, ceiling] of [
      ["user_minute", limits.MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE],
      ["project_minute", limits.MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE],
      ["project_day", limits.MAILDOCK_GMAIL_DAILY_UNITS],
    ] as const)
      quota.push({
        scope,
        used: Number(rows.find((r) => r.scope === scope)?.used ?? 0),
        ceiling: Math.floor(ceiling * 0.7),
      });
  }
  let pending = {
    p0: s.p0,
    p1: s.p1,
    p2: s.p2,
    unit: "items" as "items" | "jobs",
  };
  if (!gmail) {
    const [jobs] = await db.execute<{ p0: number; p1: number; p2: number }>(sql`
      select count(*) filter(where j.name<>'mailbox-backfill-sync-v1' and upper(b.remote_path)='INBOX')::int as p0,
        count(*) filter(where j.name<>'mailbox-backfill-sync-v1' and coalesce(upper(b.remote_path),'')<>'INBOX')::int as p1,
        count(*) filter(where j.name='mailbox-backfill-sync-v1')::int as p2
      from pgboss.job j left join public.mailboxes b on b.id::text=j.data->>'mailboxId'
      where j.name in ('mailbox-recent-sync-v1','mailbox-delta-sync-v1','mailbox-backfill-sync-v1','mailbox-discovery-v1')
        and j.state<'active' and j.data->>'accountId'=${accountId} and j.data->>'accountRevision'=(select work_revision::text from public.mail_accounts where id=${accountId}::uuid)`);
    pending = { ...jobs, unit: "jobs" };
  }
  return {
    sampledAt: iso(s.sampled_at)!,
    ...status,
    phase:
      active && s.phase && syncPhases.includes(s.phase)
        ? s.phase
        : s.executing
          ? "unknown"
          : deadline && Date.parse(deadline) > now
            ? "retry"
            : "idle",
    priority: active ? s.priority : null,
    lastCheckAt,
    nextCheckAt,
    nextEligibleAt: deadline,
    quotaBackoffUntil:
      s.error_category === "quota" &&
      s.next_attempt_at &&
      new Date(s.next_attempt_at).getTime() > now
        ? iso(s.next_attempt_at)
        : null,
    lastMaterializedAt: iso(s.last_materialized_at),
    pending,
    refusal: refusal.success ? refusal.data : null,
    quota,
    events: (s.events ?? [])
      .flatMap((e) => {
        const parsed = syncEventSchema.safeParse(e);
        return parsed.success && Date.parse(parsed.data.at) > now - 86400_000
          ? [parsed.data]
          : [];
      })
      .slice(-80)
      .reverse(),
  };
}
