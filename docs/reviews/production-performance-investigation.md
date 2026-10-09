# Read-only production performance investigation

Investigation: 2026-10-09, 12:31–12:37 UTC (14:31–14:37 Europe/Warsaw). Branch: `investigation/production-performance`, based on freshly fetched `origin/main`, `ba074880768645473af070ecc846e420ced990d5`.

The preceding source report, `docs/reviews/interactive-body-fetch-performance.md`, including its timeout addendum, was read on branch `investigation/interactive-body-fetch-performance` at commit `2eb3990` before this investigation. That report is not present on the current main baseline; it has not been copied into this branch. Only this sanitized report is added.

The principal result is stronger than the initial shared-queue hypothesis: **the retained slow body jobs mostly waited inside execution, not in the queue**. Gmail delta work repeatedly completes expensive full-folder UID-presence reconciliation even with zero changes. The largest indexed Gmail folder has **41,246 placements**, requiring **275 sequential UID SEARCH calls per delta** at the deployed default batch size. Long Gmail jobs also occupy both delta slots and delay the other accounts' pending synchronization. Google OAuth serialization exists, but no account locks, blocked backends or long transactions were observed during the live slow-delta samples. Its historical contribution remains unmeasured.

No production changes, new IMAP sessions, forced synchronization/downloads, retry operations, load tests, container lifecycle changes or maintenance were performed. No bodies, subjects, email addresses, credentials, job payloads/outputs or raw logs were exported. Account and folder labels below are arbitrary aliases; original identifiers and names are omitted.

## 1. Production environment summary

SSH used only the configured `maildock-prod` alias, with batch authentication, strict existing host-key checking and a connection timeout. The resolved SSH target returned the production host identity, and its Maildock application/database containers matched the expected deployment/image revision. No SSH settings, credentials or permissions were changed; no unrelated host was contacted. Only Maildock containers were inspected after inventory.

| Item                       | Observation                                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application image revision | Image tag `ba074880768645473af070ecc846e420ced990d5`, matching fetched main and local `v1.0.0`. Application image ID begins `sha256:ca9c65889d72`. OCI revision label absent; tag identity is not independent cryptographic source attestation. |
| Runtime                    | Node `v24.21.0`, installed ImapFlow `2.0.6`, pg-boss `12.33.7`.                                                                                                                                                                                 |
| Process layout             | One worker process, one Next web process, one supervisor; `MAILDOCK_ROLE=all`, `NODE_ENV=production`.                                                                                                                                           |
| Database                   | PostgreSQL `18.6 (Debian 18.6-1.pgdg12+2)`, `max_connections=100`. Diagnostics used the existing database connection role, without sudo or role switching.                                                                                      |
| Container lifecycle        | Both healthy, zero recorded restarts and `OOMKilled=false`. App started 2026-10-08 16:49:26 UTC; DB started 16:49:20 UTC.                                                                                                                       |
| Host                       | 4 CPUs, approximately 7.76 GiB RAM; 4.46 GiB available at initial check, no swap, root filesystem 4% used. Load averages approximately 3.24 / 2.30 / 2.20; these include other host workloads.                                                  |
| Current app resources      | 0.67% CPU, 643.1 MiB memory at 12:32; 1.72% CPU and same memory around 12:37. Docker CPU percentages are sampled container values, not historical incident peaks.                                                                               |
| Current DB resources       | 1.34% CPU, 219.7 MiB at 12:32; 0.47% CPU, 220.5 MiB around 12:37.                                                                                                                                                                               |
| Resource limits            | No explicit Docker memory limit or CPU quota on the two containers.                                                                                                                                                                             |

An explicit environment allowlist found no overrides for the following settings. Effective values are inferred from the matching revision's defaults (`src/shared/infrastructure/config/config.ts:91`), rather than by calling configuration code that reads secrets:

