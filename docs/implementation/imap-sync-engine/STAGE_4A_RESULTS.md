# Stage 4A — Durable demand and account wake delivery

2026-10-14. **PASS for isolated Stage 4A.** This does not establish receiving
release readiness. Stage 3C completed with PASS at accepted commit
`93c1fa948f677ea56c49550a3ec6bab1c776744b`.

Branch: `feature/imap-sync-stage-4a-durable-wakes`, created directly from the
requested accepted commit `93c1fa948f677ea56c49550a3ec6bab1c776744b` with a clean
working tree. No push, merge, PR, Stage 4B implementation or Dovecot rerun.

## Durable data flow

Migration `0036_receiving_demand` adds `receiving_due_at` and
`receiving_request_generation` to existing account/mailbox records. These are
scheduling hints, not synchronization completion or an additional work ledger.
Account demand also represents work before any mailbox identity exists. Mailbox
demand survives before Stage 1 enrollment/SELECT; no invented epoch is stored.
Both timestamps initially become due using PostgreSQL time.

`maildock_receiving_request(account, mailbox?)` validates enabled account and,
when supplied, owned/selectable/active mailbox. A mailbox request briefly locks
account lifecycle `FOR SHARE`, then its mailbox `FOR UPDATE`. An account-only
request updates one account row directly, avoiding shared-to-exclusive lock
upgrades. It increments generation and takes the earlier of existing due time
and database time. Concurrent producers serialize without erasing demand.
Lock waits have a two-second bound. No IMAP I/O occurs under these locks.

The function call commits independently before queue creation/start/send. Web
producers use the existing application database before starting pg-boss; worker
enqueue functions use the already-started JobRuntime database. A failed wake is
best effort and leaves demand intact. The boolean returned for INBOX means
durable demand accepted, including coalesced delivery; it does not mean a new
job was inserted or synchronization completed. Database failures still fail the
request. Failed web queue initialization can be retried on a later request.

Enabled account creation receives due defaults in its insert. A one-row trigger
records enablement and changed IMAP/password/OAuth identity/readiness in the same
transaction as the account change. It does not fan out mailbox updates. Existing
OAuth credential resolution, discovery scheduling and business behavior remain.
New mailbox metadata receives due defaults atomically with its insert.

Stage 1 `receiving_mailboxes` remains the sole F/E/R/revision/epoch authority.
History eligibility is `history_before > 1`; unenrolled selectable active folders
are fresh candidates. Fresh due timestamps are independent of old recent-sync
success/history initialization. Repair also detects existing pending/executing
commands and pending/fetching content; it does not modify or execute those intents.

The mailbox write guard excludes updates changing **only** the two scheduling
hint columns. Every other existing or future column stays guarded, using a
whole-row comparison with only those two columns removed. Placement, metadata,
epoch, revision, notification and commit-authority guards are unchanged. Mixed
hint/authoritative updates still require the Stage 1 receiving context. Due-only
updates do not increment evidence revision.

## Producer inventory and routing

| Producer                                                                     | Stage 4A status                                                                                        | Remaining dependency                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Account creation, enablement, password/IMAP edits                            | Demand committed on existing account record; old discovery enqueue preserved                           | Stage 4C startup/control integration; Stage 5 topology                                                        |
| OAuth connection/reconnection and identity changes                           | Same account trigger covers readiness/identity changes; OAuth execution unchanged                      | Stage 4C ownership/readiness; provider acceptance later                                                       |
| Mailbox discovery/INBOX metadata insertion                                   | Due defaults atomically persist before subsequent `requestSync`                                        | Existing LIST/reconciliation execution retained until Stage 5                                                 |
| `MessageService.requestSync`, `requestRecentSync`                            | INBOX goes directly to durable producer; no old recent-success decision or pending-status write        | Stage 4B/4C elected execution                                                                                 |
| Web recent/delta producer classes                                            | Commit demand through existing application DB; INBOX sends account wake                                | Secondary-folder routing awaits Stage 5                                                                       |
| Worker recent facade, `enqueueDelta`, `enqueueBackfill`                      | Known INBOX demand sends the same account wake; frontier/reason never becomes frozen work payload      | Stage 4B/4C; secondary-folder execution Stage 5                                                               |
| Old backfill continuation                                                    | Goes through demand-aware entry point; secondary continuation keeps its five-second delay/key/priority | Old consumer retirement after cutover                                                                         |
| Existing IDLE EXISTS/FLAGS/EXPUNGE/mailbox-close and reconnect signals       | Existing `enqueueDelta` calls now produce durable INBOX demand                                         | Watcher admission, eligibility and lifecycle remain Stage 4C; no new watcher                                  |
| Existing delta/backfill pollers                                              | Their enqueue calls are demand-aware                                                                   | Legacy successful-initialization gates/timers remain until Stage 4C; isolated repair has no such prerequisite |
| Command/content pending rows                                                 | Account repair reconstructs eligibility from original durable rows                                     | Stage 6 execution routing, bounded owner admission and fencing                                                |
| Command post-result repair callbacks                                         | Existing callbacks reach demand-aware delta producer for INBOX                                         | Command execution remains original Stage 6 business route                                                     |
| Attachment/sent-copy post-result metadata refresh                            | Existing callback behavior retained; receiving entry point is demand-aware                             | Stage 6 attachment/content/APPEND routing                                                                     |
| SMTP/outgoing, drafts, attachment jobs, sent-copy jobs, message-command jobs | Queues and execution preserved                                                                         | Outside Stage 4A execution scope                                                                              |

