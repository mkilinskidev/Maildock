# Architecture Decision Records

ADRs preserve durable architectural decisions. Accepted records are immutable except for typo/link fixes; when implementation/security review changes a decision, add a new ADR and mark the old record superseded.

## Index

- [ADR 0001: Single-user self-hosted deployment and instance authentication](0001-single-user-self-hosted-deployment-and-instance-authentication.md) — superseded in authentication-factor scope by ADR 0010
- [ADR 0002: Node.js, TypeScript, Next.js, React, and pnpm runtime stack](0002-node-typescript-nextjs-runtime-stack.md)
- [ADR 0003: PostgreSQL persistence with Drizzle](0003-postgresql-persistence-with-drizzle.md)
- [ADR 0004: PostgreSQL background jobs with pg-boss](0004-postgresql-background-jobs-with-pg-boss.md)
- [ADR 0005: Mail protocol and MIME libraries](0005-mail-protocol-and-mime-libraries.md)
- [ADR 0006: Better Auth single-owner implementation](0006-better-auth-single-owner-implementation.md) — superseded in deferred-MFA/recovery scope by ADR 0010
- [ADR 0007: Untrusted email HTML isolation](0007-untrusted-email-html-isolation.md)
- [ADR 0008: Initial synchronization and mail storage policy](0008-initial-sync-and-mail-storage-policy.md) — raw-MIME retention decision superseded by ADR 0011
- [ADR 0009: Application-level mail credential encryption](0009-application-level-mail-credential-encryption.md)
- [ADR 0010: Mandatory MFA and recovery-aware owner authentication](0010-mandatory-mfa-and-recovery-aware-owner-authentication.md)
- [ADR 0011: Progressive mail storage without retained incoming raw MIME](0011-progressive-mail-storage-without-retained-incoming-raw-mime.md)
- [ADR 0012: Native Gmail receiving transport on fresh installations](0012-native-gmail-receive-transport.md) — proposed; P0 review required
- [ADR 0013: Native Gmail identity and label memberships in shared tables](0013-gmail-message-identity-and-label-membership.md) — proposed; P0 review required
- [ADR 0014: Account-wide Gmail checkpoints and progressive synchronization](0014-gmail-account-history-and-progressive-sync.md) — proposed; P0 review required
- [ADR 0015: SMTP-first sending, native Gmail Sent and local drafts](0015-gmail-smtp-first-and-local-drafts.md) — proposed; Sent preference decision open

The proposed Gmail ADRs are governed by [Phase P0: fresh-install architecture](../architecture/gmail-api-p0-fresh-install.md). They supersede the original audit's legacy migration recommendations, but do not change accepted ADR status or authorize implementation before P0 review.

Use an ADR for a future decision that changes an architectural constraint in [Architecture](../ARCHITECTURE.md). Name records sequentially and never reuse a number.
