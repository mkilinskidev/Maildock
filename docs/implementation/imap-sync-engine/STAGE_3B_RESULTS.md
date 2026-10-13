# Stage 3B results — isolated multi-account receiving scheduler

Date: 2026-10-13. The original checkpoint below was **BLOCKED**. The separately
authorized two-blocker repair and fresh validation are recorded in the final
section: **PARTIAL repair; Stage 3B acceptance remains BLOCKED**. The component
remains disconnected from the running worker.

Follow-up W=4 shutdown investigation: the timeout did **not** reproduce in five
selected runs, including three with temporary ownership/retirement diagnostics.
Its root cause remains unestablished; no shutdown fix is claimed. See the final
section for the scoped 12/12 shutdown validation.

Latest acceptance finalization: **BLOCKED**, 26/28 in the one corrected full
suite run. Current-first recovery and independently observed fresh visibility
pass; the eight-account W=4 profile does not establish per-account historical
progress. Historical results below are retained. See the finalization section
at the end for assertion contracts, negative controls and measurements.

Latest diagnosis: **CONFIRMED SCHEDULER DEFECT in the distribution of protected
history opportunities**. A complete W=4 trace shows two aged, healthy accounts
receiving zero history admissions despite 16 fully open opportunities each.
Individual cursor choices were legal; fluctuating C=1 availability and the
protected-active gate repeatedly bypassed the same waiting work. No fix was
implemented. See the final diagnosis section; Stage 3B remains BLOCKED.
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

## Authorized two-blocker repair — 2026-10-13

Continued on `feature/imap-sync-stage-3b-scheduler` from clean HEAD
`f542ffd3800714501254a7c7bf4dbc0081e7fc13`. Scope was explicitly limited to the
startup fresh barrier, the observed DB admission/unhandled rejection, targeted
validation and **one** full Stage 3B rerun. The original 13 acceptance scenarios
and their assertions remain unchanged. No Stage 4 work was started.

### Startup and recovery root cause and change

The selector previously allowed an account's freshly established history age
to qualify for protection while other accounts still awaited their first fresh
admission. Fresh being due at construction was insufficient: the exception was
evaluated before normal fresh selection.

`receiving-scheduler.ts` now keeps one transient `initialFreshGranted` flag per
account. Before ordinary or protected history selection, it rotates through
runnable fresh accounts whose initial opportunity is outstanding. Actual fresh
admission sets the flag; every failure clears it and applies the existing
account backoff. A new instance reconstructs this barrier without any durable
startup state. A hung account has received its opportunity once admitted and
cannot require a successful response before healthy accounts progress. A
backing-off account is excluded until its retry becomes due; its recovery fresh
then takes precedence over history exceptions. Account/W allocations and the
shared selector are unchanged.

### DB admission root cause and isolated proof

The shared Stage 1 executor's waiter handoff resolved the waiter's promise but
did not reserve the released slot. A returning borrower's continuation could
start its next transaction before the bounded waiter's continuation resumed.
The waiter then saw `active >= capacity` and failed with
`ReceivingUnresolvedError("admission")`, despite having legitimately queued.

The new **isolated DB waiter handoff** regression uses no IMAP turn and no
authority renewal: 2D borrowers execute six sequential `SELECT` transactions
each, with the first D transactions held at a barrier. Before the fix it
reproduced **5 admission failures at D=1 and 10 at D=2**, in approximately
296/187 ms against 5-second deadlines. Therefore the error did not require
oversized turn concurrency, deadline expiry, history policy or fixture account
interference. The receiving APIs also await each DB operation sequentially;
there is no detached per-turn transaction fan-out.

This isolated failing regression justified the Stage 1 modification.
`receiving-executor.ts` now increments active allocation and marks the waiter
admitted **synchronously before resolving its wake promise**. Resumption does
not allocate a second slot. Slot return skips cancelled/expired waiters; a
waiter cancelled after allocation returns that allocation through the existing
retirement path. D executing/D queued bounds and all original deadlines stay
unchanged. The scheduler's `min(W,2D)` admission cap remains unchanged.

### Detached startup rejection root cause and fix

A separate raw response-relay test detects the driver's actual
`pg_catalog.pg_type` startup query, withholds replies and cancels the one
receiving transaction. Before the fix, the transaction's own error was handled
but Vitest still recorded an unhandled `CONNECTION_CLOSED` from that query.
This happens with **one** borrower, independently of the admission race.

In installed postgres.js 3.4.9, `ReadyForQuery` starts asynchronous
`fetchArrayTypes()` from its synchronous protocol callback. Its returned promise
has no rejection handler. Socket retirement rejects the internal query, and
the async discovery promise becomes detached even though the caller correctly
awaits/catches `reserve()` and the receiving transaction.

`patches/postgres@3.4.9.patch` changes that one ESM driver call to
`fetchArrayTypes().catch(error)`, forwarding rejection to the driver's existing
connection-error path. The patch is registered in `pnpm-workspace.yaml` and
`pnpm-lock.yaml`; package versions did not change. This is the ESM driver used
by the isolated receiving executor, not a replacement DB abstraction. CommonJS
and Cloudflare driver builds were not changed or claimed as validated.

Type discovery stays enabled. The isolated borrower regression also verifies
actual text-array decoding, including a comma-containing element. The startup
cancellation test checks the expected receiving error, waits for late errors
to surface through Vitest's unchanged global reporting, then successfully runs
another transaction through the same executor. No global rejection suppression,
larger pool or extended deadline was added.

`receiving-response-relay.ts` gained an optional raw client-byte observer solely
for this test. It does not parse protocol frames, backend secrets or driver
internals. The first probe had a missing error-class import; after correcting
that fixture typing/import, the test assertion passed while the same unhandled
rejection still independently failed the pre-fix run.