Secondary-folder requests record mailbox demand before keeping the old queue
route. Their topology/epoch/reconciliation execution cannot safely move into the
INBOX-only Stage 3B scheduler before Stage 5. This identity-based scope is not a
feature flag or dual-engine choice. No new engine receives execution registration.

## Wake contract, ACK and repair

There is one queue, `receiving-account-wake-v1`, and one strict payload:
`{ version: 1, accountId }`. No mailbox frontier, credentials, remote command or
work completion is carried in a job. Queue creation uses the same options for
producer-first and consumer-first initialization: stately policy, four retries,
30-second initial retry with backoff capped at 900 seconds, 60-second expiration.
These are delivery settings, not receiving service targets.

The existing transactional producer advisory lock/coalescing helper is reused.
Created/retry demand coalesces without resetting retry metadata. A request while
delivery is active may create one pending successor. PostgreSQL uniqueness and
the installed stately fetch patch remain the concurrency backstop. Every request
increments durable generation regardless of job coalescing.

`registerReceivingWakeDelivery` is explicitly invoked only by the isolated
harness. It reloads eligibility, ignores disabled/deleted accounts, and calls the
narrow `ReceivingWakeTarget.notify(accountId)` interface. Callback failure leaves
pg-boss retry; callback success ACKs delivery. Neither result clears due,
advances F/E/R, writes messages nor claims synchronization completion. Duplicate
delivery and lost owner-local hints are harmless because PostgreSQL remains due.

`ReceivingDemand.repairPage` reads at most 128 account rows in UUID keyset order.
Eligibility uses authoritative correlated existence checks, not an array of all
mailboxes/intents. Sends are awaited sequentially within the page, with no
unbounded in-memory queue. The isolated `ReceivingDueRepair.tick()` retains only
one cursor, skips overlapping ticks, wraps after the final page, and leaves its
cursor unchanged on read failure. Failed delivery remains due for the next
sweep. A new driver starts at the first page after restart. Neither component
depends on browser activity. Periodic timer/startup registration is intentionally
left for Stage 4C; Stage 4A supplies the directly testable repair boundary.

## Test evidence

Disposable PostgreSQL 17.6 and 18.6 containers, actual installed pg-boss 12.33.7,
Node 24.21.0, pnpm 12.7.0. Stage 4A fixtures use a non-superuser database owner,
all application migrations, independent postgres.js reader, two real producer
instances, and separate killable child processes. No configured application
database/account or IMAP server was used.

