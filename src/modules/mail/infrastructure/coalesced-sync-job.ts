import type { PgBoss, SendOptions } from "pg-boss";

/** One pending run (created or retry) per key, without altering retry state. */
export async function enqueueCoalescedSync(
  boss: PgBoss,
  queue: string,
  data: object,
  options: SendOptions & { singletonKey: string },
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
    const inserted = pending.length
      ? null
      : await boss.send(queue, data, { ...options, db: transaction.db });
    await transaction.commit();
    return inserted !== null;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
