"use client";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";

// Shared by Settings account creation and the Settings connection editor.
export function AccountConnectionFields({
  account,
  useImapCredentials,
  onUseImapCredentialsChange,
}: {
  account?: MailAccountView;
  useImapCredentials: boolean;
  onUseImapCredentialsChange: (value: boolean) => void;
}) {
  return (
    <>
      <fieldset>
        <legend>IMAP</legend>
        <div className="form-grid">
          <label>
            Host
            <input
              name="imapHost"
              required
              defaultValue={account?.imap.host ?? undefined}
            />
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
              defaultValue={account?.imap.username ?? undefined}
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
            onChange={(event) =>
              onUseImapCredentialsChange(event.target.checked)
            }
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
    </>
  );
}
