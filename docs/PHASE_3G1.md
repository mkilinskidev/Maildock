# Phase 3G.1 — OAuth Provider Architecture

Microsoft is the only real OAuth provider in this phase. Google OAuth/Gmail, configuration, scopes and callbacks are **not implemented**. Google retains its disabled “Coming soon” onboarding entry. Owner login is unchanged.

## Contract and resolution

`OAuthMailProvider` describes identity/display metadata, trusted start/callback paths, configuration availability, authorization start/completion, account access-token acquisition and default IMAP/SMTP endpoints. It deliberately retains `begin`/`complete` naming from the working flow. Completion returns the persisted local account ID: the provider owns remote identity validation and encrypted credential persistence. MSAL identities and cache objects never pass through the contract. This boundary avoids a speculative generic refresh-token model and a destructive rewrite of account storage.

```text
Web / worker composition
    └─ createOAuthComposition → OAuthProviderRegistry
Account oauthProviderId → registry.get(id) → OAuthMailProvider.accessToken(accountId)
                                             └─ MicrosoftOAuthProvider → MSAL
AccountsService → credential { kind: oauth2, accessToken } → ImapSmtpMailProvider
                                                         ├─ IMAP mail operations
                                                         └─ SMTP sending
```

The registry has an explicit in-code registration list in `oauth-composition.ts`, shared by web and worker. Duplicate IDs fail at construction; unknown/missing IDs fail safely. Account credentials are resolved in `AccountsService` using the stored provider ID, never email domain or an assumption that OAuth means Microsoft. Generic mail/application services have no Microsoft OAuth dependency. Safe authorization failures use the common `OAuthAuthorizationError` type; only fixed owner-safe messages belong in that error. The existing IMAP/SMTP provider receives the same credential shape as before and has no knowledge of MSAL. Discovery, recent/delta/backfill sync, IDLE, commands, flags, MIME, persistence and sending remain outside the OAuth contract.

Microsoft keeps its authorization-code flow, `common` authority, existing scopes, PKCE, encrypted verifier, 32 random-byte state (stored as SHA-256), ten-minute expiry, authenticated session binding and atomic single-use deletion. Pending state now also identifies its provider. Reconnect queries and token acquisition explicitly constrain the provider and account. Reconnect compares the MSAL home account ID before writing credentials. Callback account selection comes exclusively from pending state, never a callback account query parameter.

MSAL still owns silent renewal and rotated refresh tokens. Cache persistence remains serialized, encrypted and protected by an account row lock. Credential/configuration lookup happens before that transaction so a one-connection database pool works. Revoked/expired authorization retains `reconnect_required`; missing/disabled application configuration does not mark a connected account revoked.

## Installation configuration and secrets

Migration `0026_oauth_provider_architecture.sql` adds `oauth_provider_configs`: provider ID, enabled, client ID, encrypted client-secret envelope, JSONB `settings`, timestamps. This is installation-level application configuration, separate from mailbox authorization. Additional provider settings can be stored in JSONB without schema migrations. Microsoft currently uses no extra settings and always uses `common`; arbitrary authority/redirect overrides are not accepted.

Client secrets use the existing credentials key ring and AES-256-GCM `SecretEncryption`, with context `maildock:oauth-provider:<id>:client-secret:v1`. Account cache context remains `maildock:account-credential:v1:<accountId>:oauth-cache` as defined by `accountCredentialContext`; pending Microsoft verifier context is unchanged. No second master key is introduced. Retain the existing active/previous encryption keys during upgrades.

Settings → Integrations → OAuth providers lists registered providers (Microsoft only), with editable client ID, empty write-only password input, enabled switch, configured status, read-only redirect URI and Copy/Save actions. Redirect URI comes only from validated `APP_ORIGIN` and the provider callback path. Production HTTPS validation is unchanged. “Configured” means an enabled row with both client ID and encrypted secret, not a live tenant/consent validation.

The owner-only `GET/PUT /api/settings/oauth-providers` uses the existing access guard; PUT uses its normal Origin/CSRF protection. Input is bounded and validated; unknown provider IDs and unknown input properties are rejected. Neither API nor UI returns plaintext secrets or ciphertext. Views expose only `hasClientSecret`. A blank secret preserves the stored envelope, including under concurrent updates; a nonempty replacement is freshly encrypted. Settings never exposes raw JSONB settings, so it cannot accidentally expose future secret properties. Errors use fixed safe text, not SQL/MSAL exception objects.

No provider-configuration Application Events or technical object dumps are added. Existing Phase 3F event allowlists and Pino redaction remain unchanged. MSAL PII logging stays disabled with a no-op callback. New configuration/authentication code does not log credentials, codes, tokens, state or query strings.

## ENV precedence and upgrade compatibility

