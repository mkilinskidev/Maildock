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

## Final completion — 2026-10-16

This section supplements, and does not replace, the original PARTIAL decision,
failed runs, historical SQL profile or Luna's accepted `6676ce5` remediation above.
Work continued on the same branch with that commit preserved. Only the additional
sanitizer corrections below change production behavior. No scheduler redesign,
authority expansion, deadline increase, R17 work, push, merge or PR was performed.

### 1. Accepted HTML boundary validation

Exactly two representative accepted inputs were added to the disposable production
fixture: a complex newsletter with **23,889 elements** and a CSS newsletter with
**23,471 elements, 63 style blocks and 259,833 CSS bytes**. The latter is below the
unchanged 64-block / 262,144-byte CSS budget. Both are below 24,000 elements and
5 MiB. Actual compiled receiving runs in the ordinary container worker; the
producer requests content through the existing service, independently checks the
committed result and calls the authenticated HTTPS render route.

The first newsletter attempt exposed a real CPU amplification below the accepted
element ceiling. It exhausted the existing receiving attempts instead of reaching
ready. Its sampler recorded 44.547 seconds of worker CPU across repeated attempts,
618.31 MiB sampled worker RSS, and a 747.18 MiB app cgroup peak. This is retained
as failed evidence, not a successful memory-only acceptance result. An isolated
built-sanitizer CPU profile measured **14,467.06 ms** duration and **16,469.87 ms**
CPU. Descendant-array construction accounted for about 11.15 seconds of sampled
time; its stack was jsdom Document named-property lookup inside sanitization.

Repeated `rawDocument.body` access while moving each child invalidated and rebuilt
jsdom's named-element descendant index. The narrowly targeted correction retains
the already parsed `body` and `head` element references throughout the existing
in-place transformation. It adds no parser, cache, worker or new budget. An
isolated comparison on the rebuilt image measured **1,263.80 ms** duration and
**2,179.32 ms** CPU. These diagnostic processes are separate from the accepted
worker measurements below; the app container was recreated after diagnosis.

| Accepted deployed case       | Peak worker RSS | Peak used heap / reserved heap | Sampled app memory / cgroup peak |  Worker CPU | Request/oracle/render duration |
| ---------------------------- | --------------: | -----------------------------: | -------------------------------: | ----------: | -----------------------------: |
| Complex newsletter           |      401.89 MiB |            225.67 / 305.21 MiB |              779.16 / 780.18 MiB | 3,256.45 ms |                    8,111.85 ms |
| Multiple CSS rules/selectors |      539.18 MiB |            342.63 / 434.49 MiB |              917.66 / 918.41 MiB | 3,915.20 ms |                    6,207.99 ms |

Sampling uses actual worker inspector heap, `/proc` RSS, cumulative worker CPU
differences and app cgroup memory at approximately 100-ms intervals (316 and 230
samples). Sampling can miss instantaneous process peaks; cgroup peak is the
kernel high-water mark. CPU includes other ordinary worker work in the bounded
sampling interval. Duration includes dispatch, producer validation and web/CID
rendering, and is not sanitizer-only latency. One-shot producer resources are
excluded from the app cgroup; the small sampler process is included. The second
case deliberately follows the first on the same worker and includes retained heap.

Both cases reached ready, preserved all 3,980 / 3,900 newsletter sections, removed
script/active remote image sources, preserved resource markers, retained exact
plain-text-derived durable search, passed an exact HTML-only search oracle with
the built sanitizer, and returned HTTP 200 from the authenticated render route.
The first successful newsletter's producer oracle differed only in inserted
whitespace between inline siblings; the shared fixture now models that original
wire whitespace exactly. Neither difference changes structure or resource budgets.
The focused sanitizer/resource/search selection passed **27/27** before the full
regression run. The original 87,380-paragraph rejection, plain fallback, terminal
no-fallback handling, CID/privacy protections and reader isolation remain intact.
**Gate 1: PASS** for these measured boundaries; no universal resource SLA is claimed.

### 2. Stage 3C Dovecot W2/W4 diagnosis

One bounded combined W2/W4 invocation ran with the original 300-second process
ceiling, 25-second history phase limits, two-second history/publication deadline,
all five accounts and original progress/error assertions. No deadline or history
target was increased. Fixture preflight and all captured strict F/E/R/placement
boundaries passed; total invocation time including cleanup was **86,802.04 ms**.