### Targeted validation

Added 15 focused tests: D=1/2 direct waiter handoff; cancellation after handoff;
cancelled driver type discovery; W=1/2/4 crossed with D=1/2 startup ordering;
W=1/2/4 unavailable-account startup; and D=1/2 concurrent stop/restart with
current-first durable visibility and placement identity. The fresh/history
startup tests deliberately use ongoing bounded fresh demand and a 1 ms aging
threshold so the original missing barrier would fail. Separate recovery tests
check fresh recovery without replacing the original acceptance test's stronger
requirement to complete all history.

Final targeted command:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts -t 'isolated DB|targeted startup|targeted recovery|backs off one|coalesces quiet' --maxWorkers=1 --no-file-parallelism
```

**PASS: 17/17 selected tests, 11 skipped, exit 0, 22.65 seconds, no unhandled
errors.** This includes the unchanged hung-account-versus-healthy and quiet
account/diagnostic-exception scenarios. Retained output:
`stage3b-targeted-final.log`. An earlier run of the 15 added cases passed in
18.76 seconds; the direct DB regressions alone passed after repair in
8.16 seconds.

Relevant Stage 1 cancellation/capacity regressions:

```powershell
pnpm exec vitest run tests/receiving-safety.integration.test.ts -t 'bounded admission|bounded startup retirement|shutdown revokes' --maxWorkers=1 --no-file-parallelism
```

**PASS: 5/5 selected tests, 21 skipped, exit 0, 6.54 seconds.** Output:
`stage3b-stage1-targeted.log`. Existing queue overflow/deadline, stalled TCP/TLS
startup and suspended-callback shutdown behavior remained correct.

A preliminary run of the existing mixed cancellation/restart scenarios still
failed W=1/2 at their **complete-history** barrier; W=4, the hung-account and
quiet-account cases passed. That preliminary run also reported a W=1 cleanup
hook timeout. An additional diagnostic rerun of just W=1 observed complete
local DB reservation/driver retirement and the same history-completion barrier
failure, with **no** hook timeout or unhandled rejection (16.45 seconds).
The preliminary hook timeout's specific cause was not established. Temporary
retirement diagnostics were removed; the original scenario was not changed.
No unrelated history/polling/rotation repair was attempted.

### One fresh full Stage 3B result and final checks

The full suite was run **exactly once** after the final selected 17/17 pass:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

**FAIL: 21 passed, 7 failed, 28 total, exit 1, 310.83 seconds. No unhandled
promise rejections or other unhandled errors were reported.** Retained output:
`stage3b-acceptance-rerun.log`. All 15 added focused regressions passed in this
run. Of the original 13 scenarios, 6 passed and 7 failed. The unchanged
sustained-demand W=1/2 scenarios now passed, including startup ordering,
repeated protected commits, fair rotation and the configured wait guard.
The unchanged hung-account, quiet-account and both health/latency-gate cases
also passed.

Remaining failures:

| Original scenario                         | Fresh rerun failure                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| W=1 restart with history completion       | 10-second durable completion barrier timed out                                                                               |
| W=2 restart with history completion       | 10-second durable completion barrier timed out                                                                               |
| W=4 cancellation/restart                  | Test timeout at 120 seconds, then cleanup hook timeout at 120 seconds                                                        |
| W=1 occupied history/fresh responsiveness | Initial held-history fixture barrier timed out                                                                               |
| W=2 occupied history/fresh responsiveness | Initial held-history fixture barrier timed out                                                                               |
| W=4 occupied history/fresh responsiveness | First five post-injection admissions represented four distinct accounts, expected five                                       |
| W=4 sustained-demand/history rotation     | First five protected history accounts were all distinct but in a different order from the required registration-order oracle |

The startup barrier, reproduced DB waiter race and detached ESM discovery
rejection are corrected and covered. **General concurrent teardown is not
fully accepted:** the W=4 timeout above remains a blocker, even though the
focused D=1/2 teardown tests passed. Its cause and any connection to the prior
cleanup timeout are not established. There was no suppressed error, enlarged
pool, raised timeout, oracle edit or automatic broad repair after this result.
The next investigation must distinguish shutdown/resource retirement from
history completion and fixture cleanup; no cause is assumed here.

### Measurements from passing W=1/2 sustained-demand scenarios

These are exact samples in ms from committed turns in the passing original
scenarios. History cost measures admission through the successful turn callback
after DB publication/local retirement. With W=1 it occupies the sole slot and
therefore directly contributes this service time to waiting fresh work; the
fresh wait samples also include earlier account rotation. This is not an
independent injection-to-visibility measurement or an A/B latency comparison.

| W   | Eligible history waits (10 samples, ms)                                               | Protected history costs (10 samples, ms)                                       | Maximum observed fresh admission wait |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------: |
| 1   | 669.57, 805.99, 956.27, 1071.73, 1217.60, 1400.42, 1443.24, 1485.74, 1534.29, 1546.52 | 161.82, 151.64, 137.51, 150.01, 162.34, 169.33, 160.09, 172.71, 161.82, 147.34 |                            1526.14 ms |
| 2   | 158.18, 295.75, 312.85, 445.65, 434.55, 572.20, 555.71, 554.14, 598.96, 641.45        | 147.70, 150.39, 135.96, 136.43, 129.92, 133.58, 119.87, 187.74, 169.97, 152.66 |                             652.56 ms |

Fresh admission waits, including startup, were:

- W=1: 0.04, 174.58, 352.13, 508.36, 669.79, 831.41, 957.64, 1093.79,
  1221.76, 1379.96, 1417.39, 1448.49, 1519.08, 1526.14, 1511.66 ms.
- W=2: 0.02, 0.03, 145.94, 157.74, 292.92, 305.90, 446.18, 448.83,
  582.09, 564.48, 551.85, 529.77, 595.61, 631.11, 652.56 ms.

Both maxima remained below the 5000 ms admission guard. No percentile claim,
passing W=4 fairness result or validated default-setting recommendation is made.
Fresh injection-to-committed-metadata samples remain unavailable because all
three independent-visibility acceptance scenarios failed before sample emission.

### Final static checks and disposition

`pnpm typecheck`, repository `pnpm lint`, changed-file Prettier check (including
both YAML files) and `git diff --check` passed, exit 0. No new full Stage 1/2 or
whole-repository test run was performed; the five relevant Stage 1 regressions
above were the intentionally selected scope. The earlier checkpoint's 115/115
regression result is retained as historical evidence, not a new regression pass
for the driver patch.

Code/test/driver repair commit:
`d12559928bab75f8f9a9dfc8f9d90c415d7a677d`. The pinned dependency patch changes
only the ESM discovery rejection handler; its effect on other consumers or
unmodified CommonJS/Cloudflare builds has not been broadly tested.

**PARTIAL for this limited repair request; BLOCKED for complete Stage 3B
acceptance.** Work stopped after resolving the reproduced startup/admission/
unhandled-rejection defects and collecting this one fresh full result.
Unresolved W=4 retirement and the remaining history/fresh/rotation failures
were recorded without expanding scope. No push, merge, PR, worker integration
or Stage 4 implementation was performed.

## W=4 shutdown-only investigation — 2026-10-13

Continued from clean `3520e0ddd34ecabece18bb37d1015c302005de27` on the requested
branch. Investigated only the preserved W=4 cancellation/restart scenario and
shutdown regressions. **The 120-second test/cleanup timeout was not reproduced.
No precise failing await or concrete production/fixture defect was established,
and the timeout is not declared fixed.**

### Independent reproduction attempts

The original W=4 scenario, including complete durable F/E and placement
assertions, was run without changing its timeout or any acceptance assertion:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts -t 'W=4 bounds simultaneous' --maxWorkers=1 --no-file-parallelism
```