| Required scenario                      | Independent evidence                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Crash after due commit/before send     | Actual child process killed at committed barrier; due/generation visible with no job, placements or events; repair creates job                                                                                                 |
| Duplicate delivery                     | Two actual completed deliveries; identical demand/frontier/placement/event snapshot                                                                                                                                            |
| ACK without synchronization            | Completed pg-boss state with due still true, no enrollment or metadata                                                                                                                                                         |
| Crash after metadata commit/before ACK | Actual child killed inside real delivery callback after Stage 1 fenced commit; revision 1, F=2, E=2, one placement and one event; abandoned active job expires into retry and replacement consumer ACKs without changing facts |
| Lost in-process notification           | No-op delivery ACK; removing jobs and recreating producer/repair still reconstructs work                                                                                                                                       |
| Restart and due repair                 | Fresh pg-boss instance and repair cursor reproduce account job from unchanged DB state                                                                                                                                         |
| Multiple producers                     | Sixteen concurrent requests, generation 16, one pending account job; late active-delivery request leaves generation 17 and one successor                                                                                       |
| Bounded pagination                     | Three-row pages across seven new accounts plus retained fixture accounts; every due account reached, invalid page size rejected, failed sends leave state unchanged                                                            |
| Disabled/deleted account               | Producer rejects disabled/foreign/missing identities; delivery ACKs obsolete jobs without target notification; retained generation unchanged                                                                                   |
| No competing receiving writer          | `worker-process.ts` has no new delivery/scheduler/repair registration; old registrations retained; mixed hint/epoch and unfenced frontier writes rejected                                                                      |

Additional tests independently verify atomic account/credential/enablement demand,
pending command/content status and attempts remain unchanged during repair,
INBOX producer entry points create no old sync jobs, and E-derived history/fresh
eligibility works with future timestamps and no legacy initialization success.
Legacy queue/coalescing tests now model real secondary folders; their retry,
priority and concurrent uniqueness assertions remain intact.

Final focused run: **7 files, 63 tests passed**, including 12 Stage 4A tests,
existing receiving safety/retirement regressions and old secondary queue tests.
After the queue-initialization option consolidation, the 12 Stage 4A tests passed
again. Typecheck (application and worker), lint, changed-file Prettier checks and
diff whitespace checks passed. The repository-wide `pnpm format:check` reported
73 warnings: pre-existing experiment runtime/output artifacts (mostly ignored,
plus the tracked `experiments/imap-transport/plaintext-interference.json`) and two
new test files observed before their final formatting pass. Both changed tests
were subsequently formatted and rechecked successfully. Ignored historical
evidence files were left untouched; the repository-wide check is not claimed as
PASS.
Commands:

```text
pnpm exec vitest run tests/receiving-wakes.integration.test.ts tests/runtime-jobs.integration.test.ts tests/backfill-sync-jobs.test.ts tests/incremental-sync-jobs-watchers.test.ts tests/recent-sync-jobs.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
git diff --check
```

## Remaining integration and safety limits

Stage 4B must elect/fence the coordinator before any receiving socket admission.
Stage 4C must connect notification to its bounded ready set, register startup and
periodic repair, handle readiness/shutdown, and settle polling hints using a
captured generation CAS in the fenced result transaction. Stage 4A deliberately
has no due-clearing API: ACK can never erase a late request. Due stays set until
future receiving execution supplies valid completion evidence.

No new receiving consumer/repair timer is registered in the application worker.
INBOX producers now leave durable work awaiting that future integration; this
intermediate branch is independently testable, not an operational receiving
cutover. Existing queued old jobs/consumers are not purged or deleted. At cutover,
old consumers must be stopped/settled before the new authoritative writer starts.
No existing mailbox cursor conversion or production migration machinery is added.

The real crash/redelivery test exposed pg-boss's advisory singleton cache: its
supervisor monitors before expiring jobs, so cached active keys can temporarily
suppress a now-retry job. Even `getQueueStats({ force: true })` reuses stats younger
than one minute when stats persistence is disabled. The fixture ages only the
abandoned job and monitor timestamps, runs the actual supervisor/statistics APIs,
then starts the replacement consumer. No receiving deadline is relaxed. Earlier
10-second test failures are attributable to this retained cache, not lost demand
or missing metadata. Stage 4C must include queue monitor/cache/retry delay in its
recovery budget; this test does not prove a default-configuration recovery SLA.

Account/folder cardinality and correlated pending-intent lookup costs need later
deployment profiling; row/page/memory bounds are implemented, not a proven latency
envelope under arbitrary database load. Stage 3C's accepted report is PASS at
`93c1fa948f677ea56c49550a3ec6bab1c776744b`; the earlier failure-isolation/W=4
gaps were closed by its final acceptance run. No Dovecot smoke,
full suite, open-ended stress, provider release claim or Stage 4B work was done.