The earlier W2 evidence had stopped admissions after an unresolved publication,
while the scheduler could retire on a failed `beforeAdmission` control without
the fixture's operation-error list recording that failure. The harness now retains
renewal duration/outcome/error and counts failed control admission as an error.
It also explicitly requests the same aggregate control headroom as elected
production: W2 allows two data allocations; W4/D2 allows at most three. C=1 and
the D=2 executor remain unchanged. This corrects the harness contract; it is not
proof of the precise unrecorded control failure in the previous W2 run.

- **W2: PASS.** All five accounts completed exactly three historical pages,
  ending at E=617. Startup/restart were fresh-first; current arrivals were visible,
  restart oracle and unavailable-account isolation/recovery passed. Maximum
  observed current visibility latency was 5,837.26 ms. There were zero unexpected
  errors, five deliberate AUTHENTICATE failures for the disabled fixture account,
  maximum two data allocations/two sockets/two SQL sockets, no per-account
  overlap, and zero live owned sockets/SQL scopes on retirement. All 15 history
  turns completed; their observed p95/max were about 1,167 ms. No protected-history
  exception was needed in these short phases. W2's capacity is unchanged by the
  explicit control-headroom flag, so its success does not establish a deterministic
  cure for the earlier timing-dependent stop.
- **W4: unsuccessful.** The unchanged zero-unexpected-error assertion rejected one
  history deadline failure for `stage3c-5` during initial receiving. Trace 30 shows
  admission at 82,377.984 ms; owner SHARE validation took 1.64 ms; persistence was
  requested at 82,684.648 ms but its socket was not allocated until 83,723.003 ms.
  Thus **1,038.35 ms** was spent waiting for executor capacity, followed by roughly
  23.33 ms connection/setup, leaving **631.65 ms** to the original turn deadline.
  Publication did not settle in that remainder. This is a demonstrated SQL
  admission/remaining-budget limit under concurrent work, not a Dovecot login
  delay or missing R-progress oracle. No SQL microprofile separates all server
  execution and lock costs inside that remainder. Max data allocations were three,
  SQL sockets two, C overlap false. All accounts eventually had two historical
  pages at failure capture, but no third-page/restart/failure-isolation W4 PASS is
  claimed. The operation error is retained even though a subsequent normal
  scheduler recovery turn completed. No rerun campaign followed this failure.

R15 live observations legitimately add R/revision publications and SQL competition;
the existing exact R oracle remains in force. The preserved trace identifies the
limiting W4 queue interval, but does not establish that new production scheduling
logic is defective or justify changing admission/deadline policy. **Gate 2: PARTIAL.**

### 3. R15 timing-sensitive tests

The bounded comparison ran the entire unchanged R15 file once on current R16:
**37/37**, and once on the exact accepted R15 archive with the same installed
dependencies and serial Vitest settings: **37/37**. The archive's pnpm launcher
initially rejected its node_modules junction; invoking the existing Vitest entrypoint
directly resolved that launcher issue without a dependency/source change.

Inspection found a concrete fixture synchronization error: `seedMany` could already
satisfy the quiet deletion/MOVE test's `revision >= 2` barrier before the newly
elected coordinator had completed any observation. Also, independent ready/flag
visibility proves server COMMIT, but does not prove that its acknowledgement and
local resource retirement finished before the test calls stop. Quiet controls now
observe the actual scheduler `onTurn` revision before changing the peer and after
the independently visible changed publication, then stop. They retain the original
five-second barriers, real SQL/IMAP checks, no wake/API/new UID, and unchanged
count/UIDNEXT requirements. No arbitrary delay, timeout increase or production
lifecycle change was introduced. Final focused/full results are recorded below.

The paired passing runs alone cannot prove the earlier failures were harmless;
the correction removes the demonstrated invalid barrier. No real production
receiving regression was reproduced in this bounded comparison.

### 4. Actual Compose COMMIT acknowledgement loss

**Gate 4: PASS**, through the built production app and compiled ordinary worker,
not an isolated executor substituted for the worker. The disposable fixture's
existing container hosted a test-only PostgreSQL frame relay; normal production
Compose and application database configuration are unchanged. Test credentials,
volumes and the TLS IMAP peer were isolated. No real mailbox was used.