| Attempt                     | Instrumentation                        | Result                                        |          Total run time | Retained local output                |
| --------------------------- | -------------------------------------- | --------------------------------------------- | ----------------------: | ------------------------------------ |
| Baseline                    | None                                   | 1/1 PASS, 27 skipped                          |                 14.47 s | `stage3b-w4-shutdown-baseline.log`   |
| Trace 1                     | Temporary ownership/retirement logging | 1/1 PASS, 27 skipped                          |                 14.56 s | `stage3b-w4-shutdown-trace1.log`     |
| Trace 2                     | Same logging                           | 1/1 PASS, 27 skipped                          |                 12.04 s | `stage3b-w4-shutdown-trace2.log`     |
| Trace 3                     | Same logging                           | 1/1 PASS, 27 skipped                          |                 10.91 s | `stage3b-w4-shutdown-trace3.log`     |
| Final selected shutdown run | All logging removed                    | W=4 scenario PASS within 12/12 selected tests | 25.52 s for three files | `stage3b-w4-shutdown-validation.log` |

Every command completed with exit 0 and no unhandled errors. No full Stage 3B
suite was run in this task. Instrumentation can affect timing; both the baseline
and final uninstrumented case also passed, but five passing cases do not prove
that the historical sporadic timeout is gone.

### Await boundaries and observed resource ownership

Temporary diagnostics used monotonic `performance.now()` timestamps, a unique
DB transaction sequence, account UUID/turn kind, IMAP fixture port and ordered
cleanup identifiers. They bracketed:

- Scheduler `stop()` and each active receiving turn's final settlement.
- IMAP `retireReceiving()` at the actual transport finally boundary.
- PostgreSQL `reserve()`, native socket closure, retirement's awaited reserve
  promise, driver `onclose`/`driverClosed`, and `client.end()`.
- The eight reverse-order `afterEach` cleanup callbacks and the separate
  reader/database/Docker `afterAll` cleanup.

The traces showed no outstanding final await. At the initial stop, four active
accounts retired their hung SELECTs; after restart, all required durable state
and placement assertions completed, followed by safe retirement of remaining
fresh turns. In trace 2, three turns remained active at the second stop; in the
other traces, four remained active. The case's resource assertions verified
zero active scheduler allocations, C=1, at most four local clients and closed
clients after stop.

| Trace | Initial scheduler stop | Post-restart scheduler stop | Reader/database/Docker cleanup |
| ----- | ---------------------: | --------------------------: | -----------------------------: |
| 1     |                4.05 ms |                     4.89 ms |                      379.29 ms |
| 2     |                3.80 ms |                    14.30 ms |                      344.97 ms |
| 3     |                3.07 ms |                     9.82 ms |                      407.53 ms |

These values are differences between diagnostic timestamp samples, not timeout
or performance promises. Already-stopped scheduler cleanup calls also returned.
Observed `client.end()` completions followed reservation and driver retirement;
all peer cleanup callbacks and final Docker cleanup completed. Local closure
does not independently prove immediate server-backend disappearance.

The historical timeout stack names the test body and its `afterEach` hook.
Docker shutdown belongs to `afterAll`, so that stack does not identify Docker
shutdown as the direct blocked await. Without reproduction or instrumentation
from the historical failed run, it also does **not** distinguish a receiving
resource deadlock from peer/executor fixture cleanup or identify a particular
reservation/socket. Neither production leakage nor fixture interference has
been demonstrated by this investigation.

### Final targeted shutdown regressions

