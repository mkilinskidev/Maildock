# Phase 3b targeted priority review

Reviewed baseline: `73406ff39f821303395af4d8fdd47b1a910b9408` on
`codex/gmail-api-complete-provider`. Review date: 2026-10-11.

## Scheduler and worker consistency

Baseline: **FAIL**. Corrected implementation: **PASS**.

Confirmed defects:

- Admission used PostgreSQL time while the worker used `Date.now()` for lower
  priority aging and history discovery. A deterministic one-hour host clock
  skew reproduced admission P1 versus an actual worker P0 drain.
- Admission's lower-work age and history-pending/ceiling checks included stale
  account revisions. An aged stale row changed admission to P1 while the worker
  cleaned stale work and executed current P0. The baseline SQL reproduction is
  retained in the regression test. Stale rows also must not fill the discovery
  ceiling; a 5,000-row stale backlog regression verifies the existing 500-row
  cleanup bound and current P0 discovery.
- Admission did not anticipate the provider's account-revision reset. The
  baseline SQL admitted P1 from the old state after the live revision advanced;
  the authorized worker resets that state and bootstraps as P0. The regression
  compares the baseline query, corrected admission and actual bootstrap, and
  verifies that a stale delivery cannot make Gmail requests.
- The adapter updated stored job priority after pg-boss returned its result, so
  delivery metadata could retain the previous priority. Also, a fairness or
  state transition between admission and execution could change the class of
  work without changing the capacity reservation. Gmail delivery metadata now
  contains the frozen admitted priority; the worker rechecks under account
  authority and yields when its class differs. The ordinary durable poller
  admits a successor; no new queue or scheduling mechanism was added.

The shared SQL policy selects the action and class using the database statement
clock, the current revision and current history/inventory runs. It preserves
P0 preference, the eight-slice allowance, aged lower work only after at least
one higher slice, and P1/P2 alternation. It also distinguishes discovery,
draining, history probing/checkpointing and inventory work. Inventory cannot
bypass an active history discovery operation.

Deterministic regressions compare admission with actual Gmail worker execution
against the same persisted states: mixed fresh/aged classes, both alternation
directions, first P0 despite aged lower work, history below/at the ceiling,
inventory with/without due history discovery, stale work, revision reset,
history probe/checkpoint/start, legacy discovery-clock initialization,
class changes after a real pg-boss claim, quota/network deadlines and retry
jobs. They use real PostgreSQL/pg-boss and synthetic Gmail HTTP responses;
there are no live mailbox operations or timing sleeps.

## PostgreSQL admission performance

Baseline: **FAIL** for concentrated backlog. Corrected implementation: **PASS**
for the measured matrix. This is a local comparative result, not a production
latency guarantee.

The opt-in benchmark lives in
`tests/gmail-priority-review.integration.test.ts`. It extracts the actual
baseline query from Git, including substitution of `OFFSET 4499`, and compares
it with the current exported query on the same data without claiming jobs.
Full first-sample before/after plans, all execution/planning times, buffer
statistics, work-table scan summaries, database version/settings and actual
index definitions are in
[the benchmark artifact](sync-priority-phase-3b-review-benchmark.json).

Methodology:

- Disposable `postgres:18.6-bookworm`, real application migrations, bundled
  authority initialization, and pg-boss **12.33.7** queue setup.
- 27 scenarios: 10/50/100 Gmail accounts × 500/5,000/20,000 **total pending
  identities** × three distributions. Balanced work is 40% P0 / 30% P1 / 30% P2.
  Hot history cases concentrate all identities on one account, with 90% P1
  history and 10% P2 inventory; 5,000 identities place history exactly at 4,500,
  and 20,000 represent an existing backlog above the ceiling. Hot inventory
  cases use 5% P0 / 5% P1 / 90% P2, including 18,000 inventory identities.
- Each account-count scenario includes active jobs (1 / 4 / 6 respectively),
  future retry jobs and quota deadlines. State includes mixed fairness bursts
  and alternation markers, fresh and aged work. Retry jobs are delayed ten minutes. Queue capacity is eight; its reserved P0 slot is unchanged.
- `ANALYZE` work/state/accounts/job tables after every seed. One untimed warm-up,
  then three `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` measurements for each
  query/scenario. Reported values below are warm execution medians in ms.
  Baseline runs precede candidate runs; these are not cold-cache measurements.
- Existing application and pg-boss indexes are used unchanged. No global JIT
  setting, quota, worker concurrency, queue capacity or resource limit changed.

| Accounts | Total identities | Balanced before / after (ms) | Hot history before / after (ms) | Hot inventory before / after (ms) |
| -------: | ---------------: | ---------------------------: | ------------------------------: | --------------------------------: |
|       10 |              500 |                0.530 / 0.548 |                  41.100 / 0.991 |                    50.763 / 1.120 |
|       10 |            5,000 |                1.547 / 3.431 |                  41.999 / 3.413 |                    46.545 / 3.525 |
|       10 |           20,000 |               5.427 / 10.504 |                 59.947 / 13.200 |                   54.098 / 13.724 |
|       50 |              500 |                0.840 / 0.982 |                 685.219 / 1.263 |                   751.265 / 1.620 |
|       50 |            5,000 |                3.092 / 3.765 |                 714.132 / 3.829 |                   860.326 / 5.678 |
|       50 |           20,000 |              10.287 / 11.306 |                783.898 / 12.707 |                  837.416 / 15.379 |
|      100 |              500 |                1.131 / 1.375 |                 733.191 / 1.498 |                   817.547 / 2.799 |
|      100 |            5,000 |                3.084 / 3.719 |                 799.934 / 3.850 |                   900.732 / 4.151 |
|      100 |           20,000 |              11.643 / 13.221 |                763.015 / 14.872 |                  899.990 / 13.269 |