The elected owner/generation was independently live. UID 2's ordinary content
request created durable demand. A disposable deferred trigger held its ready
publication at a real COMMIT using an advisory barrier. `pg_stat_activity` identified
backend **2273**, query `commit`. Only that backend's COMMIT CommandComplete and
associated ReadyForQuery frames were dropped; other responses were forwarded.
Independent readers then observed the committed ready result at revision **50**,
F=1024/E=1, original attempt `6193b7ef-3bd5-45d7-a451-d42ecb9fef2b`.

While an independent transaction held the mailbox row, backend **2274** was observed
executing `maildock_receiving_attempt_recover`, with `pg_blocking_pids` explicitly
identifying blocker **2233**. Literal counters remained **4,181,972** during that
wait. Releasing the lock allowed normal worker recovery. The audit held exactly
one ready publication and the original succeeded attempt with `reads=1`.
STORE/MOVE/APPEND/SMTP counters stayed zero. No producer manually invoked recovery.

After restarting only the app, the final restart control required a different live
owner and greater generation, the same ready result/attempt, exactly one audit row,
and unchanged literal/mutation counters. It passed. Temporary triggers were removed
in finally cleanup. The relay/inspector exist only in the explicit disposable
override; no permanent proxy or production service was added.

Initial deployment setup failures are retained separately: Docker rejected app
extra_hosts with shared network mode, restarting the fixture required recreating
the app's shared namespace, and the relay initially omitted TCP_NODELAY. Accepted
performance/fault results use the corrected fixture. No failed setup was counted
as successful COMMIT-loss evidence.

### 5. Historical regression classifications

- **Internal BigInt row:** stale serialization fixture. Public account DTOs still
  must serialize directly; only the raw internal-row credential-leak check uses
  an explicit bigint-to-string JSON replacer.
- **Legacy reset status:** stale expectation. Reset records `not_started` while
  requesting the rebuild; UID epoch reset, removed placements, cleared delta
  checkpoints and actual rebuild request assertions remain unchanged.
- **PgBoss poller:** incomplete/outdated fixture. Merely adding executeSql exposed
  its stale assumption that INBOX should enqueue a legacy delta job. The corrected
  fixture executes the real receiving-demand SQL function, checks exactly one
  increment of the mailbox generation and the receiving account wake, and still
  proves disabled/uninitialized/nonselectable/missing folders do not enqueue.
- **Two historical authority expectations:** unsupported populated-receiving
  schema certification through the old explicit F12.2 transition allowlist.
  Tests now require conservative refusal, unchanged row hashes/functions/relations
  and retained auth/MFA/jobs. The ordinary hardened role remains valid in the
  existing-role case. Positive fresh-install hardening/password/no-op controls,
  owner DDL, denial controls and actual PgBoss 41→42 migration remain. No test is
  skipped or deleted and no Stage 1/transition allowlist is expanded.
- **Diagnostics signal:** stale mock assertion. It now requires the actual request
  AbortSignal passed with the account/overrides; origin/media-type denials remain.

The first completion-wide attempt exposed the remaining poller expectation after
its missing method was repaired. It was deliberately interrupted for that specific
fixture correction; its log remains `.r16-completion-intermediate-regression.log`.
It is not a completed all-green run or a source of combined passing totals.

### 6. Final regression and quality verification

The complete completion run selected **131 files / 2,027 cases**: **2,025 passed,
two failed**, in **1,642.01 seconds**, one worker and no file parallelism. It
included R02–R15, authority/admission/election, MIME/reader, attachments/storage,
SMTP/Sent/outgoing, drafts/composer, authentication/security, migrations/recovery
and actual process lifecycle. R15 passed **37/37** in that same run. The original
R16 2,012/2,020 run remains separate evidence above. The two completion failures
are retained in `final-regression.json`:

1. The hung-account scheduler case passed its healthy-error, frontier and retry
   assertions but its first healthy completion was at 82,055.2542 ms versus the
   bad account's first timeout at 81,903.4174 ms: **151.84 ms later**. The assertion
   requires completion before the deliberately short 300-ms hung-operation timeout.
   Scheduler source and this fixture are identical to accepted R15. Exactly one
   subsequent selected comparison per tree passed: accepted R15 **1/1**, current
   R16 **1/1**, with the original assertion/deadlines unchanged. This identifies a
   timing-order expectation, not a reproduced starvation or new scheduler change;
   the failed broad-run observation remains explicit and is not relabeled PASS.
