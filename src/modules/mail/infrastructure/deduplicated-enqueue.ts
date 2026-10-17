import type { PgBoss } from "pg-boss";

/**
 * Producer path for queues without per-key exclusivity (pg-boss "standard"
 * policy ignores singletonKey for uniqueness). A producer-only advisory lock
 * serializes check and insert, so concurrent producers (API, poller, busy
 * continuation, repair) cannot multiply jobs for the same work item.
 *
 * Queued (created/retry) jobs always count as live. An active job counts only
 * while it started within `activeLiveSeconds`: an older one is an orphan of a
 * crashed worker that pg-boss would expire much later, and a duplicate is
 * harmless because executors re-check durable state under their own lock.
 * `activeLiveSeconds: 0` ignores active jobs (continuation by the active job).
 */
export async function enqueueDeduplicated(
  boss: PgBoss,
  queue: string,
  match: Record<string, string>,
  payload: object,
  options: {
    singletonKey: string;
    activeLiveSeconds: number;
    startAfter?: number;
  },
): Promise<boolean> {
  const db = boss.getDb();
  if (!db.beginTransaction)
    throw new Error("Deduplicated enqueue requires database transactions.");
  const tx = await db.beginTransaction();
  try {
    await tx.db.executeSql(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`maildock-enqueue:${queue}:${options.singletonKey}`],
    );
    const jobs = await boss.findJobs(queue, { data: match, db: tx.db });
    const now = Date.now();
    const live = jobs.some(
      (job) =>
        job.state === "created" ||
        job.state === "retry" ||
        (job.state === "active" &&
          options.activeLiveSeconds > 0 &&
          job.startedOn !== null &&
          now - new Date(job.startedOn).getTime() <
            options.activeLiveSeconds * 1000),
    );
    if (live) {
      await tx.commit();
      return false;
    }
    const inserted = await boss.send(queue, payload, {
      singletonKey: options.singletonKey,
      ...(options.startAfter === undefined
        ? {}
        : { startAfter: options.startAfter }),
      db: tx.db,
    });
    await tx.commit();
    return inserted !== null;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
