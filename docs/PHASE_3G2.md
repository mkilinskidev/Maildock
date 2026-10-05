# Phase 3G.2 — Google OAuth Provider

Google is the second real OAuth provider registered through Phase 3G.1's `OAuthMailProvider` / `OAuthProviderRegistry`. It authenticates Gmail and Google Workspace accounts for the existing IMAP/SMTP implementation. It does not use Gmail API mail/data endpoints, introduce a parallel mail stack, or alter owner login.

## Provider and endpoints

`GoogleOAuthProvider` implements the existing contract without changing it. It provides metadata (`google`, `Google`, `Gmail / Google Workspace`), fixed start/callback paths, configuration availability, authorization completion/account persistence, access-token refresh and mail defaults.

The only external OAuth/identity endpoints are:

- Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
- Code exchange and refresh: `https://oauth2.googleapis.com/token`
- Trusted identity: `https://openidconnect.googleapis.com/v1/userinfo`

Endpoints are constants, never client/configuration overrides. Server-side token requests use form encoding and client-secret authentication, a 15-second timeout, no caching and no redirects. Identity requests likewise disallow redirects and use the server-obtained bearer token. Platform `fetch`, Node crypto and the existing Zod dependency suffice; no new dependency, Google SDK or change to MSAL is required.

## Scopes, identity and offline authorization

The requested scopes are exactly:

- `https://mail.google.com/`: Google's required IMAP/SMTP XOAUTH2 scope.
- `openid` and `email`: the minimum identity scopes for a stable Google subject and a verified mailbox email. No `profile`, People API or Gmail API data scope is requested.

The server fetches UserInfo after exchanging the code. It requires a nonempty `sub`, valid email and `email_verified: true`. The normalized trusted email becomes the account email and IMAP/SMTP username. The stable `sub`, rather than email/domain or browser input, protects reconnect; a Workspace email rename on the same subject is accepted. No client-provided or decoded/unverified ID token is used as identity evidence.

Authorization requests set `access_type=offline` and `prompt=consent select_account` on both initial connection and reconnect. Initial connection must return a refresh token, otherwise no account is created and the owner is asked to grant offline consent again. Reconnect prefers the newly issued refresh token. If Google omits it, the existing token is preserved only after validating the same subject and successfully refreshing the previous grant; any rotation from that validation is persisted. A revoked old grant cannot become a falsely successful reconnect merely because interactive sign-in returned an access token.

## State and callback security

Google reuses `oauth_authorization_states`, with `providerId=google`, the authenticated owner session ID, optional reconnect account ID and a ten-minute expiry. State is generated from 32 cryptographically random bytes; only its SHA-256 hash is stored. S256 PKCE uses another independent 32-byte random verifier, encrypted with the existing key ring and provider-specific verifier context. Google's discovery document advertises S256 support.

Completion atomically deletes a matching unexpired state constrained by provider and owner session, before code exchange or error processing. State is single-use even when consent or exchange fails. Wrong-session/provider/expired/malformed/reused callbacks are rejected. Callback account/redirect query parameters are ignored; reconnect targets come exclusively from pending state. All application redirects derive from validated `APP_ORIGIN`. Both routes require the existing authenticated owner session. Codes, tokens, secrets, verifiers and raw provider responses never enter logs, diagnostics or API responses. State/verifier appear only where needed for OAuth, with no browser-visible verifier or token.

## Credentials and refresh

Google reuses the provider-owned encrypted `mail_accounts.oauth_cache` envelope:

```text
encrypted JSON { version: 1, subject: <Google sub>, refreshToken: <durable grant> }
context: maildock:account-credential:v1:<accountId>:oauth-cache
```

The subject and refresh token are both encrypted at rest using existing `SecretEncryption` and credentials keys. `oauth_home_account_id` remains null for Google and retains its unchanged Microsoft meaning. No schema migration, provider-specific column, new key or credential contract evolution is needed.

Access tokens are not persisted or cached. Each `accessToken(accountId)` refreshes the encrypted grant and returns a newly issued bearer token with a validated lifetime exceeding 60 seconds. This deliberately simple policy prevents stale cache/expiry/restart problems, at the cost of a token-endpoint request on each credential acquisition. Rotated refresh tokens are encrypted and saved; omitted refresh tokens leave the stored grant intact. Configuration is resolved before opening an account transaction, avoiding pool-size-one deadlock. Account row locks serialize refresh, reconnect credential replacement and permanent failure status writes.

