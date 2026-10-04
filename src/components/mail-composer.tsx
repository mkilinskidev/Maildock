"use client";

import type { ComposePrefill } from "@/modules/mail/domain/compose-source";
import { useEffect, useRef, useState } from "react";
import { Send, X, Paperclip } from "lucide-react";
import type { AttachmentView } from "@/modules/mail/domain/attachments";
import { attachmentSize } from "./attachment-list";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";

export function sendingAccountAvailable(account: MailAccountView) {
  return (
    account.enabled &&
    Boolean(account.smtp?.host) &&
    (account.authMethod !== "oauth2" || account.oauthStatus === "connected")
  );
}
export function sendStatusText(status: string, sentCopyStatus?: string) {
  if (status === "sent" && sentCopyStatus === "failed")
    return "Message sent, but the copy could not be saved to Sent.";
  if (status === "sent" && sentCopyStatus === "uncertain")
    return "Message sent, but Maildock could not confirm whether the Sent copy was saved.";
  if (status === "sent" && ["pending", "saving"].includes(sentCopyStatus ?? ""))
    return "Message sent · Saving a copy to Sent…";
  if (status === "sent") return "Message sent";
  if (status === "failed") return "Message could not be sent";
  if (status === "uncertain")
    return "Maildock could not confirm whether this message was sent.";
  return "Sending…";
}

