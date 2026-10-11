# Sync observability and INBOX freshness diagnostics

Branch: `codex/gmail-api-complete-provider`. Review date: 2026-10-11.
No deployment, provider writes, checkpoint resets, polling-interval changes or
scheduler policy changes were performed.

## Diagnostic model

Migration `0044_sync_observability` adds `sync_observations`: one row per account,
cascading with account deletion. It does not rewrite any receiving state.
The row stores the account work revision, operation token, actual phase and P0/P1/P2
class, a bounded activity lease, last completed check, last committed INBOX change,
last allowlisted provider refusal and an event ring.

Gmail instrumentation follows the shared priority decision **after** OAuth,
account authority, retry gating and the frozen-class recheck. Credential preparation
is visible separately. IMAP worker delivery instrumentation follows admission and
mailbox authority; recent/delta slices additionally report committed INBOX changes
and complete checks. Admission metadata now exposes the already-frozen class for
IMAP as well as Gmail; selection, capacity, fairness and intervals are unchanged.
Credential acquisition retains its previous pg-boss retry behavior.

Finishing an old operation cannot clear a newer operation's activity token. Activity
expires after 180 seconds, matching Gmail delivery expiry; live queue evidence is
read separately. Revision mismatches hide old telemetry and reject stale writes.
Missing telemetry is reported as unavailable, without inferring a specific phase.
Diagnostic persistence failures cannot fail mail synchronization.

Events include worker admission/yield, observation slices and completion, history
page discovery and bounded drains, committed arrivals/read changes/removals,
quota entry/deadline exit, errors and recovery. Gmail projection returns aggregate
change counts, comparing committed placements and respecting stale history and
pending-command flags. IMAP counts respect UIDVALIDITY and MODSEQ guards.
There is no event per historical message. The current operation is never derived
from the last completed event.

At most 80 events are retained per account, with a 24-hour age limit on writes and
reads. Existing hourly diagnostic cleanup physically prunes expired events even
for inactive accounts; physical retention can therefore extend by one cleanup
interval. The UI displays the newest 20 events, with older retained events expandable. Busy accounts can evict older
events sooner. Last check/materialization and the last refusal remain separately
available after events rotate. Tokens, credentials, message contents, subjects,
provider message IDs and raw exception objects are not diagnostic payloads.

## Current conditions versus historical results

`GET /api/accounts/:id/sync-diagnostics` requires owner access, validates the UUID
and sends `Cache-Control: no-store`. It performs two bounded snapshot queries for
the selected account: state/work/queue/lock evidence, then quota ledger or IMAP
queued-job counts. It never calls Gmail/IMAP or schedules work.

Gmail's last complete check comes from the existing dedicated `inbox_synced_at`,
not mailbox `updated_at`, history checkpoint completion or generic job success.
A check older than the existing 60-second observation interval is **overdue**.
A missing check has **unknown** freshness. Partial observation/materialization
does not advance the complete-check timestamp. IMAP uses its completed INBOX
observation or recent/delta success timestamp, with the configured polling interval.
Freshness describes observation age, not proof that no subsequent provider change
has occurred or a provider freshness guarantee.

Header states are Synchronizing, Waiting, Up to date and Needs attention. Executing
and freshness remain separate: a busy history slice can coexist with overdue INBOX.
Previous quota/network errors do not imply active backoff after their deadline.
Persistent blocked/reconciliation/OAuth states remain attention conditions.
The mail-list coverage flag no longer treats every historical Gmail quota category
as `Sync needs attention`.

## Blockers and eligibility

- Normal wait: the complete observation's existing interval has not elapsed, or a
  queued delivery remains behind an explicitly persisted normal account deadline.
- Admission: a current-revision unfinished queue job is queued and eligible.
- Lock: a granted PostgreSQL account advisory lock matches the exact Gmail account
  lock key. A historical lock-contention event is never treated as current evidence.
