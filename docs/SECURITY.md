# Security model

## Host-administrator owner recovery

Host/container administrative access is equivalent to break-glass authority over the Maildock owner. Application database-role access or its connection credentials also lies outside browser authentication protection. Only an interactive container CLI starts owner recovery: no HTTP endpoint resets the password or reclaims the owner through `/setup`.

The transaction uses the shared auth advisory lock (`1296125023`) and READ COMMITTED isolation. It preserves immutable identity/binding, replaces password/factor material, revokes sessions and verification challenges, clears replacement/bootstrap proof, and persists `owner_recovery`. Ambiguous/corrupt states are refused. `AUTH_SECRET` and credential-encryption keys are never rotated by this operation.

While pending, business readiness and normal sessions are denied. Correct new credentials issue a random ten-minute enrollment token, stored only as SHA-256 digest. Its HttpOnly, SameSite=Strict cookie is Secure in production. This is not a persistent recovery secret. Re-login, cancel, completion, offline maintenance and explicit administrator restart invalidate prior browser authority. The pending marker survives expiry/restart. TOTP and encrypted recovery codes use installed Better Auth-compatible primitives; codes are withheld until verification commits. Completion requires fresh password-plus-MFA login.

Global work limits, password backoff, shared proof budgets and per-ceremony TOTP limits apply. Sensitive responses are no-store, QR is rendered locally, and secrets stay out of URLs, logs and browser persistence. Fixed security events record start, restart and completion. The CLI does not echo passwords; terminal recording and access to process memory remain administrator responsibilities.

Already-authorized in-flight operations may finish; recovery does not reverse provider-side effects. Database backup rollback may revive earlier auth and always requires separate offline restore maintenance. See [Installation](INSTALLATION.md#break-glass-owner-recovery) and [Backup & recovery](BACKUP_AND_RECOVERY.md).

Maildock is a single-owner application with access to sensitive mail and sending authority. Security is therefore part of the product architecture, not an optional deployment mode.

## Authentication

One installation has one immutable owner. There is no public registration. First-run creation requires an automatically generated temporary setup secret from the app container logs and closes after initialization. Passwords use Argon2id. TOTP MFA is mandatory before normal business access; recovery codes are supported. Sessions have persistent lifetime/revocation checks, and logout requires confirmed server-side revocation.

There is no email-based forgotten-owner-password reset and the bootstrap secret cannot replace an existing owner.

## Request and deployment boundaries

State-changing owner APIs enforce authenticated owner access and the canonical Origin/CSRF boundary. Authentication admission controls are persisted in PostgreSQL and do not trust forwarded client-IP headers as identity.

Production requires HTTPS at the exact `APP_ORIGIN`, no alternate untrusted raw HTTP route to the app, private PostgreSQL, protected configuration/secrets, reasonable edge limits and bounded log retention. The base Compose file publishes neither service.

## Database and secrets

Normal runtime uses an ordinary PostgreSQL application owner rather than a cluster administrator. Startup/migration/recovery roots validate expected authority.

Mail passwords, OAuth provider secrets and durable OAuth authorization state are encrypted with AES-256-GCM using an external key ring. Required encryption keys and `AUTH_SECRET` are part of the recovery set and must never be committed or logged. `AUTH_SECRET` protects Better Auth authentication/MFA cryptographic state; it is distinct from the AES-256-GCM key protecting saved mail credentials and from the temporary generated setup secret. Keep it stable and backed up: changing it is not a supported MFA reset or session-revocation procedure. See [Configuration](CONFIGURATION.md#authentication-secret-auth_secret).

## Untrusted mail

Received HTML is sanitized server-side and rendered in a sandboxed iframe with CSP. Remote images are blocked by default. Message bodies, request bodies and attachments are bounded; verified blob reads use stored metadata where required.

## Remote effects and recovery

SMTP/IMAP cannot provide universal exactly-once semantics. Maildock records uncertain outcomes instead of blindly retrying them.

A database restore can revive old sessions, recovery codes and queued remote work. Supported restore therefore requires offline security maintenance before reopening the instance: restored sessions/transient authorization state are invalidated, recovery codes are rotated and uncertain provider-side work is fenced. See [Backup & recovery](BACKUP_AND_RECOVERY.md).

## Diagnostics

Operational logs are structured. Sensitive boundaries use fixed/allowlisted diagnostics rather than arbitrary dependency error objects. Do not log mail bodies, passwords, OAuth codes/tokens, TOTP material, recovery codes, database URLs or encryption keys.

## Validation status

The initial white-box review produced twelve finding groups and all remediation items from that pass are closed in the current codebase. Dedicated security regression tests remain in `tests/security`.

This is not yet final V1 security sign-off. A second review of the remediated system, dependency/container/deployment checks and staging black-box validation remain release-gate work. Historical finding reports are available through Git history rather than the current operator documentation.

Bootstrap coordination uses the singleton `instance_state` row: only a SHA-256 digest and lease expiry are persisted. Web processes serialize issuance/renewal using a row lock and PostgreSQL time. Setup rechecks the credential under the same lock before creating the owner and stops credential rotation in the owner transaction; verified initial MFA clears the remaining digest in its completion transaction. Plaintext appears only in the deliberate bootstrap log message.
