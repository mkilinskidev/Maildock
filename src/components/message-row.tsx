"use client";

import { messageDate } from "@/shared/application/message-date";
import { Flag, Paperclip } from "lucide-react";
import type { MessageListItem } from "@/modules/mail/application/message-service";

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
          <strong>
            {message.from[0]?.name ||
              message.from[0]?.address ||
              "Unknown sender"}
          </strong>
          <time dateTime={message.date} title={messageDate(message.date).title}>
            {messageDate(message.date).text}
          </time>
        </span>
        <span className="mail-row-subject">
          {message.subject || "(No subject)"}
        </span>
        {message.snippet ? (
          <span className="mail-row-snippet">{message.snippet}</span>
        ) : null}
        {!compact ||
        message.hasAttachments ||
        message.flagged ||
        message.accountName ? (
          <span className="mail-row-bottom">
            {message.accountName ? <span>{message.accountName}</span> : null}
            {message.flagged ? <Flag size={12} aria-label="Flagged" /> : null}
            {message.hasAttachments ? (
              <>
                <Paperclip size={12} /> Attachment
              </>
            ) : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}