- Pending mail action: a current-revision pending/executing command has precedence.
- Quota: category `quota` plus a future account retry deadline. A separate
  `quotaBackoffUntil` preserves this evidence even during credential preparation.
- Local versus HTTP refusal: only the allowlisted last refusal with a matching
  active deadline supplies the specific explanation. Missing or mismatched source
  evidence produces generic quota wording.
- Provider/OAuth failure: connected-account state, persistent sync state and
  active retry category provide evidence. Expired historical categories are
  preserved in technical details without presenting an active blocker.
- No evidence: due work without a recorded queue admission explicitly says that
  admission has not been observed; it does not claim worker exhaustion.

Gmail's next check is the earliest normal observation eligibility (last check +
60 seconds), constrained by persisted account and queue retry deadlines. This is
an eligibility estimate, not a promise of execution at that second. A multi-page
observation remains in progress rather than advertising a new interval countdown.
Known next eligibility comes from persisted deadlines, never an invented retry.
The global IMAP polling timer has no durable next tick; its exact next check is
shown as unavailable rather than inferred from the last mailbox check.

Quota technical details expose rolling Google-user/project minute usage, project
daily usage, configured 70% background ceilings, last refusal time/source, HTTP
status, bounded Google reason codes, original Retry-After, normalized duration,
calculated deadline and limiting local budget snapshot. Minute usage uses the same
conservative boundary-second ledger as reservations. Usage is sampled separately
from activity; the API is not a transactionally atomic quota/admission decision.

## UI and visual verification

The existing account Diagnostics tab now starts with the specified responsive
account card: account identity/health, four prominent information blocks, waiting
explanation, compact vertical activity timeline and expandable technical details.
Desktop has two columns; mobile has one. Existing connection tests, folder details,
protocol/checkpoint facts, errors, refresh action and application-log links remain
available in expandable sections. Historical completed phases are labeled as past
results rather than current freshness.

The card uses existing CSS/Tailwind setup, theme tokens and button/details patterns.
No UI library was added. Refresh runs every 10 seconds only while the Diagnostics
tab is selected and the document is visible, skips overlapping requests, resumes
on visibility and aborts on unmount. Invalid/failed responses cannot render a
false healthy current state; the previous snapshot is explicitly historical.

`pnpm exec tsx tests/sync-diagnostics.browser.ts` verifies the actual card component
and repository CSS at 1200px and 390px in light/dark mode: grid columns, no horizontal
overflow, correct theme backgrounds, quota wording and initially collapsed details.
Four screenshots are generated under ignored `.security-results/sync-diagnostics/`;
they were visually inspected and are not committed. This is a component browser
fixture, not an authenticated production browser session.

## Read-only incident evidence

The running local `maildock-app-1` / `maildock-postgres-1` deployment was inspected
using `BEGIN READ ONLY` SELECTs and bounded existing log reads. No migration was
applied to that deployment. The compiled worker contains independent INBOX
observation and its existing 60-second eligibility decision.

Evidence timestamps below are UTC; add two hours for Europe/Warsaw on this date:

| Evidence                                 | Observed value                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot at 08:42:06.487991              | Last completed check 08:40:32.559; observation started 08:42:02.355; historical page 234 still incomplete; 4,509 pending items.   |
| Existing quota log at 08:39:55.907       | Local user-minute refusal: 2,792 used / 2,800 ceiling, requested 20; calculated retry deadline 08:40:25.907.                      |
| Existing quota log at 08:41:00.188       | Gmail HTTP 403, `rateLimitExceeded` / `RATE_LIMIT_EXCEEDED`; next eligible 08:41:30.188.                                          |
| Existing quota log at 08:41:31.289       | Another Gmail HTTP 403 rate limit; next eligible 08:42:01.289.                                                                    |
| Existing quota log at 08:42:48.945       | Local user-minute refusal: 2,790 / 2,800, requested 20; next eligible 08:43:18.945.                                               |
| Snapshot at 08:44:16.967525              | Last completed check 08:43:25.613; no observation in progress and no current error category; historical page 239.                 |
| Queue sample in the preceding 15 minutes | 166 deliveries; maximum recorded execution 4.743266 seconds. This is not a measurement of admission delay or user action latency. |

