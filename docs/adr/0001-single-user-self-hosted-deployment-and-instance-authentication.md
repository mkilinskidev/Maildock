# ADR 0001: Single-user self-hosted deployment and instance authentication

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

Maildock V1 is intended for an owner who deploys one self-hosted instance and connects any number of that owner's email accounts. Earlier architecture wording left room for multi-user ownership, per-user visibility, and a still-undecided authentication model. That ambiguity would add tenant and authorization complexity without serving the V1 product, while an unauthenticated application would be unsafe on a public VPS.

Authentication therefore needs to protect the entire instance without becoming ownership metadata in the mail domain. First-run provisioning also needs to avoid becoming a permanent public registration mechanism.

## Decision

One Maildock installation has exactly one instance owner and unlimited configured mail accounts. V1 has no public registration, multiple Maildock users, organizations, tenants, roles, RBAC, or per-user mail visibility. Mail records have no `user_id`; their `account_id` relationships preserve remote-provider identity and data integrity, not Maildock-user ownership.

An uninitialized instance provides a narrowly scoped setup flow that atomically creates the owner's username and Argon2id password hash and marks the instance initialized. Once initialization succeeds, that flow is closed during normal operation and cannot create another owner. There is no public `/register` equivalent.

After initialization, every endpoint is protected by default except the minimum login and liveness/readiness endpoints. The setup endpoint remains reachable only as needed to report that setup is unavailable. Account, mailbox, message, search, attachment, inline-CID, and mutation endpoints all require an authenticated instance session. Knowledge of a local identifier never grants access.

V1 uses a secure server-side session model with an opaque session ID in a cookie. The cookie is `HttpOnly`, `Secure` in production, and uses an appropriate `SameSite` policy. Sessions have bounded idle and absolute lifetimes, support server-side revocation, and rotate their identifier after authentication and any future authenticator change. State-changing requests use CSRF protection appropriate to the session mechanism and strict `Origin` validation against the configured canonical origin. Login is rate-limited and protected with progressive backoff against brute force.

The authentication boundary exposes a clean extension point for optional TOTP two-factor authentication later, but TOTP and a general IAM system are not part of the first MVP. The exact session library, cookie values, lifetimes, reset/recovery procedure, proxy-trust configuration, throttling parameters, and TOTP implementation remain Phase 0 or later decisions subject to security review.

## Alternatives considered

- **Unauthenticated single-user deployment:** rejected because Maildock must be safe to expose through HTTPS on a public VPS and contains sensitive mail and provider credentials.
- **Multi-user schema and authorization prepared in advance:** rejected because it adds tenant ownership, row scoping, registration, recovery, and role complexity that the V1 product does not require.
- **External identity provider or full IAM subsystem:** rejected as a mandatory dependency because it conflicts with the simple two-service self-hosted baseline. It may be reconsidered as an optional deployment integration later.
- **HTTP basic authentication at the reverse proxy only:** rejected as the application security model because endpoint protection would depend on optional deployment infrastructure and would not provide the required application session, CSRF, rotation, and future TOTP seam.

## Consequences

- The mail-domain model stays instance-wide and contains no Maildock-user ownership fields.
- Route handlers and server actions still enforce authenticated access by default; single-user never means authorization-free.
- First-run initialization becomes a security-sensitive, atomic, one-time state transition and must be safe under concurrent requests.
- Production requires correct canonical-origin, TLS/proxy, cookie, session-secret, and rate-limit configuration.
- Account filters and foreign keys remain important for provider identity and data integrity but do not express per-user visibility.
- Adding multiple Maildock users later would be a product and architecture change requiring a new ADR and data-model redesign.
- Optional TOTP can be added behind the authentication boundary without changing mail ownership.
