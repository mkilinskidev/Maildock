# Stage 3A results — isolated single-account receiving coordinator

Date: 2026-10-13. **BLOCKED: focused acceptance suite is not green.**
Implementation and validation stopped after the first focused run reported a
mandatory test failure, as requested. This is an isolated, unwired component;
this report does not approve Stage 3B or production cutover.

## Git and scope

The working tree was clean on `feature/imap-sync-stage-2-window`. Actual HEAD and
the named base both resolved to `9b3631390726857e6698f72abe14f82c3a7ab9c8`.
The ancestry check against completed Stage 1 commit `8c1ec94` succeeded before
creating `feature/imap-sync-stage-3a-coordinator`. The configured remote is
`git@github.com:mkilinskidev/Maildock.git`. No branch was overwritten; no push,
merge or PR was performed. No real account or application database was used.

## Implemented behavior and changed files

- `src/modules/accounts/infrastructure/imap-metadata-window.ts`: additive
  `kind: "fresh"` selection. Stage 2 history remains the default. Fresh uses
  `[F+1, min(UIDNEXT-1, F+128)]`; history retains descending numeric windows of
  at most 128 UIDs. Both directions use the same raw/normalized evidence,
  exact SEARCH/FETCH, deadline and owned-client retirement implementation.
  UIDNEXT regression below F is rejected along with regression below E.
- `src/shared/infrastructure/database/receiving-authority.ts`: additive locked
  enrollment recovery. Uses Stage 1 `maildock_receiving_lock`, checks configured
  account and canonical INBOX, then reads optional receiving state under the
  existing conflicting locks. Absence is observed only after ordering against
  any old writer, including uncertain initialization.
- `src/modules/mail/application/receiving-inbox-turn.ts`: reusable fresh/history
  turn, locked recovery before SELECT, safe new-install initialization and
  atomic metadata/frontier publication through `ReceivingPersistence`.
- `src/modules/mail/application/receiving-coordinator.ts`: autonomous serial
  loop and narrow `start(): void` / `stop(): Promise<void>` interface, explicit
  owner and receiving authority, local due time and bounded backoff.
- `tests/fixtures/imap-metadata-peer.ts`: opt-in mutable small-mailbox oracle
  filtering SEARCH/FETCH by the requested UID interval/set; command barriers
  reuse the existing scripted TLS fixture. Existing fixture defaults remain.
- `tests/receiving-coordinator.integration.test.ts`: focused disposable
  PostgreSQL 17.6 tests using the actual installed ImapFlow transport.
- This report.

Existing Stage 2 `receiveInboxWindow`, v1 execution, worker composition, UI,
queries, migrations and dependency versions were not changed. There is no new
transport, persistence store, durable ledger, IDLE, body fetch or scheduler fleet.

## Scheduling and ownership

Fresh is due immediately on startup and after every failed turn. Due fresh has
priority. If an observed fresh backlog exceeds one interval, another bounded
fresh turn remains immediately due. A successful caught-up probe sets the next
due time to completion plus the polling interval. Until then, one history
window runs per turn while E > 1. Every history boundary rechecks the clock;
history completion never resets F or creates a bootstrap phase. When caught up,
the loop waits on a cancellable timer instead of repeatedly connecting.

Provisional defaults are polling **15 seconds**, whole-operation deadline
**10 seconds**, retry **1 second**, exponential retry cap **30 seconds**.
The operation deadline also includes authority renewal. Each database admission
uses at most two seconds and the remaining operation budget. Timing overrides
are explicit and validated. These values are local defaults, not provider SLAs.

The serial loop owns one account/INBOX data operation at a time (C=1). Every turn
creates an exclusive IMAP client, validates fresh SELECT, disables automatic
IDLE/compression and destroys even a healthy client, awaiting local native close
before publication. No IMAP operation holds a PostgreSQL transaction.

Authority renewal is a required isolated integration callback running inside a
bounded Stage 1 transaction. The fixture locks the existing lease row, validates
owner/generation and DB-clock expiry, and extends the still-live lease to 60
seconds. It cannot revive an expired generation. No election service is added.
Local `assertCurrent` guards complement Stage 1 commit-time authority; neither
network success nor the in-memory scheduling state authorizes publication.

## Cancellation, uncertain COMMIT and restart

Stop aborts the lifetime signal, stops admission, wakes sleeping timers and
awaits the active operation's resource retirement. It does not stop the supplied
executor, which remains caller-owned. A coordinator instance is single-use;
restart creates another instance with the same explicit durable owner context.

