# Stage 3B results — isolated multi-account receiving scheduler

Date: 2026-10-13. **BLOCKED: focused acceptance failed.** This is an
unaccepted implementation checkpoint, disconnected from the running worker.
Stop-on-critical-gate-failure was applied: no acceptance assertion was weakened,
no Stage 1/2 repair was attempted, and Stage 4 was not started.

## Git and scope

The initial working tree was clean on
`feature/imap-sync-stage-3a-coordinator`. Actual HEAD and the expected accepted
Stage 3A base both resolved to
`d37ff4a7da4a19b2a8a5992d56e320a4d7be30aa`. The ancestry check succeeded.
Remote: `git@github.com:mkilinskidev/Maildock.git`. Created the requested
`feature/imap-sync-stage-3b-scheduler` branch without overwriting a branch.
No push, merge, PR, production database or real account was used.

Read the Stage 3 architecture/plan, final history policy, fairness validation,
decision log, Stage 3A results and actual receiving APIs. The implementation
reuses Stage 1 recovery/authority/persistence and Stage 2 bounded transport.
Worker composition, migrations, SMTP, OAuth, drafts, UI, pg-boss and IDLE were
not modified. No durable queue, credit ledger or orchestration framework was
added.

## Implemented scheduling model — not accepted

`receiving-coordinator.ts` now exports `runOneReceivingTurn`, extracting the
existing authority-renewal plus recover/receive/publish operation. Stage 3A
retains its original single-account autonomous loop and timing configuration.
The shared scheduler invokes the extracted operation directly; it never starts
per-account coordinator loops.

`receiving-scheduler.ts` maintains one fixed registration array, separate
round-robin cursors for fresh/history, one active flag per account and a bounded
set of active promises. Due fresh is normally selected before history.
History is inferred from the last successfully recovered/committed E > 1;
the actual turn always recovers durable state again before SELECT. Fresh due
observations and all rotation/aging/backoff state are transient.

There is one explicit selection boundary for future user work, with no command
submission API or implemented message actions. Diagnostic callbacks are
synchronous observers; exceptions are contained and cannot turn an acknowledged
publication into a retry. Connections are created only inside admitted turns.

The scheduler reserves at most W receiving turns and one per account. The
supplied shared `ReceivingExecutor.capacity` is the separately configured DB
capacity D, independent of W and of the application's general DB pool. Stage 1
allows D executing and D waiting transactions. Whole-turn admission is
conservatively capped at `min(W, 2D)` to keep simultaneous transaction requests
within that existing queue bound. For W=4/D=1, the effective receiving limit is
2; W=4/D=2 permits 4. This cap did **not** establish successful multi-account
DB admission in acceptance: admission errors remain a blocker below.

The active/account allocation is released after the receiving operation settles
its local IMAP/DB retirement, before another selector dispatch. Stop aborts the
shared lifetime, wakes the sleeping selector, stops admission and awaits active
tasks. It leaves the caller-owned executor available for restart. Registration
is limited to 128 accounts by default; there is no per-notification work queue.

## History protection and provisional settings

One per-account eligible-history timestamp requests an exception once the wait
threshold is reached. Selection resets its age on actual history admission.
A protected operation uses the shorter history deadline, applies account/global
capacity, backoff and the synchronous history-health gate, and requires
`oldest fresh due age + history deadline <= freshWaitGuardMs`. This is an
admission-age guard, not a promise of end-to-end visibility, physical retirement
time or completion of all earlier urgent work. There is at most one protected
history operation active; a fresh admission must separate protected exceptions.
Ordinary history uses capacity when no admissible fresh candidate exists.

| Setting                      | Provisional default | Meaning                                                        |
| ---------------------------- | ------------------: | -------------------------------------------------------------- |
| workers                      |                   2 | Maximum receiving operations W                                 |
| maxAccounts                  |                 128 | Fixed registration bound                                       |
| historyWaitMs                |           30,000 ms | Eligible wait before requesting protection                     |
| historyTurnMs                |            2,000 ms | History operation deadline, further capped by account deadline |
| freshWaitGuardMs             |            5,000 ms | Admission-age envelope for history exceptions                  |
| account pollMs               |           15,000 ms | Existing Stage 3A fresh polling interval                       |
| account operationMs          |           10,000 ms | Existing absolute receiving turn deadline                      |
| account retryMs / maxRetryMs |   1,000 / 30,000 ms | Independent exponential account retry                          |
| D                            |     Caller supplied | Shared Stage 1 DB executor capacity, 1–16                      |

The 2-second history budget follows the architecture's desired healthy unit
cost; the other history values are isolated hypotheses. The requested focused
measurements did **not** justify these defaults for enablement. Tests use much
smaller aging thresholds (100 ms) and a 1-second history budget to exercise
multiple opportunities reproducibly. No production numerical target was
approved or inferred from these tests.

## Recovery and the critical startup defect

Every failure clears the history candidate, sets fresh due and enters the
account's own capped backoff. Recovery uses existing generation/epoch/revision
fences. Other accounts remain selector candidates. A new scheduler starts all
accounts fresh due, discarding old interval results, credits and clocks.

