"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { ConnectionReport } from "@/modules/accounts/domain/mail-provider";

export function AccountForm({
  id,
  account,
}: {
  id: string;
  account?: MailAccountView;
}) {
  const router = useRouter();
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
      email: data.get("email"),
      enabled: data.get("enabled") === "on",
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
          Display name
          <input
            name="displayName"
            required
            maxLength={100}
            defaultValue={account?.displayName}
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

      <fieldset>
        <legend>IMAP</legend>
        <div className="form-grid">
          <label>
            Host
            <input name="imapHost" required defaultValue={account?.imap.host} />
          </label>
          <label>
            Port
            <input
              name="imapPort"
              type="number"
              min="1"
              max="65535"
              required
              defaultValue={account?.imap.port ?? 993}
            />
          </label>
          <label>
            Security
            <select
              name="imapSecurity"
              defaultValue={account?.imap.security ?? "tls"}
            >
              <option value="tls">TLS from connection start</option>
              <option value="starttls">Required STARTTLS</option>
            </select>
          </label>
          <label>
            Username
            <input
              name="imapUsername"
              required
              defaultValue={account?.imap.username}
              autoComplete="off"
            />
          </label>
          <label>
            Password
            <input
              name="imapPassword"
              type="password"
              required={!account}
              placeholder={
                account ? "Stored credential — leave blank to keep" : undefined
              }
              autoComplete="new-password"
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>SMTP</legend>
        <div className="form-grid">
          <label>
            Host
            <input name="smtpHost" required defaultValue={account?.smtp.host} />
          </label>
          <label>
            Port
            <input
              name="smtpPort"
              type="number"
              min="1"
              max="65535"
              required
              defaultValue={account?.smtp.port ?? 465}
            />
          </label>
          <label>
            Security
            <select
              name="smtpSecurity"
              defaultValue={account?.smtp.security ?? "tls"}
            >
              <option value="tls">TLS from connection start</option>
              <option value="starttls">Required STARTTLS</option>
            </select>
          </label>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={useImapCredentials}
            onChange={(event) => setUseImapCredentials(event.target.checked)}
          />{" "}
          Use IMAP credentials for SMTP
        </label>
        {!useImapCredentials ? (
          <div className="form-grid">
            <label>
              SMTP username
              <input
                name="smtpUsername"
                required
                defaultValue={account?.smtp.username}
                autoComplete="off"
              />
            </label>
            <label>
              SMTP password
              <input
                name="smtpPassword"
                type="password"
                required={!account || account.smtp.useImapCredentials}
                placeholder={
                  account && !account.smtp.useImapCredentials
                    ? "Stored credential — leave blank to keep"
                    : undefined
                }
                autoComplete="new-password"
              />
            </label>
          </div>
        ) : null}
      </fieldset>

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
          className="secondary"
          disabled={!!pending}
          onClick={(event) => void request(event.currentTarget.form!, "test")}
        >
          {pending === "test" ? "Testing…" : "Test connection"}
        </button>
        <button type="submit" disabled={!!pending}>
          {pending === "save" ? "Saving…" : "Save"}
        </button>
        <Link className="button-link secondary" href="/">
          Cancel
        </Link>
      </div>
    </form>
  );
}
