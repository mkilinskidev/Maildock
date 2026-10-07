"use client";
import { useEffect, useState } from "react";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import {
  defaultNotificationPreferences,
  type NotificationPreferences,
} from "@/modules/mail/domain/notifications";
import {
  enableNotificationPermission,
  notificationPermission,
} from "@/modules/mail/domain/desktop-notifications";

export function NotificationSettings({
  accounts,
  initialValue = defaultNotificationPreferences,
  onSaved,
}: {
  accounts: MailAccountView[];
  initialValue?: NotificationPreferences;
  onSaved?: (value: NotificationPreferences) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (status !== "Changes saved") return;
    const timer = setTimeout(() => setStatus(""), 3000);
    return () => clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    const update = () => setPermission(notificationPermission());
    update();
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  async function save(next: NotificationPreferences) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      if (next.enabled && !value.enabled) {
        const result = await enableNotificationPermission();
        setPermission(result);
        if (result !== "granted") return;
      }
      const response = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error();
      setValue(next);
      onSaved?.(next);
      setStatus("Changes saved");
    } catch {
      setStatus("Notification preferences could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const enabledAccounts = accounts.filter((account) => account.enabled);
  return (
    <section className="settings-section mail-preferences">
      <h2>Notifications</h2>
      <p className="mail-preference-description">
        Desktop notifications for new mail while Maildock is open.
      </p>
      <fieldset className="mail-preference-options" disabled={busy}>
        <label className="mail-preference-option">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={
              !value.enabled &&
              (permission === "denied" || permission === "unsupported")
            }
            onChange={(e) => void save({ ...value, enabled: e.target.checked })}
          />
          Enable desktop notifications
        </label>
        <p role="status" className="muted">
          {permission === "unsupported"
            ? "Desktop notifications are unsupported here. Use a desktop browser with HTTPS."
            : permission === "denied"
              ? "Notifications are blocked. Allow them in your browser's site settings to enable delivery."
              : permission === "granted"
                ? "Browser permission granted."
                : "Enabling notifications will request browser permission."}
        </p>
        <h3>Notify for</h3>
        <label className="mail-preference-option">
          <input
            type="radio"
            name="notification-folders"
            checked={value.folders === "inbox"}
            onChange={() => void save({ ...value, folders: "inbox" })}
          />
          Inbox messages
        </label>
        <label className="mail-preference-option">
          <input
            type="radio"
            name="notification-folders"
            checked={value.folders === "all"}
            onChange={() => void save({ ...value, folders: "all" })}
          />
          Messages in all folders
        </label>
        <h3>Accounts</h3>
        {enabledAccounts.map((account) => (
          <label key={account.id} className="mail-preference-option">
            <input
              type="checkbox"
              checked={
                value.accountIds === null ||
                value.accountIds.includes(account.id)
              }
              onChange={(e) => {
                const selected = new Set(
                  value.accountIds ?? enabledAccounts.map((a) => a.id),
                );
                if (e.target.checked) selected.add(account.id);
                else selected.delete(account.id);
                void save({ ...value, accountIds: [...selected] });
              }}
            />
            {account.displayName} ({account.email})
          </label>
        ))}
        {!enabledAccounts.length ? (
          <p className="muted">No enabled accounts.</p>
        ) : null}
        <label className="mail-preference-option">
          <input
            type="checkbox"
            checked={value.backgroundOnly}
            onChange={(e) =>
              void save({ ...value, backgroundOnly: e.target.checked })
            }
          />
          Only notify when Maildock is in the background
        </label>
      </fieldset>
      <p
        role={status && status !== "Changes saved" ? "alert" : "status"}
        className={`preference-save-status${status && status !== "Changes saved" ? " error" : ""}`}
      >
        {busy ? "Saving…" : status}
      </p>
    </section>
  );
}
