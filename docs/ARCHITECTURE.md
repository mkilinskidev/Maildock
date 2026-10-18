# Maildock architecture

Maildock is a single-owner, self-hosted web mail application. One installation has one immutable owner and any number of configured mail accounts. It is a modular TypeScript monolith with separate web and worker composition roots, deployed by default as one application container plus PostgreSQL.

Architecture Decision Records in [`docs/adr`](adr/README.md) capture durable choices. This document describes the current product, not the order in which features were implemented.

## System context

```text
Browser
   |
 HTTPS
   v
operator ingress / reverse proxy
   |
   v
Maildock application
  - Next.js UI and API
  - application/domain modules
  - web composition root
  - worker composition root
  - IMAP/SMTP adapters
  - pg-boss jobs
   |             |
   |             +---- IMAP / SMTP / OAuth providers
   |
   +---- PostgreSQL
   |
   +---- persistent blob/attachment storage
```

The PostgreSQL 18 service bundled with Maildock's official Docker Compose stack is mandatory infrastructure and part of the application security boundary. External, managed, shared, or independently provisioned PostgreSQL is explicitly unsupported: Maildock owns its database roles, ownership, authority hardening, migrations, pg-boss state, and recovery invariants. Redis, Elasticsearch, external queues and object storage are not required.

## Product boundary

Maildock is not a multi-user SaaS product. There are no organizations, tenants, roles, RBAC or per-user mail ownership columns. Authentication protects the whole instance.

Mail transport is IMAP + SMTP. Microsoft and Google OAuth provide credentials to that same mail pipeline; Maildock does not use Microsoft Graph or Gmail API mail endpoints.

Remote mail remains authoritative. PostgreSQL is a durable synchronized read model plus local operational state.

## Identity and persistence

Local UUIDs are stable application identity. Remote identifiers are stored separately.

- IMAP UID is scoped to `(account, mailbox, UIDVALIDITY)`.
- Sequence numbers are connection-local and never persisted as identity.
- UIDVALIDITY changes trigger controlled reconciliation.
- RFC `Message-ID` is optional, non-unique and untrusted.
- Account boundaries are mandatory; cross-account heuristic merging is prohibited.

PostgreSQL stores owner/auth state, encrypted account/provider configuration, mailboxes/messages/placements/content, sync checkpoints, drafts, conversations, signatures/preferences, outgoing state, remote commands, blob metadata, search data, diagnostics and pg-boss state. Binary attachment/MIME objects live in persistent blob storage.

Database + blob storage + cryptographic keys form one recovery boundary.

## Synchronization

Ordinary UI reads use PostgreSQL, not live IMAP. Remote mail stays authoritative; synchronization keeps the read model current.

Durable job payloads carry local IDs only, and handlers reload authoritative state before any remote work. CONDSTORE/QRESYNC are used where available. Mailbox synchronization consists of:

| Job                 | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| Mailbox discovery   | Lists folders, then requests initial synchronization (Inbox first).     |
| Recent sync         | Fetches metadata for the initial window (`MAILDOCK_INITIAL_SYNC_DAYS`). |
| Delta sync          | Picks up new messages, flag changes and removals after the recent sync. |
| Historical backfill | Walks older UIDs downwards in bounded, checkpointed ranges.             |

Message content and attachment binaries are fetched on demand by separate jobs. User actions run as durable message commands.

### Scheduling and priority

The priority policy governs **admission and scheduling**. It is not a total global execution order: running work is never reordered, and concurrent producers can occasionally admit work in a different order than the policy suggests.

Within one account, in decreasing precedence:

1. User message commands on the same mailbox.
2. Interactive content, attachment and inline-image (CID) fetches. Only historical backfill defers to these; recent and delta sync do not.
3. Inbox recent and delta sync.
4. Other mailboxes' recent and delta sync.
5. Inbox historical sync.
6. Other mailboxes' historical sync.

Accounts never block each other. The Inbox is identified only by the stored canonical path (`upper(remote_path) = 'INBOX'`), never by display name or discovery order.

Precedence is implemented in two separate mechanisms:

- **pg-boss `priority`** (Inbox fresh 20, other fresh 10, Inbox history −5, other history −10) orders jobs only **within one queue**. It does not rank a recent job against a delta, backfill, command or content job.
- **An admission gate** is evaluated before the mailbox lock and again under it; backfill also evaluates it between sub-ranges. A job that must yield commits one delayed successor (5 s for recent/delta, 10 s for history) and finishes without touching IMAP.

The gate is account-scoped and does not let stuck work block everything else. A job that has been ready but unclaimed for 120 s, a pending command older than 10 minutes, and an active job older than the 15-minute queue expiry no longer hold back lower tiers. Mailboxes that are missing or not selectable are ignored. Historical sync may therefore wait for as long as higher-priority work keeps arriving.

