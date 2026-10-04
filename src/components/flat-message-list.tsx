"use client";
import type { MessageListItem } from "@/modules/mail/application/message-service";
import { MessageRow } from "./message-row";

export function FlatMessageList({
  checkedIds = [],
  onToggle,
  messages,
  selectedId,
  onSelect,
}: {
  checkedIds?: string[];
  onToggle?: (message: MessageListItem) => void;
  messages: readonly MessageListItem[];
  selectedId: string;
  onSelect: (message: MessageListItem) => void;
}) {
  return (
    <div
      className={`flat-message-list${checkedIds.length ? " selection-mode" : ""}`}
    >
      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          checked={checkedIds.includes(message.id)}
          onToggle={onToggle ? () => onToggle(message) : undefined}
          selected={selectedId === message.id}
          onSelect={() => onSelect(message)}
        />
      ))}
    </div>
  );
}
