"use client";

import { useEffect, useState } from "react";
import {
  syncDiagnosticsSchema,
  type SyncDiagnostics,
  type SyncEvent,
} from "@/modules/mail/domain/sync-observability";

export const operationLabels = {
  credentials: "Preparing account connection",
  inbox: "Checking INBOX",
  history_discovery: "Discovering Gmail history",
  history_drain: "Processing Gmail history",
  history_checkpoint: "Completing Gmail history",
  inventory: "Importing older mail",
  bootstrap: "Preparing synchronization",
  imap_recent: "Checking recent IMAP mail",
  imap_delta: "Checking IMAP changes",
  imap_backfill: "Importing older IMAP mail",
  idle: "Idle",
  retry: "Waiting to retry",
  unknown: "Current operation unavailable",
};
export function eventDescription(event: SyncEvent) {
  if (event.kind === "history_page_discovered")
    return `Gmail history page discovered${event.count !== undefined ? `, ${event.count} items staged` : ""}`;
  if (event.kind === "history_slice_drained")
    return `Gmail history slice drained${event.count !== undefined ? `, ${event.count} items processed` : ""}`;
  if (event.kind === "materialized")
    return (
      [
        event.newMessages
          ? `${event.newMessages} new INBOX messages materialized`
          : "",
        event.readChanges
          ? `${event.readChanges} read/unread changes applied`
          : "",
        event.count ? `${event.count} INBOX removals applied` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "INBOX changes materialized"
    );
  if (event.kind === "backoff_entered") return "Quota backoff entered";
  if (event.kind === "backoff_exited")
    return "Quota backoff deadline elapsed; retry admitted";
  if (event.kind === "recovery") return "Synchronization recovered";
  if (event.kind === "error") return "Synchronization error recorded";
  if (event.kind === "lock_wait")
    return "Account operation could not acquire its lock";
  if (event.kind === "admitted") return "Worker admitted";
  if (event.kind === "yield") return "Worker yielded";
  if (event.phase === "inbox")
    return event.kind === "started"
      ? "INBOX observation slice started"
      : "INBOX check completed";
  return `${operationLabels[event.phase]} — ${event.kind === "completed" ? "slice completed" : event.kind}`;
}
function relative(at: string, now: number) {
  const seconds = Math.round((Date.parse(at) - now) / 1000);
  const value = Math.abs(seconds);
  const amount =
    value < 60
      ? `${value} seconds`
      : value < 3600
        ? `${Math.round(value / 60)} minutes`
        : `${Math.round(value / 3600)} hours`;
  return seconds > 0 ? `in ${amount}` : `${amount} ago`;
}
function CheckTime({ at, now }: { at: string | null; now: number }) {
  return at ? (
    <>
      <time dateTime={at}>{new Date(at).toLocaleTimeString()}</time>
      <small>
        {relative(at, now)} · {new Date(at).toLocaleDateString()}
      </small>
    </>
  ) : (
    <>Not yet recorded</>
  );
}

function ActivityTimeline({
  events,
  now,
}: {
  events: SyncEvent[];
  now: number;
}) {
  return (
    <ol>
      {events.map((event, i) => (
        <li key={`${event.at}-${i}`}>
          <time dateTime={event.at}>
            {new Date(event.at).toLocaleTimeString()}
          </time>
          <div>
            <p>{eventDescription(event)}</p>
            <details>
              <summary>Event details</summary>
              <p>
                {operationLabels[event.phase]}
                {event.priority !== null ? ` · P${event.priority}` : ""} ·{" "}
                {relative(event.at, now)}
              </p>
            </details>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SyncDiagnosticsView({
  name,
  email,
  diagnostics: d,
  now = Date.parse(d.sampledAt),
}: {
  name: string;
  email: string;
  diagnostics: SyncDiagnostics;
  now?: number;
}) {
  const pending = d.pending.p0 + d.pending.p1 + d.pending.p2;
  const activeRefusal =
    d.refusal?.deadline === d.nextEligibleAt && d.refusal?.category === "quota"
      ? d.refusal
      : null;
  return (
    <section
      className="sync-diagnostics-card"
      aria-label="INBOX synchronization"
    >
      <header className="sync-diagnostics-header">
        <div>
          <p className="muted">
            {name} · {email}
          </p>
          <h3>INBOX synchronization</h3>
        </div>
        <span
          className={`sync-health ${d.health === "Needs attention" ? "attention" : d.health === "Up to date" ? "current" : "neutral"}`}
        >
          {d.health}
        </span>
      </header>
      <div className="sync-diagnostics-grid">
        <div>
          <p>Last successful INBOX check</p>
          <strong>
            <CheckTime at={d.lastCheckAt} now={now} />
          </strong>
        </div>
        <div>
          <p>Next INBOX check</p>
          <strong>
            {d.quotaBackoffUntil ? (
              "Waiting for quota"
            ) : d.phase === "inbox" ? (
              "Observation in progress"
            ) : d.nextCheckAt ? (
              <CheckTime at={d.nextCheckAt} now={now} />
            ) : (
              "Awaiting scheduling evidence"
            )}
          </strong>
        </div>
        <div>
          <p>Current operation</p>
          <strong>{operationLabels[d.phase]}</strong>
          <small>
            {d.worker.replaceAll("_", " ")}
            {d.priority !== null ? ` · P${d.priority}` : ""}
          </small>
        </div>
        <div>
          <p>Pending operations</p>
          <strong>
            {pending.toLocaleString()} {d.pending.unit}
          </strong>
          <small>
            P0 {d.pending.p0} · P1 {d.pending.p1} · P2 {d.pending.p2}
          </small>
        </div>
      </div>
      <p className="sync-freshness">
        {d.freshness === "current"
          ? "INBOX was checked within the normal polling interval."
          : d.freshness === "overdue"
            ? "INBOX check is overdue. Changes since the last check may not be visible yet."
            : "Current INBOX freshness has not been established."}
      </p>
      {d.reason && (
        <div className="sync-waiting">
          <h4>Why is synchronization waiting?</h4>
          <p>
            {d.quotaBackoffUntil && activeRefusal?.source === "gmail_http"
              ? "Gmail rate limit reached."
              : d.quotaBackoffUntil && activeRefusal?.source === "local_budget"
                ? "Local synchronization quota exhausted."
                : d.reason}
          </p>
          {d.nextEligibleAt && Date.parse(d.nextEligibleAt) > now ? (
            <small>
              Next eligible attempt:{" "}
              <CheckTime at={d.nextEligibleAt} now={now} />
            </small>
          ) : d.nextCheckAt && Date.parse(d.nextCheckAt) > now ? (
            <small>
              Next INBOX check {relative(d.nextCheckAt, now)}. Scheduling may
              add delay.
            </small>
          ) : null}
        </div>
      )}
      <div className="sync-recent">
        <h4>Recent activity</h4>
        {d.events.length ? (
          <ActivityTimeline events={d.events.slice(0, 20)} now={now} />
        ) : (
          <p className="muted">No recent diagnostic events recorded.</p>
        )}
        {d.events.length > 20 && (
          <details>
            <summary>Older recent activity ({d.events.length - 20})</summary>
            <ActivityTimeline events={d.events.slice(20)} now={now} />
          </details>
        )}
      </div>
      <details className="sync-technical">
        <summary>Technical details</summary>
        <dl className="settings-facts">
          <dt>Snapshot</dt>
          <dd>{new Date(d.sampledAt).toLocaleString()}</dd>
          <dt>Last INBOX change materialized</dt>
          <dd>
            {d.lastMaterializedAt
              ? new Date(d.lastMaterializedAt).toLocaleString()
              : "Not yet recorded"}
          </dd>
          <dt>Next eligible account attempt</dt>
          <dd>
            {d.nextEligibleAt
              ? new Date(d.nextEligibleAt).toLocaleString()
              : "No deadline recorded"}
          </dd>
          <dt>Quota state</dt>
          <dd>
            {d.quotaBackoffUntil
              ? "Active backoff"
              : "No active quota backoff evidenced"}
          </dd>
          {d.quota.map((q) => (
            <div className="sync-quota" key={q.scope}>
              <dt>{q.scope.replaceAll("_", " ")}</dt>
              <dd>
                {q.used.toLocaleString()} / {q.ceiling.toLocaleString()}{" "}
                background units
              </dd>
            </div>
          ))}
          {d.refusal && (
            <>
              <dt>Last recorded refusal (historical)</dt>
              <dd>
                {new Date(d.refusal.at).toLocaleString()} · {d.refusal.category}
              </dd>
              <dt>Refusal source</dt>
              <dd>{d.refusal.source ?? "Unknown"}</dd>
              <dt>HTTP status / Google reasons</dt>
              <dd>
                {d.refusal.status ?? "Not recorded"} ·{" "}
                {d.refusal.reasons.join(", ") || "Not recorded"}
              </dd>
              <dt>Retry-After / calculated deadline</dt>
              <dd>
                {d.refusal.retryAfter ?? `${d.refusal.retryAfterMs} ms`} ·{" "}
                {new Date(d.refusal.deadline).toLocaleString()}
              </dd>
              {d.refusal.budget && (
                <>
                  <dt>Budget at refusal</dt>
                  <dd>
                    {d.refusal.budget.scope}: {d.refusal.budget.used} /{" "}
                    {d.refusal.budget.ceiling} · requested{" "}
                    {d.refusal.budget.requested}
                  </dd>
                </>
              )}
            </>
          )}
        </dl>
        <p className="muted">
          Completed phases describe past work. Freshness refers to the last
          complete INBOX observation. Pending Gmail counts are durable items;
          IMAP counts are queued jobs.
        </p>
      </details>
    </section>
  );
}

export function SyncDiagnosticsCard({
  accountId,
  name,
  email,
  visible,
}: {
  accountId: string;
  name: string;
  email: string;
  visible: boolean;
}) {
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let busy = false;
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const response = await fetch(
          `/api/accounts/${accountId}/sync-diagnostics`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error();
        const next = syncDiagnosticsSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setDiagnostics(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        busy = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accountId, visible]);
  return (
    <>
      {error && (
        <p className="error" role="alert">
          Synchronization diagnostics could not be refreshed.{" "}
          {diagnostics ? "The snapshot below is historical." : ""}
        </p>
      )}
      {diagnostics ? (
        <SyncDiagnosticsView
          name={name}
          email={email}
          diagnostics={
            error
              ? {
                  ...diagnostics,
                  health: "Waiting",
                  worker: "unknown",
                  phase: "unknown",
                  reason:
                    "Current activity is unavailable. This is the last recorded snapshot.",
                }
              : diagnostics
          }
          now={Date.parse(diagnostics.sampledAt)}
        />
      ) : (
        <p role="status">
          {error
            ? "Current synchronization state is unavailable."
            : "Loading synchronization activity…"}
        </p>
      )}
    </>
  );
}
