# Stage 1 results — retirement prerequisite blocked

Date: 2026-10-12. **Stage 1: BLOCKED at the database lifetime prerequisite.**
This is an investigation and retained failing gate, not a completed receiving
transaction executor or metadata persistence implementation. Stage 2 must not
depend on this branch as an accepted persistence component.

## Authorization and Git

- Repository: `mkilinskidev/Maildock`.
- Base: `design/imap-sync-engine-final`,
  `d0cd129fb2a34f31608a14de4e456039756f3645`.
- Feature branch: `feature/imap-sync-stage-1-persistence`.
- HEAD and a clean working tree were checked before fetching all remote references.
  The remote design branch matched the expected base; the ancestry check succeeded.
  The feature branch was created without replacing an existing branch.
- D15 is **APPROVED: Variant A, logical commit-time authority**. D07–D09
  directions are accepted for disabled Stage 1 work; implementation proof is pending.
- No push, PR, merge, account cutover, scheduler or IMAP implementation was performed.

Commits are separated into `558ea47` (`test: retain receiving client retirement
prerequisite failure`) and the documentation commit (`docs: approve logical commit
authority and record Stage 1 blocker`). Obtain their full identities with
`git log d0cd129fb2a34f31608a14de4e456039756f3645..HEAD --oneline`.

## Exact changes

