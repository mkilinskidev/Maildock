import type { PgBoss } from "pg-boss";

import {
  ACTIVE_WORK_STALE_SECONDS,
  syncTier,
  WAITING_WORK_STALE_SECONDS,
  type SyncKind,
} from "../application/inbox-first-policy";
import {
  MAILBOX_DELTA_SYNC_QUEUE,
  MAILBOX_RECENT_SYNC_QUEUE,
} from "./sync-queues";

// Application pg-boss instances use the library default schema.
const PGBOSS_SCHEMA = "pgboss";

/**
 * Account-scoped INBOX-first admission. Called before the mailbox lock and
 * again under it; a true result means the caller should commit a delayed
 * successor and finish without touching IMAP.
 *
 * - other-folder fresh yields to INBOX fresh that is ready but not started;
 * - history yields to any ready fresh work of the account and to active INBOX
 *   fresh work.
 *
 * "Ready" excludes future startAfter/retry, jobs whose key already has an
 * active run (stately cannot start them yet) and jobs left unclaimed past
 * WAITING_WORK_STALE_SECONDS. Active INBOX work older than the queue expiry is
 * an orphan. These bounds keep a broken INBOX from starving other folders.
 * Work of other accounts and of missing/nonselectable mailboxes is never
 * considered. Already active jobs are not
 * interrupted: there is no preemption here.
 */
export async function higherPriorityWorkWaiting(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  kind: SyncKind,
): Promise<boolean> {
  const db = boss.getDb();
  const { rows: own } = await db.executeSql(
    "SELECT remote_path FROM mailboxes WHERE id = $1 AND account_id = $2",
    [mailboxId, accountId],
  );
  const mailbox = own[0] as { remote_path: string } | undefined;
  if (!mailbox) return false;
  const tier = syncTier(kind, mailbox.remote_path);
  if (tier === "inbox-fresh") return false;
  const history = kind === "history";
  const { rows } = await db.executeSql(
    `SELECT 1
       FROM ${PGBOSS_SCHEMA}.job j
       JOIN mailboxes m ON m.id::text = j.singleton_key
      WHERE j.name = ANY($1::text[])
        AND j.state IN ('created', 'retry', 'active')
        AND m.account_id = $2::uuid
        AND m.id <> $3::uuid
        AND m.selectable
        AND m.lifecycle_status = 'active'
        AND (
          (
            j.state <> 'active'
            AND j.start_after <= now()
            AND greatest(j.created_on, j.start_after)
                > now() - make_interval(secs => $5::int)
            AND NOT EXISTS (
              SELECT 1 FROM ${PGBOSS_SCHEMA}.job a
               WHERE a.name = j.name
                 AND a.singleton_key = j.singleton_key
                 AND a.state = 'active'
            )
            AND ($4::boolean OR upper(m.remote_path) = 'INBOX')
          )
          OR (
            $4::boolean
            AND j.state = 'active'
            AND j.started_on > now() - make_interval(secs => $6::int)
            AND upper(m.remote_path) = 'INBOX'
          )
        )
      LIMIT 1`,
    [
      [MAILBOX_RECENT_SYNC_QUEUE, MAILBOX_DELTA_SYNC_QUEUE],
      accountId,
      mailboxId,
      history,
      WAITING_WORK_STALE_SECONDS,
      ACTIVE_WORK_STALE_SECONDS,
    ],
  );
  return rows.length > 0;
}