2. The existing CID/SVG authorization test demonstrated PostgreSQL **22021**:
   decoding `cid:%00bad` introduced a real NUL in an in-place DOM attribute, then
   serialized it into immutable HTML text. This was a genuine defect at the
   sanitizer/storage boundary. The final narrow correction discards a decoded NUL
   CID just like an already rejected malformed percent escape, before assigning
   a resource marker. It preserves valid CID normalization and does not replace
   Luna's accepted architecture. Three new controls cover NUL at the beginning,
   middle and end while preserving a valid sibling's case-sensitive identifier.
   The real PostgreSQL authorization control now asserts exactly the three valid
   references rejected by duplicate/SVG/spoof resolution; malformed escapes and
   NUL are rejected earlier. It additionally proves persisted HTML contains no
   NUL/bad escape and retains the original no-image/no-enqueue safety assertions.

This full run **precedes the final CID correction**. Final source HTML/security
results are separate focused evidence below; they are not combined with the
2,025 passes to claim a green full suite. A second complete 27-minute run was not
performed after this narrowly scoped correction. That remains a release-validation
limit, alongside the unchanged broad-run scheduler failure and W4 acceptance.

On the final CID-corrected source, the complete affected HTML/security selection
passed **123/123 across six files** in **133.90 seconds**, including **67/67**
receiving-content, **21/21** real authorization/database/blob attack controls,
**21/21** sanitizer, six resource-budget, three search-text and five render-API
tests. A separate final renderer/attachment-MIME/outgoing-MIME selection passed
**48/48 across three files**. These are explicitly separate runs.

The corrected three-file selection passed **81/81** in **128.16 seconds**:
R15 **37/37**, incremental sync **25/25**, database authority **19/19**. These are
separate focused results, not a replacement full-repository total. Application and
worker typecheck and repository lint both passed again on the final source.
Changed/new-file Prettier and working/staged whitespace checks accompany the
commit; the full-repository formatting failure below remains visible.

Repository-wide `pnpm format:check` completed with **75 style warnings**. Exactly
73 concern files outside this change (historical experiment outputs, local runtime
artifacts, the existing capability contract and receiving diagnostic RPC source).
The other two were this report and the incremental fixture while they were being
edited; both were formatted afterwards. The final changed-file format check is
reported separately. Historical evidence and unrelated source were not rewritten
to manufacture a repository-wide formatting PASS.

No total combines unrelated runs. Evidence directory:
`C:/Users/mateu/AppData/Local/Temp/maildock-r16-completion`.
The versioned summary is
[`r16-completion-evidence.json`](../../../experiments/receiving-production/r16-completion-evidence.json);
it retains measurements, the failing W4 SQL trace, COMMIT/recovery backend evidence,
the full-suite failure counts/hash and separate final-source controls, without
fixture secrets or session cookies.

### 7. Docker status

The production image built successfully, ran ordinary migrations/web/worker and
passed setup, receive, both accepted HTML boundaries, actual COMMIT loss, restart
with a new elected owner and verified TLS ingress (live/ready 200, unauthenticated
accounts 401). The final source correction was included in the measured rebuilt
image. Default W2/C1/D2 and single elected receiving composition remain. No legacy
receiving executor was reintroduced. The disposable project was stopped with
`down --remove-orphans`; its evidence and isolated volumes were preserved.
After the final CID correction the image was rebuilt again, reached Compose
health, passed TLS ingress once more and was stopped/removed. Its image ID is
`sha256:a7d1b6ffe5279f54c579260eb3709332f71e4e795d3f29bfa5520e90fa3431d0`.
The earlier resource and COMMIT-loss measurements precede that final NUL guard;
the guard only discards an invalid CID and is covered by the final focused controls.

### 8. Exact remaining risks

W4 has not established third-page, restart and fault-isolation acceptance under
concurrent SQL admission. The full-suite scheduler timing failure remains despite
the passing bounded comparison. No green full-repository run after the final CID
correction is claimed. Repository-wide formatting
also retains the explicitly reported issues outside this change. The HTML numbers
are observations for the two specified accepted boundaries, not an arbitrary-mail
or provider-wide resource guarantee.

### 9. Final acceptance decision

