"use client";
import type { OAuthProviderDefinition } from "@/modules/accounts/domain/oauth-mail-provider";
import { OAuthProviderSettings } from "./oauth-provider-settings";
import { ApplicationLogs } from "./application-logs";
import { AutoReadSettings } from "./auto-read-settings";
import { NotificationSettings } from "./notification-settings";
import { DesktopNotifications } from "./desktop-notifications";
import { notificationHref } from "@/modules/mail/domain/desktop-notifications";
import type { NotificationPreferences } from "@/modules/mail/domain/notifications";
import type { AutoReadPreference } from "@/modules/mail/domain/mail-interactions";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, Mail, Grid2X2 } from "lucide-react";
import { AccountForm } from "./account-form";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";
import type { SignatureCatalog } from "@/modules/mail/domain/signature";
import { MaildockBrand } from "./maildock-brand";
import { ThemeControl } from "./theme-control";
import { ConversationViewSettings } from "./conversation-view-settings";
import { SignatureSettings } from "./signature-settings";
import { RemoteContentSettings } from "./remote-content-settings";
import { AccountSettings } from "./account-settings";

type Section =
  | "oauth-providers"
  | "application-logs"
  | "add-account"
  | "add-imap"
  | "appearance"
  | "mail"
  | "notifications"
  | "signatures"
  | "remote-images"
  | `account:${string}`;