| Setting                                | Default in use absent an override                            |
| -------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_POOL_SIZE`                   | 10 per application postgres.js pool, not a server-wide limit |
| `WORKER_CONCURRENCY`                   | 5 for discovery; not total business-worker capacity          |
| `MAILDOCK_MESSAGE_SYNC_CONCURRENCY`    | 2 separately for recent and delta                            |
| `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE`    | 150                                                          |
| `MAILDOCK_BACKFILL_CHUNK_SIZE`         | 500                                                          |
| `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`  | 300                                                          |
| `MAILDOCK_CONTENT_POLL_INTERVAL_MS`    | 400, adaptively capped at 2500                               |
| `MAILDOCK_INITIAL_SYNC_DAYS`           | 30                                                           |
| `MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES` | 5 MiB per selected text part                                 |

Body concurrency remains hardcoded at 1 (`src/modules/mail/infrastructure/content-jobs.ts:69`). Deployment registration and child environment inheritance match this layout (`src/composition/worker-process.ts:93`, `scripts/container-entrypoint.mjs:9`, `:29`).

Three enabled accounts were observed, without reading names, addresses or authorization caches:

- **G:** Google OAuth2, connected; 24 discovered folders, 23 selectable active folders, all 23 historical sync states complete. Capability metadata includes CONDSTORE and IDLE.
- **M:** Microsoft OAuth2, connected; 8 active folders, history complete; stored capability metadata does not include CONDSTORE.
- **P:** Password authentication; 6 active folders, history complete; capability metadata includes CONDSTORE/QRESYNC/IDLE.

G has 66,076 placement rows and 66,076 distinct local message IDs. The three largest folders contain 41,246, 17,449 and 4,108 placements respectively, matching their latest reported remote message counts. These are folder-membership counts, **not unique logical-message counts across Gmail labels**. The initial approximately 15,000 estimate understates the largest observed folder's indexed size; unique logical messages were not counted. No message identifiers, subjects or bodies were selected to resolve that difference.

## 2. Evidence, timestamps and collection limits

Existing application logs were processed on the VPS in memory, projecting only allowlisted event names, timestamps, durations, counters, reasons and safe categories. Original account/mailbox IDs were pseudonymized before output and converted to G/M/P and folder labels here. Arbitrary log messages, security payloads, addresses, folder names and error stacks were not output. No raw-log file was created locally or committed.

The bounded log read scanned 8,182 lines (below its 20,000-line limit). JSON log timestamps span **2026-10-08 16:50:12.422 to 2026-10-09 12:31:51.359 UTC**. Counts: 7,984 successful delta events, 146 delta-failure events, one job-runtime start, 23 IDLE-connected events and one IDLE-disconnected event. These counts represent this container's retained window, not lifetime totals. Failure events do not contain a duration or exact command/stage.

PostgreSQL diagnostics ran in explicit **read-only transactions**, with transaction-local 2–3-second statement timeouts and 500-ms lock timeouts, followed by rollback. These are session safety limits, not changes to production configuration. Queries selected catalog metadata, aggregate counts, job timestamps/states/options, account authentication method/capabilities, folder counters and backend wait/lock metadata. No job `data`/`output`, mail content, stored credentials or raw SQL query text was retrieved. Diagnostic rollbacks and any temporary query work can affect cumulative DB counters; do not interpret their differences as application failures.

Live lock sampling used 15 short snapshots, roughly 3.2 seconds apart, from **12:34:38.588 to 12:35:23.890 UTC**. Sampling observes a running system, not an atomic snapshot across all measurements. Historical CPU, pool checkout latency and OAuth/IMAP stage timing are not available from these reads.

### Correlated timeline

Delta start times below are **inferred** from completion log time minus the service's recorded duration. They are service intervals, not queue residence or exact wire-command times. Body timestamps are pg-boss metadata for the latest attempt. All times are UTC on 2026-10-09 unless a date is specified.

| Time / interval               | Evidence                                                                                                   | Interpretation                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-08 19:34:35.183       | Latest completed historical-sync job; current histories complete                                           | Morning slowdown persists after historical backfill stopped. It cannot be attributed solely to an active history job.                             |
| 07:37:13.222–07:38:16.339     | G folder F02 delta, 63.117 s, zero new/changed/removed                                                     | Overlapped four other G completion intervals and one M interval. These counts are intersecting intervals over time, not six simultaneous workers. |
| 09:18:15.736 and 09:18:34.577 | G delta failures, `connection_timeout`                                                                     | Nearby provider failures precede the retained retried body request; no request-ID link establishes a shared exception.                            |
| 09:19:36.195                  | Body B07 created                                                                                           | This job later shows one retry. Its first-attempt timestamps/outcome are no longer separately recorded in the selected metadata.                  |
| 09:20:31.819–09:20:56.215     | B07 successful final attempt, 24.396 s; total creation-to-completion 80.020 s                              | Overlapped a G delta interval longer than 60 s. Original-to-latest-start 55.623 s includes prior attempt/backoff, not just queue wait.            |
| 11:40:50.923–11:49:19.758     | F01 delta, 508.835 s, zero changes                                                                         | Intersected 19 other G, 7 M and 6 P successful service intervals. Other accounts can progress while a single G slot remains occupied.             |
| 11:43:40.945–11:43:58.959     | Another G folder delta, 18.014 s, zero changes                                                             | Confirms repeated approximately 18-second work on folders beyond the largest.                                                                     |
| 11:47:23.033–11:50:58.259     | F02 delta, 215.226 s, zero changes                                                                         | Overlaps the 508-second F01 operation in the second delta slot.                                                                                   |
| 11:51:58.390–11:52:14.451     | B08 body, 16.060 s execution                                                                               | Only 0.057 s from enqueue to start; overlaps a long G delta.                                                                                      |
| 11:52:40.467–11:52:56.265     | B09 body, 15.798 s execution                                                                               | 1.691 s queue wait; overlaps a long G delta.                                                                                                      |
| 11:53:24.277–11:53:42.411     | B10 body, 18.134 s execution                                                                               | 1.607 s queue wait; overlaps a long G delta.                                                                                                      |
| 12:17:55.465–12:27:53.102     | F01 delta, 597.637 s, zero changes                                                                         | Largest successful outlier in the window, almost ten minutes.                                                                                     |
| 12:33:45                      | Two active G delta jobs, 32 created delta jobs and one retry; no active/pending content jobs               | Delta backlog and body execution isolation coexist.                                                                                               |
| 12:34:38–12:35:24             | Two active delta jobs in every sampled snapshot, no blocked backend/account relation lock/long transaction | Direct live evidence against persistent PostgreSQL/OAuth lock contention during this sampled work.                                                |
| 12:36:57                      | F01 still active from 12:31:09; both active jobs G; M/P jobs queued for about 357 seconds                  | One account's long delta execution causes cross-account delta scheduling delay.                                                                   |

The supplied body-timeout screenshot has no timestamp/job ID, so it cannot be securely assigned to B07 or any particular delta failure. CPU/memory observations were made later than the historical body events; they cannot be retroactively attached to those events.

## 3. Delta synchronization latency analysis

Statistics below use successful completion events in the retained window. Percentiles use the sorted observation nearest index to `(n - 1) × p`; failures are counted separately and excluded from duration percentiles.

| Account | Successful deltas | Median  | p95      | p99       | Maximum   | Zero-change successes |
| ------- | ----------------- | ------- | -------- | --------- | --------- | --------------------- |
| G       | 5,005             | 2.684 s | 36.616 s | 180.907 s | 597.637 s | 4,944 (98.8%)         |
| M       | 1,716             | 0.508 s | 4.253 s  | 6.579 s   | 13.189 s  | 1,087                 |
| P       | 1,263             | 0.434 s | 4.409 s  | 4.529 s   | 8.570 s   | 1,255                 |

G includes 87 successful operations in 18–20 s, 319 in 20–40 s, 64 in 40–60 s and **160 above 60 s**. There are also 924 below one second. The full-window median obscures a worsening morning trend:

| G completion hour, UTC     | Samples | Median duration |
| -------------------------- | ------- | --------------- |
| 2026-10-08 23:00–23:59     | 276     | 0.996 s         |
| 2026-10-09 06:00–06:59     | 277     | 3.730 s         |
| 07:00–07:59                | 271     | 6.235 s         |
| 08:00–08:59                | 271     | 9.034 s         |
| 09:00–09:59                | 206     | 12.710 s        |
| 10:00–10:59                | 161     | 16.566 s        |
| 11:00–11:59                | 136     | 20.198 s        |
| 12:00–12:31 (partial hour) | 65      | 24.391 s        |

Falling completion counts accompany rising execution times/backlog. Completion-hour grouping is not a controlled experiment; folder composition and failed attempts vary.

Failure events: G **111 `connection_timeout` + 19 `internal_error`**, M 16 `internal_error`, P none in this window. A generic category may hide connection establishment/greeting timeout or another failure because the current sanitizer and job wrapper lose details. It does not establish a Gmail throttle response.

### Why zero changes do not mean cheap work

`DeltaSyncService.run` starts its duration clock after initial mailbox/account checks and after the worker has acquired the mailbox execution lock (`src/modules/mail/application/delta-sync-service.ts:65`; `src/modules/mail/infrastructure/delta-sync-jobs.ts:98`). Logged duration includes marking running, credential resolution, provider execution, persistence and provider teardown; it excludes prior queue wait and advisory-lock pool acquisition. A 508-second **logged service duration cannot be explained solely by pending queue residence**.

The provider opens a fresh connection, selects the mailbox and loads all known local UIDs through the sink (`src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts:1056`, `:1064`; `src/modules/mail/application/delta-sync-service.ts:131`, `:167`). It then:

1. Searches for new UIDs (`imap-smtp-mail-provider.ts:1117`).
2. Uses changed-since FETCH when CONDSTORE and a valid baseline are available (`:1167`). Otherwise fetches flags for every indexed UID in batches (`:1190`).
3. **Unconditionally checks presence of every known local UID with sequential SEARCH batches**, independent of CONDSTORE and change counts (`:1214`).
4. Requests mailbox STATUS, persists completion and closes/logs out (`:1232`, `:1241`, `:1259`). The service logs only afterward (`delta-sync-service.ts:296`).

| Folder alias | Current indexed placements | Presence SEARCH calls at batch 150 | Historical delta samples | Median / p95 / max           |
| ------------ | -------------------------- | ---------------------------------- | ------------------------ | ---------------------------- |
| F01          | 41,246                     | 275                                | 213                      | 39.022 / 359.651 / 597.637 s |
| F02          | 17,449                     | 117                                | 222                      | 19.237 / 196.945 / 274.457 s |
| F03          | 4,108                      | 28                                 | 214                      | 6.095 / 56.285 / 75.323 s    |
| F04          | 603                        | 5                                  | 218                      | 2.585 / 23.230 / 58.568 s    |

Folder sizes are a current snapshot, not historical counts for every sample. Still, the source and current large folders establish **hundreds of sequential round trips on a routine no-change poll**. At least 441 presence SEARCH batches are implied across G's 66,076 current placements per complete folder sweep, before per-folder rounding and other commands. F01 had 196 zero-change successes; F02 216. No actual wire-command count was logged, so the table is a source-derived workload count, not observed packet telemetry. Do not divide total duration by this count and label the result measured SEARCH latency.

This workload is the strongest concrete inefficiency uncovered. Provider/network response delay, library throttling/backoff, credential/setup latency and teardown can amplify it. Larger folders correlate with higher tail durations; small folders also slowed to 18–30 s later, so folder size alone is not the complete explanation. Repeated fresh connections/token requests across labels add overhead. Gmail throttling or slow command responses are plausible, **not confirmed** without safe protocol-stage telemetry. Installed ImapFlow has FETCH throttling retry/backoff behavior (`node_modules/imapflow/dist/esm/commands/fetch.js:206`), but existing logs have its logger disabled and provide no evidence that it ran here.

## 4. Interactive body-fetch analysis

The queue retains ten body jobs, all for G, all currently completed; nine have retry count 0, one count 1. There are no created/active/retry/failed content jobs at the observation time. All ten cached content rows are ready. This does not erase a previous failed attempt or the supplied UI incident.

| Body alias | Created UTC         | Latest start UTC | Queue / creation-to-latest-start | Latest execution | Retry count |
| ---------- | ------------------- | ---------------- | -------------------------------- | ---------------- | ----------- |
| B01        | Oct 08 17:16:28.669 | 17:16:28.953     | 0.284 s                          | 37.156 s         | 0           |
| B02        | Oct 08 17:17:35.176 | 17:17:36.117     | 0.940 s                          | 18.165 s         | 0           |
| B03        | Oct 08 17:25:41.823 | 17:25:42.364     | 0.541 s                          | 1.701 s          | 0           |
| B04        | Oct 08 17:32:14.965 | 17:32:16.507     | 1.542 s                          | 13.939 s         | 0           |
| B05        | Oct 09 05:16:34.300 | 05:16:34.348     | 0.048 s                          | 2.074 s          | 0           |
| B06        | Oct 09 09:04:05.921 | 09:04:07.636     | 1.715 s                          | 9.278 s          | 0           |
| B07        | Oct 09 09:19:36.195 | 09:20:31.819     | 55.623 s, includes recovery      | 24.396 s         | 1           |
| B08        | Oct 09 11:51:58.333 | 11:51:58.390     | 0.057 s                          | 16.060 s         | 0           |
| B09        | Oct 09 11:52:38.776 | 11:52:40.467     | 1.691 s                          | 15.798 s         | 0           |
| B10        | Oct 09 11:53:22.670 | 11:53:24.277     | 1.607 s                          | 18.134 s         | 0           |

For the nine non-retried jobs, queue wait is **0.048–1.715 s**, consistent with a free single content slot and default two-second polling. The 13–37-second slow fetches mostly occur **after dispatch**. There is no support in these retained jobs for sync directly taking body worker slots or a 20-second content-queue backlog. A future burst of body requests could still saturate the single slot.

B07 `start_after` is 09:20:31.206 and latest start 09:20:31.819, approximately **0.613 s after retry eligibility**. Its 55.623 s from original creation to latest start includes first-attempt time and backoff; it must not be described as queue residence. Final creation-to-completion is 80.020 s. Without selecting job output or payload, its original failure code/time cannot be reconstructed. The screenshot cannot be conclusively associated with it.

Seven of the ten latest body execution intervals intersect at least one successful G delta interval; six intersect a G delta longer than 60 s. This is coexistence, not proof that the delta caused the body delay. B05 was fast despite overlapping G deltas. B04 had no overlapping **successful logged** delta interval; failed/unlogged activity and other IMAP tasks are not excluded. No precise browser selection-to-display measurement exists; body-ready persistence precedes job completion slightly and polling/rendering adds further observation delay.

The timeout text's known route remains: provider sanitizer → `MailProviderOperationError` → persisted `messageContents.failed/error` → later successful detail GET → reader failed state (`src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts:269`, `:1471`; `src/modules/mail/application/message-content-service.ts:249`, `:119`; `src/components/message-reader.tsx:170`). The queue POST does not wait for the body. UI polling stops on failed even if pg-boss retries later (`src/components/mail-client.tsx:1191`); final ready rows and completed jobs are therefore compatible with the user seeing a failure and needing Retry download.

## 5. Google OAuth contention analysis

G is verified as Google OAuth2, so the earlier source mechanism applies: every work credential acquisition invokes `GoogleOAuthProvider.accessToken`, locks the account row using `FOR UPDATE`, then makes a refresh-token HTTP request while holding the transaction (`src/modules/accounts/infrastructure/google-oauth.ts:372`, `:385`, `:391`). Token HTTP timeout is 15 seconds (`:140`). Lock wait precedes that timeout. All sync/content/discovery/IDLE credential acquisitions use this path (`src/modules/accounts/application/accounts-service.ts:452`, `:563`). The row lock protects refresh rotation, reconnect and revocation; removing it is unsafe.

Live evidence, however, does **not** confirm OAuth as the dominant cause:

- At 12:33:46, application backends were idle/ClientRead, with no open application transaction, blocking PID or account-table lock.
- In all 15 later samples, blocked backends, idle-in-transaction backends and account relation locks were zero; maximum application transaction age was null. Two delta jobs remained active throughout.
- Thus those slow jobs were not continuously spending the sampled interval holding/waiting for a database account row lock. They were executing outside an open DB transaction, consistent with provider I/O or between-command/application work.

Three-second sampling can miss short token acquisitions, short checkout delays and brief lock collisions. It cannot describe the earlier body event. `postgres.js` application names do not distinguish web versus worker pools, and server idle sessions do not directly expose client-side checkout queues. Preserve OAuth as a possible additional setup delay; **do not present the earlier OAuth hypothesis as a measured root cause**. Historical lock wait and token HTTP timing require new instrumentation in a later authorized release.

## 6. PostgreSQL, pg-boss and IMAP observations

### Queue state and scheduling

Production queue options match source: content/recent/delta/backfill all `stately`, retry limit 4, base delay 30 s, exponential backoff capped at 900 s, expiration 900 s, `notify=false`. They use the shared physical `job_common` storage exposed through `pgboss.job`; separate named queues remain separately consumed. Shared physical tables do not mean a shared execution-slot budget.

At 12:33:45: delta 32 created, one retry, two active, 7,984 completed (141 completed jobs retried, max retry count 2). Recent 37 completed and no current work. Backfill 1,108 completed plus four retained failed jobs, with no active/pending backfill. Historical failed jobs coexist with presently-complete folders; no queue repair was attempted. These are retained job states, not an attempt history.

At 12:36:57, both delta slots belonged to G. One active F01 job was created 12:21:00.924 and started 12:31:09.240: **608.316 seconds of initial queue residence**, already more than two five-minute polling periods. Created jobs included 20 G, seven M and six P jobs; the M/P oldest waits were approximately 357 s. One G retry was deferred to 12:37:31.343. The delta queue's two local workers are global across accounts (`src/modules/mail/infrastructure/delta-sync-jobs.ts:93`), so long G execution causes measured cross-account delta backlog. M/P's subsecond service durations do not imply their queue starts are prompt.

Coalescing keeps one pending created/retry sync request per key and preserves retry state (`src/modules/mail/infrastructure/coalesced-sync-job.ts:3`), but it does not create account fairness or preempt a running folder. A pending successor may coexist with an active job. The prior contention report's queue-priority warning still applies: priority only orders eligible jobs within a named queue.

### PostgreSQL and resources

The live snapshot had 15 application/server sessions plus the diagnostic session, far below 100; later samples reported 15–20 sessions including the observer. No persistent locks/long transactions were observed. Deadlocks were zero. Cumulative buffer hits greatly exceeded physical reads, but a cumulative cache ratio is not a query-latency measurement. `stats_reset` was null; the accumulation window is not a precise incident window. Diagnostics themselves create rollbacks and can perform temporary work, so cumulative counter differences are not attributed to the application.

Current low app/DB CPU and steady memory during active long deltas do not support continuous CPU or PostgreSQL saturation during collection. They cannot exclude historical bursts, host scheduling pressure, network trouble or short application pool starvation. Two sync advisory locks can reserve idle PostgreSQL sessions throughout provider I/O (`src/modules/mail/infrastructure/mailbox-lock.ts:10`), which explains why idle sessions can coexist with active jobs without indicating a database query is running.

### Provider evidence and limitations

A read-only app-container network-table projection found **five established connections to remote port 993** at 12:35:24; no endpoints were emitted. This is compatible with three INBOX IDLE watchers plus two delta connections, but endpoints were not mapped to accounts and external email clients are invisible here. There is no evidence from that aggregate of exceeding Gmail's connection allowance. It does not count recently disconnected sessions that the provider may still consider active.

New IMAP connections/authentication, mailbox selection, FETCH, UID reconciliation SEARCH, STATUS and teardown lack stage timings. The 111 G `connection_timeout` events are evidence of repeated provider-path reliability failures; they do not identify the specific command. The 15-second socket inactivity threshold is not a total job deadline: hundreds of successful command exchanges can keep a connection alive for minutes (`src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts:54`, `:204`). Built-in CONNECT/GREETING/UPGRADE timeout codes are incompletely classified, and first socket errors can be replaced by close/stream errors. No sensitive protocol logging or new Gmail sessions were enabled to resolve this.

## 7. Confirmed findings versus unresolved hypotheses

| Claim                                                                              | Evidence status                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Slow body jobs spend most time after dispatch                                      | **Confirmed** for the nine retained non-retried jobs, from creation/start/completion timestamps.                                      |
| Expensive presence reconciliation even with zero changes                           | **Confirmed source behavior**, exercised against large current indexed folders; actual individual SEARCH durations/counts not logged. |
| Gmail slowdown and reliability failures are account-specific in this window        | **Confirmed**, with distribution, trend and 130 G failure events; M/P have much faster service distributions.                         |
| Long G deltas delay other accounts in the delta queue                              | **Confirmed current state**, two G active jobs and aged M/P pending jobs.                                                             |
| Active historical backfill explains the current morning slowdown                   | **Contradicted by current state** and last backfill completion the previous evening. Routine delta reconciliation remains heavy.      |
| Whole-worker/shared-body-queue starvation explains retained 20-second body events  | **Not supported**; body dispatch was under 1.8 s and its queue is separate.                                                           |
| OAuth causes most of the minutes-long delta duration                               | **Unconfirmed; current sampled evidence argues against sustained OAuth row locking**. Source serialization still exists.              |
| Sustained PostgreSQL/CPU/memory overload during collection                         | **Not observed**. No historical resource time series was available.                                                                   |
| Gmail throttling, authentication delay or slow SEARCH replies amplify the workload | **Plausible leading provider-path hypotheses**, without direct stage/throttle telemetry.                                              |
| B07 is the screenshot's timeout                                                    | **Unresolved**; retry metadata has no original failure detail or browser correlation.                                                 |
| A second body worker or higher priority will fix the observed issue                | **Unsupported as a primary fix**; these do not shorten active provider work.                                                          |

The defensible causal conclusion is a confirmed excess-work mechanism and scheduling consequence, plus a measured concentration of body latency after dispatch. The exact dominant remote stage and original timeout exception remain unresolved. Do not turn the presence-search workload into a claim that every second was spent in SEARCH without measurements.

## 8. Recommended minimal v1.0.1 fixes

These are recommendations only; none are implemented or deployed.

1. **Add safe stage/error instrumentation and fix timeout classification first.** Preserve normalized ImapFlow timeout code/kind and operation stage before sanitization, without retaining raw exception/provider text. Explicitly handle CONNECT_TIMEOUT, GREETING_TIMEOUT, UPGRADE_TIMEOUT, ETIMEOUT and ETIMEDOUT. Keep authentication/TLS failures distinct. This is a confirmed classifier defect, independent of which timer failed in production.
2. **Reduce full-folder presence reconciliation round trips while preserving deletion evidence.** The current 150-UID metadata batch size is also used for existence searches, making large no-change deltas unnecessarily long. Evaluate one complete successful UID listing per selected mailbox, intersected with the known local UID snapshot, or independently sized/compacted bounded UID-search batches. A full UID listing must not import historical messages and must fail safely on incomplete responses; never delete placements from a failed/partial listing. Keep UIDVALIDITY checks, committed checkpoints and concurrent-arrival/expunge handling. Avoid a shortcut that skips removals merely because MODSEQ/count appears unchanged without a correctness design. Validate this small provider reconciliation change off production before approval to deploy.
3. **Add account fairness / bounded background admission if stage measurements confirm provider pressure.** Current long G jobs demonstrably monopolize delta capacity. Limit per-account background occupancy, leave capacity for other accounts and interactive work, and acquire admission before credentials so OAuth demand is bounded too. A simple local limit must match the verified single-worker deployment or be replaced with crash-safe multi-process leases. Do not increase all worker/connection counts or interrupt in-flight commands. Splitting a long delta requires durable reconciliation/checkpoint boundaries, not abandoning part of the known UID list.
4. **Make body retry state observable and consistent.** A failed UI can remain stale while automatic retry succeeds. Define authoritative pending/retrying/terminal status and bounded recovery, avoid duplicate manual/automatic work, preserve ready-body state and recover an interrupted request without guessing that a slow job is dead. Test before capacity/prefetch changes.
5. **Defer low-evidence changes.** Faster content polling can save up to roughly two seconds but is secondary to the measured 13–37-second execution. Raising body concurrency/priority cannot repair this execution time and could add provider load. Do not remove OAuth locks, introduce token caching, raise socket timeout globally or implement Gmail cross-label deduplication as a speculative hotfix. Each needs separate evidence and correctness review.

A blanket socket-timeout increase would hold the single body slot longer on broken sessions and hide failures. If later measurements show healthy commands legitimately idle beyond 15 seconds, evaluate a bounded configurable value with correct cleanup/retry behavior. Successful minutes-long deltas already show why an inactivity timer and total-attempt latency are different concepts.

## 9. Required instrumentation

Structured, allowlisted, correlated events with local monotonic durations should distinguish:

- Browser selection/request/ready-text/HTML timestamps from backend ready persistence.
- Queue creation, eligibility, first/latest start, attempt/retry and completion; keep per-attempt timing rather than only overwritten job timestamps.
- Application DB checkout, sync-lock acquisition, OAuth account-lock wait and token HTTP duration. Never include token request parameters, responses or credential caches.
- IMAP transport connect, greeting/session authentication, mailbox open, new-UID search, changed-since/fallback flags, **known-UID reconciliation count and duration**, STATUS, selected text-part FETCH/progress and teardown.
- Effective CONDSTORE/selected-mailbox MODSEQ use, local UID count, UID query batch count/length and response count; do not log actual UIDs, paths, addresses or message contents to the report.
- Active/admitted IMAP sessions per account/service class, safe timeout/throttle codes and bounded retry delays; no raw protocol logger.
- Event-loop lag/process CPU, database wait/pool metrics and timestamps aligned with slow spans. Current server sessions alone do not establish pool pressure.

Use `performance.now()`/`hrtime` for local stages and the same DB clock for queue timing. Do not subtract monotonic clocks across processes. Instrumentation failure must not alter authorization, mail state or job outcome. Sampling must retain slow/failed operations without exporting sensitive content.

## 10. Remaining risks and verification steps

- The deployed tag/version agrees with the source baseline, but absent an OCI revision label there is no independent source-build attestation. Verify immutable release provenance before changing code.
- The diagnostic window is finite, covers one container lifetime and includes only successful durations; the longest failed attempts may be unmeasured. Current ready bodies hide earlier failed states.
- Folder membership greatly exceeds the initial estimated account size; label overlap and All Mail naming were deliberately not retrieved. Provider identity deduplication remains a larger persistence project.
- Present lock/resource observations cannot disprove historical OAuth stalls, brief pool waits or provider session pressure from other clients. No historical stage attribution can be reconstructed from a generic timeout message.
- Correlation of slow bodies with long deltas establishes coexistence, not direct contention on the same connection. Operations create independent clients; they share account/provider/host capacity.
- Validate the proposed reconciliation change using existing fake-provider and real-PostgreSQL sync fixtures, a controlled IMAP server with complete/partial/error responses, sparse UIDs, UIDVALIDITY reset, expunge/arrival races and no-change large-folder cases. Validate retry/UI state using real pg-boss plus worker/browser tests. This is a proposed future test plan; no tests were added, modified or run.
- Compare stage p50/p95/p99, timeout rate, queue age, cross-account progress, body execution and sync correctness on a nonproduction dataset. A separate opt-in Gmail test account may be needed to reproduce provider delays; this investigation did not create one or connect to Gmail.
- Production rollout, new instrumentation, controlled retries or any disruptive diagnostic require a later explicitly authorized task. Existing availability and data integrity were preserved throughout this read-only investigation.

Validation of this deliverable is limited to evidence/source review, report formatting and Git diff checks. Only this sanitized report is committed; no raw evidence, secrets, application changes, tests, configuration or migrations are included.