export function MailComposer({
  accounts,
  accountId,
  prefill,
  onQueued,
  onClose,
}: {
  prefill?: ComposePrefill;
  accounts: MailAccountView[];
  accountId: string;
  onQueued: (id: string) => void;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    bodyRef.current?.focus();
    bodyRef.current?.setSelectionRange(0, 0);
  }, []);
  const usable = accounts.filter(sendingAccountAvailable);
  const [from, setFrom] = useState(
    usable.find((account) => account.id === accountId)?.id ??
      usable[0]?.id ??
      "",
  );
  const [to, setTo] = useState(prefill?.to ?? "");
  const [cc, setCc] = useState(prefill?.cc ?? "");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [plainText, setPlainText] = useState(prefill?.plainText ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<
    (AttachmentView & { kind: "incoming" | "staged" })[]
  >(() =>
    (prefill?.attachments ?? []).map((a) => ({ ...a, kind: "incoming" })),
  );
  const attachmentsBlocked = attachments.some((a) => a.status !== "ready");
  useEffect(() => {
    const pending = attachments.filter(
      (a) =>
        a.kind === "incoming" && ["pending", "fetching"].includes(a.status),
    );
    if (!pending.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all(
        pending.map(async (a) => {
          try {
            const response = await fetch(`/api/attachments/${a.id}`);
            if (!response.ok) throw Error();
            const result = (await response.json()) as Partial<AttachmentView>;
            if (!cancelled)
              setAttachments((current) =>
                current.map((item) =>
                  item.id === a.id
                    ? {
                        ...item,
                        status: result.status ?? "failed",
                        size: result.size ?? item.size,
                        error: result.error ?? null,
                      }
                    : item,
                ),
              );
          } catch {
            if (!cancelled)
              setAttachments((current) =>
                current.map((item) =>
                  item.id === a.id
                    ? {
                        ...item,
                        status: "failed",
                        error:
                          "Attachment status could not be loaded. Retry preparation.",
                      }
                    : item,
                ),
              );
          }
        }),
      );
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attachments]);
  async function upload(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const temporaryId = crypto.randomUUID();
      setAttachments((current) => [
        ...current,
        {
          id: temporaryId,
          kind: "staged",
          filename: file.name,
          type: file.type,
          size: null,
          status: "uploading",
          error: null,
          visible: true,
          inline: false,
        },
      ]);
      try {
        const response = await fetch("/api/attachments/staged", {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Attachment-Filename": encodeURIComponent(file.name),
          },
          body: file,
        });
        const result = (await response.json()) as AttachmentView & {
          error: string | null;
        };
        if (!response.ok)
          throw Error(result.error ?? "Attachment upload failed.");
        setAttachments((current) =>
          current.map((a) =>
            a.id === temporaryId
              ? {
                  ...a,
                  ...result,
                  kind: "staged",
                  visible: true,
                  inline: false,
                }
              : a,
          ),
        );
      } catch (failure) {
        setAttachments((current) =>
          current.map((a) =>
            a.id === temporaryId
              ? {
                  ...a,
                  status: "failed",
                  error:
                    failure instanceof Error
                      ? failure.message
                      : "Attachment upload failed.",
                }
              : a,
          ),
        );
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }
  async function retryAttachment(a: AttachmentView) {
    setAttachments((current) =>
      current.map((item) =>
        item.id === a.id ? { ...item, status: "pending", error: null } : item,
      ),
    );
    try {
      const response = await fetch(`/api/attachments/${a.id}`, {
        method: "POST",
      });
      if (!response.ok) throw Error();
    } catch {
      setAttachments((current) =>
        current.map((item) =>
          item.id === a.id
            ? {
                ...item,
                status: "failed",
                error: "Attachment could not be prepared.",
              }
            : item,
        ),
      );
    }
  }
  function removeAttachment(id: string) {
    const item = attachments.find((a) => a.id === id);
    setAttachments((current) => current.filter((a) => a.id !== id));
    if (item?.kind === "staged" && item.status === "ready")
      void fetch(`/api/attachments/staged/${id}`, { method: "DELETE" }).catch(
        () => undefined,
      );
  }
  async function send(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || attachmentsBlocked) return;
    if (
      !from ||
      ![to, cc, bcc].some((value) => value.trim()) ||
      [to, cc, bcc, subject].some((value) => /[\r\n\x00]/.test(value))
    ) {
      setError(
        "Select a sending account and enter at least one recipient. Headers must not contain line breaks.",
      );
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/outgoing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: from,
          ...(prefill ? { source: prefill.source } : {}),
          to,
          cc,
          bcc,
          subject,
          plainText,
          ...(attachments.length
            ? { attachments: attachments.map(({ kind, id }) => ({ kind, id })) }
            : {}),
        }),
      });
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id)
        throw Error(result.error ?? "Message could not be queued.");
      onQueued(result.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Message could not be queued.",
      );
      setSubmitting(false);
    }
  }
  return (
    <form className="mail-composer" onSubmit={(event) => void send(event)}>
      <div className="mail-detail-header composer-heading">
        <h2>
          {prefill
            ? { reply: "Reply", reply_all: "Reply all", forward: "Forward" }[
                prefill.source.mode
              ]
            : "New message"}
        </h2>
        <button
          className="icon-button"
          type="button"
          aria-label="Close composer"
          disabled={submitting}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <fieldset disabled={submitting} className="composer-fields">
        <label>
          From
          <select
            aria-label="From"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          >
            {usable.length ? (
              usable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} &lt;{account.email}&gt;
                </option>
              ))
            ) : (
              <option value="">No sending account available</option>
            )}
          </select>
        </label>
        <label>
          To
          <input
            aria-label="To"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            maxLength={8000}
            placeholder="Name <email@example.com>"
          />
        </label>
        <label>
          Cc
          <input
            aria-label="Cc"
            value={cc}
            onChange={(event) => setCc(event.target.value)}
            maxLength={8000}
          />
        </label>
        <label>
          Bcc
          <input
            aria-label="Bcc"
            value={bcc}
            onChange={(event) => setBcc(event.target.value)}
            maxLength={8000}
          />
        </label>
        <label>
          Subject
          <input
            aria-label="Subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={998}
          />
        </label>
        <textarea
          ref={bodyRef}
          aria-label="Message body"
          value={plainText}
          onChange={(event) => setPlainText(event.target.value)}
          maxLength={500000}
          placeholder="Write your message…"
        />
      </fieldset>
      <div className="composer-attachments">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          aria-label="Select attachments"
          disabled={submitting}
          onChange={(event) => void upload(event.target.files)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={submitting}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={15} /> Attach files
        </button>
        {attachments.map((a) => (
          <div key={a.id} className="mail-attachment">
            <Paperclip size={13} />
            <span>
              {a.filename || "Attachment"} · {attachmentSize(a.size)}{" "}
              {a.status === "uploading"
                ? "Uploading…"
                : ["pending", "fetching"].includes(a.status)
                  ? "Preparing attachment…"
                  : ""}
            </span>
            {a.error ? (
              <span role="alert" className="error">
                {a.error}
              </span>
            ) : null}
            {a.kind === "incoming" &&
            ["failed", "not_fetched"].includes(a.status) ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void retryAttachment(a)}
              >
                Retry preparation
              </button>
            ) : null}
            <button
              type="button"
              disabled={submitting || a.status === "uploading"}
              aria-label={`Remove ${a.filename || "attachment"}`}
              onClick={() => removeAttachment(a.id)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="composer-footer">
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <button
          className="button"
          type="submit"
          disabled={submitting || !from || attachmentsBlocked}
        >
          <Send size={15} />
          {submitting ? "Queueing…" : "Send"}
        </button>
      </div>
    </form>
  );
}