| Completion gate             | Result  | Remaining condition                                                                                   |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| 1: accepted HTML boundaries | PASS    | Two accepted cases measured; targeted CPU correction verified                                         |
| 2: Stage 3C                 | PARTIAL | W2 PASS, W4 admission/publication deadline failure retained                                           |
| 3: R15 timing investigation | PASS    | Invalid fixture barriers corrected; full-run R15 37/37; no demonstrated production defect             |
| 4: Compose COMMIT loss      | PASS    | Actual worker locked recovery and original result across takeover                                     |
| 5: historical failures      | PASS    | Narrow fixture/contracts corrections; no skips or expanded authority                                  |
| 6: final release evidence   | PARTIAL | Broad-run timing failure, no green complete rerun after final CID fix, repository-wide style failures |

The release decision remains **PARTIAL** because W4 failed a mandatory throughput/
zero-operation-error acceptance condition. Its SQL admission latency and remaining
two-second budget are measured; safe optimal scheduling/performance remediation
has not been established by this bounded task. No unsafe replay, data loss,
ownership violation or unresolved HTML resource-exhaustion defect was demonstrated
after the targeted correction. Passing W2, HTML and actual Compose fault recovery
do not substitute for W4 acceptance. Any final regression failures below remain
additional explicit release risks. Stop at R16.

## Final R16 closure — SQL executor contention and release verification

2026-10-16. Continued from accepted `82da4c22935c5335fc0f95b3de9d173566716aa8`
on `feature/imap-sync-r16-production-cutover`. All earlier R16 results, including
the failed W4 run and its incomplete acceptance, remain historical evidence above.

### 1. Root cause: queue capacity was mistaken for available history lifetime

The preserved failed run identifies both borrowers ahead of `stage3c-5`; this
is no longer only a hypothesis inferred from one delayed socket:

| W4 history borrower | SQL socket created (ms)                   | Publication callback (ms)                 | Local scope released (ms) |
| ------------------- | ----------------------------------------- | ----------------------------------------- | ------------------------- |
| stage3c-3           | 82,506.9144                               | 82,538.2695–83,627.0273                   | 83,730.3487               |
| stage3c-4           | 82,630.7833                               | 82,690.1242–83,646.8479                   | 83,720.2811               |
| stage3c-5           | requested 82,684.6481; socket 83,723.0025 | 83,746.3326–84,378.3816, deadline failure | 84,390.9489               |

The third operation waited **1,038.3544 ms**. Both D=2 slots belonged to actual
other-account history publications during that interval. Its owner validation
took only **1.6436 ms**, source recovery callback **45.7427 ms**, and recovery
retirement to publication request **165.6767 ms**. The first two callbacks lasted
**1,088.7578 / 956.7237 ms**, followed by **103.3214 / 73.4332 ms** through
COMMIT and local resource retirement. A waiting SQL borrower cannot use that
capacity until retirement finishes. No IMAP socket was retained into publication.

History's absolute deadline is established by `ReceivingScheduler.admit` at
`admission + min(operationMs, historyTurnMs)`, **2,000 ms** here. It does not
start at SQL acquisition. The failed admission was 82,377.9839 and deadline
84,377.9839; only **631.6513 ms** remained when its SQL callback began. Stage 1
correctly cancelled the expired scope and retained uncertain-result recovery.
The old diagnostic trace's top-level four-second history deadline was a reporting
error; the transaction deadline and actual scheduler had always been two seconds.

W2 cannot admit a third data operation. W4 could admit `min(W,2D-1)=3` data
operations, each legally owning one executing/queued SQL request. That is a valid
aggregate resource bound with protected control headroom, but it is insufficient
admission policy for this two-second history lifetime. The bottleneck combines
production admission and the service time of the existing 128-UID publication.
It is not an extra pool, an unaccounted fixture executor, owner-validation latency,
or evidence of a Stage 1 authority defect.

One bounded pre-change W4 diagnostic completed all original conditions, but still
recorded **733.0343 ms** request-to-socket delay and history callbacks up to
**899.7203 ms**. PostgreSQL samples during that long queue show two active
metadata INSERT streams without blocking PIDs. Separate samples show renewal's
exclusive coordinator lock waiting for data's compatible SHARE lock. These are
distinct phenomena. R15 adds legitimate live observation publications/revisions;
the exact R oracle and all original workload targets remain unchanged.

### 2. Minimal correction and its tradeoff

The existing scheduler retains its normal `min(W,2D-1)` admission limit. In the
elected/typed composition, history is selected only when fewer than D data
operations are active, and while any history operation remains active further
data admission is bounded by D. Excess work waits in the existing selector
**before its own lifetime starts**. History capacity is checked before advancing
the rotation cursor. There is no extra queue, SQL executor, process or service.

