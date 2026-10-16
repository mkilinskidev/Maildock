# R16 — Production receiving cutover and deployment validation

Date: 2026-10-16. Base: accepted R15
`7e281ce98469b29793cd73bd05af530287dcd3c0`. Branch:
`feature/imap-sync-r16-production-cutover`. New installations only; R17 has not
started. **Decision: PARTIAL**, for the unresolved validation limits below.

## Gate 1 — Historical publication prerequisite

The original `atomic first window` fixture, including all assertions for UIDs
129–256, reproduced the historical failure: 2,245 ms test duration and an aborted
publication at the existing two-second transaction deadline. The focused original
run had one failure, two passes and twelve unselected cases. Container startup and
migrations happen outside that deadline. No deadline, 128-message window,
adjacency, authority assertion or claim/COMMIT validation was relaxed.

A temporary local profiler measured application SQL calls and PostgreSQL
`pg_stat_statements`/`track_functions` using the same ordinary application role.
The instrumentation was removed from production source after profiling. The
baseline profiling run itself narrowly completed; that does not erase the
unmodified fixture's earlier failure.

| Exact 128-message publication            |  Baseline profile | Corrected profile |
| ---------------------------------------- | ----------------: | ----------------: |
| Transaction elapsed, including COMMIT    |       1,858.28 ms |         648.32 ms |
| Application statements, including COMMIT |               261 |               261 |
| Message INSERT calls                     |               128 |               128 |
| Message INSERT server execution          |       1,363.41 ms |         246.66 ms |
| Placement INSERT server execution        |          54.15 ms |          45.55 ms |
| Conversation trigger total               |       1,281.08 ms |         172.65 ms |
| Conversation reconcile total             |       1,279.49 ms |         171.27 ms |
| Account-removal guard calls / total      | 9,159 / 557.75 ms |  1,166 / 79.75 ms |
| Deferred COMMIT authority calls / total  |    259 / 45.58 ms |    259 / 36.86 ms |
| Client-observed COMMIT call              |          62.65 ms |          40.14 ms |

Function totals are nested, not additive. Client timings include round trips and
driver work. The dominant server execution was conversation redirect churn:
each sibling message rewrote every losing conversation redirect already pointing
at the winner, repeatedly invoking guards and maintaining tuples/indexes. This
was quadratic redundant work, rather than a need to weaken receiving permits.
No independent lock-wait timeline was collected; there was no deliberately
introduced lock contender in this fixture. The measured server/function execution
demonstrates the dominant cost, but is not presented as a precise decomposition
of every unmeasured lock/driver/fixture interval.

Migration `0053_conversation_redirect_writes.sql` replaces the original conversation
reconcile function with the additional predicate
`merged_into IS DISTINCT FROM winner` on losing redirects. It preserves merges,
changed redirect targets, winner timestamps and all receiving authority checks.
A conversation integration regression verifies the existing sibling redirect's
`ctid` remains unchanged when another sibling joins, while all messages still
resolve to the same conversation. No earlier migration was rewritten.

Before production activation, the complete selected R04, R06 and R15 regressions
plus conversation tests passed **281/281 in ten files**. This includes the original
dense fixture, sparse/empty windows, claim settlement, bounded/cache publication,
retirement, safety and all 37 R15 cases. Gate 1 therefore passed before cutover.

## Production composition and lifecycle

Normal `worker-process.ts` now constructs `ReceivingWorker`. It owns one R04
executor (D=2), an elected coordinator and the existing scheduler defaults W=2,
C=1. Registered descriptors are bootstrap/history/live INBOX, complete LIST,
destination SELECT, repair, STORE, MOVE, content, attachments, APPEND and typed
exact lookups for flags/MOVE/Sent. R09 saved encrypted credentials and OAuth
resolution remain the actual account bindings. Internal diagnostics routes to the
elected owner through the normal RPC listener.

The production process no longer registers legacy discovery/recent/delta/backfill,
content, command, attachment or sent-copy executors, pollers or IDLE watchers.
Their implementation files remain for baseline compatibility fixtures and R18;
they are not competing production consumers. SMTP/outgoing and local account
removal workers remain registered, with the existing outgoing poller.