| File                                                      | Change                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/receiving-retirement-gate.integration.test.ts`     | Four prerequisite tests using the installed postgres.js public `reserve()`/`end()` APIs. Two real PostgreSQL tests exercise pool sizes 1 and 2; two TCP peer tests withhold plaintext/SSL-negotiation startup. |
| `docs/design/imap-sync-engine/DECISIONS.md`               | Records D15 approval and separates D07–D09 direction approval from unproven production details.                                                                                                                |
| `docs/implementation/imap-sync-engine/STAGE_1_RESULTS.md` | Records the blocker, evidence limits, smallest alternative and reproduction commands.                                                                                                                          |

There are **no production source, schema or migration changes**. Existing migration
history, v1 fields, notification/conversation behavior and worker composition are
unchanged. The new engine has no runtime entry point and remains disabled.

## Research and integration boundaries

The design/readiness/validation/plan/decision documents and the Phase 3 durability,
implications and recommendation reports informed this investigation. The actual
`experiments/imap-durability/late-db-callback.ts` and `store.ts` were inspected.
The experimental store owns a custom native socket and parses BackendKeyData to
identify a backend. It was not imported or copied into production.

Installed source pins are postgres.js **3.4.9** and Drizzle **0.45.3**. Relevant
local contracts and source bodies:

- `node_modules/postgres/README.md`: reservation, custom socket, teardown APIs.
- `node_modules/postgres/src/index.js`: `reserve`, callback `begin`, `end`, `destroy`.
- `node_modules/postgres/src/connection.js`: `execute`, `connect`, `secure`,
  `end`, `terminate`, `closed`.
- `node_modules/postgres/src/query.js`: lazy query execution, `then`, `execute`,
  `cancel`, cursor and streaming entry points.
- `node_modules/drizzle-orm/postgres-js/session.js`: prepared queries execute
  through `client.unsafe(...).values()`; callback transactions call `client.begin`.

Stable application boundaries inspected include `database.ts`, `database-worker.ts`,
`runtime-database.ts`, `migrate.ts`, `database-authority.ts`, `schema.ts`,
`MessageService.persistBatch`, attachment metadata, notification consumption,
delta/backfill services, mailbox lifecycle, mailbox advisory locks, worker
composition/process shutdown and `JobRuntime`.

The current message persistence transaction updates metadata, version-aware flags,
attachment descriptors, placements and unique notification events. Conversation
reconciliation is transactionally triggered by message headers in
`0017_conversations.sql`; search definitions and notification uniqueness have
subsequent migrations. The mailbox row is locked in persistence, while current
network ownership uses a session advisory lock. These boundaries cannot simply be
wrapped in a timeout race or replaced with the experimental store.

## Failed candidate contract

**Rejected assumption: resolving `await lane.end({ timeout: 0 })` proves that the
old PostgreSQL backend transaction has settled.**

The real PostgreSQL fixture starts a reserved explicit transaction as an ordinary
login role, obtains its PID using `pg_backend_pid()`, and starts `pg_sleep(5)`.
An independent fixture reader waits until `pg_stat_activity.wait_event` is
`PgSleep`, then the lane is ended with timeout zero. After `end()` resolves, that
reader still observes the old backend as `active`. This fails for both pool sizes.
The independent reader successfully executes `SELECT 32` at the same boundary.

Both failing assertions are retained without weakening them or marking them as
expected failures. They reject this candidate settlement contract; they are **not**
proof that permanently ending an isolated client can never provide client-side
isolation. A live server query alone also does not prove a stale commit occurred.
The missing proof is backend ordering before fresh authoritative reload/retry.

Source inspection explains the gap: `index.js::end` races normal shutdown against
`destroy`; `destroy` invokes `connection.terminate`. `terminate` rejects pending
queries and sends a termination message through `socket.end(...)`. Its completion
does not await disappearance of the server transaction. A queued termination
message does not mean PostgreSQL has already stopped the running statement.

The two stalled startup tests pass after allowing 50 ms for peer close propagation,
with both plaintext startup and `ssl: 'require'` SSL negotiation held. They do not
prove authenticated TLS teardown, TLS handshake cancellation, arbitrary partition
behavior, late callback isolation, or unknown-COMMIT recovery. Do not generalize
these two passes into D09 acceptance.

The requested stop condition was applied at this prerequisite. No executor was
published that treats the end promise as settlement, and no dependent persistence
code or speculative DDL was added.

## Smallest viable alternative to investigate

Keep the approved architecture: exclusive receiving-only clients, explicit
BEGIN/COMMIT/ROLLBACK, bounded admission and revocable scoped query handles.
Separate **client lifetime retirement** from **server transaction ordering**:

1. Invalidate the turn and all scoped handles before cancellation. Guard Drizzle
   prepared execution and every supported lazy entry point; business code must
   never receive the raw client or transaction-control SQL.
2. Permanently end the affected dedicated client; never release its reserved handle
   into a replacement lifetime. Do not end unrelated application pools.
3. Treat a sent COMMIT without its definitive reply as unknown. Block authoritative
   account retry until a fresh bounded transaction acquires the conflicting
   lifecycle/mailbox locks held by the old writer. Shared lease locks alone do not
   establish this order, because they are mutually compatible. If ordering cannot
   be established within a recovery deadline, retain an unresolved outcome and
   back off rather than interpreting an unlocked snapshot as rollback.
4. After establishing order, reload epoch, revision, frontiers, placements and event
   identity under the same locks. Derive the next operation from durable state.
   No receipt or tombstone ledger is required by this failure.

This uses existing public client and SQL interfaces; it is a proposed recovery
contract, **not an implemented or tested remedy**. If bounded local I/O teardown
cannot be proved with public `end`/`onclose`, the smallest transport addition is an
owned socket via the documented `socket` factory, with explicit Node stream
destruction/close observation. That alternative must be justified and tested with
TCP and TLS; no backend wire parser or private driver fields should be copied.
Even actual local socket destruction does not by itself establish server ordering.

## Intended authority and schema contract — NOT IMPLEMENTED

The approved logical point L would be the last mandatory deferred database-native
authority check inside COMMIT, using `clock_timestamp()` after relevant lock waits.
Transaction-start `now()` and statement-start timestamps are unsuitable for lease
expiry at that point. Matching owner identity/generation, live lease, enabled
account, active/selectable mailbox, epoch, expected revision and prior progress
must be checked under lease SHARE, lifecycle and sorted mailbox locks. Renewal and
takeover UPDATE must conflict with the held lease lock and re-evaluate expiry after
waiting. A transaction valid at L may finish physically after expiry; takeover
must wait until its transaction releases its locks.

Minimal planned DDL remains mailbox F/E/R and monotonic bigint revision, coordinator
generation/expiry and coupled enforcement objects. Important constraints include
UID bounds, `E <= F + 1`, no revision reset/wrap, and required owner context on every
authoritative write. Alternate placement/metadata/flag/deletion/lifecycle writers,
source/destination writes, early `SET CONSTRAINTS`, and application-owner trigger
permissions require an explicit coverage audit. None of these constraints or
trigger permissions is implemented or certified by this branch.

The atomic entry point must eventually reuse existing message/attachment/threading
and notification semantics, validate explicit complete interval/exact-set evidence,
and accept verified empty intervals. No largest-returned-UID inference is acceptable.
Conversation/notification costs have not been benchmarked for a new bounded executor.

## Fault-injection results

| Requested case                                      | Result                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: cancelled callback, independent 32 rows/frontier | NOT RUN against a production executor; original Phase 3 source inspected only.                                                                                                                                                                                                           |
| B: stale prepared SQL                               | NOT RUN against a production executor.                                                                                                                                                                                                                                                   |
| C: actual lost COMMIT acknowledgment                | NOT RUN; recovery ordering remains unverified.                                                                                                                                                                                                                                           |
| D: expiry crossing / takeover / post-L completion   | NOT RUN; no authority DDL installed.                                                                                                                                                                                                                                                     |
| E: same-owner deletion / revision / wrap            | NOT RUN.                                                                                                                                                                                                                                                                                 |
| F: epoch replacement / visibility                   | NOT RUN for the new component.                                                                                                                                                                                                                                                           |
| G: atomic insertion/frontier/thread/event failures  | NOT RUN for the new component.                                                                                                                                                                                                                                                           |
| H: completely verified empty interval               | NOT RUN for the new component.                                                                                                                                                                                                                                                           |
| I: resources and isolation                          | PARTIAL: candidate end-settlement contract FAILED at pool 1 and 2; unrelated independent reader remained usable. Stalled plaintext/SSL-negotiation startup peer checks PASSED. Admission, lock/statement deadlines, shutdown, actual TLS and network-spanning reservation tests NOT RUN. |

## Validation commands and results

Environment: Windows PowerShell, Node **24.21.0**, pnpm **12.7.0**, Docker Desktop
available. The new gate creates its own **PostgreSQL 17.6-alpine** container and
ordinary receiving role. It ignores `TEST_DATABASE_URL` so fault injection cannot
target a supplied application database. Backend termination in `finally` is
fixture-admin cleanup only, not a proposed production privilege requirement.

```powershell
pnpm exec vitest run tests/receiving-retirement-gate.integration.test.ts
```

**FAILED:** 2 failed / 2 passed, exit 1, repeated with the same result. The failure
message is `end resolved while the old backend can still execute`, expected backend
count 0, observed 1. This intentionally red gate is included by the normal Vitest
glob; consequently a full test run cannot be reported green on this branch.

```powershell
pnpm exec vitest run tests/core-platform.integration.test.ts tests/incremental-sync.integration.test.ts tests/backfill-sync.integration.test.ts tests/conversations.integration.test.ts tests/notifications.integration.test.ts tests/incremental-sync-provider.test.ts tests/backfill-sync-provider.test.ts tests/imap-conditional-store.test.ts tests/imap-client-lifecycle.test.ts --maxWorkers=1 --no-file-parallelism
```

**PASSED:** 122 tests in 8 matched files, exit 0, 56.98 seconds. There is no standalone
`notifications.integration.test.ts`; that filter matched no file. Notification
regressions run within `incremental-sync.integration.test.ts`. Existing integrations
used their disposable fixtures. These passes preserve stable behavior but do not
prove a new executor, frontier or authority mechanism.

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
```

