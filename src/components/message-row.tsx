"use client";

import { Paperclip } from "lucide-react";
import type { MessageListItem } from "@/modules/mail/application/message-service";

export function MessageRow({
  message,
  selected,
  onSelect,
  compact = false,
  disabled = false,
}: {
  message: MessageListItem;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`mail-list-row${compact ? " conversation-child" : ""}${selected ? " selected" : ""}${!message.seen ? " unread" : ""}`}
      aria-current={selected ? "true" : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mail-row-top">
        <span className="mail-row-marker">
          {!message.seen ? (
            <span className="unread-dot" aria-label="Unread" />
          ) : null}
        </span>
        <strong>
          {message.from[0]?.name ||
            message.from[0]?.address ||
            "Unknown sender"}
        </strong>
        <time dateTime={message.date}>
          {compact
            ? new Date(message.date).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : new Date(message.date).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year:
                  new Date(message.date).getFullYear() ===
                  new Date().getFullYear()
                    ? undefined
                    : "numeric",
              })}
        </time>
      </span>
      <span className="mail-row-subject">
        {message.subject || "(No subject)"}
      </span>
      {!compact || message.hasAttachments ? (
        <span className="mail-row-bottom">
          {message.hasAttachments ? (
            <>
              <Paperclip size={12} /> Attachment
            </>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
