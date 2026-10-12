# Stage 1 results — isolated persistence passed

Date: 2026-10-12. **Stage 1: PASS for the disabled, isolated receiving persistence component.** The executor and persistence API are implemented and validated; they are not connected to IMAP, scheduling, account cutover or worker composition. No Stage 2 work, push, PR or merge was performed. D15 remains **APPROVED: Variant A, logical commit-time authority**.

## Corrected retirement and ordering contract

The original blocker confused local client retirement with server transaction completion. `postgres.end({ timeout: 0 })` can resolve while the PostgreSQL backend is still active in `PgSleep`. That observation is retained as a passing counterexample test; it is not evidence that a replacement may trust an unlocked snapshot.

Each admitted transaction now owns a fresh postgres.js client and a native socket created through the public socket factory. Cancellation revokes the frozen scoped Drizzle facade, rejects late prepared SQL, destroys the owned transport and waits for local transport/driver settlement before closing the client. A retired client is never reused or released into a shared pool. There is no global pool shutdown, private PostgreSQL protocol parser or delayed callback rollback. Capacity and waiting admission are bounded; deadlines cover admission, startup, statements and shutdown. Fresh clients add connection overhead and are an intentional Stage 1 tradeoff.

A development run exposed a separate TLS teardown race: all 30 assertions passed, but Vitest reported an uncaught `EPIPE` and exited 1. Calling `end()` immediately after destroying the underlying TLS transport let the driver write Terminate after its socket listeners had gone. That run was rejected. The fix waits for the owned socket's public `closed` state, reservation settlement and the driver's public `onclose` before `end()`. The subsequent full run exited 0 with no unhandled error. These are local lifetime observations, not proof of synchronous backend disappearance.

PostgreSQL provides the authoritative ordering. Claim takes the coordinator row `FOR SHARE`, locks account lifecycle and mailbox identity, then checks the expected epoch, revision and F/E/R under conflicting locks. Takeover takes the lease `FOR UPDATE`; mailbox recovery takes the same mailbox lock as writers. Account identity is revalidated after acquiring the mailbox lock. The mandatory deferred authority trigger performs its final database-clock expiry check at logical COMMIT point **L**, with all locks held through transaction completion. Expiry before L rejects the transaction. Expiry after valid L permits completion under Variant A while takeover waits. No claim is made that physical WAL durability precedes lease expiry.

Retirement after COMMIT may leave an unresolved outcome. Recovery must acquire these locks and reload durable state; a lock deadline remains unresolved even when an unlocked read shows the old revision. The real lost-acknowledgement test drops server response bytes without parsing the wire protocol, observes durable COMMIT independently, then recovers under the new owner/generation. Replaying the obsolete revision is rejected without duplicates.

## Implemented component

- Append-only migration `0035_receiving_authority.sql`, matching Drizzle schema/snapshot and journal entry: singleton coordinator owner/generation/expiry, per-mailbox epoch/revision/F/E/R, database claim/initialization/recovery functions and mandatory mutation/COMMIT guards. Existing migrations and v1 fields are preserved.
- `receiving-executor.ts` and `receiving-authority.ts`: bounded dedicated transaction lifetimes, revocable lazy SQL access, explicit transaction control and conservative unresolved recovery.
- `message-metadata-persistence.ts`: extracted existing metadata, attachment, conversation and notification behavior. The existing `MessageService` continues using its original transaction and recent-success notification gate.
- `receiving-persistence.ts`: complete bounded fresh/history interval evidence, exact repair keyset evidence, version-aware flags/deletions, epoch replacement and atomic frontier/revision advancement. Empty complete intervals advance correctly; incomplete evidence cannot advance. Each scope handles one mailbox, with a 128-record/2 MiB metadata budget. No external I/O occurs inside persistence transactions.
- `receiving_current_placements` gates this component's active epoch while retaining old physical rows. Global UI/query routing and body publication are future integration work; body writes on enrolled accounts are rejected until integrated. No v1 account conversion is implemented.

The application uses an ordinary PostgreSQL login owning its migrated schema, not a superuser. SQL guards protect the scoped API and ordinary writes, including both identities of moved placements and mutation without revision advancement. They do not defend against an adversarial schema owner disabling triggers, executing DDL or forging transaction settings outside that API. PUBLIC access to new authority objects is revoked. Existing notification retention deletion remains supported. Populated authority state has no automatic downgrade or reset path.

## Real PostgreSQL validation

The receiving fixtures create disposable PostgreSQL **17.6** containers, migrate the complete real journal and use an ordinary application login. They ignore `TEST_DATABASE_URL`. TLS uses a generated fixture certificate and verifies `pg_stat_ssl`; OpenSSL is required (Git for Windows supplies it in this environment). Fixture-only advisory locks/deferred triggers provide observable race barriers. Administrative backend cleanup occurs only in fixture teardown.

| Scenario                                                        | Verified outcome                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capacity 1 and 2; canceled callback and delayed prepared DELETE | Retired SQL cannot execute; replacement commit contains exactly the expected metadata/frontier; old cleanup cannot roll back replacement.             |
| Takeover first                                                  | Old generation is rejected before publication; new owner succeeds.                                                                                    |
| Old valid L first, then expiry and takeover                     | Backend may survive local retirement; recovery deadline is unresolved; takeover waits until old transaction finishes and sees its committed revision. |
| Expiry before L                                                 | COMMIT rejects; state remains unchanged; takeover succeeds afterward.                                                                                 |
| Actual lost COMMIT acknowledgement                              | Durable metadata/frontier recovered under conflicting locks and new generation; stale retry cannot duplicate.                                         |
| Atomic metadata/frontier/conversation/event publication         | Four injected PostgreSQL failures roll back all facts, revision and notification sequence together.                                                   |
| Fresh/history/repair/epoch                                      | Empty intervals, missing evidence, stale revision/epoch, repair deletion and wrap, stale MODSEQ and active-epoch visibility are covered.              |
| Startup, TLS, statement deadline, admission and shutdown        | Owned lifetimes close; suspended scopes are revoked; unrelated reader remains usable.                                                                 |
| Mutation/lifecycle/bounds                                       | Missing authority/revision, moved placement, disabled account, UID maximum and generation overflow are covered.                                       |

Final receiving command: `pnpm exec vitest run tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts --maxWorkers=1 --no-file-parallelism` — **30/30 passed** (26 safety cases plus four retained retirement/startup probes). One cold-client 32-record batch measured 373.40 ms in the accepted TLS-fix run; this is a laboratory sample, not an SLA or load proof.

Existing core/incremental/backfill/conversation/attachment/command/provider/lifecycle regression selection: **204 tests passed across 10 files**. Existing outgoing/sent-copy/provider/MIME selection: **85 tests passed across five files**. The core regression fixtures use PostgreSQL **18.6**, validating migration compatibility and preserved v1 behavior there; the receiving race evidence above is from 17.6. `pnpm typecheck`, `pnpm lint`, changed-file formatting and `git diff --check` all passed in final verification. The earlier whole-repository formatting check found 69 pre-existing experiment/runtime files; those unrelated files were left intact.

The isolated Stage 1 blocker is resolved. Remaining scheduler, IMAP/provider, full query routing, body/MIME, process-suspension, multi-folder and production resource/release validation belongs to later authorized stages. This report does not authorize those stages or production cutover.

## Preserved historical report at 725c8c37cbf3d72a308e013ccc017f97bbc912b6

The following report records the initial conclusion and failed prerequisite assumption. Its BLOCKED status and absence-of-implementation statements describe that historical commit, not the current component.

### Original Stage 1 results — retirement prerequisite blocked

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
