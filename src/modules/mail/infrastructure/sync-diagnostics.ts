import type { Job, JobWithMetadata } from "pg-boss";
import type { Logger } from "pino";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";
import {
  SyncObservationStore,
  type DiagnosticExecutor,
} from "./sync-observation-store";

export class SyncLockContentionError extends Error {}

/** One debug event per delivery, never per message; IDs are log fields, not metric labels. */
export async function observeSyncDelivery<T>(
  logger: Pick<Logger, "debug"> | undefined,
  job: Job<unknown>,
  identity: {
    accountId: string;
    mailboxId?: string;
    transport: "gmail" | "imap";
    phase: "account_sync" | "recent" | "delta" | "backfill";
    reason: "unknown" | "idle" | "poll" | "manual" | "post-discovery";
  },
  work: (observation?: SyncObservationStore) => Promise<T>,
  execute?: DiagnosticExecutor,
): Promise<T> {
  const start = performance.now();
  const metadata = job as Partial<JobWithMetadata>;
  // Eligibility age includes consumer/lock admission delay, excludes retry delay.
  const eligibleAt =
    metadata.createdOn && metadata.startAfter
      ? Math.max(metadata.createdOn.getTime(), metadata.startAfter.getTime())
      : null;
  const queueWaitMs =
    eligibleAt === null ? null : Math.max(0, Date.now() - eligibleAt);
  let outcome: "returned" | "failed" = "returned";
  let blockedReason: "lock_contention" | "unknown" | null = null;
  const revision = (job.data as { accountRevision?: string } | undefined)
    ?.accountRevision;
  const observation =
    execute && revision
      ? new SyncObservationStore(execute, identity.accountId, revision)
      : undefined;
  const priority =
    metadata.priority === 100
      ? 0
      : metadata.priority === 10
        ? 1
        : metadata.priority === -10
          ? 2
          : null;
  await observation?.admitted(priority);
  try {
    return await work(observation);
  } catch (error) {
    outcome = "failed";
    blockedReason =
      error instanceof SyncLockContentionError ? "lock_contention" : "unknown";
    await observation?.record(
      blockedReason === "lock_contention" ? "lock_wait" : "error",
    );
    throw error;
  } finally {
    await observation?.finish("yield");
    bestEffortDiagnostic(() =>
      logger?.debug(
        {
          event: "mail.sync_delivery",
          ...identity,
          queueWaitMs,
          executionMs: performance.now() - start,
          retryCount: metadata.retryCount ?? null,
          outcome,
          blockedReason,
        },
        "Synchronization delivery observed",
      ),
    );
  }
}