TypeScript and ESLint **PASSED**, exit 0. `pnpm format:check` **FAILED**, exit 1,
reporting 69 files in existing experimental/runtime outputs. Historical experimental
reports and generated measurements were not reformatted. Changed-file formatting
is checked separately:

```powershell
pnpm exec prettier --check tests/receiving-retirement-gate.integration.test.ts docs/design/imap-sync-engine/DECISIONS.md docs/implementation/imap-sync-engine/STAGE_1_RESULTS.md
```

Stage 1 unit/production-component tests and the full existing suite were **NOT RUN**,
beyond the explicit commands above.

Changed-file Prettier validation **PASSED**, as did `git diff --check`. Only the
three paths listed above were selected for commits. No generated database contents,
Docker volumes, actual credentials or benchmark artifacts were staged; the test
password constants are disposable synthetic fixture values.

## Remaining risks, rollback and next-stage readiness

D07–D09 remain unproven in production. There is no safe COMMIT classification,
authority trigger, revision enforcement or atomic new-frontier persistence to use
yet. Retaining these failed prerequisites is preferable to claiming timeout
rejection proves settlement. The blocker is the candidate retirement/ordering
contract, not D15 semantics, Docker availability or permission to implement Stage 1.

Rollback consists of reverting these test/documentation commits. There is no new
database state to migrate or downgrade. Production rollback for a populated future
new-engine schema still requires its own review; existing v1 data was not touched.

**Stage 1 BLOCKED; Stage 2 may not safely begin.** First implement and validate the
separate retirement/ordering boundary, then complete authority, revision, persistence
and all A–I tests. No Stage 2, scheduler, IDLE or cutover work is included here.
