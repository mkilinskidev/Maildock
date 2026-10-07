# ADR 0010: Mandatory MFA and recovery-aware owner authentication

- Status: accepted
- Date: 2026-10-07
- Supersedes: ADR 0001 authentication-factor scope; ADR 0006 deferred-MFA/recovery scope
- Superseded by: none

## Context

The original single-owner decisions intentionally deferred TOTP and administrative recovery. Security review established that password-only access is not an acceptable V1 boundary for an Internet-reachable mailbox application and that backup restore can revive authentication state.

## Decision

Retain the immutable single-owner and Better Auth foundation, but require verified TOTP MFA before normal business access and worker readiness. Recovery codes are supported. Authenticator replacement remains guarded and cannot silently weaken MFA.

First-run setup still requires the independent bootstrap secret and closes after initialization. The bootstrap secret cannot reset or replace an owner.

Backup restore is an authentication rollback event. Before reopening a restored instance, offline recovery maintenance invalidates restored sessions and transient authorization state and replaces recovery codes. Interrupted authenticator replacement requires proof of the immutable owner's password plus the pending TOTP; there is no password-only, bootstrap or second-owner recovery bypass.

## Consequences

V1 has no supported password-only production mode. Operators must retain TOTP/recovery material and the matched cryptographic recovery set. Restored HTTP readiness alone is insufficient evidence that authentication state is safe.
