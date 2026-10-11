# Gmail durable priority Phase 3b validation

Date: 2026-10-11. Branch: `codex/gmail-api-complete-provider`.
Baselines: Phase 2 `66c8f6458bd2344f97ee8fccd669ed68c69d1fd7`, review fixes
`a9ac545`, Phase 3a `5af2fc1`, regression fix `5535f88`.

## Scope and previous flow

Only native Gmail synchronization and its Phase 2 admission classification change.
IMAP synchronization/checkpoints, frontend intervals, unread badges, All Inboxes,
Gmail Push, quota defaults and coherent publication are unchanged.

Previously history decoding retained identities but stripped label context. The
service drained every staged fragment before discovering the next fragment/page.
Inventory catch-up occurred between whole pages, which could require dozens of
deliveries. Work selection had no deterministic priority ordering. Admission knew
only account-current versus inventory phase.

Now history discovery alternates with bounded durable drains. Pending history
survives subsequent page staging. Each drain selects one class, applies at most
12 identities in the existing four-request waves, and returns account authority
to the existing queue/admission machinery. Inventory and completed discovery with
pending history check for another unfiltered history sweep at the existing
60-second cadence. Initial recent inventory participates too; `recentReady` and
inventory completion retain their own completion requirements.

## Classification and ambiguity

The decoder retains reference `threadId`, optional reference `labelIds`, and
changed `labelIds`. Optional labels remain distinguishable from an explicit empty
snapshot. The classifier considers all typed events and generic references not
already represented by a typed event, deduplicating by native identity.

- P0: explicit INBOX membership; INBOX added/removed; previously materialized
  local INBOX placement; or an event without enough label evidence to rule out
  INBOX. This includes ambiguous arrivals, metadata, deletions and read/unread.
- P1: a supplied message label snapshot excludes INBOX, changed labels exclude
  INBOX with a complete typed event, and there is no local INBOX evidence. Generic
  events and label changes missing their changed-label list remain P0. A generic duplicate does not erase
  stronger typed evidence.
- P2: inventory, including historical import and inventory reconciliation.

Multiple events promote an identity to their strongest class. Message age does
not demote current changes. Local evidence queries inspect only the current
500-identity fragment. Classification does not issue supplemental message GETs;
the usual current-state GET supplies projection, membership and flags together.

Generic history references commonly omit labels. Such events deliberately remain
P0, including unknown non-INBOX identities. This can reduce the amount of work
that can safely be scheduled as P1; it does not invent negative INBOX evidence.
See Google's [history response contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

## Durable state, receipts and bounded intake

Migration `0041_worried_sue_storm.sql` adds four account fields:
`history_drain_due`, `history_discovered_at`, `priority_burst` and
`last_lower_priority`. Work gains `priority_class`, a class constraint and a
selection index. Existing inventory work is explicitly assigned P2; existing
history defaults conservatively to P0. The migration is additive and does not
change message identity, receipt keys or IMAP columns. Generated metadata is
included. Apply it before starting updated workers; restart cooperating workers
together. Older workers do not implement the new scheduling guarantees.

History page intake and the discovery cursor update remain one revision-fenced
transaction. History staging no longer deletes pending receipts. Upserts retain
the strongest pending relevance and reopen an observation when a later event
requires it. A persisted present message whose provider history ID already covers
the latest event can fulfill the receipt without another GET. This is evidence
of an already committed projection, not an acknowledgement based on labels or
priority. Missing/deleted observations without such evidence are fetched again.
Completed receipts can be retired in batches of at most 500 during subsequent
staging, as their projection and discovery progress are already durable.

The service stops discovering another history fragment at 4500 pending history
identities and drains to free space. Intake adds at most 500 identities, keeping
new-service pending history below 5000; legacy larger backlogs are drained rather
than discarded. This is a pending-work bound, not a bound on all stored messages,
completed receipts, response CPU time or database execution time. Inventory
retains its existing single-page staging bound.

## Checkpoint invariants

Four distinct facts are preserved:

1. Fetching a response only discovers remote changes. No cursor is committed by
   an HTTP response or queue acknowledgement.
2. `historyNextPageToken`, offset/digest and `historyPagesComplete` describe
   **durably staged discovery**, never complete application of a page. Every
   advanced fragment cursor and its work are committed together.
