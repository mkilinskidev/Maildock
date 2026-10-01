"use client";

import Link from "next/link";
import { Mail, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";
import { MessageList } from "@/components/message-list";
import { SystemFolders } from "@/components/system-folders";

function count(value: string | null): string {
  return value === null ? "" : new Intl.NumberFormat().format(BigInt(value));
}

function MailboxHierarchy({ mailboxes }: { mailboxes: MailboxView[] }) {
  if (mailboxes.length === 0) return null;
  return (
    <div className="mailbox-tree" aria-label="Discovered mailboxes">
      {mailboxes.map((mailbox) => {
        const depth = mailbox.delimiter
          ? Math.max(0, mailbox.remotePath.split(mailbox.delimiter).length - 1)
          : 0;
        return (
          <div
            className={`mailbox-row${mailbox.selectable ? "" : " mailbox-container"}`}
            key={mailbox.id}
            style={{ paddingInlineStart: `${depth * 1.25}rem` }}
          >
            <span>
              {mailbox.name}
              {!mailbox.selectable ? " (container)" : ""}
            </span>
            <span>{count(mailbox.messageCount)}</span>
            <span>
              {mailbox.unseenCount === null
                ? ""
                : `${count(mailbox.unseenCount)} unread`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AccountList({
  accounts,
  mailboxesByAccount,
  rolesByAccount,
  oauthConfigured,
  oauthResult,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
  rolesByAccount: Record<string, MailboxRoleView[]>;
  oauthConfigured: boolean;
  oauthResult: { oauth?: string; oauth_error?: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const oauthErrorMessage = oauthResult.oauth_error
    ? ({
        configuration:
          "Microsoft connection is not configured. Set the Microsoft app registration values.",
        start: "Microsoft connection could not start. Try again.",
        state:
          "Microsoft sign-in expired or was invalid. Try connecting again.",
        denied:
          "Microsoft consent was denied. Grant the requested mail permissions to connect.",
        identity: "Reconnect using the same Microsoft account as before.",
        authorization:
          "Microsoft sign-in failed. Check consent, account access, and tenant policy, then try again.",
      }[oauthResult.oauth_error] ?? "Microsoft connection failed. Try again.")
    : null;

  const discoveryInProgress = accounts.some((account) =>
    ["pending", "running"].includes(account.mailboxDiscovery.status),
  );
  useEffect(() => {
    if (!discoveryInProgress) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [discoveryInProgress, router]);

  async function mutate(
    id: string,
    action: "test" | "toggle" | "delete" | "discover",
    enabled?: boolean,
  ) {
    if (
      action === "delete" &&
      !window.confirm("Delete this mail account? This action cannot be undone.")
    )
      return;
    setPending(id);
    setError(undefined);
    const response = await fetch(
      action === "toggle"
        ? `/api/accounts/${id}/enabled`
        : action === "discover"
          ? `/api/accounts/${id}/mailboxes/discover`
          : `/api/accounts/${id}${action === "test" ? "/test" : ""}`,
      {
        method:
          action === "toggle"
            ? "PATCH"
            : action === "delete"
              ? "DELETE"
              : "POST",
        headers:
          action === "delete"
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          action === "toggle"
            ? JSON.stringify({ enabled })
            : action === "test"
              ? ""
              : undefined,
      },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(result.error ?? "The account action failed.");
    } else {
      router.refresh();
    }
    setPending(undefined);
  }

  if (accounts.length === 0) {
    return (
      <div className="empty-state">
        <Mail size={28} className="mx-auto mb-3 text-muted" />
        <h2>No mail accounts</h2>
        {oauthErrorMessage ? (
          <p className="error">{oauthErrorMessage}</p>
        ) : null}
        <p>Add an email account to get started.</p>
        <div className="actions justify-center">
          {oauthConfigured ? (
            <Link className="button-link" href="/api/oauth/microsoft/start">
              Connect Microsoft account
            </Link>
          ) : null}
          <Link className="button-link secondary" href="/accounts/new">
            <Plus size={15} />
            Configure IMAP/SMTP
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="actions page-toolbar">
        {oauthConfigured ? (
          <Link className="button-link" href="/api/oauth/microsoft/start">
            Connect Microsoft account
          </Link>
        ) : null}
        <Link className="button-link secondary" href="/accounts/new">
          <Plus size={15} />
          Configure IMAP/SMTP
        </Link>
      </div>
      {oauthResult.oauth === "connected" ? (
        <p className="success">Microsoft account connected.</p>
      ) : null}
      {oauthErrorMessage ? <p className="error">{oauthErrorMessage}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="account-list">
        {accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <div className="account-card-head">
              <span className="account-avatar">
                {account.displayName.charAt(0)}
              </span>
              <div>
                <h2>{account.displayName}</h2>
                <p className="muted">{account.email}</p>
              </div>
              <span className={"status-pill" + (account.enabled ? "" : " off")}>
                {account.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="account-summary">
              {account.authMethod === "oauth2"
                ? "Microsoft OAuth · " +
                  (account.oauthStatus === "reconnect_required"
                    ? "Reconnect required"
                    : "Connected") +
                  " · "
                : ""}
              {account.connectionStatus === "verified"
                ? "Connection verified"
                : account.connectionStatus === "error"
                  ? "Connection error"
                  : "Connection not tested"}
              {" · "}
              {mailboxesByAccount[account.id]?.length ?? 0} mailboxes
            </div>
            {account.imapResult.error ? (
              <p className="error">IMAP: {account.imapResult.error}</p>
            ) : null}
            {account.smtpResult.error ? (
              <p className="error">SMTP: {account.smtpResult.error}</p>
            ) : null}
            {account.mailboxDiscovery.error ? (
              <p className="error">{account.mailboxDiscovery.error}</p>
            ) : null}
            <div className="actions">
              {account.authMethod === "oauth2" ? (
                <Link
                  className="button-link secondary"
                  href={"/api/oauth/microsoft/start?accountId=" + account.id}
                >
                  Reconnect Microsoft account
                </Link>
              ) : (
                <Link
                  className="button-link secondary"
                  href={"/accounts/" + account.id + "/edit"}
                >
                  Edit
                </Link>
              )}
              <button
                className="button secondary"
                disabled={pending === account.id}
                onClick={() => mutate(account.id, "test")}
              >
                Test connection
              </button>
              <button
                className="button secondary"
                disabled={pending === account.id || !account.enabled}
                onClick={() => mutate(account.id, "discover")}
              >
                Refresh mailboxes
              </button>
              <button
                className="button secondary"
                disabled={pending === account.id}
                onClick={() => mutate(account.id, "toggle", !account.enabled)}
              >
                {account.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="button danger"
                disabled={pending === account.id}
                onClick={() => mutate(account.id, "delete")}
              >
                Delete
              </button>
            </div>
            <details className="details-panel">
              <summary>Connection and discovery details</summary>
              <p>
                Last successful test:{" "}
                {account.lastSuccessfulConnectionTestAt
                  ? new Date(
                      account.lastSuccessfulConnectionTestAt,
                    ).toLocaleString()
                  : "Never"}
              </p>
              <p>
                Discovery: {account.mailboxDiscovery.status}
                {account.mailboxDiscovery.lastSuccessfulAt
                  ? " · Last successful " +
                    new Date(
                      account.mailboxDiscovery.lastSuccessfulAt,
                    ).toLocaleString()
                  : ""}
              </p>
              <SystemFolders
                key={JSON.stringify(rolesByAccount[account.id] ?? [])}
                accountId={account.id}
                initialRoles={rolesByAccount[account.id] ?? []}
                mailboxes={mailboxesByAccount[account.id] ?? []}
              />
              <MailboxHierarchy
                mailboxes={mailboxesByAccount[account.id] ?? []}
              />
              {(mailboxesByAccount[account.id] ?? [])
                .filter((mailbox) => mailbox.selectable)
                .map((mailbox) => (
                  <details className="mailbox-messages" key={mailbox.id}>
                    <summary>Inspect {mailbox.name} messages</summary>
                    <MessageList accountId={account.id} mailbox={mailbox} />
                  </details>
                ))}
              {account.mailboxDiscovery.status === "success" ? (
                <details className="details-panel">
                  <summary>Advanced discovery diagnostics</summary>
                  <p>
                    Capabilities:{" "}
                    {account.mailboxDiscovery.capabilities.join(", ") ||
                      "None reported"}
                  </p>
                  {(mailboxesByAccount[account.id] ?? []).map((mailbox) => (
                    <p key={mailbox.id}>
                      <code>{mailbox.remotePath}</code> · delimiter{" "}
                      <code>{mailbox.delimiter ?? "none"}</code> · attributes{" "}
                      {mailbox.attributes.join(", ") || "none"} · special-use{" "}
                      {mailbox.specialUse.join(", ") || "none"} · selectable{" "}
                      {String(mailbox.selectable)} · UIDVALIDITY{" "}
                      {mailbox.uidValidity ?? "n/a"} · UIDNEXT{" "}
                      {mailbox.uidNext ?? "n/a"} · HIGHESTMODSEQ{" "}
                      {mailbox.highestModseq ?? "n/a"} · history{" "}
                      {mailbox.backfill.status} · next historical UID ≤{" "}
                      {mailbox.backfill.frontierUid ?? "n/a"}
                    </p>
                  ))}
                </details>
              ) : null}
            </details>
          </article>
        ))}
      </div>
    </>
  );
}
