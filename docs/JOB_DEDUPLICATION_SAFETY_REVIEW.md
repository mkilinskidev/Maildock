# Job deduplication and orphan recovery: safety review

Branch: `codex/v1-dedup-safety` (from `codex/v1-user-actions-first` at `2457804`).
Commit: see the final line of this document.

Scope: only the deduplication of `message-command-v1`,
`message-content-fetch-v1` and `attachment-fetch-v1` jobs, and recovery after a
worker crash. The Sync Engine, scheduler and preemption are untouched.

## 1. Question

`enqueueDeduplicated` treated an `active` job as dead once it was older than
120 s (commands) or 300 s (content, attachments). Age is not evidence that a
worker died. Does that produce a second job for a worker that is still alive,
and is the second job harmful?

## 2. Audit

Installed version: pg-boss `12.33.7`, with the local patch
(`patches/pg-boss@12.33.7.patch`), which only changes `fetchNextJob` for the
`stately` policy: a queued job is not claimed while a job with the same
`singleton_key` is `active`.

### 2.1 pg-boss behaviour (read from the installed `dist/`)

| Event                                        | What happens                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Job fetched                                  | `state = active`, `started_on` and `heartbeat_on` set to now.                                                                 |
| Worker alive, queue has `heartbeatSeconds`   | The worker refreshes `heartbeat_on` every `heartbeatSeconds / 2` (`touch`).                                                   |
| `expireInSeconds` elapsed since `started_on` | Supervisor `failJobsByTimeout`: job gets `retry` (while `retry_count < retryLimit`) or `failed`. The handler is not killed.   |
| `heartbeat_on + heartbeatSeconds` elapsed    | Supervisor `failJobsByHeartbeat`: same transition, output `job heartbeat timeout`.                                            |
| Neither configured/elapsed                   | The job stays `active`.                                                                                                       |
| `createQueue` on an existing queue           | Does nothing. Settings change only through `updateQueue`.                                                                     |
| Supervisor cadence                           | Per queue, at most once per `monitorIntervalSeconds` (60 s default).                                                          |
| `stately` queues                             | `fetch` skips keys listed in the cached queue stats `singletonsActive` (refreshed by the supervisor, local cache every 60 s). |

Before this change none of the three queues enabled heartbeats. A job of a dead
worker stayed `active` until `expireInSeconds` (900 s) and then went to
`retry` (commands: 4 retries, delay 15 s with backoff; content: 4 retries,
delay 30 s with backoff) or `failed` (attachments: `retryLimit: 0`). The 120 s
and 300 s thresholds existed to recover faster than 900 s, at the cost of
treating live workers as dead.

### 2.2 Per operation

|                                  | Command                                                                         | Content                                                                   | Attachment                                                           |
| -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Queue policy                     | standard, retry 4, expire 900 s                                                 | stately, retry 4, expire 900 s                                            | standard, retry 0, expire 900 s                                      |
| Durable state                    | `message_commands.status` pending/executing                                     | `message_contents.status` pending/fetching                                | `message_attachments.status` pending/fetching                        |
| Executor guard                   | mailbox advisory lock (`pg_try_advisory_lock`, session level), busy means defer | none per message; pg-boss `stately` + patch serialises the same key       | attachment advisory lock (`pg_try_advisory_lock`), held means return |
| Recovery path                    | `MessageCommandPoller` (30 s) re-enqueues pending/executing                     | `ContentRepairPoller` (30 s) re-enqueues pending/fetching older than 30 s | `AttachmentPoller` (30 s) re-enqueues pending/fetching               |
| Old second job for a live worker | yes, after 120 s, and every 30 s while the first still ran                      | yes, after 300 s                                                          | yes, after 300 s                                                     |

The five events are not equivalent and were assessed separately.

| Event                                              | Command                                        | Content                                                                                                       | Attachment                                                     |
| -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Duplicate pg-boss job (live worker, old heuristic) | **Confirmed.**                                 | **Confirmed.**                                                                                                | **Confirmed.**                                                 |
| Parallel handlers                                  | No: the second one hits the busy mailbox lock. | No: `stately` + patch do not claim the second job while the first is active (the old test only counted jobs). | No: the second one finds the attachment lock held and returns. |
| Second IMAP connection                             | No.                                            | No (same key).                                                                                                | No.                                                            |
| Repeated remote operation                          | No.                                            | No.                                                                                                           | No.                                                            |
| Double data mutation                               | No: `run()` re-reads status under the lock.    | No: second run sees `ready` and returns without IMAP.                                                         | No: second run sees `ready`.                                   |

