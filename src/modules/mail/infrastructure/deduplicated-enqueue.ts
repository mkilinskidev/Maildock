import type { PgBoss } from "pg-boss";

/**
 * Liveness contract of the queues that use this helper. An `active` job counts
 * as alive; its age proves nothing (a large attachment can legitimately run for
 * many minutes). A dead worker is detected by pg-boss itself: workers refresh
 * the job heartbeat while the handler runs, the supervisor fails a job whose
 * heartbeat is stale (retry or failed), and `expireInSeconds` bounds a job on a
 * queue created before heartbeats were enabled. Once the job leaves `active`,
 * the durable pending/fetching state is re-enqueued by the pollers.
 */
export const JOB_HEARTBEAT_SECONDS = 90;

/**
 * Creates the queue and applies the heartbeat. createQueue never changes an
 * existing queue, so updateQueue upgrades queues created by earlier versions.
 * Only jobs sent afterwards carry the heartbeat; older ones stay bounded by
 * `expireInSeconds`.
 */
export async function ensureHeartbeatQueue(
  boss: PgBoss,
  queue: string,
  options: Parameters<PgBoss["createQueue"]>[1] = {},
) {
  await boss.createQueue(queue, {
    ...options,
    heartbeatSeconds: JOB_HEARTBEAT_SECONDS,
  });
  await boss.updateQueue(queue, { heartbeatSeconds: JOB_HEARTBEAT_SECONDS });
}

/**
 * Producer path for queues without per-key exclusivity (pg-boss "standard"
 * policy ignores singletonKey for uniqueness). A producer-only advisory lock
 * serializes check and insert, so concurrent producers (API, poller, busy
 * continuation, repair) cannot multiply jobs for the same work item.
 *
 * Queued (created/retry) and active jobs always count as live.
 * `ignoreActive` is for the continuation sent by the command's own active job,
 * which must not count itself.
 *
 * A duplicate job is never proof of exactly-once: executors still re-check
 * durable state under their own lock.
 */
export async function enqueueDeduplicated(
  boss: PgBoss,
  queue: string,
  match: Record<string, string>,
  payload: object,
  options: {
    singletonKey: string;
    ignoreActive?: boolean;
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
    const live = jobs.some(
      (job) =>
        job.state === "created" ||
        job.state === "retry" ||
        (job.state === "active" && !options.ignoreActive),
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