Old queue names accept validated conversion-only callbacks. Recent/delta/history
hints commit durable source-bound demand before ACK. Discovery commits a topology
request. Content/attachment/command/Sent hints derive wake identity from durable
rows and never manufacture a remote result. A live account/mailbox mismatch fails
observably; obsolete identities cannot execute. Secondary-folder demand remains
durable for R17. Lost notifications and follower ACKs retain database work.

The existing acquisition/heartbeat/notification control opportunities perform a
bounded, keyset-paginated topology selection (32 accounts), coalesced per account.
It uses the same scheduler and W/C/D admission, not an additional poller. Only
trusted production LIST registration enables automatic discovery; explicit R07
descriptor fixtures retain their original behavior. Discovery completion is
owner/configuration/lifecycle/request fenced and does not satisfy the broader
account or secondary-folder demand.

Account configuration/re-enable changes also atomically request discovery through
the existing demand trigger. Account service requests persist before queue send.
The UI exposes INBOX history/coverage and deferred secondary folders without
claiming they are synchronized; refresh does not write legacy enrolled state.
Account settings no longer report legacy "Never" timestamps or old sync errors
as current v2 results; history progress refreshes the existing settings view.

MFA readiness gates business consumers and receiving election. The supervisor
rechecks readiness after asynchronous startup and on each existing readiness tick.
Loss/stop revokes admission immediately and retires the current lifetime before
replacement election. Shutdown awaits receiving retirement before jobs and pools.
Follower retries are handled by that same supervisor. The normal-process test
uses two actual forked entrypoints, real saved encrypted credentials, verified TLS,
synthetic owner/MFA provisioning and PostgreSQL: initial silence, one election,
INBOX/history, quiet reconciliation, STORE, old-job conversion, secondary due,
invalid identity rejection and orderly takeover are exercised without a test
client factory. It observes at most one socket for that account.

## Docker deployment and fixes found by the actual build

The base Dockerfile, PostgreSQL image and Compose service architecture are used
unchanged. Disposable project `maildock-r16` ran PostgreSQL 18.6, the ordinary
scoped application role, real migrations, normal container supervisor, standalone
Next server and compiled Node worker. Node is 24.21.0; host pnpm is 12.7.0 and
Docker is 28.5.1. A fixture override supplies verified loopback IMAP/SMTP and a TLS
ingress on host loopback port 31416. RPC 3001 and optional benchmark inspectors
are loopback-only and unpublished. No real mailbox, credentials or user volumes
were used. Fixture provisioning of verified MFA is explicitly synthetic.

Three integration defects were corrected from actual deployment evidence:

1. Startup's legacy local-search conversion attempted to update enrolled pending
   content and correctly hit receiving guards on restart. Both its bounded SELECT
   and conditional UPDATE now exclude enrolled accounts. Receiving publication
   remains the source of their search text. The new restart regression preserves
   the entire enrolled content/state row; the legacy global-search conversion
   suite, including its 30,000-message fixture, still passes (30/30 combined).
2. Worker packaging qualified static imports but left dynamic receiving imports
   without `.js`. They worked under tsx but failed in normal Node. The packaging
   rewrite now handles literal dynamic imports too. The rebuilt Docker reader
   passed with actual compiled modules; no R11 budgets changed.
3. Complete LIST published folders/roles but left a new account's saved server
   capabilities empty, making the user-facing MOVE producer unavailable. The
   owned client now exposes a revocable copy of capabilities; bounded capability
   hints publish atomically in the same locked topology transaction. R14 still
   checks the actual live connection before MOVE. The process regression checks
   discovery persists capabilities, and the corrected Docker command phase passes.

An initial benchmark override combined `network_mode` and inherited `expose`;
Compose rejected it. Resetting `expose` fixed the fixture configuration. Initial
fixture errors (PLAIN continuation, complete LIST patterns, correct RFC822.SIZE and
requested FETCH fields) were corrected in the fixture, not by relaxing protocol
collectors. Original failed-run logs remain evidence. Early resource samples from
those failed runs are excluded from accepted measurements.

## Controlled functional deployment evidence

The producer is a separate one-shot container using the built application services
and real durable rows/jobs. Actual receiving/SMTP executes in the ordinary deployed
worker. Rendering called by the producer has the ordinary service implementation,
but this is not claimed as an authenticated browser-to-HTTP walkthrough.

