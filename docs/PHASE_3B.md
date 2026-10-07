# Phase 3B — Settings & Account Management

Implemented from Phase 3A HEAD `7be5a2d60df030f2f6477ae4ba1b017ca61f4e4d`.

## Settings workspace

`/accounts` now opens a desktop Settings workspace with a persistent, independently scrolling navigation rail and a single settings pane. General contains Appearance and Mail; Accounts lists configured accounts and the existing Add account and Microsoft connection links; Compose contains Signatures; Privacy contains Remote images. Forms use section dividers and aligned fields rather than an account dashboard. Existing edit URLs redirect to the selected account in Settings (`/accounts?account=<id>`).

Appearance reuses the device's existing theme preference. Mail reuses the existing Conversation view toggle. Signatures reuses Phase 2K's editor, resources, revisions and management APIs. Remote images reuses exact-address trust management and its existing privacy policy. Immediate preferences retain immediate saving; account forms explicitly expose Save, Discard changes and dirty state.

Each account has General, IMAP and Diagnostics tabs. Changing tabs retains mounted forms and their edited values. Switching accounts or sections, following links, reloading, closing the page or navigating browser history protects unsaved edits. Active saves prevent navigation and destructive actions. The signature editor participates in the same protection, including in-progress image uploads. Disable and Delete are separated from ordinary configuration; deletion still requires explicit confirmation.

## Account identity and migration

`displayName` remains the local account label. New persisted `senderDisplayName` supplies the human name in outgoing From headers. General exposes Account name, Your name and Email address separately. Sender names are bounded and reject header control characters. An empty sender name is supported for address-only mail.

Migration `0022_boring_venom.sql` adds `sender_display_name` and copies each existing account's `display_name`, preserving existing From behavior for both password and OAuth accounts. Existing clients that omit the new field on create retain the old initial behavior; updates that omit it retain the persisted sender name. New Microsoft accounts initialize both labels from the provider profile. Reconnection preserves user-edited local and sender labels while refreshing provider email/authentication.

The existing durable outgoing service now reads `senderDisplayName` when creating its immutable sender/MIME snapshot. There is no additional send path. Previously persisted outgoing MIME is unchanged. For example, local label `DPoczta`, sender `Mateusz Kiliński`, and email `hello@mkilinski.dev` produce `From: Mateusz Kiliński <hello@mkilinski.dev>`.

Apply the forward migration through the existing `pnpm db:migrate` deployment workflow before running the updated application or worker.

## General and connection configuration

General saves identity, changed Sent/Drafts/Archive/Junk/Trash mappings and New/Reply/Forward signature defaults in one PostgreSQL transaction through `PUT /api/accounts/:id/settings`. It reuses the mailbox-role and signature services, their validation, discovery locking and account-scoped folder checks. Failed folder/signature validation rolls back the complete edit. Automatic folder selection clears manual overrides and restores existing special-use detection. Only active selectable folders from the selected account appear as choices; unavailable mappings remain visible.

Password accounts use `AccountConnectionFields`, shared with the existing Add Account form, for supported IMAP/SMTP hosts, ports, TLS or required STARTTLS, usernames and replacement passwords. Blank edit passwords preserve encrypted credentials. The existing account service handles updates, credential validation, encryption and connection testing; passwords and OAuth caches/tokens are never serialized into Settings. Tests can use unsaved connection settings without persisting them.

Microsoft accounts show provider, OAuth state, identity, reconnect and existing test controls instead of password fields. Their email is provider-managed and read-only; server validation also rejects edits to that identity. The existing Sent-copy policy remains available for both password and OAuth accounts.

## Diagnostics

Diagnostics leads with provider, enabled state, connection status, successful test/discovery/sync timestamps, capabilities and errors. Each mailbox shows recent sync, delta sync and historical backfill state. Protocol paths, special-use flags, delimiters, UID metadata and existing message inspection remain available in a secondary disclosure. Running discovery/sync refreshes the pane while no edits or account actions are active. All data comes from existing safe account/mailbox views; no credential/token details are added.

## Verification

- `pnpm test`: **58 files / 621 tests passed**, including PostgreSQL migrations, account isolation, atomic rollback, folder mappings, signature defaults, encrypted credentials, OAuth identity restrictions and outgoing MIME From headers.
- Focused UI tests cover grouped Settings navigation, account switching, three tabs, separate identity fields, credential replacement, OAuth presentation, retained edits, section/link/browser-history protection and signature editing. Existing preference, signature, remote-content and mail-shell regressions remain in the full suite.
- New settings API tests verify owner/mutation guards, account ID validation and sanitized failure responses.
- `pnpm test:security`: **2 files / 35 tests passed**. `pnpm test:security:browser`: passed, including Compose/reader isolation and zero third-party Compose requests.
- `pnpm typecheck`, `pnpm lint`, application/worker `pnpm build`, targeted Prettier and `git diff --check`: passed. Lint retains the existing unused-import warning in the ignored `.security-results/signature-settings-preview.mjs` helper.
- Actual Settings components previewed with compiled CSS at 1440×960 and 1000×760, in light/dark themes, with General, IMAP, Diagnostics and Microsoft OAuth views. Dirty navigation and narrow layout checks passed with no browser runtime errors. Screenshots and the local fixture helper are under ignored `.security-results/phase3b-*`.

Build verification used a process-only HTTPS `APP_ORIGIN` override; local configuration was not edited. Provider delivery and live Microsoft authorization were not exercised: verification uses PostgreSQL containers and local provider/browser fixtures. Phase 3C onboarding, Compose, MessageReader and the Phase 3A mail shell are unchanged.