3. Current-state projection and completion receipts commit together in the
   existing fenced `projectGmailBatch` transaction. Failed waves keep unresolved
   identities pending. Already committed waves are not replayed unnecessarily.
4. `historyId` advances only after discovery has exhausted every fragment/page
   and the transaction finds no incomplete work in the history run. P0 alone
   cannot satisfy this condition. Inventory completion remains independent.

When pages are fully staged but work remains, a due catch-up sweep reuses the
same run and starts at the previous candidate ID. That ID is a **discovery
cursor**, while `historyId` remains the older applied checkpoint. All earlier
pending work remains in the run, so the next final candidate cannot commit over
it. A new P0 can therefore overtake already staged P1 or P2 without discarding
earlier history.

Fragment identity order stays independent of priority and local membership.
Changed response fingerprints restart from the committed `historyId` (or the
bootstrap baseline), rather than the more advanced discovery cursor. This
re-discovers earlier pending work conservatively. Pagination token-cycle and
page/fragment guards remain active.

History 404 retains the older checkpoint, marks reconciliation required and
starts inventory from a new durable baseline. Existing canonical messages and
content remain; exact reconciliation and final history catch-up precede complete
coverage. Account revision changes invalidate old runs and re-enumerate under a
new revision. Stale publication is refused. Neither condition treats abandoned
pending receipts as incremental success.

## Slices, admission and fairness

A delivery stages at most one fragment or drains at most 12 identities. Existing
inventory enumeration, labels/counters, reconciliation and checkpoint deliveries
remain bounded by their existing request/page limits. There is no inline account
drain loop, new queue, or new producer timer. The unchanged Gmail poller repairs
continuations from durable account state after ordinary acknowledgement/crashes.

P0 wins the next eligible drain except a lower-class opportunity. After eight
higher-class drains, or aged lower work after at least one higher drain, the
service grants a lower turn and alternates P1/P2 when both are available. Counting
ordinary P1 drains also prevents P2 starvation under a sustained P1 stream. Aged
lower work cannot take every turn: a lower allowance resets the burst. The burst
write follows successful projection; failures/crashes can postpone its accounting,
so this is not an eight-delivery bound under repeated interruptions.

Phase 2 admission reads the same next-action conditions, persisted classes,
intake ceiling and lower allowance. Unknown discovery, bootstrap and checkpoint
prerequisites remain conservative P0. A known P1 drain is admitted as P1; known
inventory and maintenance drains remain P2. Old inventory rows without the new
clock initialize it once without remaining permanently P0. Active job class is
still frozen by the existing adapter for capacity accounting.

Cross-account rotation, reserved P0 headroom, retry exclusion, pg-boss stately
singletons and the exact pinned 12.33.7 adapter remain intact. No additional
per-account concurrency is introduced: the existing four HTTP requests per wave
and single account authority are retained. Completing one slice gives other
accounts another admission opportunity.

## Quotas, retries and diagnostics

All HTTP calls still use the existing background quota reservation, user/project
and daily ledgers, interactive reserve, cancellation and provider errors.
Discovery during inventory uses the existing 60-second cadence instead of
waiting for a whole large page; this may add history-list and existing catalog
refresh requests relative to slow inventory. No quota limit or reserve changes.
Covered duplicate history events avoid repeated message GETs.

Retry-After and persisted `nextAttemptAt` override priority, wake-ups and polling.
Authority is released before deferred retry. There is no immediate P0 retry loop.
Queue-level retry/backoff continues to handle unexpected/database failures.

New debug events record pending counts per class at slice selection, processed
items, lower-priority yields, P0 staging-to-persistence age, staged fragments and
successful checkpoint publication. P0 age starts at durable staging, not the
external arrival or first HTTP byte; it is not a provider freshness SLO. Existing
logs retain quota/retry/command blockers. Logs exclude message bodies, subjects,
tokens and sensitive headers.

## Validation

All provider calls use synthetic Gmail responses. PostgreSQL 18.6 and pg-boss
12.33.7 integration fixtures are disposable, with project migrations and real
account authority/fenced persistence. No configured database or live mailbox is
used. Migration generation used an unused connection URL.