Every receiving turn recovers durable state under the existing conflicting
locks before collecting evidence. Any network/database/unknown-COMMIT error
backs off and forces current-first recovery. No frozen interval is blindly
replayed. Initialization also uses ordered optional enrollment recovery instead
of trusting a caller's remembered initialized flag. Acknowledged publication
remains durable if stop arrives afterward.

UIDVALIDITY mismatch fails closed: there is no old-epoch publication or frontier
movement. Automatic epoch replacement/cleanup is not integrated in this stage;
the mismatch remains retryable with capped backoff until explicitly resolved.

## Validation results and blocker

Environment: Windows, Node 24.21.0, pnpm 12.7.0, Docker Desktop engine 28.5.1.
PostgreSQL tests create disposable `postgres:17.6-alpine` containers, migrate the
real journal, use an ordinary schema-owning login and ignore `TEST_DATABASE_URL`.

| Check                                                   | Result                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Focused coordinator suite                               | **FAIL: 10 passed, 1 failed**, exit 1, 14.95 seconds                                |
| Stage 1/2 and conditional STORE regressions             | **PASS: 104 tests, 5 files**, exit 0, 35.94 seconds                                 |
| `pnpm typecheck`                                        | PASS, exit 0                                                                        |
| `pnpm lint`                                             | Exit 0, no errors, **one warning**: unused `options` helper in new integration test |
| Changed TypeScript file Prettier check                  | PASS                                                                                |
| `git diff --check`                                      | PASS                                                                                |
| Full repository test suite / full repository formatting | NOT RUN                                                                             |

Focused command:

```powershell
pnpm exec vitest run tests/receiving-coordinator.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

Passed cases cover initial empty INBOX and sleeping/first arrival, initial
history and quiet history progress, new arrivals during a held history SEARCH,
fresh gaps and empty verified intervals, stop/restart with fresh/history
outstanding, cancellation during SEARCH/FETCH, timeout/backoff/reconnect,
UIDVALIDITY rejection, wrong account/revoked authority, and actual lost COMMIT
reply with subsequent locked recovery. The restart fixture verifies seven
unique authoritative placements, fresh as the first restarted turn, and local
client retirement. C=1 is exercised through the serial lifecycle, rather than a
multi-account or distributed connection-cap harness.

The failed mandatory case is **"repeated fresh arrivals never reset historical
coverage"**. It expected historical E to remain `[257, 257, 257]` across three
fresh publications. Observed E was **`[257, 129, 1]`**. Those values are descending
history progress, not an upward reset; the test currently disallows legitimate
history turns between polling deadlines. This run establishes a test-oracle
discrepancy, not evidence of E regression. Nevertheless, the mandatory test is
red and has not been weakened or rerun: the explicit stop-on-failure condition
applies. Acceptance requires reviewing that oracle and another authorized run.

The key focused scenario passed: UIDs 385/386 became queryable through an
independent PostgreSQL reader while E remained greater than 1, then restart
checked UID 387 before completing history. The test computed injection-to-durable
visibility with `performance.now()` and emitted a console sample, but the
captured Vitest result did **not** return its numeric value. Numeric fresh
visibility is therefore **unavailable in this report**, and no latency/SLA claim
is made. Retaining that measurement in an accessible result artifact remains
unfinished.

Regression command:

```powershell
pnpm exec vitest run tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-inbox-window.integration.test.ts tests/imap-metadata-window.test.ts tests/imap-conditional-store.test.ts --maxWorkers=1 --no-file-parallelism
```

## Remaining risks and readiness

Stage 3A is **BLOCKED pending focused acceptance**, so Stage 3B is **not ready**.
Review the failed test's monotonic-history oracle and retain a numeric visibility
artifact before another acceptance attempt. Unknown initialization and capped
backoff across repeated persistence outages have implementation paths but no
new focused fault-injection case here. Callback integrations must honor the
documented authority and synchronous diagnostic contracts.

Continuous fresh backlog may postpone history indefinitely; Stage 3B protection
was explicitly excluded. Sparse numeric domains retain fixed 128-UID windows.
Provider compatibility and metadata poison remain Stage 2 limitations. Local
native close is not instantaneous server-side session disappearance. Lease
fencing cannot eliminate process suspension or remote partition limitations.
Automatic epoch replacement, distributed scheduling, pg-boss delivery, worker
integration and full production resource/release validation remain future work.

No further implementation was attempted after the mandatory focused failure.
