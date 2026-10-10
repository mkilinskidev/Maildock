# Synchronization priority Phase 2 validation

Date: 2026-10-10. Branch: `codex/gmail-api-complete-provider`.
Phase 1 ancestor: `6024a69cf36adbf8a92f87e66265b83f1f3a4b42`.

## Implemented scope

Phase 2 adds effective admission before pg-boss activates synchronization jobs. It retains the existing discovery, recent, delta, backfill and Gmail account queues, consumers, retry machinery and provider services. The implementation supplies a shared PostgreSQL scheduling gate rather than assuming that priority numbers order independent queues. No Gmail history decoding, durable drain/checkpoint semantics, IMAP remote batches, sync intervals, visible badges or frontend publication behavior changes.

This is an enforceable subset of the ADR's resource policy. The guarantees below concern cooperating workers and queue-active deliveries. They are not a hard ceiling on every live connection or an unconditional freshness bound.

## Before and after

| Concern                    | Before                                                                                                | After                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMAP INBOX ordering        | Recent/delta numeric priority 10 for every folder; independent queue consumers                        | Current/recent INBOX jobs classified P0 from the persisted remote path at each admission; eligible P0 selected ahead of P1/P2 across all five queues, except the bounded lower-class allowance    |
| Initial discovery          | Alphabetical mailbox API results scheduled concurrently                                               | Provider discovery results put INBOX first; initial INBOX scheduling completes before scheduling other selectable folders                                                                         |
| Execution capacity         | Recent/delta each had independent concurrency; Gmail two, backfill one; processes multiplied capacity | Shared queue-active ceiling, at most one active sync delivery per account, and a ceiling of capacity minus one for P1/P2; consumers have enough local slots for the shared ceiling                |
| Account fairness           | Queue creation order and Gmail state update timestamps                                                | Persisted last admission time rotates eligible accounts; missing admission records go first, with deterministic timestamp/account/job tie breakers                                                |
| Lower-priority progress    | No explicit global service allowance                                                                  | P1/P2 opportunity after eight P0 admissions or 60 seconds of eligible waiting, subject to capacity and mailbox safety; alternate available lower classes and rotate their accounts                |
| Backfill mailbox admission | Handler checked queued recent/delta jobs                                                              | Shared pre-activation selection excludes backfill when eligible recent/delta needs its mailbox; existing checks before/after mailbox lock retained, now ignoring delayed retries and blocked jobs |
| Gmail producer fairness    | Repeatedly considered first 20 due accounts, including accounts with pending jobs                     | Uses shared last-admitted order and excludes accounts already pending/active/retrying; subsequent unchanged one-second polls reach accounts beyond the first 20                                   |
| IDLE across processes      | One watcher per local mailbox map, potentially duplicates across workers                              | Session advisory lease permits one watcher per account across processes; remote connection closes on authority loss and shutdown awaits lease cleanup                                             |

## Admission mechanism and dependency

Installed and inspected pg-boss: **12.33.7**. Its `minPriority`/`maxPriority` consumer filters can reserve capacity inside one queue; `priority`/`orderByCreatedOn` booleans are deprecated/ignored. Group concurrency is scoped to a queue and its fetch-time snapshot is insufficient for a hard cross-process, cross-queue account gate (also covered by the existing real queue reliability test).

`JobRuntime.start()` installs a database adapter decorator before registering business consumers. For sync fetches only, it opens a short pg-boss transaction, attempts the shared transaction advisory lock, and then reads eligible jobs in a **separate READ COMMITTED statement**. Selection therefore sees another cooperating worker's committed claim instead of relying on an earlier snapshot. It restricts pg-boss's original single-job fetch to the selected ID, records account/class admission and commits them together. No remote operation or OAuth acquisition runs inside this admission transaction. Other SQL, including command/content/attachment/outgoing consumers, passes through unchanged.

The decorator has one explicit dependency on the pinned pg-boss fetch SQL: insertion of an ID predicate into its candidate WHERE clause. It preserves the original fetch's singleton protection, start-after checks, activation, retry count, metadata and expiry logic. Startup rejects a different pg-boss package version; an unsupported recognized fetch shape fails closed. Real `fetch()` and `work()` tests verify this insertion point. A pg-boss upgrade requires revalidation before changing the version guard. This SQL adaptation is necessary because this version has no public cross-queue fetch-by-selected-ID consumer hook; no new queue framework or provider progress store is introduced.

Migration `0039_supreme_reavers.sql` adds only `sync_admission_policy` and `sync_account_admission`. The former records the bounded allowance and last lower class; the latter records account rotation. Active class is frozen in the job's priority (P0=100, P1=10, P2=-10) in the admission transaction so a Gmail phase change during execution cannot change reserved-capacity accounting. **These numbers are accounting metadata, not the cross-queue ordering mechanism.** Legacy queued jobs are classified from current mailbox/Gmail state when admitted, without rewriting payloads or resetting queues.

