# Synchronization priority Phase 3a validation

Date: 2026-10-10. Branch: `codex/gmail-api-complete-provider`.
Baseline: Phase 2 `66c8f6458bd2344f97ee8fccd669ed68c69d1fd7` and review fixes `a9ac545c037b9ece5e059d62be6581647672c377`.

## Scope and flow

Password IMAP and Microsoft OAuth2 IMAP use the same new sliced transport and persistence service. Native Gmail history, priority classification, quotas, checkpoints, intervals, frontend polling, badge semantics and All Inboxes are unchanged. Backfill retains its existing bounded UID chunks and P2 queue. No live database, account, mailbox, deployment or release was changed.

Previously recent synchronization searched the entire date window and drained every metadata batch under one mailbox lock and connection. Delta searched all new UIDs, ran a whole-mailbox CHANGEDSINCE or local flag sweep, loaded all local UIDs and confirmed all missing placements before completion. Database batches were bounded, but the delivery held authority for the entire mailbox.

Now a delivery performs either one bounded UID-position range of metadata import or one bounded local UID page of flag/presence reconciliation. Each protocol iterator is fully consumed before persistence starts. The read-only connection closes in `finally`; the existing worker mailbox advisory lock then releases. A coalesced successor enters the existing recent/delta stately queue. pg-boss settles the predecessor and Phase 2 admission selects the next eligible account/mailbox. There is no inline drain loop, new scheduler or additional persistent IMAP connection.

Production `ImapSmtpMailProvider` advertises `synchronizeMailboxSlice`, which both application services use. Older provider contracts remain as compatibility fallbacks for adapters that do not implement slices; they do not gain a bounded-delivery guarantee. The shared production password/Microsoft transport always uses the sliced path.

## Limits and configuration

| Limit                                             | Default   | Configuration and bounds                                                                 |
| ------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| UID positions searched per metadata slice         | 500       | `MAILDOCK_IMAP_SLICE_UID_SPAN`, 1–5000                                                   |
| Messages per FETCH and persistence batch          | 150       | Existing `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE`, additionally capped at 150 for sliced IMAP |
| Local flag/presence UIDs per reconciliation slice | 150       | Same effective FETCH batch limit                                                         |
| Connection deadline per slice                     | 60,000 ms | `MAILDOCK_IMAP_SLICE_TIMEOUT_MS`, 1000–120,000 ms                                        |
| Successor eligibility delay                       | 1 second  | Fixed continuation cooldown; normal pg-boss polling still applies                        |

The new environment settings are exposed in `.env.example` and Docker Compose. A dense metadata slice processes at most the UID span, in batches no larger than the effective FETCH bound; a reconciliation slice processes one local page. SEARCH ranges have explicit numeric ends, not `:*`. Empty UID ranges still advance safely after successful SEARCH and epoch validation. Sparse or historically large UID spaces require more deliveries, including empty ranges. This trades throughput for conservative resumability; measure density and reconnect overhead before increasing the span.

The connection deadline actively calls ImapFlow `close()` and refuses later checkpoints. The pg-boss job signal also closes the connection and is checked around persistence. Cancellation/timeout uses socket teardown rather than awaiting CLOSE/LOGOUT commands. This is **not a hard handler-lifetime guarantee**: credentials, database/pool waits, a blocked event loop, authority cleanup or a dependency that fails to settle after close can outlast the timer. Timers cannot interrupt a database transaction. Queue expiry remains 900 seconds, with existing retries/backoff. Phase 2 continues to count queue-active deliveries rather than every surviving operation.

## Durable progress and checkpoint correctness

Migration `0040_imap_resumable_slices.sql` adds only two nullable JSONB mailbox columns: `imap_recent_progress` and `imap_delta_progress`. The generated journal/snapshot accompany it. Existing rows require no data migration. Apply migrations before updated workers; use cooperating updated workers for the scheduling guarantees.

Each progress document contains account revision, UIDVALIDITY, fixed initial `UIDNEXT - 1` horizon, consumed UID cursor, metadata/reconciliation phase, local reconciliation cursor, original SELECT MODSEQ, fixed recent/empty-bootstrap cutoff and consumed metadata count. Initialization is durable before remote consumption. Resume validates epoch and account revision again. Revision changes discard partial scan state and restart conservatively from the existing safe arrival checkpoint; stale jobs cannot publish under a newer revision.

Message batches retain the existing fenced, idempotent `MessageService.persistBatch`, including attachment metadata, conversations and eligible delta arrival notifications. Cursor publication follows every successful batch in its UID range and a valid STATUS epoch. These are separate short transactions: a crash between message commit and cursor commit intentionally replays the range. No cursor advances after failed persistence or checkpoint rollback. The metadata count is committed with progress, so replay does not accumulate duplicate counts. Recent completion preserves the original remote-observation writers; only delta completion publishes STATUS counters as before.

