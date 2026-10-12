# Dovecot benchmark results

Measured on 2026-10-12. Sources and exact reproduction commands: [SETUP.md](SETUP.md). Machine-readable evidence: [summary.json](../../../experiments/imap-dovecot/outputs/summary.json); lossless per-run traces are linked there. All protected Phase 1/1B artifacts remain unchanged.

## Scope and conditions

Actual Dovecot 2.4.3-dev, authenticated verified loopback TLS, ImapFlow 2.0.6. Host: Intel Core Ultra 7 155H, 22 logical CPUs, 33,777,467,392 bytes RAM, Node 24.21.0. Docker Desktop WSL Linux engine has 22 CPUs and 16,481,640,448 bytes memory; fixture container is limited to two CPUs and 1 GiB. No injected RTT or bandwidth limit. Server indexes and metadata were warmed by complete independent fixture verification. Client processes are fresh; cold storage/server runs were not measured.

Initial count: **50,000**, independently verified against every manifest identity, subject, size and permanent flag; UIDNEXT 50,001, UIDVALIDITY 1791799138. Fixture generation 8.482 seconds; total preparation including verification 316.535 seconds. Actual assigned UIDs were retrieved from IMAP, never manufactured. Old-Date messages, multipart and attachments are in the fixture. The initial manifest hash is in SETUP and summary. A later destructive-test reset has its own epoch in the trace.

An in-memory Map holds compact metadata keyed by current epoch/UID, and boundaries move only after complete exact metadata. This is observable local availability, **not PostgreSQL transaction durability**. The orderly-restart JSON checkpoint is also not a crash-consistent database. The runner never invokes production services.

## A — Full inventory versus descending windows

Three runs each, alternating order. First visibility is after the first complete bounded metadata commit, not first iterator delivery. First 1,000 means the first completed batch crossing that count. Setup/authentication is recorded separately.

| Method      | Runs | First 128 ms    | First 1,000 ms  | Full 50k seconds | Peak RSS MiB  | Peak heap MiB | Maximum event-loop delay ms |
| ----------- | ---- | --------------- | --------------- | ---------------- | ------------- | ------------- | --------------------------- |
| baseline    | 3    | 1566.68–2122.18 | 1658.57–2258.75 | 7.09–7.91        | 242.98–266.48 | 125.97–129.80 | 1392.51–1867.51             |
| progressive | 3    | 215.73–304.07   | 395.21–519.35   | 6.18–8.12        | 224.41–224.82 | 111.31–111.55 | 43.71–51.09                 |

The baseline performs one full closed-UID-range FLAGS inventory and then newest-first exact metadata batches of 128. This corresponds to Thunderbird research T07–T10's full initial UID/flag discovery prerequisite. Its metadata batching, descending order, ImapFlow parser, in-memory publication and BODYSTRUCTURE differ from Thunderbird; **this is not a Thunderbird benchmark**. The 16 MiB inventory aggregate budget is a disclosed larger baseline allowance; other operations use 2 MiB.

Baseline wire totals: 25,071,888 incoming / 319,275 outgoing bytes and 402 logged outgoing commands including startup. Progressive totals: 22,971,897–22,971,913 incoming / 331,567 outgoing bytes, 792 commands. TLS record overhead, authentication bytes before transport instrumentation, server disk I/O and body bytes outside requested metadata are not included. Progressive work saves the inventory but adds closed-window SEARCH commands. Complete-time ranges overlap: faster first availability does not establish universally higher throughput. Full inventory caused much larger measured event-loop stalls.

## B/C — 50,000 plus ten arrivals and connection budgets

**27 successful primary-size arrival runs**, 270 independently appended identities, all ten observed and all 50,010 UIDs checked in every successful run. Failure traces remain below. Each major profile has at least three FETCH-trigger trials. C5-one is one data socket plus watcher; C5-two adds one preconnected user-data socket. C5 does not open five sockets.

| Profile | FETCH-trigger runs | Own / with external actor sessions | Post-completion wait p50 ms | p95 ms | Worst ms | Worst user admission wait ms | Worst BODY.PEEK admission from intent ms | Full-history seconds |
| ------- | ------------------ | ---------------------------------- | --------------------------- | ------ | -------- | ---------------------------- | ---------------------------------------- | -------------------- |
| C1      | 5                  | 1 / 2                              | 131.24                      | 271.94 | 297.42   | 52.21                        | 203.83                                   | 9.12–10.19           |
| C2      | 5                  | 2 / 3                              | 132.64                      | 286.04 | 313.82   | 42.85                        | 87.11                                    | 8.15–10.88           |
| C5-one  | 6                  | 2 / 3                              | 150.84                      | 260.41 | 465.05   | 41.05                        | 92.93                                    | 8.41–10.68           |
| C5-two  | 3                  | 3 / 4                              | 178.16                      | 348.62 | 414.45   | 0.10                         | 188.96                                   | 7.91–10.25           |

