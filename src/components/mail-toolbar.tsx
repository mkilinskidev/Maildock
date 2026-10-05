"use client";
import {
  Reply,
  ReplyAll,
  Forward,
  Archive,
  Trash2,
  Eye,
  EyeOff,
  Flag,
} from "lucide-react";
import type { ComposeMode } from "@/modules/mail/domain/compose-source";
import type { MessageAction } from "./message-reader";

export function MailToolbar({
  count,
  seen,
  flagged,
  preparing,
  prepare,
  act,
  moveAvailable,
}: {
  count: number;
  seen?: boolean;
  flagged?: boolean;
  preparing: boolean;
  prepare: (mode: ComposeMode) => Promise<void>;
  act: (action: MessageAction) => Promise<void>;
  moveAvailable: (action: "archive" | "trash") => boolean;
}) {
  return (
    <div
      className="mail-interaction-toolbar"
      role="toolbar"
      aria-label={count ? "Selected message actions" : "Message actions"}
    >
      <div className="mail-toolbar-group">
        {count ? (
          <>
            <strong>{count} selected</strong>
            <button
              className="icon-button"
              title="Mark read"
              aria-label="Mark read"
              onClick={() => void act("mark_read")}
            >
              <Eye size={17} aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              title="Mark unread"
              aria-label="Mark unread"
              onClick={() => void act("mark_unread")}
            >
              <EyeOff size={17} aria-hidden="true" />
            </button>
          </>
        ) : (
          (
            [
              { mode: "reply", label: "Reply", Icon: Reply },
              { mode: "reply_all", label: "Reply All", Icon: ReplyAll },
              { mode: "forward", label: "Forward", Icon: Forward },
            ] as const
          ).map(({ mode, label, Icon }) => (
            <button
              key={mode}
              className="icon-button"
              title={label}
              aria-label={label}
              disabled={preparing}
              onClick={() => void prepare(mode)}
            >
              <Icon size={17} aria-hidden="true" />
            </button>
          ))
        )}
      </div>
      <span className="mail-toolbar-separator" aria-hidden="true" />
      <div className="mail-toolbar-group">
        <button
          className="icon-button"
          title="Archive"
          aria-label="Archive"
          disabled={!moveAvailable("archive")}
          onClick={() => void act("archive")}
        >
          <Archive size={17} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          title="Move to Trash"
          aria-label="Move to Trash"
          disabled={!moveAvailable("trash")}
          onClick={() => void act("trash")}
        >
          <Trash2 size={17} aria-hidden="true" />
        </button>
        {!count ? (
          <>
            <button
              className="icon-button"
              title={seen ? "Mark unread" : "Mark read"}
              aria-label={seen ? "Mark unread" : "Mark read"}
              onClick={() => void act(seen ? "mark_unread" : "mark_read")}
            >
              {seen ? (
                <EyeOff size={17} aria-hidden="true" />
              ) : (
                <Eye size={17} aria-hidden="true" />
              )}
            </button>
            <button
              className="icon-button"
              title={flagged ? "Unflag" : "Flag"}
              aria-label={flagged ? "Unflag" : "Flag"}
              onClick={() => void act(flagged ? "unflag" : "flag")}
            >
              <Flag
                size={17}
                fill={flagged ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
