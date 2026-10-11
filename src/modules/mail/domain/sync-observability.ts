import { z } from "zod";

export const syncPhases = [
  "credentials",
  "inbox",
  "history_discovery",
  "history_drain",
  "history_checkpoint",
  "inventory",
  "bootstrap",
  "imap_recent",
  "imap_delta",
  "imap_backfill",
] as const;
export type SyncPhase = (typeof syncPhases)[number];
export const syncEventSchema = z.object({
  at: z.iso.datetime(),
  kind: z.enum([
    "admitted",
    "started",
    "completed",
    "yield",
    "error",
    "recovery",
    "backoff_entered",
    "backoff_exited",
    "materialized",
    "lock_wait",
    "history_page_discovered",
    "history_slice_drained",
  ]),
  phase: z.enum(syncPhases),
  priority: z.number().int().min(0).max(2).nullable(),
  count: z.number().int().nonnegative().optional(),
  newMessages: z.number().int().nonnegative().optional(),
  readChanges: z.number().int().nonnegative().optional(),
});
export type SyncEvent = z.infer<typeof syncEventSchema>;
export const refusalSchema = z.object({
  at: z.iso.datetime(),
  category: z.enum([
    "quota",
    "authentication",
    "api_disabled",
    "access_denied",
    "network",
    "invalid_response",
    "history_expired",
    "cursor_expired",
    "not_found",
    "cancelled",
    "unknown",
  ]),
  source: z.enum(["local_budget", "gmail_http"]).nullable(),
  status: z.number().int().nullable(),
  reasons: z
    .array(
      z
        .string()
        .regex(/^[a-zA-Z0-9_]+$/)
        .max(80),
    )
    .max(8),
  retryAfter: z.string().max(100).nullable(),
  retryAfterMs: z.number().nonnegative(),
  deadline: z.iso.datetime(),
  budget: z
    .object({
      scope: z.enum(["project_day", "project_minute", "user_minute"]),
      used: z.number().nonnegative(),
      ceiling: z.number().nonnegative(),
      requested: z.number().nonnegative(),
    })
    .nullable(),
});
export type SyncRefusal = z.infer<typeof refusalSchema>;
export const syncDiagnosticsSchema = z.object({
  sampledAt: z.iso.datetime(),
  health: z.enum(["Synchronizing", "Waiting", "Up to date", "Needs attention"]),
  freshness: z.enum(["current", "overdue", "unknown"]),
  phase: z.enum([...syncPhases, "idle", "retry", "unknown"]),
  priority: z.number().int().min(0).max(2).nullable(),
  worker: z.enum([
    "executing",
    "queued",
    "rate_limited",
    "waiting_eligibility",
    "idle",
    "unknown",
  ]),
  reason: z.string().nullable(),
  lastCheckAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
  nextEligibleAt: z.iso.datetime().nullable(),
  quotaBackoffUntil: z.iso.datetime().nullable(),
  lastMaterializedAt: z.iso.datetime().nullable(),
  pending: z.object({
    p0: z.number().int().nonnegative(),
    p1: z.number().int().nonnegative(),
    p2: z.number().int().nonnegative(),
    unit: z.enum(["items", "jobs"]),
  }),
  refusal: refusalSchema.nullable(),
  quota: z.array(
    z.object({
      scope: z.string(),
      used: z.number().nonnegative(),
      ceiling: z.number().nonnegative(),
    }),
  ),
  events: z.array(syncEventSchema).max(80),
});
export type SyncDiagnostics = z.infer<typeof syncDiagnosticsSchema>;

export function gmailNeedsAttention(
  status: string | null,
  category: string | null,
  deadline: string | null,
  now: number,
) {
  return (
    ["blocked", "reconcile_required"].includes(status ?? "") ||
    (!!category &&
      category !== "quota" &&
      !!deadline &&
      Date.parse(deadline) > now)
  );
}

/** An elapsed deadline is not evidence of an active quota block. */
export function currentSyncStatus(input: {
  now: number;
  enabled: boolean;
  executing: boolean;
  queued: boolean;
  lastCheckAt: string | null;
  dueAt: string | null;
  deadline: string | null;
  errorCategory: string | null;
  lockHeld: boolean;
  persistentError: boolean;
  intervalMs: number;
  commandPending?: boolean;
  retryQueued?: boolean;
}): Pick<SyncDiagnostics, "health" | "freshness" | "worker" | "reason"> {
  const freshness = !input.lastCheckAt
    ? "unknown"
    : input.now - Date.parse(input.lastCheckAt) > input.intervalMs
      ? "overdue"
      : "current";
  const delayed = !!input.deadline && Date.parse(input.deadline) > input.now;
  if (!input.enabled)
    return {
      health: "Waiting",
      freshness,
      worker: "idle",
      reason: "Synchronization is disabled.",
    };
  if (input.executing)
    return {
      health: "Synchronizing",
      freshness,
      worker: "executing",
      reason: "Synchronization currently executing.",
    };
  if (delayed && input.errorCategory === "quota")
    return {
      health: "Waiting",
      freshness,
      worker: "rate_limited",
      reason:
        "Waiting for quota. The retry deadline applies to all account synchronization.",
    };
  if (
    input.persistentError ||
    (delayed && input.errorCategory && input.errorCategory !== "quota")
  )
    return {
      health: "Needs attention",
      freshness,
      worker: delayed ? "waiting_eligibility" : "unknown",
      reason:
        "OAuth or provider error. See technical details for the recorded failure.",
    };
  if (input.lockHeld)
    return {
      health: "Waiting",
      freshness,
      worker: "waiting_eligibility",
      reason: "Another account operation holds the lock.",
    };
  if (input.commandPending)
    return {
      health: "Waiting",
      freshness,
      worker: "waiting_eligibility",
      reason:
        "A pending mail action has precedence over background synchronization.",
    };
  if (input.queued && delayed)
    return {
      health: "Waiting",
      freshness,
      worker: "waiting_eligibility",
      reason:
        input.errorCategory || input.retryQueued
          ? "A queued delivery is waiting for its retry eligibility deadline."
          : "Waiting for the normal polling interval.",
    };
  if (input.queued)
    return {
      health: "Waiting",
      freshness,
      worker: "queued",
      reason: "Waiting for worker admission.",
    };
  if (input.dueAt && Date.parse(input.dueAt) > input.now)
    return {
      health: freshness === "current" ? "Up to date" : "Waiting",
      freshness,
      worker: "waiting_eligibility",
      reason: "Waiting for the normal polling interval.",
    };
  return {
    health: "Waiting",
    freshness,
    worker: "unknown",
    reason: "INBOX work is due; worker admission has not been observed.",
  };
}