Resource totals below include the watcher and external actor, initial setup, fixture oracle and cleanup. Data-socket occupancy excludes SELECT and passive IDLE. Per-lane breakdowns and every command interval are in the trace; total occupied duration can be obtained by summing those intervals, rather than treating passive authentication as busy work.

| Profile | RSS MiB       | Heap MiB      | Whole-process CPU seconds | Max loop delay ms | Data occupation p95 ms | Max data occupation ms | Logged commands | Decrypted in / out MiB  |
| ------- | ------------- | ------------- | ------------------------- | ----------------- | ---------------------- | ---------------------- | --------------- | ----------------------- |
| C1      | 227.79–249.08 | 113.67–121.42 | 6.95–7.51                 | 38.67–51.48       | 15.30–16.76            | 255.25                 | 2331–2390       | 22.03–22.03 / 0.35–0.35 |
| C2      | 229.14–232.25 | 113.96–114.83 | 6.11–8.05                 | 37.85–50.40       | 12.79–17.75            | 386.73                 | 2325–2403       | 22.03–22.03 / 0.35–0.35 |
| C5-one  | 226.75–233.73 | 114.10–116.51 | 5.59–8.77                 | 38.31–52.17       | 12.58–17.92            | 582.64                 | 2332–2399       | 22.03–22.03 / 0.35–0.35 |
| C5-two  | 227.46–231.71 | 114.50–116.63 | 6.28–7.39                 | 50.30–65.08       | 11.23–16.95            | 357.70                 | 2389–2405       | 22.03–22.03 / 0.35–0.35 |

Session counts distinguish client-owned data/watcher sockets from the independent APPEND actor. doveadm who samples corroborate live sessions but are not an exhaustive peak audit. One data socket is never used concurrently by two operations. Watcher IDLE occupies its own socket without a data turn. C1 IDLE is explicitly exited by DONE; actual tagged IDLE completion precedes NOOP. Command/tag times and operation intervals are retained in raw traces. The extra C5 user lane greatly reduces this small request's queue delay, while these measurements do not establish a freshness or throughput gain that justifies concurrent authoritative writers.

Latency reference: local monotonic completion of the independent APPEND call. Dovecot's actual imap_command_finished.end_time and APPENDUID are matched for **270/270** successful arrivals. Server-to-client UTC estimates have no host/WSL clock calibration and are uncertain. Metadata was already available before the APPEND call completed in **11** cases; raw signed values are retained. The table reports remaining wait at that checkpoint as max(0, signed delta), meaning “already available” for those cases, not a negative delivery duration. APPEND request duration and server command duration remain separate.

Each UID has separate append completion, fresh-frontier detection, arrival-unit admission, completed retrieval and synchronous local publication timestamps. Detection here is the refreshed STATUS frontier observation, not the watcher hint or first metadata iterator row. Selector admission is immediate after that observation in this small single-account loop; waiting behind history appears in append-to-detection and user-intent wait. The first EXISTS hint is recorded separately. This is not a complete production selector/due-generation implementation.

Closed SEARCH/FETCH commands fully settle before re-admission and setImmediate yields an execution turn. Hints coalesce into a boolean; polling runs every eighth boundary and, conservatively, every boundary once APPEND work has completed. That extra polling slows history and prevents treating B/C throughput as an isolated metadata algorithm cost. No 15-second production polling SLA, continuous-arrival fairness, many-account workload or ten-minute queue plateau is proved.

## Arrival boundary trials

| Profile | Injection | Worst remaining signed completion-to-availability ms | Full run ms | Identity result               |
| ------- | --------- | ---------------------------------------------------- | ----------- | ----------------------------- |
| C1      | search    | 311.82                                               | 10327.96    | PASS: 50,010 exact local UIDs |
| C1      | after     | 252.19                                               | 11426.05    | PASS: 50,010 exact local UIDs |
| C1      | waiting   | 301.07                                               | 9111.00     | PASS: 50,010 exact local UIDs |
| C1      | idle      | 194.24                                               | 9482.80     | PASS: 50,010 exact local UIDs |
| C2      | search    | 310.53                                               | 10029.54    | PASS: 50,010 exact local UIDs |
| C2      | after     | 261.71                                               | 10274.78    | PASS: 50,010 exact local UIDs |
| C2      | waiting   | 260.52                                               | 8259.76     | PASS: 50,010 exact local UIDs |
| C2      | idle      | 219.93                                               | 10782.70    | PASS: 50,010 exact local UIDs |