A SEARCH-listed UID omitted by FETCH must be independently absent in another SEARCH and UID FETCH before the range can advance. A UID that remains live causes a retry at the previous cursor. UIDs absent from a successful bounded SEARCH are gaps; no message identity is inferred from UIDNEXT. Empty recent imports preserve their cutoff during delta bootstrap instead of importing older history as current arrivals.

Delta reconciliation reads local placements with an indexed UID keyset and SQL LIMIT. Each page fully fetches flags, separately confirms omitted UIDs through SEARCH and a UID-only FETCH, validates the remote epoch before deletion, and deletes only the confirmed page. Contradictory or failed protocol evidence does not delete placements or advance that page. Confirmed absence is irreversible within an epoch; earlier successful deletion pages may remain committed if a later page fails. Existing MODSEQ ordering prevents older flag observations from overwriting newer local MODSEQ flags.

UIDVALIDITY changes clear both partial states and old placements, reset arrival/MODSEQ/backfill authority and restart recent import. Changes detected by STATUS invalidate partial progress and force epoch reconciliation on the next selection. Delta requests the existing recent scheduler. Every publication uses the existing account revision fence; epoch-scoped cursor/completion writes also require the selected recent epoch.

## MODSEQ, capabilities and concurrent changes

An unrestricted whole-mailbox CHANGEDSINCE response cannot supply a safe intermediate MODSEQ checkpoint merely by batching callbacks. The sliced path therefore uses conservative bounded **local UID flag FETCHes**, including on CONDSTORE/QRESYNC servers. It retains the original SELECT MODSEQ throughout the scan and publishes it only after the entire required local sweep succeeds. It never substitutes a later STATUS MODSEQ. Servers without usable CONDSTORE retain a null baseline and the same bounded reconciliation. No QRESYNC vanished-set shortcut is introduced.

This deliberately gives up the old whole-mailbox CHANGEDSINCE optimization. It costs more flag requests and reconnections but avoids an unsafe streaming checkpoint. Changes behind the local cursor, including changes after a page was fetched, are revisited by the next full cycle. Arrivals above the fixed horizon remain for the next cycle; they are never skipped by a moving UIDNEXT checkpoint. A large same-mailbox cycle can therefore delay newly arriving messages until its next cycle, even though other mailboxes/accounts can run between its slices. IDLE coalesces a successor and the unchanged poller repairs missed wake-ups. This phase supplies safe admission opportunities, not a universal freshness SLO or a provider-atomic snapshot.

## Continuation, fairness, retry and cancellation

Continuation keeps the **same mailbox singleton key** and original fenced payload. Stately permits one created successor while its predecessor is active. All recent producers now use the existing transaction-based producer coalescer, as delta/IDLE already did. Repeated continuations and poll/IDLE wake-ups coalesce with pending work; existing retry state and deadlines are not rewritten. If an active delivery fails after enqueue, pg-boss can retain a retry plus a created successor; the existing live singleton and admission retry exclusion serialize them and preserve the retry deadline.

Workers enqueue only after releasing the mailbox lock and observing the job signal. The successor cannot bypass Phase 2 admission or immediately take the next opportunity just because it shares a mailbox. P0 INBOX, P1 other current folders, P2 backfill, reserved P0 headroom, account rotation and lower-class allowances remain unchanged. A retry deadline overrides priority. A lost enqueue acknowledgement or crash before enqueue is repaired by ordinary retries; the existing delta poller additionally repairs durable partial recent imports through the recent queue. No scheduler timer or provider poll interval is added. Terminal failures with durable partial recent state, and otherwise eligible delta work, can be repaired by normal polling. Failures before durable initialization retain the existing retry/manual-discovery recovery limits; outages and disconnected accounts remain operational limits.

Mailbox advisory authority still prevents simultaneous slices for one mailbox even during duplicate deliveries. Socket close occurs on normal return, protocol/persistence error, cancellation and deadline. On graceful pg-boss shutdown the job signal is honored; forced process termination relies on normal socket/session teardown and at-least-once recovery. Database authority loss and mixed-version/custom workers retain the Phase 2 limitations.

## Diagnostics

Debug events `mail.imap_slice_started`, `mail.imap_slice_resumed`, `mail.imap_slice_completed`, `mail.imap_slice_recovery` and `mail.imap_slice_yield` add account/mailbox IDs, phase, bounded progress, processed-message count, duration and typed continuation/recovery reason. Yield includes due queued INBOX presence for a non-INBOX slice when available; the actual winner remains visible in existing admission diagnostics. The existing delivery diagnostics retain retries, eligibility wait and lock contention. Yield observation is best effort and is not scheduling authority. No folder names, message contents, credentials or arbitrary provider error strings enter these new logs.