| Scenario                                             | Observed result                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Add two password accounts, discovery, fresh/history  | 1,024 INBOX placements per account; F=1,024, E=1; discovery success; deferred secondary views                                  |
| Large HTML/plain content, CID, remote-image blocking | Reader phase passed; >2 MiB HTML, exact plain text, CID ready, blocked remote image, repeated cache reads add no literal bytes |
| Incoming attachment/cache                            | Exact 100 MiB, incremental SHA-256, repeat read with no additional IMAP literals; 6.24 s producer phase                        |
| Read/unread/flag/unflag                              | All succeeded and preserved unrelated `\\Answered`                                                                             |
| Archive/Trash                                        | Two authorized MOVE commands; mapped destination state initialized through R07                                                 |
| No MOVE capability                                   | Failed conservatively, zero MOVE; no COPY/delete fallback                                                                      |
| Lost STORE reply                                     | Exactly one STORE, then read-only reconciliation succeeded                                                                     |
| Draft and compose                                    | Draft create/autosave plus reply/reply-all/forward preparation passed                                                          |
| SMTP/server Sent                                     | One SMTP, zero Maildock APPEND for server policy                                                                               |
| SMTP/Maildock Sent                                   | One SMTP and one APPEND; immutable MIME digests equal                                                                          |
| Diagnostics                                          | Saved-account IMAP owner RPC and SMTP test both succeeded                                                                      |
| Dense new account                                    | 1,024 messages in 6.75 s; separate sampled account 6.35 s                                                                      |
| Quiet new arrival, external flags and deletion       | No wake supplied; completed in 100.54 s, consistent with finite 128-UID/15-second sweep                                        |
| Shutdown during blocked attachment read              | Actual wire-read barrier confirmed; graceful app stop 685.87 ms; failed read remains visible                                   |
| Explicit retry after graceful stop                   | New attempt, exact 100 MiB and SHA-256; 9.93 s phase                                                                           |

The command phase deliberately omitted direct wake callbacks and completed in
151.61 s across its sequential operations, exercising heartbeat discovery. These
phase times include producer startup/barriers and are not operation-budget changes.
The dense measurement includes account creation/discovery/history, and is a bounded
local-fixture observation, not a provider throughput promise. Across these runs
the peer observed at most two active sockets and one per account.

Graceful cancellation records `failed_remote_read`; retrying the user request is
distinct from recovery after an abrupt process crash. The initial fixture assumed
automatic resume after graceful stop and failed; the accepted R12 behavior was
retained and tested explicitly with a separate retry phase. Original restart/crash
regressions cover original-intent read restart and quiescent orphan reclamation.
No background orphan deletion or new monitoring subsystem was introduced.

Lost MOVE/APPEND responses were injected after the synthetic mutation. The initial
APPEND lookup fixture included incorrect FETCH fields and conservatively exhausted
its three observations without replay. Its stricter saved-result assertion failed
and that evidence is retained. A separate disposable recovery project, with corrected
requested-field responses, verified exact lookup and restart: the original
APPEND attempt UUID survived, full MIME matched and the Sent result became saved.
SMTP/APPEND/MOVE/STORE counters remained 3/2/1/0 across restart. Its corrected
outgoing, uncertain-mutation and restart phases passed in 16.13 s, 31.84 s and
1.67 s respectively. TLS ingress returned 200 from live/ready endpoints and 401
from the unauthenticated account API. Both disposable projects were stopped and
their containers/networks removed; evidence and isolated volumes were retained.
PostgreSQL COMMIT reply loss is exercised by existing real PostgreSQL reply-dropping
relay regressions; a database-network fault in the Compose deployment itself is
not claimed.

## Actual resource observations

The default deployment is W=2/C=1/D=2. Docker reports a 15.35 GiB Linux host budget.
Samples use `docker stats` and actual worker/web `process.memoryUsage()` through
loopback benchmark inspectors. Producer containers are excluded. Sampling is
bounded and may miss the true peak; CPU percentages can exceed 100% across cores.
The dedicated exception debugger was detached for accepted performance runs.