The sampled complete-check gap is 173.054 seconds, with confirmed local and HTTP
quota refusals in that period. Normal 60-second polling can explain favorable
20/30-second visible changes depending on when the user action occurs. Backoff,
bounded observation slices and queue/display delay can extend this beyond a minute;
90 seconds is consistent with the observed conditions. **The exact causes of the
three reported 20/30/90-second measurements remain unconfirmed**: corresponding
external read-action timestamps and matching materialization/admission records
were not available. No exact incident timeline was reconstructed from guesses.

## Overhead

Disposable PostgreSQL 18.6, pool size one, synthetic data, local Docker:

- 85 sequential diagnostic writes: approximately 4.0 ms mean / 9.9 ms maximum.
- 20 two-query account reads: approximately 3.6 ms mean / 5.5 ms maximum.
- 80 repetitive event samples: 8,235 logical JSON bytes, approximately 800 bytes
  compressed column storage. Real varied events compress differently.

These are local observational samples, not production latency/SLO measurements or
an old/new synchronization throughput comparison. Typical slices add admission,
phase and completion/yield writes, plus aggregated changes/errors when present.
Gmail batch comparison adds one bounded placement query per projection wave;
single existing INBOX projections add one placement read. IMAP metadata uses its
existing placement reads; observed flag batches add one bounded lookup and return
updated row identities for counting. Diagnostic events contain counts, not those
identities. No additional provider requests or background polling timer were added.
Hourly cleanup reuses the existing retention timer. The API issues at most two
queries per visible selected account per 10-second UI refresh.

## Validation and limitations

Focused tests cover current versus historical quota, overdue/unknown freshness,
actual execution/queue/lock/retry/command evidence, token completion races, stale
revision rejection, activity expiry, bounded/physical event retention, materialized
arrivals/read changes, recovery, unchanged 60-second eligibility, API authorization,
safe error responses and preserved settings UI. PostgreSQL fixtures exercise real
service/projector/lock/migrations for Gmail and IMAP. Existing Gmail priority,
provider freshness/replay/quota, IMAP resumability/admission and mail-publication
regressions were run as well.

Recorded passing runs (these overlap and are not additive):

- Final diagnostics/API/settings/delivery/admission suite: **49 passed**.
- PostgreSQL diagnostics/IMAP/publication/priority suite: **65 passed**, one optional
  benchmark skipped.
- Focused Gmail INBOX/quota/revision/checkpoint provider regressions: **18 passed**.
- IMAP slice and worker-delivery regressions: **44 passed**, plus the newly added
  aggregate materialization case in the PostgreSQL suite above.

Web/worker typecheck, ESLint and changed-file Prettier/whitespace checks pass.
Repository-wide `pnpm format:check` was run and reports the pre-existing formatting
issue in `docs/architecture/gmail-api-architecture-audit.md`; that unrelated document
was left unchanged. Generated Drizzle snapshots follow the existing formatting
exclusion. Browser verification passes for all four theme/viewport combinations.

Operational limits: telemetry is best effort and may miss a transition across a
crash or persistence failure; activity has a finite lease and queue evidence may
outlive a crashed worker. INBOX pages are not atomic remote snapshots, and no
freshness guarantee is possible while receiving is blocked. Gmail pending counts
refer to current-revision durable items, excluding unknown remote pages/control
operations; IMAP pending counts are queued jobs rather than remote message totals.
Exact future IMAP tick times and the original three user-action timelines are
unavailable. Legacy non-slice IMAP fallback adapters retain delivery events and
historical timestamps but do not supply detailed flag-materialization events.
Quota ceilings assume matching receiving configuration in web/worker environments.
Deployment must run migration 0044 before starting this application revision.
