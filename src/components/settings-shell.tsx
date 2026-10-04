"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";
import type { SignatureCatalog } from "@/modules/mail/domain/signature";
import { ThemeControl } from "./theme-control";
import { ConversationViewSettings } from "./conversation-view-settings";
import { SignatureSettings } from "./signature-settings";
import { RemoteContentSettings } from "./remote-content-settings";
import { AccountSettings } from "./account-settings";

type Section =
  "appearance" | "mail" | "signatures" | "remote-images" | `account:${string}`;
export function SettingsShell({
  accounts,
  mailboxesByAccount,
  rolesByAccount,
  signatureCatalog,
  conversationEnabled,
  trustedSenders,
  oauthConfigured,
  oauthResult,
  initialAccountId,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
  rolesByAccount: Record<string, MailboxRoleView[]>;
  signatureCatalog: SignatureCatalog;
  conversationEnabled: boolean;
  trustedSenders: { address: string }[];
  oauthConfigured: boolean;
  oauthResult: { oauth?: string; oauth_error?: string };
  initialAccountId?: string;
}) {
  const [section, setSection] = useState<Section>(() => {
    const selected = accounts.find((a) => a.id === initialAccountId);
    return selected ? `account:${selected.id}` : "appearance";
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const leaving = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  const onBusyChange = useCallback((value: boolean) => setBusy(value), []);
  const selectedAccount = section.startsWith("account:")
    ? accounts.find((a) => a.id === section.slice(8))
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
    configuration:
      "Microsoft connection is not configured. Set the Microsoft app registration values.",
    start: "Microsoft connection could not start. Try again.",
    state: "Microsoft sign-in expired or was invalid. Try connecting again.",
    denied:
      "Microsoft consent was denied. Grant the requested mail permissions to connect.",
    identity: "Reconnect using the same Microsoft account as before.",
    authorization:
      "Microsoft sign-in failed. Check consent, account access, and tenant policy, then try again.",
  };
  return (
    <main className="settings-shell">
      <header className="settings-header">
        <h1>Settings</h1>
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
          </div>
          <div className="settings-nav-group">
            <h2>Accounts</h2>
            {accounts.map((a) =>
              item(`account:${a.id}`, a.displayName, a.email),
            )}
            <a href="/accounts/new">+ Add account</a>
            {oauthConfigured ? (
              <a href="/api/oauth/microsoft/start">Connect Microsoft account</a>
            ) : null}
          </div>
          <div className="settings-nav-group">
            <h2>Compose</h2>
            {item("signatures", "Signatures")}
          </div>
          <div className="settings-nav-group">
            <h2>Privacy</h2>
            {item("remote-images", "Remote images")}
          </div>
        </nav>
        <section className="settings-pane" aria-label="Settings content">
          {oauthResult.oauth === "connected" ? (
            <p className="success" role="status">
              Microsoft account connected.
            </p>
          ) : null}
          {oauthResult.oauth_error ? (
            <p className="error" role="alert">
              {oauthErrors[oauthResult.oauth_error] ??
                "Microsoft connection failed. Try again."}
            </p>
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
                <p>Preferences for reading mail. Changes apply immediately.</p>
              </header>
              <ConversationViewSettings initialEnabled={conversationEnabled} />
            </>
          ) : null}
          {section === "signatures" ? (
            <SignatureSettings
              onDirtyChange={onDirtyChange}
              onBusyChange={onBusyChange}
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
