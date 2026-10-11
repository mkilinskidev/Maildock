# Coherent mailbox publication Phase 4 validation

Date: 2026-10-11. Branch: `codex/gmail-api-complete-provider`.
Baseline: Phase 3b review `88dc3af`. Read ADR 0016, the architecture analysis,
and the Phase 1–3b implementation/review reports before implementation.

## Local unread contract

The visible `MailboxView.unseenCount` now counts distinct locally materialized
message IDs with a visible unread placement in an active, selectable mailbox.
It includes every local page, excludes command-hidden placements and messages
marked remotely missing, and returns zero for inactive/nonselectable mailboxes.
This is the same contract for Gmail REST, password IMAP and Microsoft OAuth2 IMAP.
An unread placement lacks `\\Seen`; physical removal excludes the placement.
Existing IMAP visibility does not independently hide a retained `\\Deleted` flag
before the presence/expunge machinery removes the placement.

No unread counter is stored. The existing aggregate query supplies the number.
`unseenCountObservedAt` now dates the local SQL sample. Remote provider counts
remain in their existing database columns and in `counterObservation.remote`;
`remoteUnseenCount` explicitly exposes the old remote unread value. Remote
`messageCount` remains diagnostic. Remote observation time remains unknown in
the provenance DTO; neither mailbox `updatedAt` nor a history checkpoint is
treated as proof of provider freshness.

All Inboxes counts distinct `(account_id, message_id)` pairs with an unread
placement in an enabled account's active, selectable, case-insensitive INBOX.
It does not deduplicate RFC Message-ID across accounts. Enabled accounts that
need reconnection retain their available local mail; disabled accounts are
excluded. Duplicate UIDs/INBOX placements count once. Where duplicate placements
disagree, any visible unread placement makes the identity unread, and list/reader
representatives prefer an unread placement. Conversation grouping changes rows,
not the unread message count. Archive/move/delete remove or hide relevant source
membership; destination membership is counted when committed locally.

The browser uses the envelope's exact All Inboxes aggregate rather than summing
mailbox badges. Its aggregate badge waits for that first envelope, avoiding an
incorrect bootstrap sum when duplicate INBOX placements exist.

## Publication and transaction boundaries

Migration `0042_mail_publication.sql` adds a small `mail_publications` table and
deferred constraint triggers on accounts, mailboxes, canonical messages,
placements, roles, conversation membership, cached content and Gmail sync state.
Publication uses the full PostgreSQL transaction ID as an opaque token, with
at most one publication row version per account/transaction. Tokens are compared
for equality, never numeric ordering: transaction allocation order is not commit
order. This avoids a separate counter and avoids repeatedly rewriting a hot row
for every item in a batch. Publication rows are separate from account authority
rows, preserving existing shared account publication locks. Account deletion
removes its marker; the API vector also reflects account removal/enablement.

Deferred triggers execute at the end of successful persistence, before commit.
Readers cannot observe their token before the corresponding data commits.
Rollback, including a failure of the deferred publication write itself, rolls
back both data and marker. Idempotent replay can produce a new token when existing
timestamps change; it cannot manufacture unread identities. A change anywhere
in an account invalidates both source/destination mailbox views and All Inboxes.

Existing Gmail metadata/flags/membership/receipt transactions and IMAP batch,
flag and removal transactions retain their boundaries. Successfully committed
P0 batches publish immediately, even if later history/backfill work fails or is
unfinished. A failed larger run does not retract previously committed batches.
History checkpoints, UIDVALIDITY/MODSEQ handling, scheduling/admission, quota,
backoff and provider observation intervals are unchanged.

`MailPublicationService.snapshot` opens a short, read-only REPEATABLE READ
transaction. It reads the account revision vector, mailbox aggregates, roles,
coverage, selected/All Inboxes page, exact aggregate unread count and selected
reader placement flags from that one MVCC snapshot. No provider calls or worker
authority locks occur inside the read transaction. A bounded SHA-256 token binds
the vector and conversation setting to the account/mailbox list scope.