This is deliberately conservative: SQL demand is bounded over a history turn's
whole network/publication/retirement lifetime rather than predicting its future
SQL start. W4 can still allocate three current/user data turns when history is
absent; acceptance observed that actual maximum. With history active, W4/D2
allows two data turns. W1, W2/D2 and D1 limits are unchanged. The original
standalone no-control scheduler fixture retains its accepted profile.

Protected history selection, fresh-first startup, current/user rotation, account
C=1, one coalesced control admission, D executing/D queued limits, fencing,
deferred COMMIT checks, cancellation and retirement remain on the same paths.
The history allocation is held until its original work settles, including on
cancellation; its finally block releases the history count. No transaction,
operation or scenario deadline was increased. No historical publication, HTML,
remote mutation, SMTP or credential behavior was redesigned.

### 3. Stage 3C acceptance and measurement boundaries

One complete final-source run completed in **114,919.1432 ms**, including fixture
preparation and cleanup, with the original five accounts, fresh requirements,
three history pages per account, fixed phase deadlines, restart, failure isolation,
F/E/R and placement oracles. Both W2 and W4 **PASS**. All 18 boundaries per run
passed; final history counts were `[3,3,3,3,3]`. Restart and recovery passed.
Only the intentionally unavailable account produced expected AUTHENTICATE errors;
there were **zero unexpected operation errors** and no control errors.

| Measurement (ms unless noted)                                | W2                           | W4                             |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------ |
| History SQL request-to-socket p50 / p95 / max                | 2.03 / 13.48 / 14.76         | 1.68 / 12.71 / 13.52           |
| All SQL request-to-socket p50 / p95 / max, including control | 2.70 / 15.43 / 74.77         | 2.23 / 33.69 / 309.94          |
| Publication callback p50 / p95 / max                         | 59.72 / 689.61 / 792.60      | 66.30 / 794.72 / 978.53        |
| History whole lifetime p50 / p95 / max                       | 867.30 / 993.31 / 1,099.17   | 917.94 / 1,105.10 / 1,118.88   |
| Owner validation callback maximum                            | 28.28                        | 9.36                           |
| Source recovery callback maximum, including lock waits       | 44.42                        | 324.29                         |
| SQL work-end through COMMIT and retirement maximum           | 93.69                        | 136.33                         |
| IMAP local retirement maximum                                | 0.82                         | 1.14                           |
| Fresh visibility p50 / p95 / max                             | 703.37 / 4,565.22 / 5,566.17 | 1,981.91 / 5,972.36 / 6,113.72 |
| Maximum data allocations / IMAP sockets / SQL scopes         | 2 / 2 / 2                    | 3 / 3 / 2                      |
| Sampled maximum SQL waiters                                  | 0                            | 1                              |
| Per-account overlap                                          | false                        | false                          |
| Final active data / IMAP / PostgreSQL sockets                | 0 / 0 / 0                    | 0 / 0 / 0                      |

Request-to-socket is an **upper bound on executor queue wait**, including client
construction and event-loop scheduling; it is not labelled pure server execution.
Callback duration includes PostgreSQL work, query round trips and application
metadata processing, excluding queue/setup and COMMIT/retirement. A bounded 20-ms
PostgreSQL sampler records state, wait type, blocking PIDs, normalized query and
executor executing/waiting counts. `pg_stat_statements` in the disposable fixture
separately records server statement calls and execution durations. Server durations
include lock wait; the sampled lock evidence identifies blocking queries but is
not an exact per-transaction lock-time decomposition. Raw events retain connection
setup, protocol replies, source validation and actual remote retirement ordering.
These measurements do not claim a provider-independent latency guarantee.

The independent server sampler observed transaction elapsed times at COMMIT up
to **790.725 ms (W2)** and **1,134.679 ms (W4)**. These are sampled server-side
elapsed observations, not an assertion that a 20-ms sampler sees every exact
transaction end. Client scope lifetimes and the complete event stream are also
retained in the evidence, separately from callback and statement durations.

Server-side examples from the complete acceptance run (1,940 INSERTs of each
kind per W profile) separate actual statement work from executor queue time:
message INSERT mean/max **1.924/23.652 ms (W2), 2.307/27.366 ms (W4)**;
placement INSERT mean/max **0.449/3.667 ms (W2), 0.393/4.066 ms (W4)**.
Renewal server execution, including its separately observed coordinator lock
wait, reached **747.207 ms (W2), 415.582 ms (W4)**. Individual cheap statements
do not make a 128-UID transaction instantaneous. The raw samples also preserve
the separate arrival-notification sequence-row contention during fresh work.