Apply the migration before starting the updated workers. Restart all workers together with the same concurrency configuration; old workers or custom consumers that bypass the decorator do not participate in the guarantee. No migration was applied to a configured/live database during validation.

## IMAP and Microsoft OAuth2

Standard/password and Microsoft OAuth2 use the same IMAP scheduling and mailbox authority. Case-insensitive remote path `INBOX` is P0 for both recent and delta; other current folders are P1; every backfill job is P2, including historical INBOX work. Message age does not enter classification. Discovery is conservatively P0 as a prerequisite for making current INBOX work schedulable.

At most one queue-active sync job per account limits concurrent background folder connections to one; discovery also participates. IDLE has its separate global account lease, permitting at most one background observer in addition to that sync connection under intact authority. The lease uses a dedicated PostgreSQL session, preserving the application pool for work and commands. Contending observers retain existing exponential reconnect delays, rather than enqueueing sync failures. Session loss closes the observer; cleanup skips UNLOCK on a lost reserved connection, and the next observer can reacquire authority.

Existing IDLE event handling, 500 ms coalescing, reconnect delta triggers and interval settings remain intact. Recent/delta/backfill mailbox locks, UIDVALIDITY, MODSEQ, UID cursors, provider errors and recovery are unchanged. An active backfill chunk remains non-preemptible; a new higher job can make it yield at the existing pre-lock/post-lock checks. Backfill does not acquire a mailbox already needed by eligible higher work merely because its allowance is due. A higher job whose retry deadline is still in the future does not prevent otherwise eligible backfill.

## Gmail REST

The existing account queue and Gmail authority/revision/quota/progress mechanisms remain unchanged. Admission classifies a persisted active inventory run with no history run, a baseline and no reconcile-required state as P2. Active history, history startup, bootstrap, missing/uncertain state and repair prerequisites are conservatively account-current P0. An inventory run that also has an active history run is P0 because the unchanged service executes history first.

This **does not classify Gmail history events by INBOX membership**. It also cannot distinguish an unseen external current change while an account's inventory phase is active. It gives already-identifiable account-current work on other accounts precedence over that inventory, preserves lower service, and stops inventory accounts from occupying all shared slots. Recent inventory stays conservatively within the account inventory classification; changing its internal behavior or interleaving histories belongs to Phase 3b.

Both queue `start_after` and persisted Gmail `next_attempt_at` gate eligibility. Priority cannot bypass Retry-After, minute/daily quota deadlines, authentication backoff or the service's own rechecks. Manual wake/enqueue behavior remains unchanged and preserves error deadlines. The quota reservation code and interactive reserve are untouched. Tests assert admission never modifies history checkpoints, and existing provider regressions exercise failures and durable progress.

## Defaults, fairness and diagnostics

| Policy                                  | Default / configuration                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Shared sync queue-active capacity       | `max(2, MAILDOCK_MESSAGE_SYNC_CONCURRENCY)`; default 2, across cooperating processes, replacing independent sync execution budgets |
| Reserved P0 headroom                    | One slot; P1/P2 together use at most capacity minus one, even when P0 is momentarily absent                                        |
| Per-account sync admission              | One active delivery across the five queues                                                                                         |
| Per-account IDLE                        | One globally leased watcher, separate from sync capacity                                                                           |
| Lower-class allowance                   | Eight P0 admissions or 60 seconds of eligible queue age; fixed starting policy from ADR 0016                                       |
| Consumer polling and provider intervals | Unchanged; no added scheduler polling or deferral re-enqueues                                                                      |

The existing concurrency setting controls the global sync budget and corresponding local consumer capacity; its effective sync minimum is now two to retain headroom while permitting lower work. No additional environment knobs are introduced. Discovery's local consumers are at least this capacity; backfill consumers also have enough idle threads for the global budget. The shared gate, not local thread counts, enforces the execution limit.

The allowance deliberately counts **admissions**, including failures/skips, rather than asserting that a returned delivery was productive. It can grant maintenance earlier than eight productive slices, not later because of skipped jobs. It is an opportunity at a safe capacity boundary, not a completion-time SLA. An account holding authority or waiting for retry is not eligible for rotation. Continuous higher work on the **same mailbox** can postpone its backfill: mailbox safety overrides the maintenance allowance. With finite operations, available cooperating consumers and eligible accounts/classes, last-admitted order and alternating lower classes prevent a hot account/class repeatedly winning every opportunity.

With `LOG_LEVEL=debug`, `mail.sync_admission` records selected class, account/mailbox IDs, queue order, eligibility wait and allowance. `mail.sync_admission_deferred` distinguishes a queue waiting for a different selected queue/class; these logs are limited to one per queue per process per minute. Existing `mail.sync_delivery` records execution time/retries/lock contention; Gmail state/failure diagnostics retain provider backoff/quota/deadline explanations. Empty capacity polls do not emit per-job noise. No message contents, folder names, credentials or arbitrary provider error strings are logged.

