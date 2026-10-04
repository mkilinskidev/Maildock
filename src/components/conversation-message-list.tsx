"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MessageListItem } from "@/modules/mail/application/message-service";
import type { ConversationMessage } from "@/modules/mail/application/conversation-service";
import { MessageRow } from "./message-row";

function normalizedSubject(subject: string | null) {
  return (
    subject?.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").trim() || "(No subject)"
  );
}

function ConversationGroup({
  accountId,
  mailboxId,
  representative,
  selectedId,
  refreshKey,
  onSelect,
}: {
  accountId: string;
  mailboxId: string;
  representative: MessageListItem;
  selectedId: string;
  refreshKey: number;
  onSelect: (message: ConversationMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ConversationMessage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const childrenId = useId();
  useEffect(() => {
    if (!expanded || !representative.conversationId) return;
    let cancelled = false;
    let busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/accounts/${accountId}/conversations/${representative.conversationId}?metadataOnly=true&mailboxId=${mailboxId}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw Error("Conversation could not be loaded.");
        const result = (await response.json()) as {
          items: ConversationMessage[];
        };
        if (!cancelled) {
          setItems(result.items);
          setError("");
        }
      } catch {
        if (!cancelled) setError("Conversation could not be loaded.");
      } finally {
        busy = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [
    expanded,
    accountId,
    mailboxId,
    representative.conversationId,
    representative.id,
    representative.messageCount,
    representative.conversationMessageCount,
    representative.seen,
    refreshKey,
    retry,
  ]);
  return (
    <section className="conversation-group">
      <button
        className={`conversation-group-header${!representative.seen ? " unread" : ""}`}
        aria-expanded={expanded}
        aria-controls={childrenId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown size={15} aria-hidden="true" />
        ) : (
          <ChevronRight size={15} aria-hidden="true" />
        )}
        <span className="conversation-subject">
          {normalizedSubject(representative.subject)}
        </span>
        {representative.accountName ? (
          <span
            className="conversation-account"
            title={representative.accountName}
          >
            {representative.accountName}
          </span>
        ) : null}
        {!representative.seen ? (
          <span
            className="unread-dot"
            aria-label="Unread messages in this mailbox"
          />
        ) : null}
        <span className="conversation-count" aria-label="Message count">
          {representative.conversationMessageCount ??
            representative.messageCount ??
            1}
        </span>
      </button>
      {expanded ? (
        <div id={childrenId} className="conversation-children">
          {loading && !items.length ? (
            <p className="conversation-list-status" role="status">
              Loading messages…
            </p>
          ) : null}
          {error ? (
            <div className="conversation-list-status" role="alert">
              {error}{" "}
              <button
                className="button secondary"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : null}
          {items.map((message) => (
            <MessageRow
              key={message.id}
              message={{ ...message, accountName: representative.accountName }}
              compact
              selected={selectedId === message.id}
              disabled={!message.mailboxId}
              onSelect={() => onSelect({ ...message, accountId })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ConversationMessageList({
  accountId,
  mailboxId,
  messages,
  selectedId,
  refreshKey,
  onSelect,
}: {
  accountId: string;
  mailboxId: string;
  messages: readonly MessageListItem[];
  selectedId: string;
  refreshKey: number;
  onSelect: (message: ConversationMessage) => void;
}) {
  return (
    <div className="conversation-message-list">
      {messages.map((message) => (
        <ConversationGroup
          key={message.conversationId ?? message.id}
          accountId={message.accountId ?? accountId}
          mailboxId={message.mailboxId ?? mailboxId}
          representative={message}
          selectedId={selectedId}
          refreshKey={refreshKey}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
