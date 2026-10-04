"use client";
import type { MessageListItem } from "@/modules/mail/application/message-service";
import { MessageRow } from "./message-row";

export function FlatMessageList({
  messages,
  selectedId,
  onSelect,
}: {
  messages: readonly MessageListItem[];
  selectedId: string;
  onSelect: (message: MessageListItem) => void;
}) {
  return (
    <div className="flat-message-list">
      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          selected={selectedId === message.id}
          onSelect={() => onSelect(message)}
        />
      ))}
    </div>
  );
}