So the hypothesis "a live long job gets a second parallel execution" is
**refuted**: the executor locks already prevent it. What the heuristic did
cause is a duplicate job:

- Command: while a slow mutation holds the mailbox lock, the extra job defers
  (2 to 6 s) and creates a successor, repeatedly, for as long as the mutation
  runs. Bounded to one successor, but pointless churn.
- Content: an extra `created` job parked behind the active one.
- Attachment: a no-op job every 30 s while a large download runs.

The explicit requirement "a correct long-running worker must not be treated as
dead only because its job is 120 or 300 s old" is violated by that heuristic
regardless of the harmless outcome, and the age thresholds were also coarse
for real crashes (recovery depended on the poll that happened to follow the
threshold).

Residual cases found while auditing (not changed, see section 6):

- The content queue key is `mailboxId:messageId`; the same message in two
  mailboxes can be fetched by two jobs concurrently. Both write the same
  deterministic result, last writer wins.
- Advisory locks are session level. If the database connection of a live
  worker is lost, the lock is released while the handler may still run.

## 3. Options

- A. Trust `active`: remove the age heuristic. Alone it would make recovery
  wait for `expireInSeconds` (900 s), 3 to 7.5 times slower than before.
- B. Recover from the real job state: the pollers already re-enqueue when a job
  is no longer `queued/active`. This needs pg-boss to move dead jobs out of
  `active` quickly.
- C. A custom lease/heartbeat: rejected. pg-boss 12.33.7 already provides
  `heartbeatSeconds` natively, so A + B is complete.

Chosen: A + B using the native pg-boss heartbeat. No new table, migration,
lease, fencing or ownership concept.

## 4. Change

`src/modules/mail/infrastructure/deduplicated-enqueue.ts`

- `activeLiveSeconds` is removed. Queued (`created`/`retry`) and `active` jobs
  always count as live. `ignoreActive` replaces `activeLiveSeconds: 0` for the
  busy continuation sent by the command's own active job.
- New `JOB_HEARTBEAT_SECONDS = 90` and `ensureHeartbeatQueue`: `createQueue`
  with `heartbeatSeconds`, then `updateQueue` so queues created by earlier
  versions are upgraded (idempotent).

`message-command-jobs.ts`, `content-jobs.ts`, `attachment-jobs.ts`

- Use `ensureHeartbeatQueue`; thresholds 120/300 removed. Retry limits, delays,
  expiry, concurrency, policies, busy delay (2 to 6 s), pending state,
  pollers and lifecycle rules are unchanged.

Why 90 s: the worker timer fires every 45 s, so a stalled event loop needs more
than 90 s to cause a false death. A false death is still safe: the retry job
meets the same executor lock. The pg-boss minimum is 10 s.

Not changed: `message-command-service.ts` (MOVE lifecycle), the patch, queue
policies, the number of IMAP connections.

### Behaviour after the change

- Live worker: heartbeat refreshed, job stays `active`, producers and pollers
  add nothing, however long it runs. If it outlives `expireInSeconds` pg-boss
  moves it to `retry`/`failed`; the executor lock still prevents a second
  execution (tested for commands).
- Dead worker: heartbeat stops. The next supervisor pass after 90 s moves the
  job to `retry` (commands, content) or `failed` (attachments). Commands and
  content then retry through pg-boss; attachments are re-enqueued by
  `AttachmentPoller` (the row stays pending/fetching).
- Latency (worst case): about 90 s heartbeat + up to 60 s supervisor pass, plus
  the retry delay (15 s commands, 30 s content) and, for `stately` content, up
  to one more stats/cache refresh (about 60 s each) because `fetch` consults
  the cached list of active keys. Previously 900 s. This delay is acceptable:
  all three paths are background or asynchronously reported work.
- Jobs inserted before the upgrade have no `heartbeat_seconds`; they remain
  bounded by `expireInSeconds` (900 s) and are never stuck permanently.
- After a worker process restart the new supervisor and the pollers (which run
  once immediately on start) drain stale jobs and durable pending/fetching
  rows.

## 5. Safety of MOVE and commands

Unchanged lifecycle, re-verified through the real `MessageCommandService`:

- `request`/`continue` modes: one job per command id; the continuation is
  created by the active job and yields at most one successor.