| Workload                            | Actual app container                                  | Actual worker                                                                       | PostgreSQL                                         |
| ----------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| Before business readiness           | ~443 MiB; 0.22% CPU sample                            | RSS 377.2 MB, heap ~64 MB                                                           | ~83 MiB; 0.13% sample                              |
| Dense sampled 1,024-message history | 463.6–477.8 MiB; 0.38–35.21% CPU samples              | RSS 416.3–419.7 MB; heap 77.5–146.8 MB; external <=7.57 MB; buffers <=3.46 MB       | 133.3–161.1 MiB; 0.25–84.34% CPU                   |
| Large HTML receiving/sanitization   | Baseline 1.763 GiB; corrected run cgroup peak 729 MiB | Baseline RSS 1,786,990,592 bytes / heap 1,517,793,536; corrected worker HWM 442 MiB | See corrected run below                            |
| 100 MiB attachment retry/stream     | 436.5–462.4 MiB; 0.58–67.73% CPU                      | RSS 393.0–414.4 MB; heap <=85.1 MB; external <=8.50 MB; buffers <=4.38 MB           | 136.5–139.9 MiB; 1.25–55.39% CPU                   |
| Final quiet samples, four accounts  | 554.5–555 MiB; 0.09–0.22% CPU                         | Recorded per-process snapshots in evidence                                          | 133.6–137.3 MiB; 0.08–10.86% CPU (periodic sweeps) |

The HTML fixture has 87,380 repeated paragraph elements. Its DOM/sanitizer heap
amplification is a material modest-host risk even below the 5 MiB R11 content
limit. Streaming attachment memory is much smaller and does not scale to a
100 MiB fixture buffer. These observations do not establish universal hardware
requirements or guarantee a memory peak for every message. The web process stayed
near 148–153 MB in sampled deployed runs; the producer's separate rendering memory
was not measured as actual web-route memory.

Final sampled database size was 21,706,431 bytes; messages 4,243,456 and placements
1,892,352 bytes. Blob storage was 204,860 KiB after two valid 100 MiB cached
attachments, small CID/MIME files and filesystem overhead. Sampled worker file
descriptors were about 32–38. PostgreSQL snapshots include ordinary pg-boss/control
pools, producer pools and a sampling connection; examples show 5–10 idle
`maildock-worker` backends and at most one sampled Stage 1 transaction. Such
`idle in transaction`/Client observations are instantaneous, not evidence of a
permanent leak. SQL D=2 limits receiving publication, not every SMTP/job/web pool.
Gate 1 server profiling identifies the observed avoidable SQL bottleneck.

R13's original ten-second APPEND lifetime remains unchanged. The actual smoke
uses small immutable MIME snapshots; existing size/deadline fault regressions
provide bounded large-MIME coverage, not a successful 25 MiB provider throughput
guarantee. R15's 15-second finite page cadence implies multi-page quiet-change
latency; the observed 100.54 s sweep is recorded rather than described as instant.

## R16 HTML memory/CPU remediation completion (2026-10-16)

The actual production worker was sampled against the original fixture before
changing the sanitizer. The HTML is a shallow `<div>` containing 87,380 repeated
`<p>R16 HTML body text.</p>` nodes plus two image references (2,271,961 UTF-8
bytes). V8's sampling heap profiler attributed about 649.5 MiB of allocations to
the request, about 630.1 MiB beneath `sanitizeEmailHtml`; the sampled CPU profile
contained 11.5% garbage-collection samples over 33.8 seconds of capture. The
allocation tree implicated jsdom/parse5/DOMPurify tree construction, CSS wrappers,
and repeated serialization/reparsing. This is measured evidence for this fixture,
not an estimate extrapolated from source complexity.

The fix adds a quote-aware structural scanner before DOM construction (input,
element, attribute, nesting, CSS, and style-block budgets), sanitizes one parsed
tree in place, and shares that tree for search text and reader CID/render work.
If the guard rejects HTML but a non-empty plain-text alternative exists, receiving
publishes the message as ready with `sanitized_html = NULL` and keeps the plain
text/search text. Without a usable fallback, the structural exception follows the
existing terminal display-content-limit path instead of being retried as a remote
read failure. The exact 87,380-node input is under the existing 5 MiB input cap,
so the element budget safely rejects it before jsdom allocation. Ordinary HTML,
malformed markup, and a near-5-MiB single text node remain supported.

Verification used the production Docker image and disposable TLS IMAP/PostgreSQL
fixture, with inspector disabled for the corrected smoke. BetterAuth TOTP
verification established the fixture session; the actual HTTPS authenticated
render API route returned the normal newsletter while remote images stayed
blocked. `reader` passed in 33.81 s including startup/cache-path setup, ordinary
CID fetch and authenticated route. A second distinct UID containing the same
large HTML passed `html-repeat` in 5.59 s and retained only plain text; another
request hit the content cache without another IMAP literal. Across the smoke the
peer recorded 2,272,609 literal bytes and no IMAP mutations. These are receive
workflow durations, not isolated sanitizer CPU timings.

