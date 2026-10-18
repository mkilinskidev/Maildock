"use client";

import { messageDate } from "@/shared/application/message-date";
import { Flag, Paperclip } from "lucide-react";
import type { MessageListItem } from "@/modules/mail/application/message-service";

export function senderLabel(
  from: readonly { name?: string; address?: string }[],
) {
  return from[0]?.name || from[0]?.address || "Unknown sender";
}

// A stable hue per sender keeps avatars recognisable without remote images.
export function SenderAvatar({ sender }: { sender: string }) {
  let hue = 0;
  for (const char of sender.toLowerCase())
    hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return (
    <span
      className="mail-row-avatar"
      aria-hidden="true"
      style={{ "--avatar-hue": hue } as React.CSSProperties}
    >
      {sender.trim().charAt(0) || "?"}
    </span>
  );
}

export function MessageRow({
  checked = false,
  onToggle,
  message,
  selected,
  onSelect,
  compact = false,
  disabled = false,
}: {
  checked?: boolean;
  onToggle?: () => void;
  message: MessageListItem;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="mail-selectable-row">
      {onToggle ? (
        <input
          type="checkbox"
          aria-label={`Select ${message.subject || "(No subject)"}`}
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
        />
      ) : null}
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
          <SenderAvatar sender={senderLabel(message.from)} />
          <strong>{senderLabel(message.from)}</strong>
          <time dateTime={message.date} title={messageDate(message.date).title}>
            {messageDate(message.date).text}
          </time>
        </span>
        <span className="mail-row-text">
          <span className="mail-row-subject">
            {message.subject || "(No subject)"}
          </span>
          {message.snippet ? (
            <span className="mail-row-snippet">{message.snippet}</span>
          ) : null}
        </span>
        {!compact ||
        message.hasAttachments ||
        message.flagged ||
        message.accountName ? (
          <span className="mail-row-bottom">
            {message.accountName ? <span>{message.accountName}</span> : null}
            {message.flagged ? <Flag size={12} aria-label="Flagged" /> : null}
            {message.hasAttachments ? (
              <>
                <Paperclip size={12} aria-hidden="true" />
                <span className="mail-row-label">Attachment</span>
              </>
            ) : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}