SEARCH/FETCH injection launches the independent append while the client's operation promise is active. Dovecot completion can race the append; it does not provide a deterministic server-side pause barrier. These are **nondeterministic overlap trials**, with exact operation/APPEND intervals retained. “After” is an explicit completed-operation boundary; “waiting” is a controlled 25 ms admission pause; C1 IDLE has an explicit IDLE/DONE boundary. Boundary cases have one trial per profile, not three or a broad seeded race matrix. The existing scripted TLS fixture retains deterministic malformed/hung cases.

## D/E — Remote changes, resource limits and recovery

Latest destructive trace: [2026-10-12T10-27-33-312Z-changes-condstore.json.gz](../../../experiments/imap-dovecot/outputs/2026-10-12T10-27-33-312Z-changes-condstore.json.gz). Overall destructive runner: **PASS**.

| Case                          | Outcome | Measurement / observation                                          |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| flags                         | PASS    | rows=1; 2.06 ms;                                                   |
| ordinary-flags-fallback       | PASS    | rows=128; 12.62 ms;                                                |
| unflags                       | PASS    |                                                                    |
| search-fetch-expunge          | PASS    |                                                                    |
| same-epoch-absence-recheck    | PASS    |                                                                    |
| equal-count-old-date-arrival  | PASS    |                                                                    |
| completed-read-retry          | PASS    |                                                                    |
| aggregate-budget              | PASS    | 11.52 ms; received overshoot 1180 bytes;                           |
| partial-fetch-abandoned       | PASS    |                                                                    |
| reconnect-conservative-replay | PASS    |                                                                    |
| connection-rejection          | PASS    |                                                                    |
| 15000-deletions-sparse-holes  | PASS    | 25212.85 ms; 15000 deletions; final 35009; worst arrival 326.94 ms |
| uidvalidity-recreated-mailbox | PASS    |                                                                    |

D starts with the verified fixture's compact local model and runs bounded reconciliation, rather than rebuilding all historical metadata while deleting. The external actor changes Seen/Flagged in both directions, expunges a UID between SEARCH and FETCH, performs equal-count removal/old-Date arrival, and deletes 15,000 known messages in 128-sized batches. Ten arrivals during deletion are discovered through fresh NOOP/STATUS/closed SEARCH, independently of the actor's UID oracle. Membership and flags converge through two bounded passes after finite churn; this is not recovery of mail expunged before observation. Every missing required FETCH remains unresolved until complete same-epoch membership recheck. CHANGEDSINCE is compared with full FLAGS for the same 128 known identities; both still require independent complete membership evidence, and neither uses QRESYNC.

Ordinary read reconnect/replay, abandoned partial FETCH, completed-read retry, aggregate-budget rejection, and server connection rejection are exercised on Dovecot. A separate orderly two-process checkpoint restart resumes the saved lower frontier and records replay/SELECT overhead. It deliberately has no fsync, transaction, lease, pg-boss ACK or power-loss contract. Malformed/deep/never-ending responses, missing tagged completions and wrong BODY.PEEK origins run against the existing scripted TLS peer: **46/46 assertions passed** in a new output file; expected unsafe reproductions remain classified unsafe. These are not Dovecot measurements. Existing application regression: **47/47**, three IMAP-related Vitest files.

## Resource and correctness interpretation

Primary A–C process memory includes the loaded ground-truth oracle, compact 50k local model, ImapFlow and retained instrumentation. It is sampled every 5 ms and may miss transient peaks; it is not a strict process-memory limit. CPU includes process setup and oracle preparation; per-operation byte/time scopes exclude fixture loading. The destructive D/E runner retains command bytes/timing but does not sample process RSS/heap/CPU/event-loop peaks; those D/E resource metrics are **not measured**. Docker samples for the primary suites reached approximately **116.90% CPU** and **526.7 MiB** memory. These container samples include filesystem cache and span sequential profiles; they are not per-profile attribution.

The approved byte/resource direction is used. K=128 is the work batch size, not a token-allocation assertion. Incoming decrypted aggregate budgets include the rejected current chunk; measured overshoot is recorded. Arbitrary TLS/native/allocator headroom remains outside this logical budget. Compact ESEARCH expansion, compression and IMAP4rev2 remain unvalidated in this real-server profile; the scripted adapter explicitly rejects dangerous ESEARCH expansion. Active cancellation invalidates the scope, destroys the actual socket and awaits native close/work settlement; successful cancellation is not inferred from Promise.race.

Every successful A/B/C run compares all still-existing initial UID identities to the independent assigned manifest, forbids duplicate local keys and advances history only after complete metadata. Flags-only unsolicited FETCH, including sequence-only notifications, is kept as a bounded hint without assigning it a remote UID or authorizing metadata/absence. Requested metadata remains exact-set and complete. UIDVALIDITY rejection is exercised only in a separate supported delete/recreate mailbox. Owner/transaction fencing, epoch changes during concurrent production commits and application integrations are unproven.