## Validation

Focused deterministic protocol tests use mutable simulated IMAP responses for both password and OAuth credentials. Integration tests use disposable PostgreSQL 18.6 and real pg-boss 12.33.7 with project migrations, real fenced persistence, mailbox advisory locks and Phase 2 admission. No configured/live database URL is used by the new suite.

The new suites cover multiple recent slices, bounded requests, persisted restart before enqueue, lost message-commit acknowledgement, checkpoint rollback after message persistence, duplicated continuation coalescing, UID gaps and expunges between SEARCH/FETCH, omitted live UID recovery, UIDVALIDITY changes at SELECT and STATUS, flags/deletions/new arrivals between slices, original MODSEQ retention, no-CONDSTORE fallback, revision fencing, cancellation/deadline cleanup, overlapping mailbox rejection and registered recent/delta workers draining continuations.

The admission regression claims and persists an Archive slice, queues a same-account INBOX wake-up and duplicated Archive successors, releases/settles Archive, then proves the INBOX P0 claim persists UID 1–3 before Archive resumes. An independently eligible account receives the next lower opportunity before the recently admitted Archive account. Its stored P0 priority is 100; returned fetch metadata predates the separate accounting update, so the test checks the persisted job. Existing admission suites cover independent processes, capacity, lower fairness, retry deadlines and expiry. Existing backfill and IDLE suites verify compatibility and wake-up coalescing.

Final targeted command: `pnpm exec vitest run` with these 19 files and `--maxWorkers=4`: `imap-resumable-sync.test.ts`, `imap-resumable-sync.integration.test.ts`, `incremental-sync-provider.test.ts`, `incremental-sync.integration.test.ts`, `incremental-sync-jobs-watchers.test.ts`, `backfill-sync-provider.test.ts`, `backfill-sync.integration.test.ts`, `backfill-sync-jobs.test.ts`, `recent-sync-jobs.test.ts`, `imap-client-lifecycle.test.ts`, `imap-hotfix.test.ts`, `mail-provider.test.ts`, `sync-admission.test.ts`, `sync-admission.integration.test.ts`, `sync-diagnostics.test.ts`, `synchronization-policy.test.ts`, `config.test.ts`, `core-platform.integration.test.ts` and `worker-imports.test.ts`, all under `tests/`.

- Targeted suite: 221 tests passed across 19 files.
- Separate `runtime-jobs.integration.test.ts` rerun: seven tests passed.
- `pnpm typecheck`: application and worker passed.
- `pnpm lint`: passed with no warnings.
- Prettier on every changed supported file, including migration metadata: passed.
- `git diff --check`: passed.
- Migration generation used an unused connection string; migration execution was limited to disposable test PostgreSQL. No deployment or live-provider validation was performed.

The registered-worker smoke test initially imposed a 30-second drain budget. Traces showed successful short slices and durable local cursors advancing through 0, 2, 4 and 6, with due successors waiting between admissions, rather than a stuck remote slice. The final test allows the existing polling/admission cadence 90 seconds to finish; it verifies completion and cleanup, not a 30-second freshness SLO. Its isolated rerun completed successfully. No production polling cadence was changed.

The existing concurrent admission test was also made deterministic about a valid try-lock outcome: a mismatching queue can own the selection lock while the matching queue sees contention, so both initial fetches may return empty. One subsequent normal polling opportunity must still claim exactly one job; overlapping account claims remain rejected. This changes the assertion, not the admission policy.

One expanded parallel run exposed the existing `runtime-jobs.integration.test.ts` content timestamp assertion (`terminal` versus `missing` for a future request time). Its isolated rerun passed all seven tests. Content queue code was unchanged; the cause was not established and this result is recorded as a test timing limitation, not fixed in Phase 3a.

## Remaining dependencies and operational limits

- Large/sparse UID spaces, full local reconciliation and repeated connection setup can reduce throughput. Conservative batching is not an elapsed-time completion SLA; no live-provider or freshness benchmark was run.
- Same-mailbox changes after a scanned page or above the fixed horizon wait for a subsequent cycle. Bootstrap IDLE eligibility still requires completed recent synchronization, as before.
- The connection timer limits live IMAP work under responsive ImapFlow teardown, not all credentials/database/handler lifetimes or total interactive connections. Phase 2 expiry/resource accounting limitations remain explicit.
- Correct SEARCH/FETCH/STATUS protocol behavior, stable UID semantics within an epoch, intact mailbox authority and cooperating workers are assumptions. Malformed/contradictory evidence fails closed where independently detectable; no server-atomic remote snapshot is claimed.
- Native Gmail durable INBOX classification and interleaving remain Phase 3b. Coherent frontend publication/local badge cutover remains Phase 4. Gmail Push/Pub/Sub and polling/quota tuning are outside this change.
