"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type {
  MailboxRoleView,
  SystemMailboxRole,
} from "@/modules/mail/application/mailbox-role-service";
import type { SignatureCatalog } from "@/modules/mail/domain/signature";
import { AccountIdentityFields } from "./account-identity-fields";
import { accountConnectionPayload } from "./account-connection-payload";
import { AccountConnectionFields } from "./account-connection-fields";
import { SentCopyPolicyFields } from "./sent-copy-settings";

const folderLabels = {
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash",
} as const;
type Tab = "General" | "IMAP" | "Diagnostics";
async function request(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error ?? "The account action failed.");
  return result;
}
function friendlyStatus(value: string) {
  const labels: Record<string, string> = {
    unverified: "Not run",
    verified: "Passed",
    error: "Failed",
    untested: "Not run",
    success: "Succeeded",
    active: "Available",
    unavailable: "Unavailable",
    removed: "Removed",
    missing: "Unavailable",
    pending: "Waiting",
    queued: "Waiting",
    running: "In progress",
    syncing: "Synchronizing",
    complete: "Up to date",
    completed: "Up to date",
    ready: "Up to date",
    succeeded: "Up to date",
    failed: "Needs attention",
    idle: "Idle",
    not_started: "Not started",
    paused: "Paused",
    fetching: "In progress",
  };
  return (
    labels[value] ??
    value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}
function latestSync(mailboxes: MailboxView[]) {
  return (
    mailboxes
      .flatMap((m) => [
        m.deltaSync.lastSuccessfulAt,
        m.recentSync.lastSuccessfulAt,
      ])
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? null
  );
}
function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function AccountSettings({
  account,
  mailboxes,
  roles,
  catalog,
  onDirtyChange,
  onBusyChange,
}: {
  account: MailAccountView;
  mailboxes: MailboxView[];
  roles: MailboxRoleView[];
  catalog: SignatureCatalog;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("General");
  const initialIdentity = {
    displayName: account.displayName,
    senderDisplayName: account.senderDisplayName,
    email: account.email,
  };
  const [identity, setIdentity] = useState(initialIdentity);
  const [savedIdentity, setSavedIdentity] = useState(initialIdentity);
  const [folders, setFolders] = useState<
    Partial<Record<SystemMailboxRole, string | null>>
  >({});
  const initialSignatures = catalog.defaults[account.id] ?? {
    new: null,
    reply: null,
    forward: null,
  };
  const [signatures, setSignatures] = useState(initialSignatures);
  const [savedSignatures, setSavedSignatures] = useState(initialSignatures);
  const [connectionAccount, setConnectionAccount] = useState(account);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [useImapCredentials, setUseImapCredentials] = useState(
    account.smtp.useImapCredentials,
  );
  const [policy, setPolicy] = useState(account.sentCopyPolicy);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const generalDirty =
    JSON.stringify(identity) !== JSON.stringify(savedIdentity) ||
    Object.keys(folders).length > 0 ||
    JSON.stringify(signatures) !== JSON.stringify(savedSignatures);
  useEffect(() => {
    onDirtyChange(generalDirty || connectionDirty);
  }, [generalDirty, connectionDirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);
  const working =
    account.mailboxDiscovery.status === "pending" ||
    account.mailboxDiscovery.status === "running" ||
    mailboxes.some((m) =>
      [m.recentSync.status, m.deltaSync.status, m.backfill.status].some(
        (s) => s === "pending" || s === "running",
      ),
    );
  useEffect(() => {
    if (!working || generalDirty || connectionDirty || pending) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [working, generalDirty, connectionDirty, pending, router]);
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setStatus("");
    try {
      await action();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The account action failed.");
    } finally {
      setPending(false);
    }
  }
  function connectionPayload(form: HTMLFormElement) {
    return {
      ...savedIdentity,
      enabled: account.enabled,
      providerType: account.providerType,
      sentCopyPolicy: policy,
      ...accountConnectionPayload(form, useImapCredentials),
    };
  }

  return (
    <>
      <header className="settings-pane-header">
        <h2>{account.displayName}</h2>
        <p>
          {account.email} ·{" "}
          {account.authMethod === "oauth2"
            ? `${account.oauthProviderName ?? "OAuth"} OAuth`
            : "IMAP / SMTP"}
        </p>
      </header>
      <div
        role="tablist"
        aria-label="Account settings"
        className="settings-tabs"
      >
        {(["General", "IMAP", "Diagnostics"] as const).map((item) => (
          <button
            key={item}
            id={`tab-${item}`}
            role="tab"
            aria-selected={tab === item}
            aria-controls={`panel-${item}`}
            className={tab === item ? "active" : ""}
            onClick={() => {
              setTab(item);
              setError("");
              setStatus("");
            }}
          >
            {item}
          </button>
        ))}
      </div>
      <div
        hidden={tab !== "General"}
        id="panel-General"
        role="tabpanel"
        aria-labelledby="tab-General"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await request(`/api/accounts/${account.id}/settings`, "PUT", {
                identity,
                folders,
                signatures,
              });
              setSavedIdentity({ ...identity });
              setSavedSignatures({ ...signatures });
              setFolders({});
              setStatus("Saved");
            });
          }}
        >
          <fieldset disabled={pending} className="settings-section">
            <legend>Identity</legend>
            <p className="muted">
              Account name is your local label. Your name appears in outgoing
              From headers.
            </p>
            <AccountIdentityFields
              value={identity}
              onChange={setIdentity}
              emailReadOnly={account.authMethod === "oauth2"}
            />
            {account.authMethod === "oauth2" ? (
              <p className="muted">
                Email identity is managed by the OAuth provider. Reconnect to
                refresh authentication.
              </p>
            ) : null}
          </fieldset>
          <fieldset disabled={pending} className="settings-section">
            <legend>System folders</legend>
            <p className="muted">
              Use server mappings or choose a folder from this account.
            </p>
            <div className="settings-fields">
              {(Object.keys(folderLabels) as SystemMailboxRole[]).map(
                (role) => {
                  const mapped = roles.find((r) => r.role === role);
                  const value =
                    role in folders
                      ? (folders[role] ?? "")
                      : mapped?.source === "manual"
                        ? (mapped.mailboxId ?? "")
                        : "";
                  return (
                    <label key={role}>
                      {folderLabels[role]}
                      <select
                        aria-label={`${folderLabels[role]} mailbox`}
                        value={value}
                        onChange={(e) =>
                          setFolders({
                            ...folders,
                            [role]: e.target.value || null,
                          })
                        }
                      >
                        <option value="">
                          Automatic —{" "}
                          {mapped?.source === "special_use" && mapped.available
                            ? mapped.mailboxName
                            : "server mapping"}
                        </option>
                        {mapped?.source === "manual" &&
                        !mapped.available &&
                        mapped.mailboxId ? (
                          <option value={mapped.mailboxId} disabled>
                            {mapped.mailboxName ?? "Folder"} (unavailable)
                          </option>
                        ) : null}
                        {mailboxes
                          .filter(
                            (m) =>
                              m.selectable && m.lifecycleStatus === "active",
                          )
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  );
                },
              )}
            </div>
          </fieldset>
          <fieldset disabled={pending} className="settings-section">
            <legend>Signature defaults</legend>
            <div className="settings-fields">
              {(
                [
                  ["new", "New messages"],
                  ["reply", "Replies"],
                  ["forward", "Forwards"],
                ] as const
              ).map(([mode, label]) => (
                <label key={mode}>
                  {label}
                  <select
                    aria-label={`${label} signature`}
                    value={signatures[mode] ?? ""}
                    onChange={(e) =>
                      setSignatures({
                        ...signatures,
                        [mode]: e.target.value || null,
                      })
                    }
                  >
                    <option value="">None</option>
                    {catalog.signatures.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="settings-save-bar">
            <span>{generalDirty ? "Unsaved changes" : "Changes saved"}</span>
            <button className="button" disabled={pending || !generalDirty}>
              Save
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending || !generalDirty}
              onClick={() => {
                setIdentity(savedIdentity);
                setSignatures(savedSignatures);
                setFolders({});
              }}
            >
              Discard changes
            </button>
          </div>
        </form>
        <section className="settings-section settings-danger">
          <h3>Account availability</h3>
          <p className="muted">
            Disabling pauses provider work. Deleting removes the account and its
            local mail data.
          </p>
          <div className="actions">
            <button
              className="button secondary"
              disabled={pending || generalDirty || connectionDirty}
              onClick={() =>
                void run(async () => {
                  await request(
                    `/api/accounts/${account.id}/enabled`,
                    "PATCH",
                    { enabled: !account.enabled },
                  );
                })
              }
            >
              {account.enabled ? "Disable account" : "Enable account"}
            </button>
            <button
              className="button danger"
              disabled={pending || generalDirty || connectionDirty}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete this mail account and its local data? This cannot be undone.",
                  )
                )
                  void run(async () => {
                    await request(`/api/accounts/${account.id}`, "DELETE");
                  });
              }}
            >
              Delete account
            </button>
          </div>
        </section>
      </div>
      <div
        hidden={tab !== "IMAP"}
        id="panel-IMAP"
        role="tabpanel"
        aria-labelledby="tab-IMAP"
      >
        {account.authMethod === "oauth2" ? (
          <section className="settings-section">
            <h3>OAuth authentication</h3>
            <dl className="settings-facts">
              <dt>Provider</dt>
              <dd>{account.oauthProviderName ?? account.oauthProviderId}</dd>
              <dt>Authentication</dt>
              <dd>OAuth 2.0</dd>
              <dt>Status</dt>
              <dd>
                {account.oauthStatus === "reconnect_required"
                  ? "Reconnect required"
                  : "Connected"}
              </dd>
              <dt>Identity</dt>
              <dd>{account.email}</dd>
            </dl>
            <div className="actions">
              <a
                className="button-link secondary"
                href={`${account.oauthAuthorizationPath ?? `/api/oauth/${encodeURIComponent(account.oauthProviderId ?? "")}/start`}?accountId=${account.id}`}
              >
                Reconnect account
              </a>
              <button
                className="button secondary"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await request(`/api/accounts/${account.id}/test`, "POST");
                    setStatus(
                      "Connection test completed. See Diagnostics for results.",
                    );
                  })
                }
              >
                Test connection
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await request(
                    `/api/accounts/${account.id}`,
                    "PUT",
                    { sentCopyPolicy: policy },
                  );
                  setConnectionAccount(result.account);
                  setConnectionDirty(false);
                  setStatus("Saved");
                });
              }}
            >
              <SentCopyPolicyFields
                policy={policy}
                onChange={(value) => {
                  setPolicy(value);
                  setConnectionDirty(true);
                }}
                sentRole={roles.find((r) => r.role === "sent")}
                disabled={pending}
              />
              <div className="settings-save-bar">
                <span>
                  {connectionDirty ? "Unsaved changes" : "Changes saved"}
                </span>
                <button
                  className="button"
                  disabled={pending || !connectionDirty}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending || !connectionDirty}
                  onClick={() => {
                    setPolicy(connectionAccount.sentCopyPolicy);
                    setConnectionDirty(false);
                  }}
                >
                  Discard changes
                </button>
              </div>
            </form>
          </section>
        ) : (
          <form
            key={connectionRevision}
            onChange={() => setConnectionDirty(true)}
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const body = connectionPayload(form);
              void run(async () => {
                const result = await request(
                  `/api/accounts/${account.id}`,
                  "PUT",
                  body,
                );
                setConnectionAccount(result.account);
                setPolicy(result.account.sentCopyPolicy);
                setUseImapCredentials(result.account.smtp.useImapCredentials);
                setConnectionDirty(false);
                setConnectionRevision((n) => n + 1);
                setStatus("Saved");
              });
            }}
          >
            <p className="muted">
              Leave password fields blank to keep encrypted credentials.
            </p>
            <fieldset disabled={pending} className="settings-connection-fields">
              <AccountConnectionFields
                account={connectionAccount}
                useImapCredentials={useImapCredentials}
                onUseImapCredentialsChange={setUseImapCredentials}
              />
              <SentCopyPolicyFields
                policy={policy}
                onChange={(value) => {
                  setPolicy(value);
                  setConnectionDirty(true);
                }}
                sentRole={roles.find((r) => r.role === "sent")}
                disabled={pending}
              />
            </fieldset>
            <div className="settings-save-bar">
              <span>
                {connectionDirty ? "Unsaved changes" : "Changes saved"}
              </span>
              <button className="button" disabled={pending || !connectionDirty}>
                Save
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={pending || !connectionDirty}
                onClick={() => {
                  setUseImapCredentials(
                    connectionAccount.smtp.useImapCredentials,
                  );
                  setPolicy(connectionAccount.sentCopyPolicy);
                  setConnectionRevision((n) => n + 1);
                  setConnectionDirty(false);
                }}
              >
                Discard changes
              </button>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={(event) => {
                const body = connectionPayload(event.currentTarget.form!);
                void run(async () => {
                  const result = await request(
                    `/api/accounts/${account.id}/test`,
                    "POST",
                    body,
                  );
                  setStatus(
                    result.result.imap.success && result.result.smtp.success
                      ? "IMAP and SMTP connections successful"
                      : "Connection test failed. See Diagnostics for results.",
                  );
                });
              }}
            >
              Test connection
            </button>
          </form>
        )}
      </div>
      <div
        hidden={tab !== "Diagnostics"}
        id="panel-Diagnostics"
        role="tabpanel"
        aria-labelledby="tab-Diagnostics"
      >
        <section className="settings-section">
          <h3>Connection and synchronization</h3>
          <a
            className="button-link secondary"
            href={`/accounts?section=application-logs&account=${encodeURIComponent(account.id)}`}
          >
            View related application logs
          </a>
          <dl className="settings-facts">
            <dt>Provider</dt>
            <dd>
              {account.authMethod === "oauth2"
                ? `${account.oauthProviderName ?? "OAuth"} OAuth`
                : "IMAP / SMTP"}
            </dd>
            <dt>Account</dt>
            <dd>{account.enabled ? "Enabled" : "Disabled"}</dd>
            <dt>Receiving mail</dt>
            <dd>
              {!account.enabled
                ? "Synchronization disabled"
                : latestSync(mailboxes)
                  ? "Synchronization has succeeded"
                  : "No successful synchronization recorded"}
            </dd>
            <dt>Manual connection test</dt>
            <dd>{friendlyStatus(account.connectionStatus)}</dd>
            <dt>Last successful manual test</dt>
            <dd>
              {account.lastSuccessfulConnectionTestAt
                ? date(account.lastSuccessfulConnectionTestAt)
                : "No successful test recorded"}
            </dd>
            <dt>Mailbox discovery</dt>
            <dd>{friendlyStatus(account.mailboxDiscovery.status)}</dd>
            <dt>Last successful discovery</dt>
            <dd>{date(account.mailboxDiscovery.lastSuccessfulAt)}</dd>
            <dt>Last successful sync</dt>
            <dd>{date(latestSync(mailboxes))}</dd>
            {account.gmailSync && (
              <>
                <dt>Gmail synchronization</dt>
                <dd>{account.gmailSync.status}</dd>
                <dt>Recent messages</dt>
                <dd>{account.gmailSync.recentReady ? "Ready" : "Importing"}</dd>
                <dt>Historical coverage</dt>
                <dd>
                  {account.gmailSync.inventoryComplete
                    ? "Complete"
                    : "Importing in background"}
                </dd>
                <dt>Metadata observations</dt>
                <dd>{account.gmailSync.processedCount}</dd>
                <dt>History checkpoint</dt>
                <dd>
                  {account.gmailSync.historyHealthy
                    ? "Healthy"
                    : "Awaiting synchronization or reconciliation"}
                </dd>
                <dt>Quota units reserved</dt>
                <dd>{account.gmailSync.quotaUnits}</dd>
                <dt>Next attempt</dt>
                <dd>{date(account.gmailSync.nextAttemptAt)}</dd>
                {account.gmailSync.errorCategory && (
                  <>
                    <dt>Gmail failure</dt>
                    <dd>{account.gmailSync.errorCategory}</dd>
                  </>
                )}
              </>
            )}
            <dt>Capabilities</dt>
            <dd>
              {account.mailboxDiscovery.capabilities.join(", ") ||
                "None reported"}
            </dd>
          </dl>
          <p className="muted">
            Synchronization confirms receiving mail only. Manual connection
            tests check receiving and SMTP separately; successful
            synchronization does not verify sending.
          </p>
          <details>
            <summary>Technical connection details</summary>
            <dl className="settings-facts">
              <dt>Connection test state</dt>
              <dd>{account.connectionStatus}</dd>
              <dt>
                {account.receiveTransport === "gmail"
                  ? "Gmail API test"
                  : "IMAP test"}
              </dt>
              <dd>{friendlyStatus(account.imapResult.status)}</dd>
              <dt>SMTP test</dt>
              <dd>{friendlyStatus(account.smtpResult.status)}</dd>
              <dt>Discovery state</dt>
              <dd>{account.mailboxDiscovery.status}</dd>
            </dl>
          </details>
          {[
            account.imapResult.error,
            account.smtpResult.error,
            account.mailboxDiscovery.error,
          ]
            .filter(Boolean)
            .map((e, i) => (
              <p className="error" key={i}>
                {e}
              </p>
            ))}
          <button
            className="button secondary"
            disabled={pending || !account.enabled}
            onClick={() =>
              void run(async () => {
                await request(
                  `/api/accounts/${account.id}/mailboxes/discover`,
                  "POST",
                );
                setStatus("Mailbox refresh requested");
              })
            }
          >
            Refresh mailboxes
          </button>
        </section>
        <section className="settings-section">
          <h3>Mailbox synchronization</h3>
          {mailboxes.length === 0 ? (
            <p>
              {account.enabled
                ? "No folders have been discovered yet. Use Refresh mailboxes above to request them."
                : "Synchronization is disabled. Enable this account to discover its folders."}
            </p>
          ) : (
            <div className="settings-sync-list">
              {mailboxes.map((m) => (
                <div key={m.id}>
                  <strong>{m.name}</strong>
                  <span>
                    {friendlyStatus(m.lifecycleStatus)} · Latest mail:{" "}
                    {friendlyStatus(m.recentSync.status)} · Changes:{" "}
                    {friendlyStatus(m.deltaSync.status)} · Older mail:{" "}
                    {friendlyStatus(m.backfill.status)}
                  </span>
                  <span>
                    Last sync: {date(latestSync([m]))} ·{" "}
                    {m.synchronizedMessageCount} messages saved in Maildock
                  </span>
                  <details>
                    <summary>Technical sync details</summary>
                    {m.lifecycleStatus} · Recent: {m.recentSync.status} · Delta:{" "}
                    {m.deltaSync.status} · History: {m.backfill.status}
                  </details>
                  {[m.recentSync.error, m.deltaSync.error, m.backfill.error]
                    .filter(Boolean)
                    .map((e, i) => (
                      <p key={i} className="error">
                        {e}
                      </p>
                    ))}
                </div>
              ))}
            </div>
          )}
        </section>
        <details className="settings-section">
          <summary>Protocol details</summary>
          {mailboxes.map((m) => (
            <div key={m.id}>
              <p>
                <code>{m.remotePath}</code> · delimiter {m.delimiter ?? "none"}{" "}
                · attributes {m.attributes.join(", ") || "none"} · special-use{" "}
                {m.specialUse.join(", ") || "none"} · selectable{" "}
                {String(m.selectable)} · UIDVALIDITY {m.uidValidity ?? "n/a"} ·
                UIDNEXT {m.uidNext ?? "n/a"} · HIGHESTMODSEQ{" "}
                {m.highestModseq ?? "n/a"} · historical frontier{" "}
                {m.backfill.frontierUid ?? "n/a"}
              </p>
            </div>
          ))}
        </details>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <p role="status">{pending ? "Working…" : status}</p>
    </>
  );
}