## Retained failures and repairs

| Trace                                                                                                                                                                  | First reported failure                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [2026-10-12T10-06-21-520Z-arrivals-50000-C1-fetch.json.gz](../../../experiments/imap-dovecot/outputs/2026-10-12T10-06-21-520Z-arrivals-50000-C1-fetch.json.gz)         | AssertionError [ERR_ASSERTION]: Availability timing must be observed, not inferred                                                                                                                                                               |
| [2026-10-12T10-07-54-024Z-arrivals-50000-C5-two-fetch.json.gz](../../../experiments/imap-dovecot/outputs/2026-10-12T10-07-54-024Z-arrivals-50000-C5-two-fetch.json.gz) | Error: {"status":"unresolved","kind":"incomplete","remoteOutcome":"read-only","message":"Unexpected or duplicate FETCH identity","metrics":{"received":58124,"accepted":58124,"maxChunk":2430,"rejectedChunk":0,"identities":0,"parserAtAbort":{ |
| [2026-10-12T10-09-48-806Z-arrivals-50000-C5-two-fetch.json.gz](../../../experiments/imap-dovecot/outputs/2026-10-12T10-09-48-806Z-arrivals-50000-C5-two-fetch.json.gz) | Error: {"status":"unresolved","kind":"malformed","remoteOutcome":"read-only","message":"Invalid unsolicited UID","metrics":{"received":58168,"accepted":58168,"maxChunk":4034,"rejectedChunk":0,"identities":0,"parserAtAbort":{"lineBytes":0,"r |
| [2026-10-12T10-16-05-615Z-arrivals-50000-C5-one-fetch.json.gz](../../../experiments/imap-dovecot/outputs/2026-10-12T10-16-05-615Z-arrivals-50000-C5-one-fetch.json.gz) | TypeError: Cannot read properties of null (reading 'once')                                                                                                                                                                                       |

Small-fixture failures and destructive-run failures are also preserved as gzip traces. They include stale STATUS UIDNEXT before NOOP, an incorrect assumption about the public NOOP return value, APPEND/FETCH timing collection racing the APPEND callback, legitimate unsolicited flags during metadata/repair, a 256 KiB line-cap rejection of full SEARCH, and a passive actor socket expiring after ten seconds of unrelated history. The fixes refresh selection, require actual tagged success, retain publication timestamps independently, classify hints without weakening required metadata, bound inventories and separate 60-second passive inactivity from the unchanged 10-second active deadline. One suite collector also discovered a concurrently written summary instead of its child's result; filenames are now matched to that exact scenario. No partial/failed trace was counted as a passing complete run.

## Architecture hypotheses

| Original hypothesis                                                | Assessment                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First 128 within 5 s                                               | Observed within 5 s locally for both A variants. Reference RTT/bandwidth profile absent: **not an original-SLA pass**.                                                                                 |
| Ten arrivals within 5 s with watcher / 20 s without                | Observed within these values in completed local trials. Nondeterministic boundaries and absent reference network: **partial evidence**.                                                                |
| Individual user/content admission within 5 s                       | Observed for one small request per trial; sustained/moderate multi-account demand **not measured**.                                                                                                    |
| Healthy occupancy p95 <=2 s, configured absolute deadline 10 s     | Local individual command p95 below 2 s; active deadline configured and scripted hangs rejected. SEARCH and FETCH have separate scopes here, so complete multi-command/DB turn deadline **not proved**. |
| Hung turn released within 11 s                                     | Scripted accelerated deadlines prove local destruction under responsive event loop. Unconditional wall-clock/production 10 s failure matrix **not measured**.                                          |
| Metadata DB commit p95 <=250 ms, statement/lock <=2 s              | **Not measured**, no PostgreSQL.                                                                                                                                                                       |
| Recent flags/deletions <=45 s, bulk 50k <=10 min                   | Finite D convergence measured; cadence/production protected admission **not measured**.                                                                                                                |
| Multi-account 2:1 fairness, rotations, saturation, post-crash 45 s | **Not measured**.                                                                                                                                                                                      |
| Logarithmic huge sparse gaps                                       | Only deletion-created moderate holes here; billion-UID adaptive probing **not measured**.                                                                                                              |
| Strict K parser allocation                                         | Explicitly superseded by approved byte/resource contract; never claimed. Memory amplification/headroom and long queue plateau still **uncertain**.                                                     |

This is a substantial real-server latency and correctness experiment, with explicit partial D/E and durability boundaries. It is not the full production evidence gate from SYNC_ENGINE_VALIDATION.md. See [architecture review](ARCHITECTURE_REVIEW.md) and [recommendation](RECOMMENDATION.md).