1. A database row is authoritative whenever present, including a disabled or incomplete row.
2. If no Microsoft row exists and **both** `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are nonempty, bootstrap inserts an enabled row and encrypts the secret in memory before the database write.
3. Bootstrap runs after normal `pnpm db:migrate` SQL migrations. Microsoft configuration/token access also invokes the same idempotent bootstrap, supporting installations that apply SQL separately.
4. The insert uses `ON CONFLICT DO NOTHING`: concurrent web/worker bootstrap cannot overwrite an existing or newly saved configuration. Subsequent calls leave its credentials, settings, enabled state and timestamps unchanged.
5. Partial/missing ENV creates no row. Configure Microsoft through Settings in that case. Existing ENV variables may remain; they never overwrite a DB row. Deleting a row while ENV remains would permit bootstrap again; this phase offers an enabled switch rather than a deletion API.

The SQL migration assigns `microsoft` to existing OAuth accounts and pending authorizations, since Microsoft was the sole provider before this phase. It preserves all encrypted cache/verifier bytes, remote identity IDs, statuses and session binding. Existing connected accounts need no reconnect because of the migration. Manual password accounts retain a null OAuth provider ID. Existing `oauthCache` is the provider-owned encrypted payload; `oauthHomeAccountId` is retained for Microsoft compatibility and is not required by generic account storage for future providers. The Microsoft provider still requires and checks it internally.

Apply migrations before starting updated web/worker processes, preserving volumes, database and encryption keys. Keep the registered Microsoft client ID and APP_ORIGIN unchanged to test upgrade continuity. Deliberately replacing the application registration may require fresh consent; that is a configuration change rather than migration behavior.

## Contributor extension test

**If a contributor wanted to add another OAuth-based IMAP/SMTP provider, which core files would they need to change?**

- Add a provider implementation of `OAuthMailProvider`, including its remote identity checks, token lifecycle, opaque encrypted account state, metadata and mail defaults.
- Register it in `src/modules/accounts/infrastructure/oauth-composition.ts`. This is the single registration root for web and worker.
- Add its authenticated start/callback route files if it uses provider-specific routes. Preserve state/provider/session binding, trusted redirects and discovery scheduling.
- Add focused provider/configuration/security tests. The existing test-only provider demonstrates generic IMAP and SMTP credential resolution without changing synchronization code.

The generic configuration API/form already enumerates registered providers and supports client ID/secret/enabled. Add-account onboarding also enumerates registry metadata; account views and reconnect links use the registered provider name and authorization path. The conventional `/api/oauth/<id>/start` path remains a fallback for legacy/test views. A provider requiring extra nonstandard application settings would need additional validation and controls in `oauth-provider-configs.ts` / `oauth-provider-settings.tsx`; JSONB storage requires no migration. Google’s disabled coming-soon row would be removed from `settings-shell.tsx` when a real Google contribution is implemented. No fake production provider or plugin SDK exists.

Contributors should **not** normally modify `MessageService`, `DeltaSyncService`, `BackfillSyncService`, `MailboxDiscoveryService`, `OutgoingMessageService`, `MessageCommandService` or `ImapSmtpMailProvider` synchronization behavior. The intentional limitation is that authorization completion still owns account persistence, rather than introducing a new generic account provisioning subsystem.

## Manual upgrade smoke procedure

1. Start with an existing Phase 3F installation and a connected Microsoft account. Record last sync/send outcomes and keep the same database volumes, credentials encryption key ring, APP_ORIGIN and Microsoft registration.
2. Upgrade code and apply `pnpm db:migrate` using the existing ENV. Do **not** delete Docker volumes. Confirm migration and bootstrap complete.
3. Start the application and worker using the normal deployment workflow.
4. Open the existing Microsoft account. Verify status remains connected and new inbound messages/flag changes synchronize **without reconnecting**.
5. Send a message through its SMTP account, verify recipient delivery and the configured Sent-copy behavior.
6. Open Settings → Integrations → OAuth providers. Microsoft should be Configured after ENV bootstrap; client ID and trusted redirect URI are shown. The secret field must be empty and no API response may contain plaintext/ciphertext.
7. Save with a blank secret and verify Microsoft remains configured and synchronization/sending continue. Reload to verify the secret is still never rendered.
8. Connect another Microsoft account through Add account; then reconnect an existing account with the same identity. Try a different identity and verify rejection without replacing its cache.
9. Verify mailbox discovery and initial sync for the newly connected account. Check recent/delta sync, outgoing SMTP and manual IMAP/SMTP accounts, and existing Application logs.
10. If no ENV/database configuration exists, verify onboarding directs the owner to OAuth providers instead of starting OAuth. Google must still be disabled/Coming soon.

Automated regression uses mocked MSAL against real PostgreSQL and real authenticated API sessions. A live Microsoft tenant smoke run is still required to validate external consent/tenant policy and actual IMAP/SMTP connectivity; it cannot be claimed from mocked tests.

## Validation

Final validation on Node 24.19.0:

- Complete existing suite: `pnpm test --maxWorkers=4` — 66 files, 739 tests passed; concurrency bounded without excluding tests.
- Separate security integration suite: `pnpm test:security` — 2 files, 38 tests passed with real owner sessions and PostgreSQL.
- `pnpm test:security:browser` — passed using installed Edge; existing hostile-email and composer harness checks remain intact.
- `pnpm typecheck` — web and worker passed.
- `pnpm lint` — no errors; one pre-existing unused-import warning in the ignored local `.security-results/signature-settings-preview.mjs` preview artifact.
- `pnpm build` — Next.js production build and worker TypeScript/import-fix build passed. The process received `APP_ORIGIN=https://mail.example.com` because the local development HTTP origin is correctly rejected in production; local `.env` was not changed.
- Desktop (1280px) and narrow (390px) browser previews of the provider configuration form were inspected, including an empty secret field.

Coverage includes a real Phase 3F-to-3G.1 schema upgrade with preserved account cache and pending state, idempotent ENV bootstrap/DB precedence, encrypted write-only configuration, blank/replaced secrets, owner/Origin protection, registry rejection and a test-only alternative provider with no MSAL home account ID, one-connection token resolution, PKCE challenge/verifier matching, state expiry/session/single-use/provider binding, Microsoft account creation/reconnect identity checks, silent renewal/revocation, onboarding and Settings UI. Existing manual IMAP/SMTP, discovery, sync, sending and diagnostics regressions remain in the full suite.

Live Microsoft tenant/IMAP/SMTP smoke verification was not performed in this development environment. Follow the upgrade procedure above on an installation with an existing connected account.
