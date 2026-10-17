import type { PgBoss } from "pg-boss";

import {
  ACTIVE_WORK_STALE_SECONDS,
  COMMAND_WAITING_STALE_SECONDS,
  syncTier,
  WAITING_WORK_STALE_SECONDS,
  type SyncKind,
} from "../application/inbox-first-policy";
import {
  MAILBOX_DELTA_SYNC_QUEUE,
  MAILBOX_RECENT_SYNC_QUEUE,
} from "./sync-queues";
import { MESSAGE_CONTENT_QUEUE } from "./content-jobs";
import { ATTACHMENT_QUEUE } from "./attachment-jobs";

// Application pg-boss instances use the library default schema.
const PGBOSS_SCHEMA = "pgboss";

/**
 * User-actions-first, then account-scoped INBOX-first admission. Called before the mailbox lock and
 * again under it; a true result means the caller should commit a delayed
 * successor and finish without touching IMAP.
 *
 * - every sync kind, INBOX included, yields to a runnable command of the same
 *   mailbox. Runnable = status 'pending' (never started; 'executing' either
 *   holds the mailbox lock or waits in bounded pg-boss retry) created within
 *   COMMAND_WAITING_STALE_SECONDS, so an orphan cannot starve history. Commands
 *   of other mailboxes and accounts never matter;
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
  return (await higherPriorityWork(boss, accountId, mailboxId, kind)) !== null;
}

/** Category of the outranking work (diagnostics only), or null. */
export type HigherPriorityWork = "command" | "fresh";

/** Same decision as higherPriorityWorkWaiting, naming the first match. */
export async function higherPriorityWork(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  kind: SyncKind,
): Promise<HigherPriorityWork | null> {
  const db = boss.getDb();
  const { rows: own } = await db.executeSql(
    "SELECT remote_path FROM mailboxes WHERE id = $1 AND account_id = $2",
    [mailboxId, accountId],
  );
  const mailbox = own[0] as { remote_path: string } | undefined;
  if (!mailbox) return null;
  const { rows: commands } = await db.executeSql(
    `SELECT 1 FROM message_commands
      WHERE mailbox_id = $1 AND account_id = $2 AND status = 'pending'
        AND created_at > now() - make_interval(secs => $3::int)
      LIMIT 1`,
    [mailboxId, accountId, COMMAND_WAITING_STALE_SECONDS],
  );
  if (commands.length > 0) return "command";
  const tier = syncTier(kind, mailbox.remote_path);
  if (tier === "inbox-fresh") return null;
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
  return rows.length > 0 ? "fresh" : null;
}

/**
 * Interactive fetching (message content, attachments and CID images, which
 * are attachment jobs) of one account that is running or could start now.
 * These jobs take no mailbox lock, so history cannot see them through lock
 * contention; it yields to them between sub-batches instead, so the account's
 * IMAP sessions and bandwidth go to what the user is looking at.
 *
 * Only pg-boss jobs count, never durable pending/fetching rows (an orphan is
 * re-enqueued by its poller and counts again only as a live job):
 * - active within ACTIVE_WORK_STALE_SECONDS (queue expiry; heartbeats fail
 *   dead workers sooner);
 * - created/retry already due and not older than WAITING_WORK_STALE_SECONDS,
 *   so far retries and unclaimed leftovers never hold history back.
 * Other accounts never count. Only history consults this.
 */
export async function interactiveFetchWaiting(
  boss: PgBoss,
  accountId: string,
): Promise<boolean> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT 1
       FROM ${PGBOSS_SCHEMA}.job j
      WHERE j.name = ANY($1::text[])
        AND (
          (
            j.state = 'active'
            AND j.started_on > now() - make_interval(secs => $5::int)
          )
          OR (
            j.state IN ('created', 'retry')
            AND j.start_after <= now()
            AND greatest(j.created_on, j.start_after)
                > now() - make_interval(secs => $4::int)
          )
        )
        AND (
          (j.name = $2 AND j.data->>'accountId' = $3::text)
          OR (
            j.name = $6
            AND EXISTS (
              SELECT 1
                FROM message_attachments a
                JOIN messages msg ON msg.id = a.message_id
               WHERE a.id::text = j.data->>'attachmentId'
                 AND msg.account_id = $3::uuid
            )
          )
        )
      LIMIT 1`,
    [
      [MESSAGE_CONTENT_QUEUE, ATTACHMENT_QUEUE],
      MESSAGE_CONTENT_QUEUE,
      accountId,
      WAITING_WORK_STALE_SECONDS,
      ACTIVE_WORK_STALE_SECONDS,
      ATTACHMENT_QUEUE,
    ],
  );
  return rows.length > 0;
}