The versioned [closure evidence](../../../experiments/receiving-production/r16-closure-evidence.json)
contains the original three overlapping scopes, separate before/after metrics
and hashes for compressed raw diagnostic/acceptance traces. The pre-change
diagnostic PASS is not substituted for the earlier failed W4 run.

Instrumentation is confined to the existing benchmark and its diagnostic adapter.
It now attributes renewal/control scopes separately, records awaited execute calls
and reports the correct history deadline. It does not change the benchmark's
workload, acceptance assertions or production SQL resources.

### 4. Deterministic regression and complete repository suite

`tests/receiving-sql-contention.test.ts` uses the real selector with a controlled
turn boundary and fake monotonic time. With two history publications held, the
original code admits a third and fails the two-active assertion (**1/1 FAIL**).
After correction it admits two, waits outside the third lifetime for 1,100 ms,
then starts that turn with its original full 2,000-ms budget after retirement.
Stop cancels both remaining turns and drains all allocations (**1/1 PASS**).
This isolates the admission defect deterministically; the real SQL/socket/progress
coverage is supplied separately by Stage 3C and repository integration tests.

The single complete final-source repository run selected **132 files / 2,031
cases**: **2,029 passed, two failed, zero skipped/pending**, in **1,485.72 s**.
Command: `pnpm test --maxWorkers=1 --no-file-parallelism` with default and JSON
reporters. The count adds the three final CID controls and this admission
regression to the earlier 2,027-case pre-CID full run. The earlier interrupted
pre-correction run is not a completed result and contributes no combined counts.

The full run passed the previously troublesome healthy-versus-hung ordering case,
all sustained W1/W2/W4 visibility/history cases, actual worker lifecycle, SQL
authority/COMMIT-loss controls, admission **20/20**, HTML authorization **21/21**,
SMTP/outgoing **47/47** and the new contention regression. Its two failures remain
explicit:

1. R15 restart/takeover (`receiving-demand-settlement.integration.test.ts:451`):
   the **first** owner's five-second `reconcile_after === "1"` barrier expired,
   before `first.stop()`, flag mutation, lost wake or second-owner creation.
   This run therefore does not demonstrate a failed takeover or dropped wake;
   it does fail the mandatory first quiet-observation requirement. R15 was 36/37.
2. Scheduler health gate (`receiving-scheduler.integration.test.ts:1215`):
   the final zero-error assertion received one `ReceivingUnresolvedError` at
   **72,959.4291 ms**, phase **commit**, retry **100 ms**. The preceding gate,
   frontier, eventual history and retirement assertions passed. This fixture has
   a fixed **1,000-ms** history lifetime; its original deadline was not changed.
   Scheduler was 30/31.

Both failing fixtures use **W1/D1**, for which the old and new effective data
limits are identically one; their test files are byte-identical to accepted HEAD.
This is evidence against a changed admission decision causing these failures,
not sufficient evidence to label every failure harmless or erase it. Exactly one
bounded two-file comparison per accepted/current tree is recorded separately.
No assertion, timeout, fixture barrier or applicable test was changed or skipped.

The bounded comparison ran both entire unchanged files, serially, once per tree:

| Source                     | R15   | Scheduler | Total |
| -------------------------- | ----- | --------- | ----- |
| Accepted `82da4c2` archive | 37/37 | 29/31     | 66/68 |
| Corrected current source   | 37/37 | 31/31     | 68/68 |

Accepted source instead failed sustained-W4's observer-based age/rotation
assertion for two candidate identities and the known healthy-versus-hung ordering
assertion. For the latter, first healthy completion was **67,807.6173 ms** versus
bad-account timeout **67,773.7517 ms**, **33.8656 ms later**. The preceding healthy
error/frontier and bad-account retry assertions passed. This is a strict ordering
failure, not observed absence of healthy progress. Current source passed that
case both in the complete run and in the comparison. No special additional rerun
campaign followed the comparison.

The mismatched failures establish variability, not a conclusive explanation of
the complete run's R15 barrier and health-gate COMMIT failure, nor resolution of
accepted source's observer-order assertion. The separate 68/68 is **not** combined
with 2,029 passes to manufacture a green full suite. These remain explicit
release-validation limitations, rather than suppressed baseline exceptions.