After restoring all four temporarily instrumented source/test files byte for
byte from the starting commit, ran only the following selected tests:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-coordinator.integration.test.ts -t 'W=4 bounds simultaneous|targeted recovery|isolated DB cancellation|bounded startup retirement|shutdown revokes|bounded admission|cancels during' --maxWorkers=1 --no-file-parallelism
```

**PASS: 12 tests, 53 skipped, three files, exit 0, 25.52 seconds; no unhandled
rejections.** Coverage: the unchanged W=4 acceptance case; D=1/2 concurrent
stop/restart; cancellation after DB waiter handoff and during type discovery;
Stage 1 bounded admission, stalled TCP/TLS startup and suspended callback
shutdown; Stage 3A cancellation during SEARCH/FETCH.

### Changes and remaining blockers

Only this results document is changed for the final commit. All temporary
diagnostics were removed, with no production change, new speculative regression,
modified acceptance assertion, increased timeout or Stage 1/2 modification.
Changed-document formatting and `git diff --check` passed. TypeScript and lint
were not rerun because the final change is documentation only; the previous
repair's successful static checks are retained above as historical evidence.

**Investigation completed; timeout unresolved/not reproduced.** Complete Stage
3B remains BLOCKED by the last full acceptance result: sporadic W=4 shutdown
timeout, W=1/2 history completion after restart, W=1/2/4 fresh-responsiveness
scenarios and W=4 history-rotation assertion. These independent passes do not
replace that full-suite result or authorize fixes to its other scenarios.
No push, merge, PR, Stage 4 or production integration was performed.

## Acceptance finalization — 2026-10-13

Started on the requested branch with a clean working tree and exact HEAD
`7b90d23f02598db36721636e4322bef255f52fd0`. Re-read the affected scenarios,
scheduler and approved D06 policy, the Stage 3B authorization's D10-style
mechanism, architecture §14.4 and validation H1–H7. The final code changes are
confined to the integration test and this report. Stage 1/2, driver patches,
persistence, transport, worker composition and scheduler policy remain unchanged.

### Assertion contracts and replacements

| Modified scenarios           | Approved invariant                                                                                                                                             | Invalid original assumption                                                                                                                       | Direct replacement                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart W=1/2/4              | Architecture §14.4 current-first restart; validation H6; durable epoch/F/E and placement correctness                                                           | Every account must finish eight historical windows within 10 s while fresh polls are due every 50 ms                                              | First restart retains the 50 ms profile, gates history, and reads exact epoch=7, F=1025, E=1025 and UID 1025 through the independent DB reader. A separate quiet lifetime must finish the same eight windows and exact placements under the unchanged 10 s barrier. Its 30 s poll ensures no new fresh probe becomes due within that barrier.                                                                                                                                                  |
| Fresh responsiveness W=1/2/4 | Fresh-first selection at safe completed-operation boundaries; C=1/W limits; fresh visibility independent of history                                            | History starts even though fresh stays continuously due; first five post-injection admissions must be five distinct registered accounts           | All initial probes complete before history eligibility opens. A 500 ms fixture poll leaves a controlled spare-capacity interval. W actual SEARCH commands are explicitly held, arrivals are injected, and the 550 ms hold makes all polling observations due. Releasing tagged completions returns real slots. The observer rejects ordinary history whenever a known available due-fresh account exists; exact durable UID/F/epoch and incomplete E are independently read for every account. |
| History fairness W=1/2/4     | Approved D06, architecture §14.4, validation H2–H4: bounded protected opportunities, available-account rotation, no consecutive exceptions, durable E progress | First five protected accounts must follow registration order even when some accounts are busy; five accounts at W=4 always exercise a real choice | Use H3's moderate eight-account profile to expose multiple available candidates at W=4. Replay actual admission/completion observations against an independent cyclic-order oracle, rejecting skipped fully-aged available candidates and more than seven consecutive missed safe opportunities for any continuously eligible account. Require real candidate alternatives to be exercised and at least two independently committed descending E windows per account.                          |

The quiet fixture's poll adjustment does not change a test/operation timeout or
product default. A 2 s trial quiet poll still introduced fresh work within the
10 s completion barrier and left E=129 at its boundary; it was not a controlled
all-history execution interval. The final 30 s quiet poll corrects that fixture
eligibility while all fresh responsiveness and sustained-demand cases remain.
All eight original history windows, metadata identities and completion checks
are retained. W=4 restart is corrected consistently with W=1/2; the prior
intermittent shutdown risk is not declared fixed.

Eligibility observations come from admission, completion and actual owned
clients, outside the selector's private state. Completion timestamps are
slightly later than the selector's own timestamps: a 2 ms exclusion band omits
ambiguous due/age threshold-edge candidates from rotation/priority comparison.
It does not add a scheduling grace period. The decisive fresh fixture has a
550 ms held interval versus a 500 ms due interval; its known candidates are
well outside that band. Exact threshold-edge timing is not claimed as measured.

### Independent publication and resource oracle

The disposable PostgreSQL fixture now adds `stage3b_audit` and an AFTER UPDATE
trigger; these are test-only DDL, not a migration or durable scheduler ledger.
Each row atomically records old/new F/E, old/new epoch, revision and the exact
placement UID set for that published interval. Rolled-back updates cannot leave
audit evidence. The independent reader verifies:

- Every revision increments exactly once, epoch remains 7 and each old frontier
  equals the previous committed frontier.
- Fresh publication advances F by at most 128 and leaves E unchanged; sustained
  sparse fresh windows advance exactly 128. History leaves F unchanged and
  lowers E by exactly one bounded window, down to 1.
- The interval's complete placement set equals the scripted mailbox oracle,
  with completed SEARCH/FETCH evidence on that account's actual connection.
- Final F/E/revision match the entire durable audit; all covered placements
  match exact UID/epoch identities with no duplicates or missing covered mail.

Restart also retains exact final placement/epoch checks and the complete E
sequence `[897,769,641,513,385,257,129,1]` for every account. Fresh tests read
each injected UID independently, assert F=1025/epoch=7 while E>1 at visibility,
and verify exactly one UID 1025 placement afterward. Callback counters are not
the durability oracle. Original socket overlap/C=1, W, cancellation, closed
clients, no extra connections and excluded-command checks remain in place.

### Negative controls and restoration

Temporary targeted mutations were applied only to `receiving-scheduler.ts`,
one at a time, and restored to the exact starting implementation after every
run. No mutation is part of the final diff. All final controls produced the
intended failures for W=1/2/4, rather than being accepted as passing tests:

| Control                                                            | Corresponding defect and exact rejection                                                                                                                  | Result / retained output                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Execute history in place of the restart's selected fresh operation | Direct independent-reader assertion rejected E=897 instead of E=1025 before fresh recovery                                                                | 3/3 rejected, exit 1, 11.23 s; `stage3b-negative-recovery-exact.log`                                              |
| Disable all history candidates                                     | Quiet fixture independently rejected unchanged E=1025 instead of complete E=1                                                                             | 3/3 rejected on the final 30 s quiet-poll profile, exit 1, 42.81 s; `stage3b-negative-history-progress-final.log` |
| Select ordinary history before fresh                               | Replayed real boundaries rejected history while an available fresh account was already due; checked during visibility polling, not merely after a timeout | 3/3 rejected, exit 1, 12.53 s; `stage3b-negative-fresh-priority-exact.log`                                        |
| Reset history cursor to zero after every selection                 | Available fully-aged accounts were bypassed; cyclic-order assertion failed during independent durable-progress polling                                    | 3/3 rejected, exit 1, 20.36 s; `stage3b-negative-history-rotation-final.log`                                      |

The first five-account rotation-control trial rejected W=1/2 but **accepted
W=4** (2 failed, 1 passed). That exposed an insufficient test choice set, not
proof that cursor-zero was correct. Moving to the approved eight-account
profile and requiring alternative candidates made the corrected W=4 test
reject the same defect. This strengthens, rather than relaxes, acceptance.

Draft fixture wiring initially failed typecheck and 3/9 affected cases before
message injection; the held-command variable was corrected and all three fresh
cases then passed. A preliminary recovery mutation produced timeout rejections;
the final exact control above instead immediately rejected the independently
observed incorrect E. The initial progress-disabled control already rejected
exact E at W=1/2/4 (43.36 s). The initial priority control rejected W=2/4 directly
and W=1 by the visibility barrier; the final control checks the priority
violation during polling for all three W values. These exploratory results are
retained in local logs, not substituted for the final integrity controls.

### Bounded positive validation and remaining failures

Affected scenarios were tested before the single complete rerun. An early
trial had 6/9 pass and three held-fixture wiring failures (59.82 s). After the
wiring correction, the fresh subset passed 3/3 (14.59 s). With the stronger
eight-account fairness profile, the final affected run was **6 passed, 3
failed, 19 skipped**, exit 1, 80.26 s. Failures: the 2 s quiet-poll completion
assumption, a leftover modulo-5 test index after changing to eight accounts, and
W=4 durable progress. The first two test-fixture issues were corrected; the
remaining W=4 condition was instrumented with independent state snapshots,
without increasing its 15 s barrier or the 1 s history deadline.

The complete Stage 3B focused suite was then run **once**:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

**FAIL: 26 passed, 2 failed, 28 total; exit 1; 98.55 s. No unhandled errors were
reported.** Retained output: `stage3b-finalization-full.log`. All corrected
restart scenarios and fresh responsiveness scenarios passed. W=1/2 protected
history tests passed their cyclic-opportunity, publication and wait checks.

**Failure 1: W=4 per-account durable historical progress remains unverified.**
After 15 s, the independent reader reported the following exact states. Account
numbers below are registration indices for readability, not a required service
order. All eight had revision=17 and no receiving errors.

| Account index |    F |    E | Historical admissions |
| ------------- | ---: | ---: | --------------------: |
| 1             | 2176 |    1 |                     8 |
| 2             | 2432 |  257 |                     6 |
| 3             | 3072 |  897 |                     1 |
| 4             | 3200 | 1025 |                     0 |
| 5             | 2176 |    1 |                     8 |
| 6             | 2560 |  385 |                     5 |
| 7             | 3200 | 1025 |                     0 |
| 8             | 3200 | 1025 |                     0 |

This is not dismissed as a registration-order discrepancy: three healthy
accounts repeatedly committed fresh metadata but had no historical admission,
while two completed all history. The test did not observe a skipped fully-aged
available candidate at a protected selection boundary; per-account availability
under C=1 and the single active protected-operation gate may constrain which
accounts reach those boundaries. A precise implementation defect versus a
missing safe opportunity has **not** been proven. The required progress
guarantee is therefore unverified and acceptance is BLOCKED. No policy change,
deadline increase, gate removal or broad refactoring was guessed from this
snapshot. The 15 s reference barrier is an observation bound, not a production
promise; its failure prevents this fixture from proving the required guarantee.

**Failure 2: unchanged hung-account timing assertion.** The existing test
required the healthy account's first callback to occur before the hung
account's 300 ms timeout callback. Observed timestamps were 92755.1399 and
92719.9810 ms respectively: healthy success occurred **35.1589 ms after** that
failure callback. Other assertions in that test had passed, including healthy
F=1025/E=1, no healthy errors, bad-account unchanged F and retries `[200,400]`.
This relative callback deadline is not a stated product guarantee of immediate
admission or completion. It is newly failed and outside the three requested
scenario corrections; it was recorded without silently changing its assertion
or running a broad repair loop. Its proper independent acceptance oracle needs
separate review.

### Fresh visibility and historical measurements

These are exact independent-reader injection-to-durable-visibility samples from
the full rerun, in ms; polling observation makes them upper bounds on actual
commit latency. Each includes the deliberately imposed 550 ms held-command
interval. Every sample's corresponding UID was visible with epoch=7, F=1025
and E>1; all placement and resource assertions passed.

| W   | Individual samples (ms)                     |    Maximum |
| --- | ------------------------------------------- | ---------: |
| 1   | 916.89, 1092.07, 1262.48, 1452.73, 1634.46  | 1634.46 ms |
| 2   | 873.26, 901.40, 1142.36, 1176.81, 1417.81   | 1417.81 ms |
| 4   | 1068.68, 1091.11, 1185.99, 1204.33, 1432.65 | 1432.65 ms |

Five samples per W are reported without p50/p95 claims or provider SLA inference.
All were below the unchanged 5000 ms reference visibility guard.

| Passing sustained-demand profile | Real alternative history choices checked | Maximum consecutive skipped eligible opportunities | Historical wait range | Committed protected-turn cost range | Maximum fresh admission wait |
| -------------------------------- | ---------------------------------------: | -------------------------------------------------: | --------------------- | ----------------------------------- | ---------------------------- |
| W=1, eight accounts              |                                       16 |               7 (below one eight-account rotation) | 1651.12–3273.41 ms    | 169.89–268.11 ms                    | 3292.68 ms                   |
| W=2, eight accounts              |                                       43 |                                                  3 | 500.41–10704.88 ms    | 195.43–396.54 ms                    | 4724.72 ms                   |

Every account in these two profiles independently committed at least the exact
E sequence `[897,769]`, with complete interval placements and no fresh reset of
E. Full individual diagnostic wait/cost samples are retained in
`stage3b-finalization-full.log`. History costs include admitted transport/DB
service through the acknowledged publication callback; these diagnostics are
corroborated by the independent atomic audit. W=1 time in history directly
occupies the sole slot, but no A/B incremental-latency claim is made. Both fresh
wait maxima remained below the existing 5000 ms guard. W=4 has no accepted
historical fairness/progress measurement.

### Final regression/static results and disposition

Impacted regressions passed **115/115 tests in six files**, exit 0, 59.39 s;
no unhandled errors were reported. Output: `stage3b-finalization-regressions.log`.
The single-account Stage 3A sample was 524.54 ms, E=257, and is not a Stage 3B
measurement. Command:

```powershell
pnpm exec vitest run tests/receiving-coordinator.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-inbox-window.integration.test.ts tests/imap-metadata-window.test.ts tests/imap-conditional-store.test.ts --maxWorkers=1 --no-file-parallelism
```

The final history-disabled control rejected all three W cases on the final
quiet fixture with direct E=1025 versus E=1 assertions, exit 1, 42.81 s.
Thus all four final controls rejected 3/3 corresponding defects each (12/12
intentional rejections). The scheduler file was restored after every control;
`git diff -- src` is empty. The full Stage 3B suite was not rerun.

Typecheck, repository lint, changed-file Prettier and `git diff --check` passed,
exit 0. No test/operation deadline, DB capacity or product default was raised.

**BLOCKED for Stage 3B readiness.** The original assumption errors have direct
replacement oracles and verified defect-detection controls, but green corrected
restart/fresh cases do not prove per-account historical progress at W=4. The
intermittent W=4 shutdown/cleanup timeout remains disclosed and unreproduced;
this task did not launch a reproduction campaign solely for it. No new
production correctness defect was conclusively isolated or fixed. Stage 4,
production integration, real accounts, push, merge and PR remain out of scope.

## W=4 history starvation diagnosis — 2026-10-13

Started from clean, exact HEAD
`5e2a5e253c9a770a05827d9f4cdf7598ba7d98c6` on the requested branch.
Investigated only the unchanged eight-account W=4 sustained-demand scenario.
**CONFIRMED SCHEDULER DEFECT: protected-history opportunity distribution is
not fair under changing account availability.** This is an end-to-end
fairness/liveness defect, not a corrupted cursor or an illegal individual
selection. The original registration-order assertion is not reinstated and
the current fairness requirement is not relaxed.

### Bounded instrumentation and exact run scope

The only command used for test execution was:

```powershell
pnpm exec vitest run tests/receiving-scheduler.integration.test.ts -t 'W=4 rotates continuously' --maxWorkers=1 --no-file-parallelism
```

Temporary diagnostics, enabled by `MAILDOCK_HISTORY_DIAGNOSTIC`, wrapped the
existing selector without changing any branch, candidate, timing, capacity or
policy. Each selection recorded the pre-selection account active/exclusion
state, available accounts, due fresh, history eligibility/age, `historySince`,
`freshDue`, `retryAt`, cursors, `lastProtected`, `protectedActive`, the exact
fresh-wait predicate and chosen account/kind. Reasons included active C=1,
backoff, unknown/complete history, insufficient age, fresh-wait envelope,
startup barrier and both protected-history gates. Account UUIDs/mailbox UUIDs
were mapped once to registration indices; time was monotonic and relative to
this scheduler lifetime. No health callback was supplied, so its gate was the
original default true; it was not re-invoked by instrumentation.

The buffer was capped at 256 events and printed only after normal test cleanup
stopped the scheduler. No per-decision terminal I/O, unbounded log collection,
new timer, framework or benchmark was added. Test-only cleanup diagnostics
then used the existing independent PostgreSQL reader/audit and exact publication
oracle to verify committed F/E/revision/epoch, all covered UID placements,
completed SEARCH/FETCH evidence and final closed-client/C=1/W allocations.

| Run            | Result                       | Total duration | Evidence completeness                                                       |
| -------------- | ---------------------------- | -------------: | --------------------------------------------------------------------------- |
| Initial trace  | 1 failed, 27 skipped; exit 1 |        22.65 s | 256 recorded events; 100 later events dropped; complete final durable audit |
| Complete trace | 1 failed, 27 skipped; exit 1 |        21.95 s | 154 selections + 31 completed history events = 185 events; zero dropped     |

The second run removed **fresh completion logging only** from the buffer to
retain all decisions within the same cap. It did not change the scenario or
selection policy. Final fresh commits remain independently present in the SQL
audit. The complete trace spans selection timestamps 0.27–14989.30 ms.
Raw local evidence: `stage3b-history-diagnosis.log` and
`stage3b-history-diagnosis-complete.log`; bounded derived summaries:
`stage3b-history-diagnosis-summary.log` and
`stage3b-history-diagnosis-complete-summary.log`. No full Stage 3B suite or
shutdown-timeout reproduction was run, and no unhandled error was reported.

### Durable state and completed historical work

The complete run's post-retirement independent SQL audit produced:

| Account index |    F |    E | Revision | History admissions | Completed historical commits | Committed E sequence          |
| ------------- | ---: | ---: | -------: | -----------------: | ---------------------------: | ----------------------------- |
| 1             | 2432 |    1 |       19 |                  8 |                            8 | 897,769,641,513,385,257,129,1 |
| 2             | 2560 |  129 |       19 |                  7 |                            7 | 897,769,641,513,385,257,129   |
| 3             | 3456 |  897 |       20 |                  1 |                            1 | 897                           |
| 4             | 3328 |  897 |       19 |                  1 |                            1 | 897                           |
| 5             | 2432 |    1 |       19 |                  8 |                            8 | 897,769,641,513,385,257,129,1 |
| 6             | 2560 |  257 |       18 |                  7 |                            6 | 897,769,641,513,385,257       |
| 7             | 3328 | 1025 |       18 |                  0 |                            0 | None                          |
| 8             | 3328 | 1025 |       18 |                  0 |                            0 | None                          |

All eight had zero receiving errors and epoch 7. Account 6's final admitted
history operation was not committed before stop; admission is not publication.
The resource and exact-placement audit passed for all accounts after cleanup.
The 31 completed historical turns took approximately **309.91–605.15 ms** from
selection observation to acknowledged turn completion, below the unchanged
1000 ms history budget. This corroborates a serviceable fixture and actual
historical publication elsewhere; it does not assert a provider SLA or that
every hypothetical alternative operation would have succeeded.

The initial trace independently finished with admissions
`[8,8,4,0,8,8,3,0]`; accounts 4/8 had E=1025 and zero historical commits.
The historical full-suite vector `[8,6,1,0,8,5,0,0]` is retained above. Thus the
exact zero-history indices vary with timing: this is not a hard-coded exclusion
of account indices 4/7/8. The same mechanism affected all three original index
positions across these observations. The original run had no complete decision
trace, so its individual past decisions cannot be reconstructed exactly.

### Safe opportunities versus legitimate exclusions

An **open opportunity for account i** below means that the scheduler really
called selection with a free W allocation, account i was inactive (C=1 free),
outside backoff, had known pending E>1, was fully aged, passed its fresh-wait
guard, startup current opportunities were complete, and both protected gates
were false. These are actual selection events, not hypothetical mid-operation
preemption or an assumption that a busy account was available.

| Complete trace                                                      | Account 4 | Account 7 | Account 8 |
| ------------------------------------------------------------------- | --------: | --------: | --------: |
| Pending/fully-aged selection observations                           |       143 |       142 |       142 |
| Excluded as active with C=1 held                                    |        53 |        53 |        52 |
| Available, fully aged and fresh-wait guard passed                   |        79 |        79 |        80 |
| Of those, blocked by protectedActive                                |        63 |        63 |        64 |
| Of those, protectedActive true and lastProtected false              |        47 |        44 |        48 |
| Of those, lastProtected true (also protectedActive true)            |        16 |        19 |        16 |
| Fully open opportunities                                            |        16 |        16 |        16 |
| Open opportunity selected for this account's history                |         1 |         0 |         0 |
| Open opportunity assigned to another history account                |        15 |        16 |        16 |
| This account selected fresh despite being aged/available/guard-safe |        15 |        16 |        16 |

Active exclusions are legitimate and account for part of the waiting, but do
**not** explain the whole result. Accounts 7/8 were genuinely available at 16
history-admission decisions each and were never chosen. Neither backoff,
authority failure, unknown history nor missing account eligibility explains
those 16 events. There were 17 selection events with a failed global
fresh-wait predicate during the run; these legitimately paused protection but
are excluded from the open-opportunity counts. The fresh-wait guard was not a
permanent block for the zero-history accounts. No event for either account was
blocked by `lastProtected` alone.

The instrumented selections always had at most three existing active turns
before admitting the fourth. The original C=1/W resource assertions passed.
The trace found **zero violations of instantaneous protected-candidate
round-robin**: each chosen historical account was exactly the first currently
admissible candidate at/after the history cursor. The flaw appears across
successive eligibility changes, not within one candidate list.

### Exact mechanism: phase-dependent bypass with no missed-opportunity debt

Early protected selections alternated between availability groups:

| Relative time | History cursor before selection | Fully admissible history candidates | Active accounts | Selected history |
| ------------- | ------------------------------: | ----------------------------------- | --------------- | ---------------: |
| 580.23 ms     |                               1 | 1,2,3,4                             | 6,7,8           |                1 |
| 892.65 ms     |                               2 | 5,6,7,8                             | 2,3,4           |                5 |
| 1296.39 ms    |                               6 | 1,2,3,4                             | 6,7,8           |                1 |
| 1661.03 ms    |                               2 | 5,6,7,8                             | 2,3,4           |                5 |
| 2077.03 ms    |                               6 | 1,2,3,4                             | 6,7,8           |                1 |
| 2510.18 ms    |                               2 | 5,6,7,8                             | 2,3,4           |                5 |

At each individual boundary the cursor correctly skipped active accounts.
However, those skipped accounts did not retain an effective claim on a later
safe opportunity. When they were next available, a lower-index candidate
appeared earlier on the advanced/wrapped cursor. When the cursor returned to
their positions, they were again active with freshly admitted current work.
After accounts 1/5 completed their eight windows, the same effect mostly
alternated history between 2/6. At 8644.31 ms, cursor 7 skipped active 7/8 and
selected 2 from candidates 2,3,4. At 9025.06 ms, available candidates were
6,7,8, but cursor 3 selected 6. That pattern repeated through multiple cycles.

Fresh resubmission sustains the phase pattern. At **974.02 ms**, account 7 had
historySince=653.99 ms, freshDue=653.99 ms, retryAt=0 and was available.
Its projected fresh wait was 1687.36 ms, safely below 5000 ms. `lastProtected`
was false but `protectedActive` true, so fresh 7 was selected. At **1058.44 ms**,
account 8 was similarly available/aged, with historySince/freshDue=693.94 ms,
retryAt=0 and projected wait=1771.78 ms; fresh 8 was selected for the same gate
reason. Their new fresh turns subsequently held C=1 as the cursor passed them.
All 16 aged/guard-safe fresh resubmissions of each zero-history account occurred
while `protectedActive` was true (account 7: 13 protected-only and 3 with both
flags; account 8: 16 protected-only). Guard projections for those resubmissions
ranged 1687.36–4811.79 ms and 1565.67–4851.25 ms respectively.

`historySince` was not reset by those fresh turns: the waiting age correctly
continued to accrue. But `select()` only converts age into a boolean threshold.
Once all candidates are aged, a 14-second-old historical request has no more
effective protection than a recently serviced request that again exceeds
100 ms. `rotate()` advances beyond unavailable accounts without remembering
their missed historical opportunities. Combined with serial protected-history
execution and immediate fresh re-admission, that permits repeated bypass of
the same waiting work even when later safe choices exist.

### Contract finding and recommendation only

The approved [D06 policy](../../design/imap-sync-engine/DECISIONS.md) and
[architecture §14.4](../../design/imap-sync-engine/SYNC_ENGINE_ARCHITECTURE.md)
require occasional safe historical opportunities under sustained current
demand, with account rotation and transient eligible-wait/missed-opportunity
protection. [Validation H3](../../design/imap-sync-engine/SYNC_ENGINE_VALIDATION.md)
requires each aged candidate to receive a unit within one full safe history
rotation. Global historical progress alone does not satisfy that per-account
fairness requirement.

**That end-to-end distribution contract is violated in the observed reference
profile.** Accounts 7/8 were intermittently, not continuously, physically idle;
the finding does not pretend otherwise. But their aged work repeatedly passed
all real gates at 16 protected-history decisions without one grant, while
other accounts received eight grants each. Thirty-two historical admissions
were available globally, enough for the required sixteen first/second units.
This is not solely hard overload, a permanently busy account, a mistaken demand
for immediate preemption, or a fixed-registration-order assertion. Passing a
weak instantaneous rotation check does not prove fair protection across the
changing C=1 eligibility set.

**Smallest justified recommendation, not implemented:** retain the current
startup, W/C=1, health/backoff, fresh-wait guard, one active protected turn and
fresh-between-exceptions gates. At the already-authorized protected-history
selection boundary, make accumulated eligible wait effective when choosing
among fully aged, admissible candidates: prefer the longest outstanding
`historySince` and use the existing cursor for ties. Alternatively use the
approved bounded transient missed-safe-opportunity counter, but that requires
additional state; reusing the existing timestamp is the smaller candidate
change. Keep ordinary spare-capacity history and fresh rotation unchanged.
This is local tie/choice ordering inside the bounded exception, not a global
continuous priority-score promotion, fixed quota, worker reservation, second
scheduler or durable ledger. It needs separate implementation authorization
and regression validation; no after-fix behavior is claimed here.

Do not simply remove the protected-active gate, enlarge budgets or weaken the
eight-account progress assertion: those changes would alter other guarantees
without addressing the missing account-debt effect directly.

### Remaining uncertainty, cleanup and disposition

The diagnosis proves repeated safe-opportunity bypass in a bounded 15 s trace,
not infinite starvation in every workload. Earlier historical operations can
eventually complete and change candidate sets, and timing affects which account
has zero or one grant. The exact historical zero vector cannot be replayed
retroactively. The recommendation has not been executed or simulated and its
effect on all fairness/latency gates remains untested. Configured budgets and
the fixture's default-true health gate are the observed admission model, not a
measurement of every hypothetical alternative DB/IMAP outcome.

All temporary scheduler/test diagnostics and the local analysis script were
removed. Production and test files were restored byte-for-byte from the base
commit; `git diff -- src tests` is empty. Only this report is committed. Report
formatting and `git diff --check` passed; no new typecheck/full suite/broad
regression run was needed for the final documentation-only diff.

**CONFIRMED SCHEDULER DEFECT; Stage 3B remains BLOCKED.** No correction was
implemented, no other investigation was started, and no push, merge, PR, worker
composition change or Stage 4 work was performed.
