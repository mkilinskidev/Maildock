"use client";

import type { ComposePrefill } from "@/modules/mail/domain/compose-source";
import { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
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
  async function send(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
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
      {prefill?.attachmentsOmitted ? (
        <p role="note">Original attachments are not included.</p>
      ) : null}
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
      <div className="composer-footer">
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <button className="button" type="submit" disabled={submitting || !from}>
          <Send size={15} />
          {submitting ? "Queueing…" : "Send"}
        </button>
      </div>
    </form>
  );
}