Added deterministic and real-database coverage includes:

- New INBOX persistence ahead of a 300-item staged P2 page, then inventory finish.
- Read/unread, archive, delete and an old message entering INBOX ahead of P1.
- Ambiguous events, retained decoder context and strongest-event deduplication.
- Later-page P0 ahead of 88 still-pending P1 identities, with the old checkpoint.
- Restart after staging and after projection/receipt commit, without duplicate GET.
- PostgreSQL-trigger failures rolling back staging and checkpoint publication.
- Expired history while earlier work is pending; revision change with pending work.
- Changed oversized fragments restarting from the committed cursor.
- Retry-After 120 seconds retaining P0 without an early retry.
- Eight-slice P1/P2 opportunities, P2 progress under P1, and the intake ceiling.
- Current INBOX catch-up before initial recent inventory completes.
- Real pg-boss selecting another account's P0 before P1 and persisting class 10.
- Existing quota, lock, provider, admission, retry and inventory regressions.

Final targeted command: `pnpm exec vitest run` with these ten files and
`--maxWorkers=4`, all under `tests/`: `gmail-history-priority.test.ts`,
`gmail-provider.integration.test.ts`, `gmail-client.test.ts`,
`gmail-foundation.test.ts`, `gmail-foundation.integration.test.ts`,
`sync-admission.test.ts`, `sync-admission.integration.test.ts`,
`sync-diagnostics.test.ts`, `synchronization-policy.test.ts` and
`worker-imports.test.ts`.

- Final targeted run: **157 tests passed across ten files**.
- Additional pending-identity promotion/overlap regression: **one test passed**,
  run with `pnpm exec vitest run tests/gmail-provider.integration.test.ts -t
'promotes an already pending'`. Total: **158 passing tests**. This final test was
  added after the ten-file run started; production code was identical.
- `pnpm typecheck`: application and worker passed.
- `pnpm lint`: passed without warnings.
- Prettier check on changed supported TypeScript, Markdown and journal JSON:
  passed. Generated snapshot serialization is retained according to the existing
  `.prettierignore`; no formatter claims are made for SQL or ignored snapshots.
- `git diff --check`: passed.
- Migration execution and fault-trigger creation were limited to disposable
  PostgreSQL fixtures. No live-provider benchmark, deployment or production
  migration was performed.

During development, a full run exposed a timing-sensitive existing notification
fixture that passed alone. Its synthetic live arrival now uses a date explicitly
after the persisted account baseline instead of comparing two independent host /
container clocks. Production notification eligibility was not changed. New fault
tests were corrected to inspect Drizzle's wrapped PostgreSQL cause, and stale
credential acquisition is asserted to reject before authority acquisition.

## Tested guarantees and limits

The named fixtures test durable ordering, transaction rollback, safe checkpoint
retention, restart/replay, revision fencing, resource slicing and real admission.
They do not establish a universal latency bound or production capacity envelope.

- An undiscovered P0 can still wait behind earlier history pages/fragments or the
  pending-work ceiling. No optional INBOX-only reconciliation is introduced.
- Generic sparse history can conservatively classify unrelated work P0. This
  trades throughput for correctness; history-list calls are unfiltered.
- The 60-second observation cadence is preserved. No 10–30-second SLO, elapsed
  handler deadline, or forced preemption of an in-flight HTTP/database operation
  is claimed. Existing client response/time limits and Phase 2 surviving-handler
  accounting limits remain.
- Correct Gmail history/current-state semantics, intact PostgreSQL authority and
  cooperating updated workers are assumptions. Sustained ingress exceeding
  quota/service capacity can extend backlog completion indefinitely.
- Completed receipt retention and admission/database query costs are not
  benchmarked at production scale. The pending ceiling is a conservative resource
  bound, not throughput tuning evidence.
- Counters and rows can still be published independently. Phase 4 remains needed
  for coherent UI snapshots, local badge semantics, reader/tail invalidation and
  truthful freshness/coverage. This phase does not claim coherent publication.

**READY FOR PHASE 4.** No confirmed blocking defect remains in the tested Gmail
priority/checkpoint scope. Coherent publication remains a separate, required
Phase 4 change; the operating and latency limitations above remain explicit.
