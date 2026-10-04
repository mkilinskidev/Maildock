"use client";

import Link from "next/link";
import { AccountConnectionFields } from "./account-connection-fields";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { ConnectionReport } from "@/modules/accounts/domain/mail-provider";
import type { SentCopyPolicy } from "@/modules/accounts/domain/account";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";
import { SentCopyPolicyFields } from "@/components/sent-copy-settings";

export function AccountForm({
  id,
  account,
  sentRole,
}: {
  id: string;
  account?: MailAccountView;
  sentRole?: MailboxRoleView;
}) {
  const router = useRouter();
  const [sentCopyPolicy, setSentCopyPolicy] = useState<SentCopyPolicy>(
    account?.sentCopyPolicy ?? "server",
  );
  const [useImapCredentials, setUseImapCredentials] = useState(
    account?.smtp.useImapCredentials ?? true,
  );
  const [pending, setPending] = useState<"save" | "test">();
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<ConnectionReport>();

  function payload(form: HTMLFormElement) {
    const data = new FormData(form);
    const optional = (name: string) => {
      const value = String(data.get(name) ?? "");
      return value.length > 0 ? value : undefined;
    };
    return {
      ...(account ? {} : { id }),
      displayName: data.get("displayName"),
      senderDisplayName: data.get("senderDisplayName"),
      email: data.get("email"),
      enabled: data.get("enabled") === "on",
      sentCopyPolicy,
      providerType: "imap_smtp",
      imap: {
        host: data.get("imapHost"),
        port: data.get("imapPort"),
        security: data.get("imapSecurity"),
        username: data.get("imapUsername"),
        password: account ? optional("imapPassword") : data.get("imapPassword"),
      },
      smtp: {
        host: data.get("smtpHost"),
        port: data.get("smtpPort"),
        security: data.get("smtpSecurity"),
        useImapCredentials,
        username: useImapCredentials ? undefined : data.get("smtpUsername"),
        password: useImapCredentials
          ? undefined
          : account
            ? optional("smtpPassword")
            : data.get("smtpPassword"),
      },
    };
  }

  async function request(form: HTMLFormElement, action: "save" | "test") {
    setPending(action);
    setError(undefined);
    setReport(undefined);
    const response = await fetch(
      action === "save"
        ? account
          ? `/api/accounts/${id}`
          : "/api/accounts"
        : account
          ? `/api/accounts/${id}/test`
          : "/api/accounts/test",
      {
        method: action === "save" ? (account ? "PUT" : "POST") : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(form)),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
      result?: ConnectionReport;
    };
    if (!response.ok) setError(result.error ?? "The request failed.");
    else if (action === "test") setReport(result.result);
    else {
      router.push("/");
      router.refresh();
      return;
    }
    setPending(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void request(event.currentTarget, "save");
  }

  return (
    <form className="account-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Account name
          <input
            name="displayName"
            required
            maxLength={100}
            defaultValue={account?.displayName}
          />
        </label>
        <label>
          Your name
          <input
            name="senderDisplayName"
            maxLength={200}
            defaultValue={account?.senderDisplayName}
          />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            required
            defaultValue={account?.email}
          />
        </label>
      </div>
      <label className="checkbox">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={account?.enabled ?? true}
        />{" "}
        Enabled
      </label>

      <AccountConnectionFields
        account={account}
        useImapCredentials={useImapCredentials}
        onUseImapCredentialsChange={setUseImapCredentials}
      />

      <SentCopyPolicyFields
        policy={sentCopyPolicy}
        onChange={setSentCopyPolicy}
        sentRole={sentRole}
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
          {pending === "save" ? "Saving…" : "Save"}
        </button>
        <Link className="button-link secondary" href="/">
          Cancel
        </Link>
      </div>
    </form>
  );
}