Recent, delta, backfill and message-command work on one mailbox is serialized by a session-level PostgreSQL advisory lock (`mailbox-sync:<mailboxId>`, `pg_try_advisory_lock`). A handler never waits for the lock; see [User commands](#user-commands). Content and attachment fetches do not take the mailbox lock; attachments use a per-attachment advisory lock.

### Inbox synchronization

- **Discovery and priority.** After discovery stores the folders, it requests synchronization of the Inbox first, then of the other selectable folders. Initial recent sync of a non-Inbox folder defers (5 s successors) while the Inbox has not yet completed or failed its first recent sync, for at most 60 s after the Inbox was first discovered.
- **Initial message window.** Recent sync searches for messages since `MAILDOCK_INITIAL_SYNC_DAYS` days ago and fetches the highest UIDs first: a first batch of up to 25 messages, then batches of `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE`. A higher UID means later arrival in the folder, not a newer `INTERNALDATE`. Each batch is persisted before the next is fetched.
- **Delta sync and IDLE.** Delta sync is requested by IDLE notifications, the periodic poller (`MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`), message actions and discovery. IDLE watchers run only for Inbox folders of accounts whose server advertises IDLE; they are a wake-up hint, and correctness comes from delta sync. Other folders rely on polling.
- **Account-scoped admission.** Recent and delta jobs of other folders yield to Inbox fresh work that is ready but not yet started. Inbox fresh work yields only to a pending user command on the same mailbox.
- **Reserved Inbox delta capacity.** The delta worker has `MAILDOCK_MESSAGE_SYNC_CONCURRENCY` slots per worker process. When that value is 2 or more, one slot accepts only Inbox-priority jobs (a pg-boss `minPriority` filter) and the remaining slots accept any delta job. With a value of 1 there is no reserved slot. Recent sync has no equivalent reserved slot.
- **Initial Inbox protection and recovery.** The 60 s protection above is derived from the stored discovery time, so it is stable across retries and restarts. If the enqueue was lost or a worker died, a 30 s repair poll re-enqueues initial recent sync for any Inbox that has not completed one, and the regular poller does the same for other folders. Repair never duplicates a queued or retrying job.

Active recent and delta jobs are not preempted. The only yield points are admission and, for backfill, sub-range boundaries.

### User commands

Remote message mutations (flags, move, delete) are durable commands.

- The API stores a command row and an optimistic local projection, then enqueues a command job. The UI shows the projected state at once; provider reconciliation corrects it later.
- A command takes the same mailbox advisory lock as synchronization. If the mailbox is busy the handler does not wait: it enqueues one short, jittered successor (2–6 s plus up to 1 s) and finishes. This consumes neither pg-boss retries nor command attempts.
- Sync jobs on that mailbox yield to a pending command (status `pending`, created within the last 10 minutes). An already-running sync is not interrupted, so a command can still wait for it to finish.
- Producers (API, poller, busy continuation) share one deduplicating path, and a 30 s poller re-enqueues pending commands. Deduplication reduces redundant jobs; it is not an exactly-once guarantee. The executor re-checks durable command state under the lock. Flag changes may be applied again after an ambiguous failure, and non-move actions fail permanently after repeated attempts.
- A MOVE whose outcome is uncertain (found `executing` after a crash or retry, or failing mid-flight) is never repeated automatically. It is marked failed with an uncertainty message and the mailbox is reconciled from the provider.

### Cooperative historical synchronization

Historical backfill is the only synchronization work that yields in the middle of a job.

- **Job range and sub-ranges.** One backfill job covers up to `MAILDOCK_BACKFILL_CHUNK_SIZE` UIDs (default 500) below the durable frontier. Internally it processes disjoint, descending sub-ranges of at most 100 UIDs (an internal constant, never larger than the job range). For the first job the frontier starts at `UIDNEXT − 1`.
- **Per sub-range.** UID `SEARCH` for the range, `UID FETCH` of the UIDs found, then a re-`SEARCH` of any UID the FETCH did not return. If such a UID still exists, the range fails and is retried instead of being skipped. Messages and the new frontier are then committed in one transaction.
- **Frontier.** The frontier is the highest unprocessed UID. It advances only to the range boundary (`lower − 1`), never to the lowest UID received, and only together with the data, guarded by compare-and-swap on the previous frontier and the UIDVALIDITY epoch. If the checkpoint changed concurrently, the transaction fails and nothing advances.
- **Yielding.** After each committed sub-range the job asks the admission gate whether commands, fresh work (including a queued recent or delta job for the same mailbox) or interactive fetches are waiting. If so, it ends normally and enqueues a successor keyed by the new frontier. If the gate cannot be read, it also stops. Yielding happens only at these boundaries: a started FETCH runs to completion because ImapFlow cannot cancel it, and closing the client is a failure path, not a yield mechanism.
- **Continuation.** A successor, a retry or the poller resumes from the committed frontier in PostgreSQL, never from the job payload.
- **UIDVALIDITY.** A change resets backfill state and requests a fresh recent sync; data of different epochs is never mixed.

### Job durability and recovery

- **Scheduling.** pg-boss runs in the application database. Maildock owns payload contracts, handlers and scheduling policy. Discovery, recent, delta, backfill and content queues use the `stately` policy; command and attachment queues use the standard policy with Maildock's deduplicating producer.
- **Producer-side deduplication.** Producers serialize check-and-insert with a transactional advisory lock and a live-job check (`created`, `retry` and, on some paths, `active`). `singletonKey` on a standard queue is not relied on for exclusivity. The pg-boss patch only stops a `stately` successor from being claimed beside an active job with the same key (see [Dependency patches](DEPENDENCY_PATCHES.md)).
- **Heartbeat.** Command, content and attachment queues use native pg-boss heartbeat (90 s) so a dead worker's job leaves `active` quickly. Discovery, recent, delta and backfill queues rely on expiration only.
- **Expiration.** Queues expire jobs after 900 s (discovery after 120 s). Expiration changes pg-boss's record of the job; it does not cancel application work. Handlers receive no abort signal, so an expired handler can keep running while a retry starts. Executor locks and durable status, not pg-boss, prevent duplicate remote effects.
- **Retries.** Discovery, sync, command and content queues retry up to 4 times with backoff. Attachment jobs do not retry; their durable state and poller re-request them. Busy-lock and yield continuations are separate delayed jobs and do not consume retries.
- **Recovery pollers.** Delta (`MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`, default 300 s) plus a 30 s Inbox initial-recent repair; backfill (60 s); message commands, content and attachments (30 s each). They read durable state and re-enqueue work whose job was lost.
- **Database invariants.** Backfill checkpoints move by compare-and-swap; the `stately` unique index prevents concurrent same-key claims; durable status columns (`pending`, `fetching`, `executing`) are the source of truth when re-enqueueing.

### Known limitations

- Active recent and delta jobs are not preempted by higher-priority work. An active ImapFlow `FETCH` cannot be cancelled to make way for it.
- Admission checks cannot eliminate every scheduling race; a lower-priority job may occasionally start first.
- Recent sync has no reserved Inbox slot. Worker slots, including the reserved delta slot, are local to one worker process and are not coordinated across processes.
- Job expiration does not stop the existing handler. After expiration and retry, content work for a message can overlap.
- Loss of a database session releases its session-scoped advisory locks, so another process can take a lock while the original handler is still running.
- Historical synchronization can be postponed for as long as higher-priority work keeps arriving.
- Intermediate backfill status is not a precise progress indicator: between committed ranges it can read `pending` while a successor is delayed or queued.

## Actions and sending

Remote message mutations use durable command state, optional optimistic local projection and later provider reconciliation.

Compose/reply/reply-all/forward share one durable sending pipeline. A complete MIME snapshot becomes immutable before queueing. SMTP delivery and Sent-folder copy have separate states because either can become uncertain independently. Maildock does not claim universal exactly-once SMTP semantics.

## Mail features

Maildock includes local drafts, optional conversation view, PostgreSQL full-text search, rich compose/signatures, attachment handling, desktop notifications and owner diagnostics.

Received HTML is sanitized and rendered in a sandboxed iframe with CSP. Remote images are blocked by default. Incoming attachment binaries are fetched on demand; outgoing/staged blobs use bounded verified storage.

## OAuth

An OAuth provider registry isolates provider-specific authorization from generic mail behavior. Microsoft and Google both resolve to OAuth2 credentials consumed by the same IMAP/SMTP adapter. Provider configuration is installation-level database state with encrypted client secrets.

## Jobs and runtime

pg-boss uses the application PostgreSQL database and owns its internal schema. Maildock owns job payload contracts, idempotent handlers and scheduling policy.

The default image runs migrations and then both web and worker roots. Advanced deployments may use `MAILDOCK_ROLE=web|worker`.

## Security boundaries

Principal boundaries are canonical HTTPS `APP_ORIGIN`, private raw app/database networking, immutable owner + mandatory MFA, Origin/CSRF mutation checks, persistent authentication admission controls, bounded inputs, encrypted provider credentials, ordinary PostgreSQL runtime authority, isolated untrusted email HTML, safe diagnostics and matched database/blob/key recovery sets.

See [Security](SECURITY.md), [Installation](INSTALLATION.md) and [Backup & recovery](BACKUP_AND_RECOVERY.md).

## Non-goals

- multiple Maildock users, tenants or RBAC;
- POP3;
- Microsoft Graph or Gmail API mail transport;
- contacts/address-book management;
- calendar;
- AI features;
- mandatory Redis/external broker/search service/object storage;
- microservice decomposition;
- provider-independent exactly-once remote effects.

Future work should preserve these identity/security invariants unless a new ADR explicitly changes them.
