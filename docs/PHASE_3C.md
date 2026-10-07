# Phase 3C — Add Account Provider Flow

Implemented from Phase 3B HEAD `970f3216e7fa5326c4e8e35e1e5d73f5f5cf50ba`.

## Settings onboarding

The Accounts sidebar contains configured accounts and one **+ Add account** action. Provider selection lives exclusively in the existing right Settings pane. It shows a vertical list of Microsoft, Google and Other email rows at every viewport width. Google is disabled and marked **Coming soon**. Microsoft is visible but disabled with **Not configured** when the existing OAuth integration has no configuration.

Microsoft links to the existing `/api/oauth/microsoft/start` endpoint. The existing callback, session binding, state checks, authorization handling and encrypted OAuth cache remain in place. Successful connection requests mailbox discovery and returns to `/accounts?oauth=connected&account=<id>`, opening the connected account for normal Phase 3B management. OAuth errors return to Settings with the provider chooser and existing safe error messages.

Other email replaces the chooser with the IMAP/SMTP creation form in the same pane. Back returns to provider selection. Account name, sender name and email use `AccountIdentityFields`, shared with the General editor. IMAP/SMTP configuration uses the existing `AccountConnectionFields`, shared with the connection editor. Both forms now use `accountConnectionPayload`; the existing create/update schemas and account services continue to validate their submissions. Create requires credentials, while blank edit passwords preserve stored credentials. SMTP can reuse IMAP credentials or collect its own username/password. The existing Sent-copy policy control is retained.

Creation and connection testing continue through `POST /api/accounts` and `POST /api/accounts/test`. Testing does not save an account. Successful creation immediately adds the safe returned account view to the sidebar, selects its General tab, replaces the URL with `/accounts?account=<id>` and refreshes server data. Once refreshed data includes the account, the temporary view is cleared so later deletion cannot restore it. Connection fields never initialize with plaintext stored passwords.

Onboarding participates in Phase 3B's dirty/busy navigation protection. Back, section/account changes, links, browser history and unload protect edited values; pending requests disable fields and navigation. Network failures show a generic message, retain entered values and restore controls for retry.

## Legacy entry points and preserved boundaries

`/accounts/new` remains an authenticated compatibility redirect to `/accounts?add=1`; it renders no standalone form. The empty Mail view and retained legacy account-list component link directly to Settings onboarding. The account-list component no longer offers a separate Microsoft connection action. Account creation navigation always starts with provider selection.

No Google OAuth, database migration, new authentication flow or credential storage mechanism was introduced. Owner access, mutation Origin/CSRF checks, encrypted credentials and OAuth security boundaries remain in the existing infrastructure. Phase 3B account tabs, signatures, folder mappings, privacy preferences, Compose, Mail and synchronization retain their existing behavior.

## Verification

- `pnpm test`: **59 files / 632 tests passed**, including existing PostgreSQL integration coverage, encrypted credential storage and account isolation.
- Focused UI coverage verifies the Accounts rail, one Add action, same-pane provider selection and manual form, disabled Google, existing Microsoft start URL, Back/dirty protection, shared create/edit fields, connection testing, successful creation selecting the new account, blank edit passwords and sanitized network failures.
- Focused route tests verify the authenticated compatibility redirect, session-bound Microsoft start/callback and selected account redirect, owner/Origin guards, sanitized creation failures, shared form infrastructure and vertical CSS.
- `pnpm test:security`: **2 files / 35 tests passed**.
- `pnpm test:security:browser`: passed, including reader isolation and zero third-party Compose requests.
- `pnpm typecheck`, `pnpm lint`, application/worker `pnpm build`, targeted Prettier and `git diff --check`: passed. Lint retains the pre-existing unused-import warning in `.security-results/signature-settings-preview.mjs`.
- Browser fixture using the actual Settings components and production CSS verified vertical rows at 1440×960, 1000×760 and 600×760, light/dark themes, no horizontal page overflow, same-pane form/Back navigation and dirty protection. No browser runtime errors occurred. Screenshots and the local fixture helper are under ignored `.security-results/phase3c-*`.

Build verification used a process-only HTTPS `APP_ORIGIN` override without editing local configuration. Live Microsoft authorization and external IMAP/SMTP servers were not exercised; provider and browser fixtures plus existing service integration tests supply automated coverage.