`invalid_grant` at the token endpoint, loss of full-mail scope, or unusable durable account authorization follows the existing safe `OAuthAuthorizationError` convention and results in `reconnect_required` during background acquisition. Network/timeouts, rate limits, server failures, malformed/expired token responses and application-credential/configuration failures return fixed safe errors without marking authorization permanently revoked. No raw Google error description is reflected. No successful-refresh Application Event or new diagnostics taxonomy is introduced.

## Account creation and mail protocols

Initial completion creates the normal `imap_smtp` account with `authMethod=oauth2`, `oauthProviderId=google`, encrypted authorization and trusted email. Defaults:

| Protocol | Host             | Port | Existing security representation |
| -------- | ---------------- | ---- | -------------------------------- |
| IMAP     | `imap.gmail.com` | 993  | `tls`                            |
| SMTP     | `smtp.gmail.com` | 465  | `tls`                            |

SMTP 465 uses the existing implicit TLS transport, certificate verification and generic XOAUTH2 credential support. STARTTLS or a new abstraction is unnecessary. Callback requests discovery through `AccountsService.requestMailboxDiscovery`; discovery and initial/recent/delta/backfill work use the existing pipeline.

```text
GoogleOAuthProvider.accessToken(accountId)
  → AccountsService registry resolution
  → { kind: oauth2, accessToken }
  → ImapSmtpMailProvider
  → Gmail IMAP / SMTP
```

Reconnect checks the trusted Google subject while holding the existing account row lock, then replaces authorization and resets connection-test status. It preserves account ID, local mailbox/message state, owner labels, protocol settings and Sent policy. Different subjects are rejected even when the email strings match. No delete/recreate operation occurs.

## Configuration and onboarding

Google is database-backed from day one; no Google environment variables or legacy bootstrap are required. Its registry entry automatically appears in the existing owner-only provider configuration API, Settings → Integrations → OAuth providers, and metadata consumers in web and worker. The generic form provides Enabled, Client ID, write-only encrypted Client secret, trusted read-only Redirect URI and Configured status. A blank secret preserves the saved secret; neither plaintext nor ciphertext is returned. Existing owner/Origin protection is unchanged.

The redirect URI is exactly `<APP_ORIGIN>/api/oauth/google/callback`, as displayed by Maildock. Add account uses registry metadata and the generic `Continue with <provider name>` link when enabled/configured. The disabled Google placeholder is removed. An unconfigured/disabled Google entry uses the existing provider-neutral configuration guidance rather than beginning an unusable OAuth flow. Existing account reconnect UI obtains Google's name/start path from the same registry.

## Production diff and Microsoft compatibility

Added production files:

- `src/modules/accounts/infrastructure/google-oauth.ts`: provider implementation, trusted identity, state/PKCE, encrypted persistence, refresh and reconnect.
- `src/app/api/oauth/google/start/route.ts`: authenticated Google authorization start through the registry.
- `src/app/api/oauth/google/callback/route.ts`: authenticated completion and existing discovery scheduling.

Every changed existing production file, and why:

- `src/modules/accounts/infrastructure/oauth-composition.ts`: construct/register Google beside Microsoft in the single shared web/worker composition root.
- `src/components/settings-shell.tsx`: remove the disabled Google placeholder, allowing the registered provider to render through the existing metadata enumeration, and add a provider-neutral continuation label.

There are no other existing generic/core production changes. `OAuthMailProvider`, configuration storage/API/form, account services/storage/schema, workers, IMAP/SMTP implementation, discovery, sync, sending, notification and diagnostics infrastructure are unchanged. `MicrosoftOAuthProvider`, MSAL cache format, encryption contexts, scopes, legacy bootstrap/migration and reconnect/token lifecycle are unchanged. No migration or forced Microsoft reauthorization is introduced.

## Extension-point result

**Did adding Google require changes to Maildock core mail synchronization or sending architecture?**

No. Google was added through the Phase 3G.1 provider extension point. The only existing production changes are provider registration and activation of generic onboarding. The OAuth provider contract did not change; its opaque encrypted account state already accommodates Google's refresh grant and stable identity.

## Automated validation

Focused Google tests use mocked Google HTTP responses against real migrated PostgreSQL and real credential encryption. They cover registry enumeration, DB-only configuration, state/session/provider binding and consumption, S256 matching, server exchange/UserInfo, identity validation, creation/defaults, generic discovery/IMAP/SMTP credential resolution, durable refresh/rotation/omission/restart, permanent versus temporary failures, same/different-subject reconnect and retained local mail state. Route tests cover owner authentication, trusted redirects, callback query injection, safe failure responses and generic discovery scheduling. Generic UI tests cover configured/unconfigured Google and the shared configuration form. Security integration tests use real owner sessions and PostgreSQL to verify Google configuration owner/Origin protection and write-only secrets. Existing Microsoft migration/MSAL lifecycle and mail regressions remain intact.

