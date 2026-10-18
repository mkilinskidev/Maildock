"use client";
import { Fragment, useEffect, useState } from "react";
import {
  eventAreas,
  eventLevels,
  type ApplicationEventPage,
  type ApplicationEventView,
} from "@/modules/diagnostics/domain/application-event";
const detailLabels = {
  category: "Category",
  mailboxPath: "Mailbox path",
  uidValidity: "UIDVALIDITY",
  phase: "Failed step",
  reason: "Triggered by",
  imapStatus: "IMAP status",
  imapResponseCode: "IMAP response code",
  errorCode: "Error code",
};
const categoryDescriptions: Record<string, string> = {
  dns_or_host_unreachable: "The mail server could not be reached.",
  connection_timeout: "The mail server did not respond in time.",
  tls_certificate_failure: "The mail server's TLS certificate was rejected.",
  authentication_rejected: "The mail server rejected the stored credentials.",
  starttls_unavailable: "The mail server did not offer the required STARTTLS.",
  verification_failed: "The SMTP server rejected the verification.",
  server_rejected: "The mail server refused the request.",
  server_unavailable:
    "The mail server is temporarily unavailable or limiting requests. Maildock retries automatically.",
  connection_lost: "The connection to the mail server closed unexpectedly.",
  mailbox_unavailable: "The mailbox no longer exists on the mail server.",
  internal_error: "Maildock failed while processing the request.",
};
const valueLabels: Record<string, Record<string, string>> = {
  phase: {
    connect: "Connecting",
    open_mailbox: "Opening the mailbox",
    search: "Searching messages",
    fetch: "Downloading messages",
    flags: "Synchronizing flags",
    status: "Reading mailbox status",
    save: "Saving to Maildock",
  },
  reason: {
    idle: "Server notification (IDLE)",
    poll: "Scheduled check",
    manual: "Manual sync",
    "post-discovery": "Folder discovery",
  },
};
export function ApplicationLogs({
  accounts,
  initialAccountId = "",
}: {
  accounts: { id: string; displayName: string }[];
  initialAccountId?: string;
}) {
  const [accountId, setAccountId] = useState(initialAccountId);
  const [level, setLevel] = useState("");
  const [area, setArea] = useState("");
  const [events, setEvents] = useState<ApplicationEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  function resetPage() {
    setLoading(true);
    setError("");
    setEvents([]);
    setCursor(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "50" });
    if (accountId) params.set("accountId", accountId);
    if (level) params.set("level", level);
    if (area) params.set("area", area);
    void fetch(`/api/application-events?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return (await r.json()) as ApplicationEventPage;
      })
      .then((page) => {
        if (controller.signal.aborted) return;
        setEvents(page.events);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Application logs could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [accountId, level, area, reload]);
  async function loadMore() {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "50", cursor: cursor! });
    if (accountId) params.set("accountId", accountId);
    if (level) params.set("level", level);
    if (area) params.set("area", area);
    try {
      const response = await fetch(`/api/application-events?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const page = (await response.json()) as ApplicationEventPage;
      setEvents((previous) => [...previous, ...page.events]);
      setCursor(page.nextCursor);
    } catch {
      setError("Application logs could not be loaded.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <header className="settings-pane-header">
        <h2>Application logs</h2>
        <p>
          Significant mail lifecycle events and problems. Routine polling is
          recorded in Docker logs.
        </p>
      </header>
      <div className="application-log-filters">
        <label>
          Level
          <select
            disabled={loading}
            value={level}
            onChange={(e) => {
              if (e.target.value !== level) {
                resetPage();
                setLevel(e.target.value);
              }
            }}
          >
            <option value="">All levels</option>
            {eventLevels.map((v) => (
              <option key={v} value={v}>
                {v.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          Account
          <select
            disabled={loading}
            value={accountId}
            onChange={(e) => {
              if (e.target.value !== accountId) {
                resetPage();
                setAccountId(e.target.value);
              }
            }}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Area
          <select
            disabled={loading}
            value={area}
            onChange={(e) => {
              if (e.target.value !== area) {
                resetPage();
                setArea(e.target.value);
              }
            }}
          >
            <option value="">All areas</option>
            {eventAreas.map((v) => (
              <option key={v} value={v}>
                {v.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => {
            resetPage();
            setReload((v) => v + 1);
          }}
        >
          Refresh
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && !error && !events.length ? (
        <p>No diagnostic events yet.</p>
      ) : null}
      <ol className="application-log-list">
        {events.map((e) => (
          <li key={e.id}>
            <details>
              <summary>
                <div className="application-log-heading">
                  <time dateTime={e.createdAt}>
                    {new Date(e.createdAt).toLocaleString()}
                  </time>
                  <span className="application-log-source muted">
                    {[e.accountName, e.mailboxPath, e.area.toUpperCase()]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <strong className="application-log-message">
                    {e.message}
                  </strong>
                  <strong className={`application-log-level ${e.level}`}>
                    {e.level.toUpperCase()}
                  </strong>
                </div>
              </summary>
              {e.details.category &&
              categoryDescriptions[e.details.category] ? (
                <p>{categoryDescriptions[e.details.category]}</p>
              ) : null}
              <dl className="settings-facts">
                <dt>Event</dt>
                <dd>{e.event}</dd>
                {e.accountId ? (
                  <>
                    <dt>Account ID</dt>
                    <dd>{e.accountId}</dd>
                  </>
                ) : null}
                {e.mailboxId ? (
                  <>
                    <dt>Mailbox ID</dt>
                    <dd>{e.mailboxId}</dd>
                  </>
                ) : null}
                {Object.entries(e.details).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{detailLabels[key as keyof typeof detailLabels]}</dt>
                    <dd>{valueLabels[key]?.[value] ?? value}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ol>
      {loading ? <p role="status">Loading application logs…</p> : null}
      {cursor ? (
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          Load older events
        </button>
      ) : null}
    </>
  );
}
