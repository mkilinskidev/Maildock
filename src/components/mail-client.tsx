"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MessageListItem } from "@/modules/mail/application/message-service";
import { LogoutButton } from "@/components/logout-button";

type Address = { name?: string; address?: string };
type Detail = {
  id: string;
  subject: string | null;
  date: string;
  sentAt: string | null;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  attachments: { filename: string | null; type: string; size: string | null }[];
  content: {
    status: string;
    plainText: string | null;
    sanitizedHtml: string | null;
    remoteContentBlocked: boolean;
    error: string | null;
  };
};
function address(values: Address[]) {
  return values
    .map((value) =>
      value.name
        ? `${value.name} <${value.address ?? ""}>`
        : (value.address ?? "Unknown"),
    )
    .join(", ");
}
function shell(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'"><style>body{font:15px/1.55 system-ui,sans-serif;color:#20242b;margin:20px;overflow-wrap:anywhere}table{max-width:100%;display:block;overflow:auto}pre{white-space:pre-wrap}blockquote{border-left:3px solid #d0d7de;padding-left:1em;margin-left:0;color:#596579}</style></head><body>${html}</body></html>`;
}

export function MailClient({
  accounts,
  mailboxesByAccount,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
}) {
  const first = accounts[0];
  const [accountId, setAccountId] = useState(first?.id ?? "");
  const folders = mailboxesByAccount[accountId] ?? [];
  const [mailboxId, setMailboxId] = useState(
    () =>
      folders.find((item) => item.remotePath.toUpperCase() === "INBOX")?.id ??
      folders.find((item) => item.selectable)?.id ??
      "",
  );
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const folder = folders.find((item) => item.id === mailboxId);
  const base = `/api/accounts/${accountId}/mailboxes/${mailboxId}/messages`;

  useEffect(() => {
    if (!accountId || !mailboxId) return;
    let cancelled = false;
    fetch(`${base}?pageSize=50`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Messages could not be loaded.");
        return response.json() as Promise<{ items: MessageListItem[] }>;
      })
      .then((result) => {
        if (!cancelled) setMessages(result.items);
      })
      .catch(() => {
        if (!cancelled) setError("Messages could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, mailboxId, base]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `${base}/${selectedId}`;
    async function load() {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Message could not be loaded.");
      const value = (await response.json()) as Detail;
      if (cancelled) return;
      setDetail(value);
      if (value.content.status === "not_fetched") {
        const queued = await fetch(`${url}/content`, { method: "POST" });
        if (!queued.ok) {
          const body = (await queued.json()) as { error?: string };
          throw new Error(body.error ?? "Content could not be requested.");
        }
        timer = setTimeout(() => void load().catch(handleError), 2500);
      } else if (
        value.content.status === "pending" ||
        value.content.status === "fetching"
      ) {
        timer = setTimeout(() => void load().catch(handleError), 2500);
      }
    }
    function handleError(failure: unknown) {
      if (!cancelled)
        setError(
          failure instanceof Error
            ? failure.message
            : "Message could not be loaded.",
        );
    }
    void load().catch(handleError);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [base, selectedId, retryNonce]);

  async function retryContent() {
    if (!selectedId) return;
    setRetrying(true);
    setError("");
    try {
      const response = await fetch(`${base}/${selectedId}/content`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Content could not be requested.");
      }
      setDetail((current) =>
        current
          ? {
              ...current,
              content: { ...current.content, status: "pending", error: null },
            }
          : current,
      );
      setRetryNonce((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Content could not be requested.",
      );
    } finally {
      setRetrying(false);
    }
  }

  async function refresh() {
    if (!mailboxId) return;
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch(`${base}/refresh`, { method: "POST" });
      if (!response.ok)
        throw new Error("Synchronization could not be requested.");
      window.setTimeout(async () => {
        const result = await fetch(`${base}?pageSize=50`);
        if (result.ok)
          setMessages(
            ((await result.json()) as { items: MessageListItem[] }).items,
          );
        setRefreshing(false);
      }, 2500);
    } catch {
      setError("Synchronization could not be requested.");
      setRefreshing(false);
    }
  }

  return (
    <main className="mail-app">
      <aside className="mail-sidebar">
        <div className="mail-brand">Maildock</div>
        <select
          aria-label="Account"
          value={accountId}
          onChange={(event) => {
            const id = event.target.value;
            setMessages([]);
            setSelectedId("");
            setDetail(null);
            setError("");
            setAccountId(id);
            const next = mailboxesByAccount[id] ?? [];
            setMailboxId(
              next.find((item) => item.remotePath.toUpperCase() === "INBOX")
                ?.id ??
                next.find((item) => item.selectable)?.id ??
                "",
            );
          }}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName}
            </option>
          ))}
        </select>
        <nav className="mail-folders" aria-label="Mailboxes">
          {folders
            .filter(
              (item) => item.selectable && item.lifecycleStatus === "active",
            )
            .map((item) => (
              <button
                key={item.id}
                className={item.id === mailboxId ? "active" : ""}
                onClick={() => {
                  setMessages([]);
                  setSelectedId("");
                  setDetail(null);
                  setError("");
                  setMailboxId(item.id);
                }}
              >
                <span>{item.name}</span>
                <small>{item.unseenCount ?? item.messageCount ?? ""}</small>
              </button>
            ))}
        </nav>
        <div className="mail-sidebar-footer">
          <Link href="/accounts">Accounts & settings</Link>
          <Link href="/accounts/new">Add account</Link>
          <LogoutButton />
        </div>
      </aside>
      <section className="mail-list-pane" aria-label="Messages">
        <header className="mail-pane-header">
          <div>
            <h1>{folder?.name ?? "Mail"}</h1>
            <small>{messages.length} recent messages</small>
          </div>
          <button onClick={() => void refresh()} disabled={refreshing}>
            ↻ <span>Sync</span>
          </button>
        </header>
        {error && <p className="error mail-error">{error}</p>}
        <div className="mail-rows">
          {messages.map((message) => (
            <button
              key={message.id}
              className={`mail-list-row ${selectedId === message.id ? "selected" : ""} ${message.seen ? "" : "unread"}`}
              onClick={() => {
                if (selectedId === message.id) return;
                setDetail(null);
                setError("");
                setSelectedId(message.id);
              }}
            >
              <span className="mail-row-top">
                <strong>
                  <i>{message.seen ? "" : "●"}</i>
                  {message.from[0]?.name ||
                    message.from[0]?.address ||
                    "Unknown sender"}
                </strong>
                <time>{new Date(message.date).toLocaleDateString()}</time>
              </span>
              <span className="mail-row-subject">
                {message.subject || "(No subject)"}
              </span>
              <span className="mail-row-bottom">
                {message.hasAttachments ? "📎 Attachment" : ""}
              </span>
            </button>
          ))}
        </div>
        {!messages.length && (
          <p className="mail-placeholder">
            No synchronized messages in this mailbox.
          </p>
        )}
      </section>
      <section className="mail-detail-pane" aria-label="Message detail">
        {!selectedId && (
          <div className="mail-empty-detail">Select a message to read it.</div>
        )}
        {selectedId && !detail && (
          <p className="mail-placeholder">Loading local message…</p>
        )}
        {detail && (
          <>
            <header className="mail-detail-header">
              <h2>{detail.subject || "(No subject)"}</h2>
              <div>
                <strong>From:</strong> {address(detail.from)}
              </div>
              <div>
                <strong>To:</strong> {address(detail.to)}
              </div>
              {detail.cc.length > 0 && (
                <div>
                  <strong>Cc:</strong> {address(detail.cc)}
                </div>
              )}
              <time>
                {new Date(detail.sentAt ?? detail.date).toLocaleString()}
              </time>
            </header>
            {detail.content.remoteContentBlocked && (
              <div className="mail-privacy">Remote content blocked</div>
            )}
            <div className="mail-body">
              {detail.content.status === "ready" ? (
                detail.content.sanitizedHtml !== null ? (
                  <iframe
                    title="Email content"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={shell(detail.content.sanitizedHtml)}
                  />
                ) : (
                  <pre>{detail.content.plainText}</pre>
                )
              ) : detail.content.status === "failed" ? (
                <div className="mail-content-failure">
                  <p className="error">
                    {detail.content.error ?? "Content fetch failed."}
                  </p>
                  <button
                    onClick={() => void retryContent()}
                    disabled={retrying}
                  >
                    Retry download
                  </button>
                </div>
              ) : (
                <p className="muted">Downloading message content…</p>
              )}
            </div>
            {detail.attachments.length > 0 && (
              <div className="mail-attachments">
                <h3>Attachments</h3>
                {detail.attachments.map((item, index) => (
                  <span key={index} className="mail-attachment">
                    {item.filename ?? "Unnamed attachment"} · {item.type}
                    {item.size
                      ? ` · ${Math.ceil(Number(item.size) / 1024)} KB`
                      : ""}{" "}
                    · Not available yet
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