Validation on bundled Node 24.19.0:

- `pnpm test --maxWorkers=4`: 68 files, 779 tests passed, including existing Microsoft migration/MSAL/mail regressions.
- `pnpm test:security`: 2 files, 39 tests passed with real owner sessions and PostgreSQL.
- `pnpm typecheck`: web and worker passed.
- `pnpm lint`: zero errors; one pre-existing unused `writeFile` import warning in ignored `.security-results/signature-settings-preview.mjs`.
- `pnpm build`: Next.js production build and worker TypeScript/import-fix build passed. `APP_ORIGIN=https://mail.example.com` was supplied to this process to satisfy existing production HTTPS validation; `.env` was unchanged.
- `git diff --check`: passed.
- `pnpm test:security:browser`: passed using installed Chromium 148.0.7778.96 via the harness's existing `SECURITY_BROWSER_EXECUTABLE` option. The default Edge run and standalone Edge retry both reached an unchanged composer DOM-selection check and timed out at `tests/security/compose-browser.ts:322`; no harness or composer source was changed or weakened. Chromium ran the entire original harness, including hostile-email, composer, attachments and signature checks.

These automated checks do not establish real Google consent or external IMAP/SMTP connectivity.

## Real Google smoke procedure (requires credentials; not performed by automated tests)

1. Create a Google Cloud project and configure its OAuth consent screen/audience. For an external application in Testing, add the intended Google account as a test user and configure the requested scopes. Workspace administrators may need to permit the app/IMAP access.
2. Create an OAuth **Web application** client. Copy the exact redirect URI displayed by Maildock's Google configuration view into Google's authorized redirect URIs; use the same production HTTPS `APP_ORIGIN`.
3. In Settings → OAuth providers → Google enter that Client ID and Client secret. Save; reload and verify the secret input remains empty and the URI is unchanged.
4. Enable Google and verify Configured status.
5. Open Add account → Google → Continue with Google.
6. Select the intended account and complete Google's consent, granting mail and identity permissions.
7. Verify normal account creation with the authorized email, OAuth connected status and Gmail protocol defaults; ensure no token appears in browser/API/log output.
8. Verify mailbox discovery succeeds and Gmail labels/folders are shown through the existing pipeline.
9. Verify recent mail synchronization and opening existing messages.
10. Deliver new mail to Gmail and verify delta/new-mail synchronization.
11. Send to a second mailbox through Maildock; verify Gmail SMTP delivery and sender identity.
12. Verify the sent message appears in Gmail Sent and Maildock's configured Sent behavior produces no unwanted duplicate. The default server-managed Sent policy is retained.
13. Restart application and worker while keeping the database and encryption keys. Verify background IMAP access and SMTP sending without reauthorization; repeat after the former access token's lifetime (normally about an hour).
14. Reconnect the existing Google account using the same Google identity. Verify the same Maildock account ID and local mail state remain and background access works.
15. Attempt reconnect using another Google account. Verify rejection and unchanged existing account/credentials/local mail state. Reconnect correctly again if needed.
16. Verify an existing Microsoft account still renews, syncs and sends after Google was added, without a migration-triggered reconnect.

Optional lifecycle smoke: revoke Maildock authorization in the Google account's security settings, verify background acquisition transitions to reconnect_required, and restore it through same-account reconnect.

## Google consent / verification limitations

The full-mail scope is restricted. Public applications must satisfy Google's user-data policies and relevant verification requirements; deployment/audience/security-assessment requirements depend on the application's distribution and handling of restricted data. External Testing projects generally issue refresh tokens that expire after seven days when scopes beyond basic identity are requested, so a successful short smoke is not proof of indefinite unattended access. Refresh grants can also be revoked or expire due to account/admin policy or token limits. Maildock handles authorization loss through reconnect; it adds no verification-specific product logic or scope workaround.

References checked for this implementation:

- [Google web-server OAuth and offline/refresh behavior](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OpenID Connect identity](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google discovery document, endpoints and S256 support](https://accounts.google.com/.well-known/openid-configuration)
- [Gmail IMAP/SMTP XOAUTH2 and scope requirements](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
- [Google OAuth refresh-token expiration and consent constraints](https://developers.google.com/identity/protocols/oauth2)

## Git handoff

Implementation starts from `4bedfafb5862018c5a642dcef6e7cb577e177bc4`. All changes are left uncommitted for repository-owner review. No commit, amend or push is part of this phase.