The confirmed baseline bottleneck was repeated correlated scans of the same
pending work (including the offset ceiling probe, lower-work age, history
existence and class selection). Skewed per-account estimates increased plan
cost enough to trigger expensive JIT optimization/emission, even where most
accounts had no work. The captured plans distinguish JIT cost from scan time.

The narrow SQL correction materializes eligible jobs, summarizes pending
identities once by account/revision/run/purpose, then filters those small
summaries against current state. Current-run counts replace `OFFSET 4499` and
reuse the shared class policy. Global account rotation, P0 reserved capacity,
backfill exclusion, retry eligibility and the pinned pg-boss fetch/settlement
remain intact. No index migration was justified by the measured result.

For 100 accounts / 20,000 hot history identities, the representative baseline
plan spent 698.766 ms in JIT. Its ceiling/age/existence/class-selection
subplans repeatedly accessed pending work. The corrected plan has one work
scan (loops=1, rows=20,000, shared hits=2,390),
followed by grouped run summaries and small joins; no JIT block appears in this
plan. The highest corrected scenario median is 15.379 ms; the
highest individual corrected sample is 15.593 ms.

Balanced workloads can become modestly slower because the summary counts all
eligible pending identities rather than relying on short-circuiting probes;
the table reports that tradeoff explicitly. Concentrated workloads no longer
show the baseline account-count amplification or JIT latency cliff.

The baseline balanced plans use `gmail_work_priority_idx` and bitmap heap
scans; concentrated plans can select sequential scans for the same predicates.
The corrected aggregation scans pending work once in these measured datasets.
`gmail_work_due_idx`, `gmail_work_priority_idx` and the work primary key remain
unchanged. Full plan nodes and index definitions are included in the artifact.

## Validation and preserved safeguards

- Focused regression command: `pnpm exec vitest run` with Gmail provider,
  Gmail foundation integration, sync admission integration, Gmail client,
  foundation, history priority, sync admission, synchronization policy,
  sync diagnostics and the new priority review file: **10 files passed,
  177 tests passed**, benchmark skipped by default.
- Final targeted rerun with the benchmark enabled, including the subsequently
  added stale-ceiling regression: **22 tests passed** (21 regressions plus the
  27-scenario SQL benchmark).
- `pnpm typecheck`: **PASS**, including the worker TypeScript project.
- `pnpm lint`: **PASS**.
- Prettier check on all seven changed/new files and `git diff --check`: **PASS**.

Initial new-fixture failures (invalid history/inventory state resets and an
unsupported error category) were corrected to satisfy the real schema before
these final passes. The confirmed baseline clock-skew failure was reproduced
before the production fix.

The existing provider integration suite checks receipt atomicity, interrupted
staging/checkpoint transactions, restart recovery, duplicate/reordered history,
history expiry, revision fencing, commands, Retry-After/quota budgets and
bounded HTTP work. The real admission suite checks cross-account rotation,
P1/P2 allowance, reserved P0 capacity, multi-process claims, rollback and retries.
Those safeguards remain covered. History event classification, projection and
receipt transactions, IMAP transport code, frontend polling/unread badges and
Phase 4 publication were not changed.

## Operational limitations

- A class transition after admission intentionally consumes a skipped delivery
  and waits for the existing poller to admit the new class. Queue completion
  never advances Gmail progress; pending durable work and its checkpoint remain.
- The SQL summary still scales with eligible pending identities. Measurements
  stop at 100 accounts and 20,000 total identities; substantially larger queues,
  retained terminal work, storage pressure and production contention require
  separate measurements. Sequential scans are reasonable for these compact,
  mostly pending test tables; existing indexes remain available for selective
  lookups. No claim is made that an index must appear in every plan.
- Three warm samples measure local Docker behavior and include normal host
  noise. They do not establish a p95/p99 SLA, sustained multi-worker throughput
  or cold-cache latency. Live Gmail latency and quotas are outside this SQL
  benchmark; HTTP behavior is exercised with fixtures.
- Priority decisions now share the database clock. Existing persisted discovery
  timestamps and unrelated retry deadlines retain their established storage and
  handling; normal application/database clock synchronization remains advisable.

The opt-in baseline comparisons require the reviewed Git commit to be available
locally; ordinary regressions do not require Git history. Reproduce the SQL
benchmark in PowerShell:

```powershell
$env:MAILDOCK_PHASE3B_BENCHMARK = '1'
pnpm exec vitest run tests/gmail-priority-review.integration.test.ts
Remove-Item Env:MAILDOCK_PHASE3B_BENCHMARK
```

**PHASE 3B VERIFIED** after the targeted fixes and validation described above.
