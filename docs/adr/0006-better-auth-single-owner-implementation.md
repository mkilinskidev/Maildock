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
