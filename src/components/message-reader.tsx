"use client";
import {
  Reply,
  ReplyAll,
  Forward,
  Archive,
  Trash2,
  Star,
  Eye,
  EyeOff,
  MailOpen,
  CircleAlert,
} from "lucide-react";
import { RichEmailBody } from "./rich-email-body";
import { AttachmentList } from "./attachment-list";
import type { AttachmentView } from "@/modules/mail/domain/attachments";
import type { ComposeMode } from "@/modules/mail/domain/compose-source";
type Address = { name?: string; address?: string };
export type MessageDetail = {
  id: string;
  seen: boolean;
  flagged: boolean;
  subject: string | null;
  date: string;
  sentAt: string | null;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  attachments: AttachmentView[];
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
export type MessageAction =
  "archive" | "trash" | "mark_read" | "mark_unread" | "flag" | "unflag";
export function MessageReader({
  selectedId,
  detail,
  loadingDetail,
  selectedMessage,
  preparing,
  prepareError,
  retrying,
  prepare,
  act,
  moveAvailable,
  retryContent,
  renderUrl,
  contentPollIntervalMs,
}: {
  selectedId: string;
  detail: MessageDetail | null;
  loadingDetail: boolean;
  selectedMessage?: { seen: boolean; flagged: boolean };
  preparing: boolean;
  prepareError: string;
  retrying: boolean;
  prepare: (mode: ComposeMode) => Promise<void>;
  act: (action: MessageAction) => Promise<void>;
  moveAvailable: (action: "archive" | "trash") => boolean;
  retryContent: () => Promise<void>;
  renderUrl?: string;
  contentPollIntervalMs?: number;
}) {
  const sender = detail?.from[0];
  const senderName = sender?.name || sender?.address || "Unknown sender";
  return (
    <>
      {!selectedId ? (
        <div className="pane-empty reader-empty">
          <MailOpen size={30} strokeWidth={1.4} />
          <strong>Select a message</strong>
          <p>Choose a message from the list to read it here.</p>
        </div>
      ) : null}
      {selectedId && loadingDetail && !detail ? (
        <div className="mail-detail-header">
          <div className="skeleton" style={{ width: "60%", height: 22 }} />
          <div
            className="skeleton"
            style={{ width: "40%", height: 13, marginTop: 24 }}
          />
        </div>
      ) : null}
      {detail ? (
        <>
          <header className="mail-detail-header">
            <div
              className="message-actions"
              role="toolbar"
              aria-label="Message actions"
            >
              {(
                [
                  { mode: "reply", label: "Reply", Icon: Reply },
                  {
                    mode: "reply_all",
                    label: "Reply All",
                    Icon: ReplyAll,
                  },
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
                  <Icon size={17} />
                </button>
              ))}
              <button
                className="icon-button"
                title="Archive"
                aria-label="Archive"
                disabled={!moveAvailable("archive")}
                onClick={() => void act("archive")}
              >
                <Archive size={17} />
              </button>
              <button
                className="icon-button"
                title="Move to Trash"
                aria-label="Move to Trash"
                disabled={!moveAvailable("trash")}
                onClick={() => void act("trash")}
              >
                <Trash2 size={17} />
              </button>
              <button
                className="icon-button"
                title={selectedMessage?.seen ? "Mark unread" : "Mark read"}
                aria-label={selectedMessage?.seen ? "Mark unread" : "Mark read"}
                onClick={() =>
                  void act(selectedMessage?.seen ? "mark_unread" : "mark_read")
                }
              >
                {selectedMessage?.seen ? (
                  <EyeOff size={17} />
                ) : (
                  <Eye size={17} />
                )}
              </button>
              <button
                className="icon-button"
                title={selectedMessage?.flagged ? "Unflag" : "Flag"}
                aria-label={selectedMessage?.flagged ? "Unflag" : "Flag"}
                onClick={() =>
                  void act(selectedMessage?.flagged ? "unflag" : "flag")
                }
              >
                <Star
                  size={17}
                  fill={selectedMessage?.flagged ? "currentColor" : "none"}
                />
              </button>
            </div>
            {preparing ? <p role="status">Preparing message…</p> : null}
            {prepareError ? (
              <p role="alert" className="error">
                {prepareError}
              </p>
            ) : null}
            <h2>{detail.subject || "(No subject)"}</h2>
            <div className="reader-sender">
              <span className="sender-avatar">{senderName.charAt(0)}</span>
              <div className="reader-addresses">
                <strong>{senderName}</strong>
                <small>
                  {sender?.name ? sender.address : address(detail.from)}
                </small>
              </div>
              <time
                className="reader-date"
                dateTime={detail.sentAt ?? detail.date}
              >
                {new Date(detail.sentAt ?? detail.date).toLocaleString()}
              </time>
            </div>
            <div className="reader-meta">
              To: {address(detail.to)}
              {detail.cc.length ? " · Cc: " + address(detail.cc) : ""}
            </div>
          </header>
          <div className="mail-body" key={`body:${detail.id}`}>
            {detail.content.status === "ready" ? (
              detail.content.sanitizedHtml?.trim() && renderUrl ? (
                <RichEmailBody
                  contentPollIntervalMs={contentPollIntervalMs}
                  key={detail.id}
                  url={renderUrl}
                  plainText={detail.content.plainText}
                />
              ) : (
                <pre>{detail.content.plainText}</pre>
              )
            ) : detail.content.status === "failed" ? (
              <div className="mail-content-failure">
                {detail.content.plainText ? (
                  <pre>{detail.content.plainText}</pre>
                ) : null}
                <p className="error">
                  <CircleAlert size={15} />{" "}
                  {detail.content.error ?? "Content fetch failed."}
                </p>
                <button
                  className="button secondary"
                  onClick={() => void retryContent()}
                  disabled={retrying}
                >
                  Retry download
                </button>
              </div>
            ) : (
              <div className="pane-empty">
                <div className="skeleton" style={{ width: 180, height: 11 }} />
                <p>Downloading message content…</p>
              </div>
            )}
          </div>
          <AttachmentList key={detail.id} attachments={detail.attachments} />
        </>
      ) : null}
    </>
  );
}