## API and frontend behavior

Existing selected-mailbox and All Inboxes message routes accept `coherent=1`.
The response adds `publication`, containing the revision, mailbox/role maps,
enabled account IDs, `allInboxesUnread`, coverage and optional reader flags.
`readerId`, `readerAccountId` and `readerMailboxId` identify the selected placement.
Disabled source accounts do not keep a reader visible through All Inboxes.
Requests use the existing owner access boundary and UUID validation, and responses
are `no-store`.

Passing the previous `revision` on a first-page request returns a small
`unchanged: true` response when the vector is unchanged. This skips the counts,
roles, message list and reader queries. Cursor pages always execute their reads.
Legacy message requests still return their existing page shape; consumers needing
coordinated badges must use the envelope. Independent HTTP requests are not
claimed to share a snapshot. Mailbox list unread values are local in both paths.

MailClient replaces independent folder and list timers with one visible-tab
10-second envelope poll across all transports. It batches application of badge,
rows, roles, coverage and ready-reader metadata. Successful action enqueue
immediately requests a new local envelope; remote success/failure also refreshes
the relevant local state through the existing command polling flow. This does
not wait for another account's historical work or for a remote counter sample.

Optimistic row/reader flags and existing rollback/feedback are retained. Badge
adjustments before local persistence acknowledgement are removed: especially an
optimistic mark-unread must not raise a badge ahead of a committed placement.
The local command overlay already lives in the database when enqueue succeeds,
so the next snapshot counts it without a second browser delta. Remote completion
cannot double-count it. Moves do not optimistically invent destination rows.

Cancellation, location guards and an action request epoch reject stale responses
across scopes and mutations. Ready-reader flags come from the envelope and take
precedence over a delayed standalone content/detail response. Conversation
children reuse their existing refresh key. A publication invalidates loaded
tail rows by returning to the first page; pagination responses from a different
revision trigger refresh instead of appending stale rows. No full-page reload,
WebSocket, SSE, new scheduler or provider request is introduced.

## Coverage and freshness

The envelope preserves mailbox recent/delta/backfill information and adds an
account summary: `historyIncomplete`, `syncing`, `blocked`, and
`currentFreshness: "unknown"`. Gmail history completeness comes from its actual
inventory state; an uninitialized Gmail state is incomplete. IMAP uses existing
backfill and sync statuses. Reconnection requirements and sync errors are blocked
conditions. The pane shows local availability, history import incompleteness,
synchronization or a need for attention. Badge tooltips identify local unread
messages. These indicators do not infer freshness from equal totals or a zero
local count. Last successful IMAP delta time retains its existing precise meaning.

## Validation

All integration fixtures use disposable PostgreSQL 18.6 containers and project
migrations. Gmail HTTP responses and IMAP protocol/provider responses are
synthetic. No configured database, live account, mailbox, deployment or migration
was accessed.

- `mail-publication.integration.test.ts`: 10 tests passed. Real Gmail bootstrap,
  arrival, read/unread, archive and deletion; both IMAP account/authentication
  shapes with replay/flags/movement/removal; multiple accounts, conflicting
  duplicate placements, duplicate INBOXs and actual conversation grouping;
  disabled/reconnect-required accounts; partial import and remote/local gaps;
  pending/rolled-back persistence, failure of deferred publication at commit,
  a concurrent commit between revision and count/list reads, and local commands
  before remote completion. The final four boundary/scope regressions passed
  again after binding/hashing the revision token.
- Final eleven-file command: **151 tests passed** with `--maxWorkers=3`, covering
  publication, resumable IMAP integration, incremental IMAP integration, backfill
  integration, sidebar publication UI, mail shell, mail interactions, reply/
  forward UI, search UI, All Inboxes API and reader UI.
