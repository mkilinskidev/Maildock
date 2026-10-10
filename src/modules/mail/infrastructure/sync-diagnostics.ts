import type { Job, JobWithMetadata } from "pg-boss";
import type { Logger } from "pino";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";

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
  work: () => Promise<T>,
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
  try {
    return await work();
  } catch (error) {
    outcome = "failed";
    blockedReason =
      error instanceof SyncLockContentionError ? "lock_contention" : "unknown";
    throw error;
  } finally {
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