After both pathological messages had been processed, the app cgroup's recorded
peak was 764,227,584 bytes (729 MiB), and current usage was 549,253,120 bytes
(524 MiB). Worker RSS was 408,420 KiB, process high-water RSS 452,356 KiB (442
MiB), and it held 24 file descriptors. This is a peak reduction of about 60%
against the earlier 1.763 GiB container observation for the same pathological
HTML scenario. The after figure includes the full app, web server, worker,
database client pools, and fixture startup; do not interpret it as sanitizer-only
memory. The prior heap profile estimated allocated objects, not simultaneously
live heap, and should not be compared numerically to process RSS.

Regression coverage now includes the exact 87,380-node fixture, structural-limit
boundaries, deep nesting/attributes, malformed and entity text, ordinary large
newsletters, near-5-MiB HTML, plain-text fallback publication, repeated receive,
and real authenticated route rendering. The applicable focused selection passed
102 tests across six files; app and worker TypeScript checks passed. The complete
suite result and unresolved Stage 3C W2/W4 acceptance status below remain
unchanged. In particular, the corrected HTML evidence does not make the overall
R16 release green.

## Final verification and decision

The full repository run selected all **130 files / 2,020 cases**: **2,012 passed,
eight failed**, in 1,407.45 s, one worker and no parallel files. The receiving
subset was 25 files / 722 cases: 720 passed and two failed. Original results are
preserved in `r16-final-regression.json`; the following corrections/comparisons
are separate evidence, not an assertion that the full run was green.

- One new process-test assertion expected `IMAP4REV1`, while actual installed
  ImapFlow preserves `IMAP4rev1`. Correcting that exact expected capability spelling
  made the normal-process test pass, including invalid identity conversion and
  retained secondary demand. The capability itself is persisted unchanged.
- The full run's R15 quiet-flags case raised an unresolved transaction during
  cancellation. A focused, unchanged full R15 rerun passed quiet flags but failed
  the different quiet-MOVE five-second barrier. Combined with the process test,
  that run was **37/38**, not a clean replacement for the original run. Gate 1 had
  already passed the same R15 file 37/37 before activation; the isolated accepted
  R15 comparison also passed 37/37. This is unresolved timing-sensitive validation,
  not proof that a new functional receiving regression has been eliminated.
- Six other failures reproduce on a clean archive of exact accepted R15 with the
  same installed dependencies: raw internal account-row `JSON.stringify` cannot
  serialize BigInt; legacy incremental reset expects `pending` instead of
  `not_started`; its PgBoss mock lacks `executeSql`; two authority-transition tests
  ask an older explicit allowlist to accept a fully migrated receiving schema;
  and the mutation-policy mock omits R09's diagnostics AbortSignal argument.
  The baseline comparison selected these six cases plus all 37 R15 cases:
  **37 passed / six failed / 72 unselected** in 80.93 s. Baseline source was
  extracted outside the checkout; no alternate branch or product authority rule
  was changed. In particular, the authority allowlist was not broadened to make
  populated-v1 transition tests pass in this new-install-only stage.

Actual SMTP/outgoing, draft/reply, MIME, reader, attachment, APIs, OAuth, account
lifecycle and security suites are included in the full run. The baseline failures
above remain explicit; they are not relabeled as passing compatibility evidence.
No failing assertion was disabled, no test timeout was raised and no automatic
retry loop was used to produce an all-green total.

The final UI/account/API compatibility selection passed **13/13 in four files**
after the status cleanup. This is additional focused evidence, not a new full-run
total. Production Docker build/startup, real migrations, application/worker typecheck,
repository lint and diff checks pass. Relevant migrations also ran in actual
ordinary-role integration fixtures. The supplemental standalone Dovecot NodeNext
tsconfig check reports pre-existing extensionless-import/type-resolution errors;
the normal application bundler typecheck includes these sources and passes.

The final source was rebuilt once more after UI cleanup. A third fresh disposable
Compose project (`maildock-r16-release`) reached app/PostgreSQL health with the
actual entrypoint and final image. Before owner/MFA provisioning the protocol peer
observed zero IMAP connections. This final project was then stopped and removed.

