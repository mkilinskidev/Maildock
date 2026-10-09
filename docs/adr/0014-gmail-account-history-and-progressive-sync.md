# ADR 0014: Account-wide Gmail checkpoints and progressive synchronization

- Status: proposed — awaiting P0 review
- Date: 2026-10-09
- Supersedes: original Gmail audit shadow/cutover synchronization; proposes replacing mailbox-specific Gmail synchronization in ADR 0008
- Superseded by: none

## Context

Gmail history is account-wide and expires; mailbox pagination is not an atomic snapshot. pg-boss may redeliver work and workers may die between remote fetch, database commit and queue acknowledgement. Maildock already separates recent metadata, older backfill and lazy content.

## Decision

Persist one account checkpoint as decimal text, alongside separate bootstrap/inventory/history run and page progress. Capture baseline before enumeration, publish recent metadata first, and run low-priority historical metadata backfill. Keep existing configurable recent window and ADR 0011 lazy body/attachment storage. Account history is serviced between bounded backfill slices, not deferred until the full import finishes.

Stage page IDs and cursor changes in the same database transaction using bounded `gmail_sync_work`; idempotently upsert native messages/current full label state. For history, use no label/type filter and never advance the committed checkpoint until all pages and affected IDs are durably resolved. The final completed history response supplies the candidate head; a later profile head cannot substitute for it. Atomic CAS checks run/revision/expected checkpoint and no pending work. A crash resumes/replays; queue acknowledgement is not authority.

Serialize sync projection and remote commands with an account advisory lock on a reserved connection, using that connection for guarded transactions. Lock-session loss invalidates publication. Resolve/refresh credentials outside that reservation, then revalidate account/run. No HTTP-spanning DB transaction or nested pool checkout. Content/attachment publication retains existing request/attempt/account fences.

Order durable user intents per logical message across labels and retain optimistic overlays over confirmed history state. Per-message observed-history guards prevent stale metadata publication. Long quota waits release account/DB resources and persist retry deadlines; shared account/project budgeting and fairness prioritize live sync/content/commands over import.

Expired-history 404 starts complete **native** ID/label re-enumeration with a new baseline, preserving UUIDs/caches/blobs. Confirm unseen old IDs before retiring projections, replay new history and record incomplete coverage until repair finishes. Exact-message 404 is distinct from credential/network failure and history expiration. Never clear the DB or redownload all bodies to recover.

## Consequences and review gates

Only two native operational tables are needed; there is no shadow sync or legacy reconciliation. Native history repair is required even on a fresh installation. Repair pollers and needs-work state close enqueue/crash gaps, while conditional identity constraints enforce replay safety.

Future validation must cover page/item/commit/ACK interruption, duplicate workers, lock-session loss, pool=1, token expiration, concurrent commands and history expiration. Recent-first results cannot imply complete local search/count coverage. Pub/Sub is optional future work, not a release prerequisite.

Details: [P0 synchronization protocol](../architecture/gmail-api-p0-fresh-install.md#progressive-synchronization-and-checkpoint-protocol), [acceptance](../architecture/gmail-api-p0-roadmap.md). Protocol basis: [history contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [sync guidance](https://developers.google.com/workspace/gmail/api/guides/sync).
