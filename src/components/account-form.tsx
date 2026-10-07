"use client";

import { AccountIdentityFields } from "./account-identity-fields";
import { accountConnectionPayload } from "./account-connection-payload";
import { AccountConnectionFields } from "./account-connection-fields";
import { FormEvent, useEffect, useState } from "react";

import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { ConnectionReport } from "@/modules/accounts/domain/mail-provider";
import type { SentCopyPolicy } from "@/modules/accounts/domain/account";
import { SentCopyPolicyFields } from "@/components/sent-copy-settings";

export function AccountForm({
  onCreated,
  onDirtyChange,
  onBusyChange,
}: {
  onCreated: (account: MailAccountView) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [identity, setIdentity] = useState({
    displayName: "",
    senderDisplayName: "",
    email: "",
  });
  const [sentCopyPolicy, setSentCopyPolicy] =
    useState<SentCopyPolicy>("server");
  const [useImapCredentials, setUseImapCredentials] = useState(true);
  const [pending, setPending] = useState<"save" | "test">();
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<ConnectionReport>();

  useEffect(() => {
    onBusyChange(!!pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);

  async function request(form: HTMLFormElement, action: "save" | "test") {
    if (pending || !form.reportValidity()) return;
    setPending(action);
    setError(undefined);
    setReport(undefined);
    try {
      const response = await fetch(
        action === "save" ? "/api/accounts" : "/api/accounts/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            ...identity,
            enabled: true,
            sentCopyPolicy,
            providerType: "imap_smtp",
            ...accountConnectionPayload(form, useImapCredentials),
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        result?: ConnectionReport;
        account?: MailAccountView;
      };
      if (!response.ok) setError(result.error ?? "The request failed.");
      else if (action === "test") setReport(result.result);
      else if (result.account) {
        onDirtyChange(false);
        onCreated(result.account);
      } else
        setError(
          "The account could not be opened. Reload Settings to check your accounts.",
        );
    } catch {
      setError("The request failed. Check your connection and try again.");
    } finally {
      setPending(undefined);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void request(event.currentTarget, "save");
  }

  return (
    <form
      className="settings-create-form"
      onSubmit={submit}
      onChange={() => onDirtyChange(true)}
    >
      <fieldset disabled={!!pending} className="settings-section">
        <legend>Identity</legend>
        <p className="muted">
          Account name is your local label. Your name appears in outgoing From
          headers.
        </p>
        <AccountIdentityFields value={identity} onChange={setIdentity} />
      </fieldset>
      <fieldset disabled={!!pending} className="settings-connection-fields">
        <AccountConnectionFields
          useImapCredentials={useImapCredentials}
          onUseImapCredentialsChange={setUseImapCredentials}
        />
      </fieldset>
      <SentCopyPolicyFields
        policy={sentCopyPolicy}
        onChange={setSentCopyPolicy}
        disabled={!!pending}
      />
      {report ? (
        <div className="test-results" aria-live="polite">
          <p className={report.imap.success ? "success" : "error"}>
            {report.imap.success
              ? "✓ IMAP connection successful"
              : `✗ ${report.imap.message}`}
          </p>
          <p className={report.smtp.success ? "success" : "error"}>
            {report.smtp.success
              ? "✓ SMTP connection successful"
              : `✗ ${report.smtp.message}`}
          </p>
        </div>
      ) : null}
      {error ? (
        <p className="error" aria-live="polite">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="button secondary"
          disabled={!!pending}
          onClick={(event) => void request(event.currentTarget.form!, "test")}
        >
          {pending === "test" ? "Testing…" : "Test connection"}
        </button>
        <button type="submit" className="button" disabled={!!pending}>
          {pending === "save" ? "Saving…" : "Create account"}
        </button>
      </div>
    </form>
  );
}
