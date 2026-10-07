"use client";

import { useEffect, useState } from "react";

import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MessageListItem } from "@/modules/mail/application/message-service";

function sender(message: MessageListItem): string {
  const first = message.from[0];
  return first?.name || first?.address || "Unknown sender";
}

async function fetchMessages(accountId: string, mailboxId: string) {
  const response = await fetch(
    `/api/accounts/${accountId}/mailboxes/${mailboxId}/messages?pageSize=50`,
  );
  const result = (await response.json()) as {
    items?: MessageListItem[];
    error?: string;
  };
  if (!response.ok)
    throw new Error(result.error ?? "Messages could not be loaded.");
  return result.items ?? [];
}

export function MessageList({
  accountId,
  mailbox,
}: {
  accountId: string;
  mailbox: MailboxView;
}) {
  const [messages, setMessages] = useState<readonly MessageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void fetchMessages(accountId, mailbox.id)
      .then((items) => {
        if (!cancelled) setMessages(items);
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(
            failure instanceof Error
              ? failure.message
              : "Messages could not be loaded.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, mailbox.id]);

  async function refresh() {
    setError(undefined);
    const response = await fetch(
      `/api/accounts/${accountId}/mailboxes/${mailbox.id}/messages/refresh`,
      { method: "POST" },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(
        result.error ?? "Recent synchronization could not be scheduled.",
      );
      return;
    }
    window.setTimeout(() => {
      void fetchMessages(accountId, mailbox.id)
        .then(setMessages)
        .catch(() => setError("Messages could not be loaded."));
    }, 1500);
  }

  return (
    <section className="message-panel" aria-label={`${mailbox.name} messages`}>
      <div className="message-panel-header">
        <div>
          <h3>{mailbox.name}</h3>
          <p className="muted">
            Sync: {mailbox.recentSync.status} · Last successful:{" "}
            {mailbox.recentSync.lastSuccessfulAt
              ? new Date(mailbox.recentSync.lastSuccessfulAt).toLocaleString()
              : "Never"}
          </p>
        </div>
        <button onClick={() => void refresh()}>Refresh messages</button>
      </div>
      {mailbox.recentSync.error ? (
        <p className="error">{mailbox.recentSync.error}</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading local messages…</p> : null}
      {!loading && messages.length === 0 ? (
        <p className="muted">No synchronized recent messages.</p>
      ) : null}
      <div className="message-list">
        {messages.map((message) => (
          <div
            className={`message-row${message.seen ? "" : " unread"}`}
            key={message.id}
          >
            <span
              className="unread-dot"
              aria-label={message.seen ? "Read" : "Unread"}
            >
              {message.seen ? "" : "●"}
            </span>
            <span className="message-sender">{sender(message)}</span>
            <span className="message-subject">
              {message.flagged ? "★ " : ""}
              {message.subject || "(No subject)"}
            </span>
            <span
              aria-label={message.hasAttachments ? "Has attachment" : undefined}
            >
              {message.hasAttachments ? "📎" : ""}
            </span>
            <time dateTime={message.date}>
              {new Date(message.date).toLocaleString()}
            </time>
          </div>
        ))}
      </div>
    </section>
  );
}
