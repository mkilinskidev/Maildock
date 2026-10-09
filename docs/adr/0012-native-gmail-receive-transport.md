# ADR 0012: Native Gmail receiving transport on fresh installations

- Status: proposed — awaiting P0 review
- Date: 2026-10-09
- Supersedes: original Gmail audit migration/activation/rollback recommendations; proposes replacing ADR 0005 Google receiving protocol choice only
- Superseded by: none

## Context

The owner will initialize a fresh Maildock database after native receiving is ready. The current `test` application routes all accounts through an IMAP/SMTP provider and already supplies Google OAuth configuration/refresh. The PoC shows bounded Gmail reads but is not a production provider. Generic IMAP and the `test` reliability hotfix must remain.

## Decision

Create Google OAuth accounts as `gmail_smtp`: Gmail REST receives/synchronizes/content-fetches/mutates, and existing SMTP sends. Other OAuth/password providers retain `imap_smtp`. Google OAuth identity and persisted transport select the receiver; there is no domain inference or manual selector. New Google accounts use REST immediately, with no Gmail-over-IMAP fallback when the API is unavailable.

Reuse the existing Google Settings Client ID/Secret, tile, routes, encrypted refresh tokens, subject validation and scope set. Enabling Gmail API in that same Cloud project is a future operator prerequisite. No separate credentials or setup screen is introduced.

Keep mailbox-oriented IMAP contracts rather than implementing them with fake Gmail UIDs. Add native account synchronization and discriminated content/attachment/mutation contracts, shared router/capabilities and existing storage projectors. Wire both web account assembly and worker root; route every producer and validate every consumer. Google must be excluded from mailbox IMAP polling, backfill and IDLE, including retries.

Preserve the `test` UI/DTO/endpoints/security baseline. Internal capability/readiness changes may support the same controls. Visible differences are restricted to Gmail labels/folders, API connection details and sync diagnostics. Retain generic UID/epoch/STATUS/lifecycle fixes, content generations, Google token rotation and dependency patches.

No legacy data conversion, shadow mode, aliases, per-account transport switch/rollback, rollout cohort or old Gmail record support is part of this architecture. Application revision fencing remains for ordinary reconnect/disable/config races, not migration.

## Consequences and review gates

REST API failure becomes a Google readiness/sync error, not an IMAP receiver. Password accounts aimed at Gmail remain ordinary IMAP accounts. The design adds one receive adapter and native orchestrator, not a new mail storage or auth system. Future implementation needs targeted changes across roots/services, not a broad module rewrite.

P0 review must approve the concrete model and native folder/Sent policies. API enablement, effective grant/admin policy and quotas require authorized staging validation later. This proposed ADR does not mark accepted ADR 0005 superseded before review.

Details: [P0 architecture](../architecture/gmail-api-p0-fresh-install.md), [roadmap](../architecture/gmail-api-p0-roadmap.md). Protocol basis: [Google history API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).
