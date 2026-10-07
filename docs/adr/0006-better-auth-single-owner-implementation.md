# ADR 0006: Better Auth single-owner implementation

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

ADR 0001 requires exactly one instance owner, atomic first-run provisioning, no public registration, server-side opaque sessions, Argon2id, origin/CSRF protection, throttling, and a future TOTP seam. Better Auth 1.7.5 supports Next.js 16, Drizzle 0.45, PostgreSQL sessions, username authentication, custom password hashing, trusted origins, database rate limiting, and a two-factor plugin seam.

Better Auth requires an email field internally even for username login. Its normal signup operation also cannot atomically update Maildock's singleton initialization row as one application transaction.

## Decision

Use Better Auth 1.7.5 as authentication infrastructure with its username plugin and Drizzle adapter. Use `@node-rs/argon2` 2.2.1 with Argon2id (64 MiB memory, three iterations, four lanes, 32-byte output).

First-run setup is a Maildock-owned endpoint, not Better Auth signup. It takes a PostgreSQL transaction-scoped advisory lock, locks the singleton `instance_state` row, inserts exactly one Better Auth user and credential account, and marks the instance initialized in the same transaction. The internal non-routable email `owner@localhost.invalid` satisfies Better Auth's infrastructure schema and is never a mail-domain identity.

The singleton persists `owner_user_id`, referencing Better Auth's immutable `user.id` with restrictive deletion and update semantics. Provisioning writes the user, credential account, owner reference and initialization timestamp atomically. A check constraint requires either an uninitialized row without a binding or an initialized row with a nonempty binding. Setup only writes a binding when both fields are null; no application operation replaces it.

Maildock's central `getValidSession()` requires a valid Better Auth session within the F5 lifetime policy, an initialized singleton, an existing referenced user and an exact match between the session user ID and `owner_user_id`. This applies to protected APIs, page/proxy checks, Google and Microsoft OAuth, and current-session logout. A legitimate non-owner Better Auth session receives unauthorized responses or login redirects; non-owner logout returns 401 and cannot revoke an owner's session. Public Better Auth login and session lookup remain authentication protocol boundaries and do not confer Maildock business access.

Migration `0028_owner_binding` must run through the transactional Drizzle migrator before starting the updated application. It locks the legacy auth tables and backfills only an initialized database with exactly one user consistent with the previous provisioning contract: UUID v4, canonical username, verified internal email, matching creation timestamps, exactly one matching Argon2id credential account, and persisted password metadata. These checks validate the sole legacy candidate; usernames and email never determine runtime ownership. A clean uninitialized database with no auth users/accounts remains unbound. Missing singleton state, initialized state with zero or multiple users, uninitialized state containing auth users, or inconsistent provisioning evidence abort the migration with a fixed F10 error and roll back its schema changes and journal entry. No users are deleted and setup is never reopened for recovery. An updated application against a failed/unapplied migration cannot authorize business sessions because the required binding column is absent.

After migration, missing, malformed, dangling or uninitialized bindings fail closed. Setup also stays closed when a singleton is absent, a binding exists, or unexpected auth users remain in an otherwise uninitialized instance. Deleting the owner fails at the foreign key; additional users do not change ownership. An operator who bypasses integrity constraints must resolve the inconsistency explicitly; Maildock never infers a replacement owner. Database administrators retain control of the database, so the invariant is immutable through normal application behavior rather than protected by ownership-change triggers.

Better Auth signup is disabled and signup routes are blocked. The exposed auth surface is limited to username login, logout, and session lookup. Login uses database-backed Better Auth rate limits plus bounded exponential per-username backoff. Sessions remain database-backed with cookie caching disabled, a 12-hour sliding idle expiry, and a separately enforced 30-day absolute expiry. Cookies are HttpOnly, SameSite=Lax, and Secure in production. The canonical origin is the only trusted origin.

No password reset or recovery flow is provided in Phase 0. Recovery requires an explicit, documented administrative procedure in a future decision. TOTP is deferred, with Better Auth's plugin boundary retained.

## Alternatives considered

- A custom session framework: rejected because Better Auth satisfies the required foundation with less bespoke security code.
- Better Auth public signup followed by closing registration: rejected because owner creation and instance initialization would not share the required atomic transition.
- Email-based owner UX: rejected because the product requires username/password UX and has no transactional email dependency.

## Consequences

- Better Auth's user/account/session tables are authentication infrastructure only and must never introduce `user_id` into mail-domain tables.
- Changes to Better Auth schema or credential-account conventions require migration review because setup writes those foundation rows transactionally.
- Losing the password currently requires an operator-managed recovery procedure; the README states this limitation plainly.