- Native Gmail provider suite: **55 tests passed** in the expanded eight-file
  regression run. Its only failing file was an obsolete UI fixture that relied
  on separate role polling; the fixture now supplies the intended missing role
  in initial props and passed in subsequent full UI/eleven-file runs.
- Separate eight-file publication/command/conversation/core/API/UI/worker-import
  command: **114 tests passed**. These runs overlap; counts are not additive.
- `pnpm typecheck`: passed for application and worker.
- `pnpm lint`: passed without warnings.
- Changed-file Prettier checks and `git diff --check`: passed.

Earlier development runs intentionally exposed legacy assertions that expected
remote counts before metadata drain. They now assert the separate remote value
and the still-unchanged local badge. Initial new fixtures were corrected for
the existing credential/discovery schema constraints, and the pending-reader
UI fixture disables auto-read to isolate external synchronization.

## Performance

The [raw benchmark](sync-priority-phase-4-benchmark.json) records five warm samples
on local Docker PostgreSQL, one enabled IMAP account, two mailboxes, 10,000 local
INBOX identities, 5,000 unread, a 50-item page and no retained content bodies.
The counter query includes both mailbox metadata and aggregate counts.

| Operation                                  | Range           | Median    |
| ------------------------------------------ | --------------- | --------- |
| Full selected-mailbox publication envelope | 95.98–108.77 ms | 104.19 ms |
| Unchanged revision check                   | 3.55–4.90 ms    | 4.22 ms   |
| Mailbox metadata/local counter query       | 13.17–16.37 ms  | 14.17 ms  |

Counts are queried only when the account vector changes. These costs do not
justify an independent unread projection. Fixture writes took 14,467 ms for
10,000 canonical messages and 437 ms for placements, including existing database
conversation/search/constraint work and new publication triggers. These are
end-to-end fixture timings, not isolated trigger overhead; no before/after write
throughput claim is made. The new trigger coalesces repeated row events to one
publication row version per account/commit.

To reproduce/export the benchmark in PowerShell:

```powershell
$env:MAILDOCK_PHASE4_BENCHMARK_OUTPUT = 'docs/validation/sync-priority-phase-4-benchmark.json'
pnpm exec vitest run tests/mail-publication.integration.test.ts --maxWorkers=1
Remove-Item Env:MAILDOCK_PHASE4_BENCHMARK_OUTPUT
```

## Deployment and limitations

Apply migration 0042 before deploying the updated web process. SQL triggers also
cover existing worker writers without rewriting their algorithms. Generated
schema snapshot and migration journal accompany the SQL; no existing migration
is changed.

- Local coherence is not remote freshness. Existing Gmail observation cadence,
  IMAP IDLE/fallback intervals, undiscovered history, backoff and provider outages
  can exceed the browser's 10-second polling interval. No live latency SLO is
  claimed, and completed import does not establish a current remote snapshot.
- The read transaction can return a coherent older state if another transaction
  commits during the read; the next revision poll advances all local views.
- A changed account invalidates the whole sidebar/list envelope, including changes
  to unrelated folders or cached content. Loaded older pages are discarded rather
  than refetched individually; users can scroll to load them again.
- Conversation children/content retain their existing asynchronous requests and
  converge through invalidation. Only reader placement metadata is included in
  the snapshot, not message bodies or provider-atomic conversation state.
- Full reads scale with local placements and account count. Benchmarks stop at
  10,000 identities/one account and five warm samples; cold storage, larger account
  vectors and sustained concurrent write contention need separate measurements.
- Triggers cover supported writers with stable account identity. Disabling them,
  bypassing them with administrative TRUNCATE or rewriting account identity is
  outside the application's publication contract.

**PHASE 4 COMPLETE**: the Maildock badge uses only committed local materialization,
and its coordinated list/reader publication progresses independently of unfinished
historical synchronization. The remote-freshness and scale limits above remain.
