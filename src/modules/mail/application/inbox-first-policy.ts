// INBOX-first policy for Sync Engine v1. Pure values only: every producer and
// admission gate derives tiers from the stored canonical remotePath, never from
// display names, discovery order or caller-supplied payload fields.

/** fresh = recent, delta, IDLE, poll, manual, recovery; history = backfill. */
export type SyncKind = "fresh" | "history";

export type SyncTier =
  "inbox-fresh" | "other-fresh" | "inbox-history" | "other-history";

export function isInboxPath(remotePath: string): boolean {
  return remotePath.toUpperCase() === "INBOX";
}

export function syncTier(kind: SyncKind, remotePath: string): SyncTier {
  const inbox = isInboxPath(remotePath);
  if (kind === "fresh") return inbox ? "inbox-fresh" : "other-fresh";
  return inbox ? "inbox-history" : "other-history";
}

const PRIORITY: Record<SyncTier, number> = {
  "inbox-fresh": 20,
  "other-fresh": 10,
  "inbox-history": -5,
  "other-history": -10,
};

/** pg-boss priority; only orders candidates within one queue. */
export function syncPriority(kind: SyncKind, remotePath: string): number {
  return PRIORITY[syncTier(kind, remotePath)];
}

/** Lowest priority accepted by the reserved INBOX lane of a fresh queue. */
export const INBOX_FRESH_PRIORITY = PRIORITY["inbox-fresh"];

/** Successor delay when a job yields to higher-tier work or a busy mailbox. */
export const FRESH_DEFER_SECONDS = 5;
export const HISTORY_DEFER_SECONDS = 10;

// Starvation bounds. A ready job nobody claimed for this long is treated as a
// stuck consumer, not as competition. Active jobs older than the queue expiry
// are orphans awaiting pg-boss expiration.
export const WAITING_WORK_STALE_SECONDS = 120;
export const ACTIVE_WORK_STALE_SECONDS = 15 * 60;

/** Splits localConcurrency into general slots and one INBOX-only slot. */
export function freshLanes(concurrency: number): {
  general: number;
  inbox: number;
} {
  return concurrency >= 2
    ? { general: concurrency - 1, inbox: 1 }
    : { general: Math.max(1, concurrency), inbox: 0 };
}

// User actions (message commands) outrank every sync tier on the same mailbox.
/**
 * A pending command nobody has started for this long no longer holds sync back
 * (orphan without a live job); the command poller keeps retrying it meanwhile.
 */
export const COMMAND_WAITING_STALE_SECONDS = 10 * 60;
/** Busy-lock continuation delay: short, growing, capped (seconds). */
export const COMMAND_BUSY_BASE_SECONDS = 2;
export const COMMAND_BUSY_MAX_SECONDS = 6;

/** Integer seconds (pg-boss startAfter) with up-to-1 s jitter; no thundering herd. */
export function commandBusyDelaySeconds(
  deferrals: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    COMMAND_BUSY_MAX_SECONDS,
    COMMAND_BUSY_BASE_SECONDS + Math.max(0, deferrals),
  );
  return base + Math.floor(random() * 2);
}