**The implementation lacks the required global startup current-opportunity
barrier.** History may age after the first account's fresh success and become a
protected candidate before remaining startup accounts receive their first
fresh opportunity. In the W=1 sustained-demand test, the first five admissions
were `fresh, fresh, history, fresh, history`, instead of five startup fresh
opportunities. W=2 also admitted history before the fifth startup fresh turn.
This is a direct critical recovery/priority gate failure, not an accepted
policy exception. Implementation work stopped when the failed run was read.

## Focused integration results

Environment: Windows, Node 24.21.0, pnpm 12.7.0, disposable
`postgres:17.6-alpine`, scripted TLS IMAP peer with actual installed ImapFlow.
The fixtures ignore `TEST_DATABASE_URL` and use a schema-owning ordinary DB
login, matching the Stage 3A approach. Five accounts use moderate sparse
1024-UID histories; sustained fresh demand replenishes one sparse 128-UID window
per completed fresh turn, retaining a bounded two-window backlog.

Command:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

**FAIL: 2 passed, 11 failed, 13 total; one unhandled rejection; exit 1;
78.29 seconds.** Retained raw local output: `stage3b-focused.log`.

| Scenario                                          | Result / observed failure                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| W=1/2/4 simultaneous cancellation and restart     | All three failed the durable restart/history completion barrier                                                  |
| W=1/2 occupied history followed by injected fresh | Failed reaching the initial held-history fixture barrier                                                         |
| W=4 occupied history followed by injected fresh   | Post-injection admission assertion observed four fresh then history                                              |
| W=1/2 sustained fresh with history protection     | Startup fresh barrier violated as described above                                                                |
| W=4 sustained fresh with history protection       | Strict expected history rotation assertion failed; one account appeared twice in first five protected selections |
| One hung account plus healthy account             | Healthy account recorded four `ReceivingUnresolvedError(phase="admission")` errors                               |
| History health gate and restoration               | PASS                                                                                                             |
| History latency gate                              | PASS                                                                                                             |
| Quiet accounts / W=4, D=1 / diagnostic exceptions | Failed quiet-account completion barrier                                                                          |

The unhandled rejection was postgres.js `write CONNECTION_CLOSED` during its
startup `pg_catalog.pg_type` query, attributed by Vitest to the first restart
test. Its relationship to concurrent executor admission is **not established**.
The `min(W,2D)` queue-size bound does not prove race-free slot handoff in the
executor; determining the source of these admission failures requires a
separately reviewed investigation. Stage 1 code was not changed.

Some timing/rotation assertions may need eligibility-aware fixture review, but
that is not permission to weaken them or waive the confirmed startup defect.
In particular, the W=4 post-injection sequence alone does not prove a
fresh-priority violation when a fresh account remains active or not yet due.

## Measurements

**No accepted numerical fresh-latency or history-wait measurement is available.**
The test emits numeric samples only after its assertions pass; the measurement
scenarios failed before emission. No p50/p95, maximum or fairness target is
claimed. Fixture delays (15/250 ms), test thresholds and test-run duration are
controls or execution times, not injection-to-committed-metadata measurements.
The observed scheduling sequences and admission-error counts above are the
available evidence. The latency guard is only tested for suppression; passing
safe history and fresh coexistence remains unproven.

## Regression and static checks

The independent regression run passed **115/115 tests in six files**, exit 0,
47.50 seconds: all 11 Stage 3A tests plus the 104 selected Stage 1/2 and
conditional STORE regressions. Its retained output is `stage3b-regression.log`.
The Stage 3A sample was **453.80 ms** fresh durable visibility with E=257; this
is a single-account regression sample, not a Stage 3B measurement.

```powershell
pnpm exec vitest run tests/receiving-coordinator.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-inbox-window.integration.test.ts tests/imap-metadata-window.test.ts tests/imap-conditional-store.test.ts --maxWorkers=1 --no-file-parallelism
```

TypeScript checks passed after correcting configuration types and fixture
mutability typing; those changes do not alter the failed runtime acceptance
assertions. Repository lint passed with no reported warnings. The first changed
file formatting check found two files needing formatting after typing edits;
formatting was then corrected without behavioral edits. Final changed-file
Prettier and `git diff --check` both passed, exit 0.
No full repository test suite or real-provider matrix was run.

## Remaining risks and Stage 4 readiness

Stage 3B is **BLOCKED**, not PARTIAL acceptance or production ready. Mandatory
startup ordering, multi-account recovery, admission reliability and measured
latency/fairness remain unaccepted. Historical progress was observed far enough
to reach rotation assertions, but does not satisfy the complete acceptance
contract. Infinite overload/provider unavailability still have no progress
guarantee; shorter deadlines can safely abort history without advancing E.

Next work requires authorization to resolve the recorded blockers and rerun the
unchanged acceptance gates, including a review of concurrent DB admission and
the startup barrier. Stage 4 election, durable wakes, IDLE, worker composition
and production cutover remain out of scope and were not begun.