### 5. Final build, quality and deployment

Application/worker typecheck, repository lint and changed-code Prettier passed.
Changed/new supported-file Prettier, documentation formatting and working/staged
`git diff --check` passed. Repository-wide `pnpm format:check` retains **75
warnings, all outside this commit's changed/new files** (including historical
outputs, ignored local runtime evidence, the existing capability contract and
diagnostic RPC source). No unrelated files were reformatted.

Production `docker compose ... build` passed for the normal application and
PostgreSQL images. Application image:
`sha256:519a2dfa525cd0875e4e8af066f5abf9866cf00793cc1b5628dd00cf351cf3c8`.
Fresh disposable project `maildock-r16-closure` used the unchanged base Compose,
normal entrypoint, **54 real migrations**, new isolated volumes and generated
secrets outside the checkout. The existing fixture peer was added only through
an external test override. App/PostgreSQL became healthy. `setup`, `receive`
(**2,048 placements, two complete INBOX histories**), verified-TLS `ingress`
(live/ready **200**, unauthenticated accounts **401**), `reader` and `outgoing`
passed through the actual built web/worker and ordinary application services.

The optional outgoing smoke was initially invoked without its documented reader
prerequisite. It failed `pending != ready` while preparing quoted resources,
before creating SMTP work. The unchanged reader phase then passed, followed by
one outgoing run: **two SMTP deliveries, one Maildock-policy APPEND**, matching
SMTP/APPEND MIME digest and no server-policy duplicate APPEND. The preliminary
fixture-order failure is retained; no assertion or production source was changed
to hide it. Reader also exercised the authenticated actual render route.

Independent PostgreSQL inspection observed live elected owner
`391096dc-4072-46c3-bc85-dcd815875825`, generation **1**. Normal defaults remain
W2/C1/D2. Controlled `compose stop app` completed in **677.2082 ms**; logs show
`worker.shutdown` with **SIGTERM**, followed by `jobs.stopped`, without runtime
errors. The app container's observed exit code was **143** after SIGTERM, not a
claimed zero exit. Independent post-stop SQL showed the same owner tombstone,
`live=false` and **zero receiving SQL backends**. The still-running fixture showed
**zero active IMAP sockets**, peak two and per-account peak one. `down
--remove-orphans` removed the disposable containers/network; isolated volumes and
local evidence were preserved.

Composition inspection and the complete actual-process test confirm one receiving
worker, the existing owner-routed operation registry and independent SMTP/outgoing
registration. No competing legacy receiving executor, extra production queue,
worker or service was introduced. Environment/session/setup secrets remain only
in ignored logs or external disposable evidence; none appear in the committed
source, report or compressed benchmark evidence. Final evidence directory:
`C:/Users/mateu/AppData/Local/Temp/maildock-r16-final-closure`; complete-run and
paired JSON reports are in its parent TEMP directory, with hashes/counts retained
in the versioned closure evidence.

### 6. Final decision and remaining limits

| Final closure gate  | Result  | Evidence/remaining condition                                                                          |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| W4 diagnosis        | PASS    | Both actual blocking publications identified; queue, SQL work and retirement separated                |
| Minimal correction  | PASS    | Existing selector delays excess history admission; deterministic original FAIL/current PASS           |
| Stage 3C W2/W4      | PASS    | Original complete workload, three pages/account, restart, failure isolation and all oracles           |
| Complete regression | PARTIAL | 2,029/2,031; first-observation barrier and health-gate COMMIT failures remain inconclusive            |
| Docker and quality  | PASS    | Built/healthy normal deployment, real receiving/SMTP, controlled retirement; changed-file checks pass |

**Final decision: PARTIAL.** The demonstrated W4 admission contention is corrected
and both complete benchmark profiles pass. The complete final-source suite still
has two applicable failures; their causes have not been established conclusively
by the single bounded comparison, and different accepted-source failures prevent
calling them individually justified baseline-only exceptions. A passing focused
68-case selection does not resolve that release gate. No data-loss, unsafe replay,
ownership or resource-retirement defect was demonstrated in the completed checks;
that is not a substitute for the outstanding regression investigation. There is
no green complete-suite claim or additional rerun campaign. Stop at R16; no push,
merge, pull request or R17 work was performed.
