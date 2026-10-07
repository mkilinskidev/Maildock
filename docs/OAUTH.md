# OAuth mail providers

OAuth in Maildock authenticates mail accounts; it does not authenticate the Maildock owner. The owner always signs in through Maildock's own password + mandatory TOTP flow.

Microsoft and Google OAuth both end in the existing IMAP/SMTP provider. Maildock does not use Microsoft Graph or the Gmail API for mail synchronization/sending.

Provider application configuration is stored in PostgreSQL and client secrets are encrypted with the Maildock credential key ring. Configure providers from **Settings → Integrations → OAuth providers**.

## Microsoft 365 / Outlook.com

Create a Microsoft Entra application that supports the account types you need. To support both Microsoft 365 organizational accounts and Outlook.com personal accounts, allow both.

Configure a **Web** redirect URI:

```text
<APP_ORIGIN>/api/oauth/microsoft/callback
```

Add delegated Exchange Online permissions:

- `IMAP.AccessAsUser.All`
- `SMTP.Send`

Maildock's Microsoft flow also requests normal OpenID identity/offline scopes required for authorization and token renewal.

In Maildock open **Settings → Integrations → OAuth providers → Microsoft** and enter:

- Client ID
- Client secret
- Enabled = on

The secret field is write-only. Leaving it blank on a later edit preserves the stored encrypted secret.

### Legacy environment bootstrap

`MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` remain supported for upgrades. If no Microsoft provider row exists and both variables are non-empty, Maildock bootstraps an enabled database row. Once a row exists, the database is authoritative; environment variables do not overwrite it.

New installations should normally configure Microsoft in Settings.

## Gmail / Google Workspace

Create a Google OAuth client for a web application and configure this redirect URI:

```text
<APP_ORIGIN>/api/oauth/google/callback
```

Maildock requests:

- `https://mail.google.com/` for Gmail IMAP/SMTP XOAUTH2;
- `openid`;
- `email`.

The authorization requests offline access because Maildock must refresh credentials for background synchronization. Google may require OAuth consent-screen configuration and, depending on how you distribute/use the application, Google verification for the Gmail scope. Those provider-side requirements are outside Maildock.

In Maildock open **Settings → Integrations → OAuth providers → Google** and enter:

- Client ID
- Client secret
- Enabled = on

Google configuration is database-backed only. There are intentionally no `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` environment variables.

## Adding an OAuth account

After a provider is enabled/configured:

1. open **Settings → Accounts → Add account**;
2. choose Microsoft or Google;
3. complete the provider consent flow;
4. Maildock validates the returned provider identity and creates the local account;
5. mailbox discovery and synchronization run through the normal background pipeline.

OAuth state is random, short-lived, single-use and bound to the authenticated Maildock owner session. PKCE is used where implemented by the provider flow. Account reconnect is bound to the stored provider identity rather than trusting an email/domain supplied by the browser.

## Reconnect and revocation

Maildock stores durable authorization state encrypted at rest. Access tokens are acquired/refreshed server-side and are never browser-owned mail credentials.

When a provider indicates durable authorization has been revoked or is unusable, the account enters a reconnect-required state. Temporary network/provider failures do not automatically destroy durable authorization.

Reconnect preserves the local account ID and synchronized local mail state when the provider identity matches the existing account.
