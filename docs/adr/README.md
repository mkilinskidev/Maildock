# Architecture Decision Records

Use an ADR for a decision that changes or resolves an architectural constraint listed in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Name records sequentially: `0001-short-decision-title.md`, `0002-next-decision.md`, and so on. Do not reuse a number. Accepted records are immutable except for typo/link fixes; supersede a decision with a new ADR and cross-link both records.

## Index

- [ADR 0001: Single-user self-hosted deployment and instance authentication](0001-single-user-self-hosted-deployment-and-instance-authentication.md)
- [ADR 0002: Node.js, TypeScript, Next.js, React, and pnpm runtime stack](0002-node-typescript-nextjs-runtime-stack.md)
- [ADR 0003: PostgreSQL persistence with Drizzle](0003-postgresql-persistence-with-drizzle.md)
- [ADR 0004: PostgreSQL background jobs with pg-boss](0004-postgresql-background-jobs-with-pg-boss.md)
- [ADR 0005: Mail protocol and MIME libraries](0005-mail-protocol-and-mime-libraries.md)
- [ADR 0006: Better Auth single-owner implementation](0006-better-auth-single-owner-implementation.md)
- [ADR 0007: Untrusted email HTML isolation](0007-untrusted-email-html-isolation.md)
- [ADR 0008: Initial synchronization and mail storage policy](0008-initial-sync-and-mail-storage-policy.md)

## Template

```md
# ADR NNNN: Decision title

- Status: proposed | accepted | superseded
- Date: YYYY-MM-DD
- Supersedes: none
- Superseded by: none

## Context

What problem or constraint requires a decision?

## Decision

What was chosen?

## Alternatives considered

What viable alternatives were evaluated and why were they not selected?

## Consequences

What becomes easier, harder, required, or prohibited because of this decision?
```
