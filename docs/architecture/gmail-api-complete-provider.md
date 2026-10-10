# Native Gmail provider — P2–P4 implementation

Implementation branch: `codex/gmail-api-complete-provider`, based on P1 commit
`7dfe29925473d8656febfdf2909733acc2871d3e`. The P0 documents and ADRs
0012–0015 remain the design authority. This document records implementation
details and qualification limits; it does not authorize deployment.

## Transport and identity

Web and worker composition bind `GmailReceiveAdapter` for Google OAuth accounts.
Gmail receiving never opens IMAP. Microsoft and password accounts retain their
existing IMAP path. SMTP, outgoing MIME, Bcc, uncertain-send handling and local
drafts retain the existing implementations. No new scope, account tile, API send,
cloud draft or Pub/Sub integration was added.

Native message IDs identify one canonical message per account. Mailbox UUIDs
identify native label IDs and survive label renames. Membership changes preserve
message UUIDs and cached content. All Mail is a virtual projection. Remote drafts
are tracked for inventory/history but have no normal list/search memberships.
Search uses existing local PostgreSQL full-text search; bodies become searchable
only after fetching. Conversations retain RFC-based grouping and exclude hidden
native drafts/tombstones. Multiple labels do not multiply search results or
conversation members.

## Durable synchronization

`GmailSyncService` persists profile H0 before enumeration. It lists recent messages
first, marks recent-ready independently, replays account-wide history from H0,
then imports older messages progressively and replays history before full coverage.
List pages contain at most 100 IDs. Durable page intake precedes metadata requests;
each slice drains at most 12 receipts with HTTP concurrency four. Metadata uses a
FULL field mask that excludes body data, retaining nested MIME structure without
automatically downloading bodies or attachment bytes.

History includes all event types. Affected IDs are deduplicated and current state
is fetched. Large history pages are split into fragments of at most 500 IDs, with
a durable offset and page fingerprint. A changed page restarts replay from the
fixed start checkpoint. Checkpoints use run/revision/start-value CAS and cannot
advance while work remains pending. Pagination has bounded token hashes and page
counts. Confirmed message GET 404 creates a native tombstone; label removal only
removes memberships.

Expired history or invalid page cursors enter reconciliation. Complete inventory
uses a new generation and H0; unseen records receive an exact GET before being
declared absent. Partial inventory never authorizes deletion. UUIDs/content are
retained. Old work is cleaned in bounded batches.

Account execution uses a reserved PostgreSQL session advisory lock. Gmail REST
waits hold no transaction or row lock. All publications validate account revision. The
transaction shim runs on the reserved connection and checks its backend identity
and authority before beginning; pool size one is supported. OAuth resolution and
refresh occur outside that reservation; the existing credential resolver's
serialized refresh transaction/credential row locking is unchanged. pg-boss carries IDs/revisions only;
durable eligibility polling repairs lost wakeups and queue acknowledgments.
Pending commands get priority over backfill.

## Content, actions and Sent

On-demand FULL MIME retrieval feeds the existing body selector, sanitizer,
sandboxed reader, remote-image policy and cache. Native attachment IDs use the
existing attachment jobs/blob store and publication fences. MIME traversal,
base64url data, HTTP responses, text and attachment bytes have explicit limits.

Native commands persist intent before execution. Read/star flags are global;
archive removes Inbox while preserving unrelated labels; move removes the source
label and adds the destination; Trash uses the native trash endpoint. Commands
observe before retry and after mutation, apply idempotent desired state and publish
confirmation atomically. Pending intents overlay stale remote reads. The existing
action endpoint supports `move` with `destinationMailboxId`; existing UI controls
remain in place. Label counters are refreshed progressively and may lag an action
until the next sweep.

Gmail server-managed SENT is observed through native receiving. Correlation to an
SMTP-accepted outgoing item requires an unambiguous account/RFC ID/sender/time
match. It never creates a synthetic received row or issues IMAP APPEND. A custom
Sent-copy preference fails explicitly through the existing error surface rather
than claiming a copy was written. This resolves the implementation behavior while
leaving the product's future custom-copy policy outside this scope.

## Quotas and diagnostics

The client uses only `https://gmail.googleapis.com/gmail/v1/users/me/`, rejects
redirects, bounds request/response sizes, supports abort/timeouts and classifies
authentication, API-disabled/access-denied, absence, expired history/cursors,
quota, transient network and invalid-response errors. Interactive requests have
bounded transient retries with Retry-After/backoff/jitter; background failures
persist a retry deadline instead of advancing work.

Weighted endpoint costs were checked against the official
[Gmail quota documentation](https://developers.google.com/workspace/gmail/api/reference/quota)
on 2026-10-10: profile/label get/list 1, message list/modify 5, message get/trash/
attachment get 20, history list 2. Published limits at validation were 6,000 units
per user/minute and 1,200,000 per project/minute; actual Cloud project allocations
must be checked before live qualification.

Reservations serialize through a short project quota transaction and persist in
native account state. Current and previous minute buckets conservatively bound
rolling usage. Defaults are 4,000 user units/minute, 100,000 project units/minute
and 2,000,000 project units/day (UTC). Background can consume 70%; interactive
requests retain the remainder. Failed attempts remain charged. Account deletion
removes that account's counters; Cloud quotas remain authoritative, so do not
delete/recreate accounts to evade budgets. One configured OAuth application is
treated as one shared project. Other applications using that project are outside
Maildock's local accounting.

Settings show OAuth/API readiness, recent/full coverage, processed IDs, history
health, retry deadline and weighted usage. They expose no credentials or message
content. Queue payloads contain no credentials.

## Database and qualification

Additive migration `0037_gmail_provider_operations.sql` adds durable quota/day,
pagination guard and history-fragment fields/checks, and constrains native move
commands. P1 schema/identities remain in use. Shipped migrations 0000–0036 are
unchanged; recovery manifests include the new migration. No legacy Gmail migration,
database reset, UID conversion or cutover mechanism was added.

See [staging runbook](../validation/gmail-staging-runbook.md), the machine-readable
[synthetic benchmark](../validation/gmail-synthetic-benchmark.json) and
[validation report](../validation/gmail-provider-validation.md). Automated results
and a synthetic benchmark do not qualify live Google OAuth, Cloud quotas or real
mailbox behavior. Those checks remain release gates.