## Validation

Final targeted run: **12 files, 128 tests passed**. Files: `sync-admission.test.ts`, `sync-admission.integration.test.ts`, `gmail-provider.integration.test.ts`, `incremental-sync-jobs-watchers.test.ts`, `backfill-sync-jobs.test.ts`, `recent-sync-jobs.test.ts`, `sync-diagnostics.test.ts`, `synchronization-policy.test.ts`, `runtime-jobs.integration.test.ts`, `incremental-sync.integration.test.ts`, `backfill-sync.integration.test.ts`, and `worker-imports.test.ts`, all under `tests/`. Run with `pnpm exec vitest run` followed by those paths.

- `pnpm typecheck`: application and worker passed.
- `pnpm lint`: passed.
- Prettier check on changed TypeScript, Markdown and supported JSON files: passed.
- `pnpm format:check`: the existing `docs/architecture/gmail-api-architecture-audit.md` formatting issue remains; that unrelated file is unchanged, as recorded in Phase 1.
- `git diff --check`: passed.
- No broad unrelated suite, live mailbox mutation, live database migration/reset or deployment was performed.

The added IDLE session-loss test initially exposed an attempted UNLOCK on an already-lost reserved connection, causing cleanup to hang. Cleanup now observes authority loss, skips that query and closes its session. The final complete targeted run includes the passing loss/reacquisition regression, with no unhandled errors.

The new deterministic tests use disposable PostgreSQL and real pg-boss, covering both IMAP authentication variants, cross-queue numeric-priority independence, reserved headroom, actual consumers, account rotation, lower-class turns/aging, mailbox backfill exclusion, simultaneous independent worker claims, retry preservation, Gmail classification/checkpoints/deadlines, accounts beyond the 20-row producer limit, INBOX-first discovery, and IDLE lease contention/session loss. Adapter boundary tests cover passthrough, transaction rollback, lock deferral and rejection of unsupported SQL shape. Existing targeted suites cover IDLE wake-ups/coalescing, provider authority, duplicate delivery/recovery and Gmail quota/history behavior.

## Performance, quota and remaining dependencies

Provider request algorithms and polling intervals are unchanged, so there is no new per-slice Gmail API cost or relaxed quota reserve. Account selection changes which slices execute first. Shared capacity/one-account admission can reduce historical throughput and parallel folder throughput, while preserving capacity for current work. Gmail's poller avoids repeated enqueue/state-update attempts for accounts already represented in the queue.

Each consumer's existing polling cycle performs a short admission transaction; successful claims add two small fairness writes and a job class update. Candidate queries inspect eligible/active sync jobs with existing pg-boss indexes and join persisted mailbox/Gmail state. No independent dispatcher loop or busy retry loop is added. Query cost under a large real backlog is not benchmarked here; profile it before increasing concurrency. A live IDLE observer now holds one extra dedicated PostgreSQL session per account; size server connection capacity for these sessions, pg-boss/application pools and existing Gmail authority sessions.

Remaining limits are explicit:

- IMAP recent/delta operations are whole-mailbox, non-preemptible runs. Their durations can exceed every scheduling allowance. Phase 3a must add safe resumable boundaries without changing UID/MODSEQ correctness.
- Gmail priority is account/phase-level only. INBOX event classification, durable message ordering, history-page interleaving and any optional INBOX reconciliation remain Phase 3b work. An undetected current change cannot promote persisted inventory work by speculation.
- Admission counts **queue-active** deliveries. If a remote operation survives pg-boss expiry or a forced shutdown timeout, its surviving execution is not represented in that count. Existing mailbox/Gmail authority still protects the original scope, but the shared capacity/account ceiling is not a hard physical-connection guarantee in that abnormal window. Strict execution-lifetime resource leases or verified cancellation would be additional admission work; resumable bounded Phase 3 operations reduce this exposure but alone do not prove it impossible.
- Commands, lazy content/attachments, web-provider tests and other interactive operations remain functional outside the shared sync budget. Consequently one sync plus one IDLE is a background scheduling envelope, not a total per-provider/global connection ceiling. A full interactive/provider connection budget is deferred rather than silently imposed on those existing flows.
- PostgreSQL authority loss and mixed-version workers are outside intact-lease/cooperating-worker guarantees. IDLE closes its observer on observed lease loss; there is no provider-atomic handoff guarantee during network/session loss.
- No freshness SLO or p95 measurement, live deployment/mailbox experiment, badge cutover or coherent publication claim is made. Phase 4 publication/UI work remains required.

These gaps do not reduce INBOX precedence to numeric priority: code and real consumers enforce cross-queue selection and execution headroom in the declared admission envelope. They do prevent describing Phase 2 as a universal hard resource guarantee.