export function SettingsShell({
  accounts,
  mailboxesByAccount,
  rolesByAccount,
  signatureCatalog,
  conversationEnabled,
  autoReadPreference,
  notificationPreferences,
  trustedSenders,
  oauthProviders,
  oauthResult,
  initialAccountId,
  initialAddAccount = false,
  initialApplicationLogs = false,
  initialOAuthProviders = false,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
  rolesByAccount: Record<string, MailboxRoleView[]>;
  signatureCatalog: SignatureCatalog;
  conversationEnabled: boolean;
  autoReadPreference?: AutoReadPreference;
  notificationPreferences?: NotificationPreferences;
  trustedSenders: { address: string }[];
  oauthProviders: (OAuthProviderDefinition & { configured: boolean })[];
  oauthResult: { oauth?: string; oauth_error?: string };
  initialAccountId?: string;
  initialAddAccount?: boolean;
  initialApplicationLogs?: boolean;
  initialOAuthProviders?: boolean;
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(notificationPreferences);
  const [createdAccount, setCreatedAccount] = useState<MailAccountView>();
  const accountItems =
    createdAccount && !accounts.some((a) => a.id === createdAccount.id)
      ? [...accounts, createdAccount]
      : accounts;
  // Use the server list once refresh includes the created account. Clear the
  // temporary view so a subsequent deletion cannot reintroduce it in the rail.
  if (createdAccount && accounts.some((a) => a.id === createdAccount.id))
    setCreatedAccount(undefined);
  const [section, setSection] = useState<Section>(() => {
    if (initialOAuthProviders) return "oauth-providers";
    if (initialApplicationLogs) return "application-logs";
    const selected = accounts.find((a) => a.id === initialAccountId);
    return selected
      ? `account:${selected.id}`
      : initialAddAccount
        ? "add-account"
        : "appearance";
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const leaving = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  const onBusyChange = useCallback((value: boolean) => setBusy(value), []);
  const selectedAccount = section.startsWith("account:")
    ? accountItems.find((a) => a.id === section.slice(8))
    : undefined;
  useEffect(() => {
    leaving.current = false;
    const currentUrl = window.location.href;
    const currentHistoryState = window.history.state;
    function beforeUnload(event: BeforeUnloadEvent) {
      if ((dirty || busy) && !leaving.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    // Covers Back to mail, existing add-account/OAuth flows and any inner links.
    function followLink(event: MouseEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("a[href]")
      )
        return;
      if (
        busy ||
        (dirty && !window.confirm("Discard unsaved settings changes?"))
      ) {
        event.preventDefault();
        event.stopPropagation();
      } else if (
        dirty &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.target.closest("a[href]")?.getAttribute("target") !== "_blank"
      ) {
        leaving.current = true;
      }
    }
    // Next's client-side history traversal does not trigger beforeunload.
    function traverseHistory(event: PopStateEvent) {
      if (
        busy ||
        (dirty && !window.confirm("Discard unsaved settings changes?"))
      ) {
        event.stopImmediatePropagation();
        window.history.pushState(currentHistoryState, "", currentUrl);
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", traverseHistory, true);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", traverseHistory, true);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty, busy]);
  function select(next: Section) {
    if (section === next || busy) return;
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    setDirty(false);
    setSection(next);
  }
  function item(value: Section, label: string, detail?: string) {
    return (
      <button
        type="button"
        key={value}
        aria-current={section === value ? "page" : undefined}
        disabled={busy}
        onClick={() => select(value)}
      >
        <span>{label}</span>
        {detail ? <small>{detail}</small> : null}
      </button>
    );
  }
  const oauthErrors: Record<string, string> = {
    configuration: "OAuth is not configured. Open OAuth providers in Settings.",
    start: "OAuth connection could not start. Try again.",
    state: "Provider sign-in expired or was invalid. Try connecting again.",
    denied:
      "Provider consent was denied. Grant the requested mail permissions to connect.",
    identity: "Reconnect using the same email account as before.",
    authorization:
      "Provider sign-in failed. Check consent, account access, and tenant policy, then try again.",
  };
  return (
    <main className="settings-shell">
      {notifications?.enabled ? (
        <DesktopNotifications
          onOpen={(event) => router.push(notificationHref(event))}
        />
      ) : null}
      <header className="settings-header">
        <div className="settings-brand-heading">
          <MaildockBrand />
          <h1>Settings</h1>
        </div>
        <Link href="/" className="button-link secondary">
          Back to mail
        </Link>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings navigation">
          <div className="settings-nav-group">
            <h2>General</h2>
            {item("appearance", "Appearance")}
            {item("mail", "Mail")}
            {item("notifications", "Notifications")}
          </div>
          <div className="settings-nav-group">
            <h2>Accounts</h2>
            {accountItems.map((a) =>
              item(`account:${a.id}`, a.displayName, a.email),
            )}
            <button
              type="button"
              disabled={busy}
              aria-current={
                section === "add-account" || section === "add-imap"
                  ? "page"
                  : undefined
              }
              onClick={() => select("add-account")}
            >
              + Add account
            </button>
          </div>
          <div className="settings-nav-group">
            <h2>Compose</h2>
            {item("signatures", "Signatures")}
          </div>
          <div className="settings-nav-group">
            <h2>Privacy</h2>
            {item("remote-images", "Remote images")}
          </div>
          <div className="settings-nav-group">
            <h2>Integrations</h2>
            {item("oauth-providers", "OAuth providers")}
          </div>
          <div className="settings-nav-group">
            <h2>Diagnostics</h2>
            {item("application-logs", "Application logs")}
          </div>
        </nav>
        <section className="settings-pane" aria-label="Settings content">
          {oauthResult.oauth === "connected" ? (
            <p className="success" role="status">
              Email account connected.
            </p>
          ) : null}
          {oauthResult.oauth_error ? (
            <p className="error" role="alert">
              {oauthErrors[oauthResult.oauth_error] ??
                "OAuth connection failed. Try again."}
            </p>
          ) : null}
          {section === "oauth-providers" ? (
            <OAuthProviderSettings
              onDirtyChange={setDirty}
              onBusyChange={setBusy}
            />
          ) : null}
          {section === "add-account" ? (
            <>
              <header className="settings-pane-header account-provider-header">
                <h2>Add email account</h2>
                <p>Choose how you want to connect your account.</p>
              </header>
              <div
                className="account-provider-list"
                aria-label="Email providers"
              >
                {oauthProviders.map((provider) =>
                  provider.configured ? (
                    <a
                      key={provider.id}
                      className="account-provider-row"
                      href={provider.authorizationPath}
                    >
                      <Grid2X2 aria-hidden="true" />
                      <span>
                        <strong>{provider.name}</strong>
                        <small>{provider.description}</small>
                      </span>
                      <ChevronRight aria-hidden="true" />
                      <small>Continue with {provider.name}</small>
                    </a>
                  ) : (
                    <button
                      key={provider.id}
                      className="account-provider-row"
                      disabled
                    >
                      <Grid2X2 aria-hidden="true" />
                      <span>
                        <strong>{provider.name}</strong>
                        <small>{provider.description}</small>
                      </span>
                      <small>Not configured</small>
                    </button>
                  ),
                )}
                <button
                  type="button"
                  className="account-provider-row"
                  onClick={() => select("add-imap")}
                >
                  <Mail aria-hidden="true" />
                  <span>
                    <strong>Other email</strong>
                    <small>Connect using IMAP and SMTP</small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
              {oauthProviders
                .filter((provider) => !provider.configured)
                .map((provider) => (
                  <p key={provider.id}>
                    {provider.name} OAuth is not configured.{" "}
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => select("oauth-providers")}
                    >
                      Configure OAuth providers
                    </button>
                  </p>
                ))}
            </>
          ) : null}
          {section === "add-imap" ? (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => select("add-account")}
              >
                <ArrowLeft size={16} aria-hidden="true" /> Back
              </button>
              <header className="settings-pane-header">
                <h2>Add email account</h2>
                <p>Connect using IMAP and SMTP.</p>
              </header>
              <AccountForm
                onDirtyChange={onDirtyChange}
                onBusyChange={onBusyChange}
                onCreated={(account) => {
                  setDirty(false);
                  setCreatedAccount(account);
                  setSection(`account:${account.id}`);
                  router.replace(
                    `/accounts?account=${encodeURIComponent(account.id)}`,
                  );
                  router.refresh();
                }}
              />
            </>
          ) : null}
          {selectedAccount ? (
            <AccountSettings
              key={selectedAccount.id}
              account={selectedAccount}
              mailboxes={mailboxesByAccount[selectedAccount.id] ?? []}
              roles={rolesByAccount[selectedAccount.id] ?? []}
              catalog={signatureCatalog}
              onDirtyChange={onDirtyChange}
              onBusyChange={onBusyChange}
            />
          ) : null}
          {section.startsWith("account:") && !selectedAccount ? (
            <>
              <h2>Accounts</h2>
              <p>
                This account is no longer configured. Select an account or add a
                new one.
              </p>
            </>
          ) : null}
          {section === "application-logs" ? (
            <ApplicationLogs
              accounts={accountItems}
              initialAccountId={initialAccountId}
            />
          ) : null}
          {section === "appearance" ? (
            <>
              <header className="settings-pane-header">
                <h2>Appearance</h2>
                <p>Choose how Maildock looks on this device.</p>
              </header>
              <section className="settings-section">
                <h3>Theme</h3>
                <p className="muted">
                  Light, dark, or follow your system preference. Changes apply
                  immediately.
                </p>
                <ThemeControl />
              </section>
            </>
          ) : null}
          {section === "mail" ? (
            <>
              <header className="settings-pane-header">
                <h2>Mail</h2>
                <p>
                  Preferences for reading mail. Saved preferences apply to all
                  accounts.
                </p>
              </header>
              <ConversationViewSettings initialEnabled={conversationEnabled} />
              <AutoReadSettings initialValue={autoReadPreference} />
            </>
          ) : null}
          {section === "signatures" ? (
            <SignatureSettings
              onDirtyChange={onDirtyChange}
              onBusyChange={onBusyChange}
            />
          ) : null}
          {section === "notifications" ? (
            <NotificationSettings
              accounts={accountItems}
              initialValue={notifications}
              onSaved={setNotifications}
            />
          ) : null}
          {section === "remote-images" ? (
            <RemoteContentSettings initialSenders={trustedSenders} />
          ) : null}
        </section>
      </div>
    </main>
  );
}