The pinned Dovecot image and PostgreSQL dependencies were present, so the existing
Stage 3C benchmark was run rather than skipped. Its first run prepared the fixture
and reached history but failed the pre-R15 F/E-only publication oracle after an R
publication. Audit now records old/new R and checks exact bounded keyset pages and
only exhausted wraps, while preserving all F/E numeric adjacency checks. The
preflight passes sparse, R-page and wrap controls plus 15 negative controls.

The next run passed those history/coverage boundaries but retained two unexpected
transaction deadline errors. Actual diagnostic traces show the prototype's
per-turn `FOR UPDATE` lease renewal waiting 1,155.90 ms behind another account's
publication, leaving only about 631 ms of the unchanged two-second history turn
for result settlement. This fixture predates the elected composition: production
renews as control work before admission and performs compatible shared validation
inside a turn. The fixture now uses that same admission-renewal/shared-validation
pattern. No SQL or history deadline is enlarged. Original and intermediate
benchmark failures are retained, with the final rerun recorded separately.

An intermediate corrected-authority run had no operation errors and passed all
coverage boundaries through restart, but its old whole-state restart equality
rejected legitimate R15 R/revision progress. Restart verification now preserves
the exact F/E/placement/history state and audit prefix, permits only independently
validated R publications, and has positive/negative preflight controls. There are
16 negative controls in the final preflight. This does not suppress metadata
replay or revision-chain checks.

The final Stage 3C run remains **incomplete/failed acceptance**: fixture PASS,
W2 stopped at the unchanged bounded history-target-3 scenario deadline after
76.02 s; W4 was not run. There were zero unexpected operation errors and every
captured coverage boundary, including failure cleanup, passed the strict oracle.
Two accounts reached three historical pages and three remained at two. This is
not a passing W2/W4 benchmark; no scenario deadline or zero-error assertion was
relaxed to turn it green. All original/intermediate/final JSON evidence is saved.

| Gate                           | Decision | Evidence / outstanding limit                                                                                              |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1: historical SQL prerequisite | PASS     | Exact original 128-UID fixture preserved; profiled 648.32 ms; 281/281 prerequisite regressions                            |
| 2: production cutover          | PASS     | Normal process registration, conversion-only legacy hints, single elected owner and takeover                              |
| 3: Docker deployment           | PASS     | Actual production build, migrations, web/worker startup, saved credentials, verified TLS health and API denial            |
| 4: functional smoke            | PARTIAL  | Controlled deployed workflows pass; Compose-level PostgreSQL reply loss is not exercised                                  |
| 5: operational resources       | PARTIAL  | Corrected pathological HTML is bounded and authenticated route passes; wider W2/W4 resource acceptance remains incomplete |
| 6: final regression/release    | PARTIAL  | Full-run failures retained; six reproduced on R15; inconsistent R15 timing and incomplete W2/W4 benchmark remain          |

The result remains **PARTIAL**: production cutover and controlled Docker workflows
are implemented and verified, but R15 is not consistently green in the final
regression runs, Stage 3C W2/W4 acceptance is incomplete, and Compose-level
COMMIT-ack loss is still unexercised. The pathological HTML peak is now bounded
for the tested fixture and the authenticated render route passes; this does not
establish a universal hardware requirement for arbitrary email content. No data
loss, duplicate receiving owner, unsafe mutation replay or broken existing SMTP
delivery was observed; those would require a BLOCKED decision instead.

## Remaining boundaries

No populated-v1 upgrade, dual-engine feature flag, real-provider mailbox exercise,
push, merge or PR. Secondary inventory/history and unknown destination metadata
remain R17 work with retained demand. R18 can remove obsolete implementation files
after compatibility evidence permits. Existing source/attempt/owner fencing and
quiescent-only orphan cleanup remain in force. Arbitrary process suspension still
cannot instantly revoke a remote socket; no stronger guarantee is invented.

Reproduction helpers are in `experiments/receiving-production/README.md`. Raw
profiling, generated Compose environment/overrides and JSON reports are outside
the checkout at `C:/Users/mateu/AppData/Local/Temp/maildock-r16-Eqpan3`; ignored
`.r16-*.log` files retain chronological original failures and corrected runs.
Generated fixture secrets are not committed or included here.