- Crash before `status = executing`: job recovered by pg-boss, runs once.
- Crash during `mutateMessage`, or after IMAP confirmation but before the
  result is stored (both leave `status = executing`): a recovered or duplicate
  job finds `executing` for a MOVE and calls `fail()` ("Move outcome is
  uncertain"); the provider is never called again and the hidden placement is
  restored. Verified through a pg-boss retry and through a poller-created job.
- Succeeded command plus stray duplicate jobs: no provider call.
- pg-boss expiry while the first handler still works: the retry job meets the
  mailbox lock, defers, and the provider is called exactly once overall.
- A non-MOVE action (flags) interrupted mid-flight can be re-applied once by
  recovery; this is idempotent and pre-existing.

Deduplication is not an exactly-once guarantee. It only reduces redundant jobs;
exactly-once for MOVE is replaced by "never retried when uncertain".

## 6. Remaining limitations

- Heartbeat is refreshed by the worker's event loop. A stall longer than 90 s
  can fail a live job; the retry is harmless because of the executor locks.
- Recovery of content may take roughly two supervisor/cache intervals longer
  than commands, because of how pg-boss `stately` claims.
- Same message in two mailboxes: two content jobs may run concurrently.
- Lost database connection of a live worker releases its advisory lock.
- Older jobs without heartbeat are recovered by the 900 s expiry.
- The 90 s value is not configurable; `JOB_HEARTBEAT_SECONDS` is one constant.

## 7. Tests

`tests/job-deduplication-safety.integration.test.ts` (new, 19 tests). It uses
a disposable `postgres:18.6-bookworm` container, its own pg-boss, real
advisory locks, real `MessageCommandService`, `MessageContentService.orphanedRequests`
and `AttachmentService.repair`, and fake providers. Time is controlled by
editing `started_on`/`heartbeat_on` and running `boss.supervise()`, so no
multi-minute waits.

| Requirement                                    | Test                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| 1 command alive over 120 s                     | `command: a live job older than 120 s ...`                      |
| 2 content alive over 300 s                     | `content: a live job older than 300 s ...`                      |
| 3 attachment alive over 300 s                  | `attachment: a live job older than 300 s ...`                   |
| 4 poller adds nothing                          | same three tests (also after `supervise`)                       |
| 5 crash recovery                               | `command/content/attachment: crash ...`                         |
| 6 expiry never repeats the remote call         | `pg-boss expiry of a still-working job ...`                     |
| 7 busy continuation at most one successor      | `busy continuations create at most one successor ...`           |
| 8 concurrent producers                         | `many concurrent producers ...`                                 |
| 9 pending without job                          | `content ... without any job`, `attachment: pending row ...`    |
| 10 fetching without job                        | same                                                            |
| 11 uncertain MOVE never rerun                  | `crash during MOVE ...`, `a pending-orphan poller replay ...`   |
| 12 confirmed mutation not repeated             | `a confirmed mutation is not repeated ...`                      |
| 13 no parallel fetch for one id                | `content/attachment: duplicate jobs ... never ... concurrently` |
| 14 INBOX-first / user-actions-first regression | existing suites, below                                          |
| 15 restart leaves no orphans                   | `a restarted pg-boss instance ...`                              |
| heartbeat on queues, upgrade of old queues     | `liveness contract`                                             |

Existing tests changed: `user-actions-first.integration.test.ts` now asserts
that an aged active job is **not** replaced (previously it asserted the
replacement); `user-actions-first`, `inbox-first-priority` and `security/safe-logging`
test fakes provide `updateQueue`.

Results (this branch, Windows host, Docker Testcontainers, no connection to the
running Maildock instance or Gmail):

- New suite: 19/19 passed.
- Full `vitest run`: 110 files, 1347 tests. The first run had 3 failures in
  `tests/security/safe-logging.test.ts` (its fake boss lacked `updateQueue`);
  after adding it to the fake, that file passes (16/16). All other files
  passed (1344 of 1347 in the first run).

`tsc --noEmit` (app and worker), `eslint`, `prettier --check` on the touched
files and `git diff --check`: clean.

Safety: tests ran only in their own throw-away containers. The running
`maildock-app` and `maildock-postgres` containers, their queues and database
were not touched; no real IMAP/Gmail access.

Branch: `codex/v1-dedup-safety`, commit `c8ea358` (message commit; later amendments none).

## 8. Final verification — expiration and full regression

Scope: verification only. No production code changed; one test file added.
Decision: **A, keep `expireInSeconds: 900`** on all three queues.

### 8.1 Full regression (actual results)

Environment check before running: no `DATABASE_URL` / `TEST_DATABASE_URL` in the
shell, so every integration test starts its own throw-away
`postgres:18.6-bookworm` Testcontainer on a random port. The only Docker call
that touches compose is `docker compose config` (read-only, placeholder
secrets). Test files mention Gmail only as fixture strings; providers are fakes.
The running `maildock-app-1` and `maildock-postgres-1` containers, their
database and queues were not touched; no migration, restart, IMAP or SMTP.

| Check                                            | Result                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest run` before the new tests (HEAD 57bcda5) | 110 files, **1347/1347 passed**, exit 0                                                                                                                                                           |
| `vitest run` with the new test file              | 111 files, **1353/1353 passed**, exit 0 (includes the 30 `tests/security/*.test.ts` files and the security integration suites)                                                                    |
| `pnpm typecheck` (app and worker)                | clean                                                                                                                                                                                             |
| `pnpm lint`                                      | clean                                                                                                                                                                                             |
| `pnpm format:check`                              | fails only on `SYNC_ENGINE_V1_AUDIT.md` and `SYNC_ENGINE_V1_PRIORITY_DESIGN.md`; both predate this branch (b24e19a), left alone                                                                   |
| Fakes of pg-boss                                 | the three suites that stub pg-boss for these queues (`inbox-first-priority`, `user-actions-first`, `security/safe-logging`) provide `updateQueue`; other fakes never reach `ensureHeartbeatQueue` |

`tests/security/**` is covered by the single `vitest run` (include glob
`tests/**/*.test.{ts,tsx}`). The `.mjs` production-image scripts are not part of
vitest; they build images and start containers, so they were not run.

### 8.2 What pg-boss 12.33.7 (with the local patch) does

Read from `node_modules/pg-boss/dist/{manager,plans,tools}.js`, not from the
current upstream documentation.

1. **Expiry vs. heartbeat.** Independent. `failJobsByTimeout` tests
   `started_on + expire_seconds < now` and never reads `heartbeat_on`; `touch`
   only refreshes `heartbeat_on`. A live job with a perfect heartbeat is expired
   at 900 s. The heartbeat only detects dead workers sooner.
2. **Two enforcement points.** (a) In the worker: `#processJobs` races the
   handler against a timer of `expireInSeconds` (`resolveWithinSeconds`) and then
   calls `fail()` with "handler execution exceeded Ns". This is the normal path,
   at 900 s of handler time. (b) The supervisor (`failJobsByTimeout`, "job timed
   out"), at most once per `monitorIntervalSeconds`, covers dead workers and
   other instances. Section 2.1 above lists only (b).
3. **The handler is not interrupted.** The race only stops waiting for it. The
   job becomes `retry` (commands, content) or `failed` (attachments,
   `retryLimit: 0`); the handler promise keeps running. The worker slot is freed
   and the heartbeat timer is cleared.
4. **AbortSignal.** pg-boss sets `job.signal` on every job. It is aborted when
   the race ends (timeout, but also normal completion) and on shutdown. **None
   of the three Maildock handlers reads `job.signal`**, and IMAP, storage and DB
   calls do not take one, so expiry never cancels work.
5. **Late result.** The abandoned handler's return value is dropped:
   `complete()` is not called and the failed/retried job is not revived (tested).
   Edge case from code reading only (not tested): a handler that outlives a
   _supervisor_-initiated failure (event-loop stall over 90 s) later calls
   `complete()`, which matches on id and `state = active`; retries keep the job
   id, so if the retry was already claimed it is marked completed while still
   running. The executor locks make that harmless; it only weakens
   deduplication for the rest of that run.
6. **Second worker.** It can start after expiry, because the first job is no
   longer `active` (the `stately` patch looks at live `active` rows only). What
   prevents duplicate effects is the executor, not pg-boss.
7. **Restart / upgrade.** In-process timers die with the process. After a
   restart the new supervisor fails jobs whose heartbeat is stale (jobs inserted
   with `heartbeat_seconds`, i.e. after the upgrade) or past 900 s (older jobs).
   `ensureHeartbeatQueue` runs on every worker and web start, so `updateQueue`
   reaches pre-existing queues; `heartbeat_seconds` is copied to each job at
   insert, hence jobs created before the upgrade rely on the 900 s expiry
   (covered by the "liveness contract" tests).

### 8.3 Assessment per queue

Timing facts: ImapFlow `connectionTimeout` 10 s, `socketTimeout` 15 s
(inactivity, not total time). There is no overall operation deadline, so a slow
but steadily trickling server is bounded only by size limits and by 900 s. No
universal maximum message size is assumed; the limits below are Maildock's own
configuration, and servers/providers may differ.

**Message commands.** One IMAP mutation (MOVE or flag change) plus DB writes;
`reconcile` only enqueues a delta job. Exceeding 900 s needs a server that keeps
one STORE/MOVE alive with gaps under 15 s: not realistic. If it happens, the
retry meets the mailbox advisory lock and defers (tested with MOVE: provider
called once, no double MOVE). If the process dies instead, the lock drops with
the connection; an `executing` MOVE is marked uncertain and restored without
calling IMAP again, and a flag change may be re-applied once (idempotent).
Keep 900 s.

**Message content.** Fetch of the display parts (each capped by
`MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES`, default 5 MiB, max 20 MiB), sanitising
and one UPDATE. Reaching 900 s needs a sustained trickle below about 6 KB/s at
the default cap. If it happens, **the content executor has no lock**: the retry
fetches in parallel with the first fetch (tested, two concurrent fetches). Both
write the same deterministic result, and the failure path never overwrites
`ready` (`setWhere status <> 'ready'`); the test ends with one row, `ready`, no
error. The cost is duplicate IMAP traffic, bounded by `retryLimit: 4` with 30 s
backoff. A lock would remove it, but that is a service change without a measured
problem behind it.

**Attachments / CID.** Largest exposure: default cap 15 MiB, configurable up to
100 MiB. 900 s is crossed below about 17 KB/s at the default, 116 KB/s at
100 MiB. Tested with a transfer stalled mid-stream: at expiry pg-boss marks the
job `failed`; the handler continues, still holding the attachment advisory lock;
the row stays `fetching`; the poller re-enqueues and each extra job finds the
lock held and returns without IMAP (`fetchAttachment` called once). When the
transfer ends the blob is written (`LocalBlobStorage.put` writes a temp file and
renames, so expiry during the write cannot leave a partial blob), then
`registerBlob` and the `ready` update run once: one blob, status `ready`, no
live job left. A second handler cannot start work; the only cost is one no-op
job (plus an account lookup) per poll while the slow transfer lasts. 900 s is a
reasonable safety bound.

### 8.4 New tests

`tests/job-expiration-safety.integration.test.ts` (6 tests, own container, fake
providers, real pg-boss, real advisory locks, real command/content/attachment
services). It first asserts the production values (900 s expiry, 90 s
heartbeat), then shortens `expireInSeconds` to 3 s on the throw-away database so
the real pg-boss timers fire in seconds; nothing waits 15 minutes. Heartbeat is
the production value. All 6 pass.

| Scenario                                                             | Result                                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Production queue configuration                                       | 900 s / 90 s asserted for all three queues                                                          |
| Supervisor, content and attachment, past expiry with fresh heartbeat | failed anyway ("job timed out"): `retry` (content), `failed` (attachment)                           |
| AbortSignal probe                                                    | not aborted at start, aborted after expiry; handler finishes; job stays `failed`                    |
| Command MOVE, live handler with fresh heartbeat passes expiry        | `retry` ("exceeded"), provider still blocked; retry defers; one `archive` call; command `succeeded` |
| Content, handler passes expiry                                       | retry fetches in parallel; final row `ready`, consistent, no error                                  |
| Attachment, stalled transfer passes expiry, repeated poller passes   | one provider call, one blob, `ready`, no live job                                                   |
| Real crash recovery                                                  | already covered by the deduplication suite (killed heartbeat, restarted instance, uncertain MOVE)   |

### 8.5 Decision: A

900 s stays. Expiry never causes a second effect for commands (mailbox lock plus
durable `executing`) or attachments (advisory lock plus durable status). Content
can duplicate a fetch but converges to the same row. The timeout most likely to
be hit, a slow attachment above the default 15 MiB, is handled by the lock and
the poller without harm. No queue has a confirmed problem that another value
would fix, and a larger value would only slow recovery of jobs created before
the heartbeat upgrade.

No production code change. Variant C items, not implemented and not urgent:
propagate `job.signal` into the IMAP/storage calls, and/or add an executor lock
to content fetch.

### 8.6 Remaining risks

- Expiry does not cancel work (no handler uses `job.signal`); an abandoned
  handler can outlive 900 s and, for content, run in parallel with its retry.
- A slow server can keep an attachment `fetching` for a long time while a no-op
  job is created every poll.
- Advisory locks are session-level: a lost database connection of a live worker
  releases the lock under a still-running handler (section 6).
- The late `complete()` of an abandoned handler on a re-claimed job (8.2, point 5) is from code reading; no test.
- Two Markdown files fail `format:check` independently of this branch.
