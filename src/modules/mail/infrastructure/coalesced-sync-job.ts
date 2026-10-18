import type { PgBoss, SendOptions } from "pg-boss";

import { syncPriority, type SyncKind } from "../application/inbox-first-policy";

type ExecuteSql = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: unknown[] }>;

/** Priority from the stored remotePath, read inside the producer transaction. */
export async function storedSyncPriority(
  db: { executeSql: ExecuteSql },
  accountId: string,
  mailboxId: string,
  kind: SyncKind,
): Promise<number | undefined> {
  const { rows } = await db.executeSql(
    "SELECT remote_path FROM mailboxes WHERE id = $1 AND account_id = $2",
    [mailboxId, accountId],
  );
  const mailbox = rows[0] as { remote_path: string } | undefined;
  return mailbox ? syncPriority(kind, mailbox.remote_path) : undefined;
}

/** One pending run (created or retry) per key, without altering retry state. */
export async function enqueueCoalescedSync(
  boss: PgBoss,
  queue: string,
  data: object,
  options: SendOptions & { singletonKey: string },
  priorityFor?: { accountId: string; mailboxId: string; kind: SyncKind },
): Promise<boolean> {
  const database = boss.getDb();
  if (!database.beginTransaction)
    throw new Error("Synchronization enqueue requires database transactions.");
  const transaction = await database.beginTransaction();
  try {
    // Producer-only transaction lock; distinct from the mailbox execution lock.
    // Every producer, including backfill continuations, uses this same boundary.
    await transaction.db.executeSql(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`maildock-sync-enqueue:${queue}:${options.singletonKey}`],
    );
    const pending = await boss.findJobs(queue, {
      key: options.singletonKey,
      queued: true,
      db: transaction.db,
    });
    if (pending.length) {
      await transaction.commit();
      return false;
    }
    // Callers never pass a priority: the tier is derived centrally. A mailbox
    // removed meanwhile keeps the lowest priority of its kind.
    const priority = priorityFor
      ? ((await storedSyncPriority(
          transaction.db,
          priorityFor.accountId,
          priorityFor.mailboxId,
          priorityFor.kind,
        )) ?? syncPriority(priorityFor.kind, ""))
      : options.priority;
    const inserted = await boss.send(queue, data, {
      ...options,
      ...(priority === undefined ? {} : { priority }),
      db: transaction.db,
    });
    await transaction.commit();
    return inserted !== null;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
