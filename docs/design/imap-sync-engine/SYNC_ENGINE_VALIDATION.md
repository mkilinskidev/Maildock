# IMAP synchronization: validation before production implementation

Status: **test design only**. Written 2026-10-12. Companion: [architecture](SYNC_ENGINE_ARCHITECTURE.md). No prototype, automated test, benchmark, destructive test, real mailbox connection or production result was produced in this task. Values below are initial hypotheses to challenge, not approved SLAs.

## 1. Environment, assumptions and stages

Use an isolated, disposable local IMAP server and PostgreSQL database. Never use Maildock's configured accounts, credentials, attachment directory or production database. A later separately authorized validation task creates the harness; this document neither implements it nor changes dependencies/migrations. Reuse existing Vitest/Testcontainers/pg-boss tooling where useful.

Two complementary server fixtures are necessary:

1. A scriptable IMAP peer with explicit command barriers, UID/epoch oracle and connection caps, able to reorder/omit FETCH, hang tagged completion, reset epoch, drop connections and delay notifications. It must exercise the actual future ImapFlow path; a fake provider method cannot prove socket or parser behavior.
2. A real isolated IMAP server, such as a pinned Dovecot fixture, plus a TCP fault proxy. Confirm baseline command/capability semantics and transport behavior there. A scripted peer can accidentally accept impossible protocol sequences. Select/pin the exact image version in the harness proposal; no image/version/performance claim is made here.

First validate a paper/state-transition model against the oracle. Then, with separate authorization, build the smallest nonproduction transport/persistence/admission harness implementing only the proposed unit boundaries. It must not become an application prototype by default. Last, port existing invariants and check feature compatibility once production implementation is independently authorized. A paper model alone cannot pass the transport gates.

Fixtures: 50,000 INBOX placements, initially dense UIDs 1..50,000, UIDNEXT 50,001; randomized old/future/missing Date and INTERNALDATE values, varied MIME trees, headers and sizes. Add secondary folders including Sent/Archive/Trash and two accounts with identical UID numbers. Preserve a server-side oracle of every append, flag update, move, expunge and epoch change with monotonic event IDs. Observe events from a second test client; do not confuse client-advertised counts with the oracle. Seeds must be reproducible.

Profiles: C=1/2/5 remote connection cap; IDLE on/off; CONDSTORE on/off/NOMODSEQ; MOVE/UIDPLUS variants; W=1/2/4 admitted receive units; DB pool limits 1/2/6; warm/cold authentication. Also test cap shared with a second client: close that client after injection so the engine eventually has capacity. Label faulted versus healthy trials explicitly.

Healthy reference conditions are hypotheses: local TLS, 20 ms injected command round-trip delay, 20 MiB/s transport ceiling, metadata fitting architecture caps, no provider outage, moderate bounded user demand and available DB. For the 5-second individual-user latency hypothesis, moderate demand means at most two accounts contending for current work, each with one outstanding individual command and one content continuation; the eight-account saturation trials have separate rotation/fairness gates. Record host CPU/memory, runtime/dependency versions, server image digest, TLS mode, storage, configuration and latency distribution. Do not generalize local performance to Gmail/Outlook without later provider compatibility evidence and explicit authorization.

## 2. Instrumentation and metrics

Emit structured events with opaque account/folder/operation/owner IDs, epoch, operation kind/class, interval or exact-UID-set digest/count, retry attempt and reason. Synthetic fixture UIDs may be logged; never subjects, addresses, tokens or attachment contents. Use a monotonic process clock for durations and correlate it to server oracle/barrier timestamps. Use DB time for leases; account for cross-process clock offsets.

Required timestamps:

- server append committed, second-client mutation completed;
- notification delivered, timer due, due marker committed, wake queued/delivered;
- selector consideration, eligible/ineligible reason, admission granted;
- owner generation acquired/renewed/lost, worker token and socket allocation/release;
- DONE/SELECT/SEARCH/FETCH/STORE/MOVE/APPEND start, first response, last response, tagged completion, deadline, socket destruction/close acknowledgement;
- metadata parse ready, DB admission/wait, transaction start/commit/rollback/unknown;
- progress before/after, stale fence rejection, notification committed and metadata visible to an independent DB reader;
- pg-boss acknowledgment/redelivery, repair sweep revisit and content cache finalization/discard.

Metrics must distinguish detection from persistence:

| Measurement | Definition / why |
| --- | --- |
| First useful INBOX | Account enabled to first nonempty committed/queryable metadata unit; record connect/auth time separately. |
| Arrival visibility | Oracle append to committed metadata, per UID; also time until all ten are visible. |
| Detection and admission | Append to due eligibility, then due to admitted unit; identifies lost signals versus resource waiting. |
| Residual blocking | Urgent eligible to active low-priority turn release; proves real yielding rather than database batching. |
| Operation occupancy | Total worker/busy/socket duration including reselect, all subcommands and commit; report p50/p95/p99/max and overruns. |
| User service | Intent persisted to first admitted command/content slice and to remote acknowledgment/confirmed outcome; distinguish queue delay from operation time. |
| Remote-state lag | Oracle flag/expunge to DB convergence, recent-known versus old placements. |
| Fairness | Dispatches, eligible waiting age and worker/socket/DB occupancy per account/class; compare ratios with similar command cost. |
| Repair progress | Pages/identities per pass, pass completion time and oldest unvisited placement; no claim based on unchanged counts. |
| Cost | Bytes/commands/SEARCH results, duplicate upserts, retry amplification, peak buffered identities/bytes, RSS and socket churn. |
| DB isolation | Network-spanning DB sessions (must be zero), row lock time, pool wait, lease-renewal/wakeup delay, query rows examined. |
| Crash correctness | Saved frontiers versus independently proven coverage; duplicate placements/events, stale writes accepted, missing current-epoch identities. |

Attach wire transcripts with sensitive payloads redacted, pg-boss job states, lease history, DB snapshots and oracle events. Every operation trace must contain a release or destruction outcome. Evidence that only shows small transaction sizes is insufficient.

## 3. Correctness invariants and oracle

At every committed state, assert:

1. At most one placement per `(mailbox, UIDVALIDITY, UID)`; no cross-account identity collision or Message-ID-only membership merging.
2. `history_before = E` and `fresh_through = F` prove coverage only in `[E,F]` (empty if E=F+1). Initial SELECT observes B and initializes E=B, F=B-1, proving no historical coverage. B remains in the test oracle/trace, not a persisted cursor. MAX(local UID), dates and counts are never substitutes.
3. Every SEARCH hit crossed by a moved boundary has complete metadata or a subsequent successful same-epoch absence check. Empty ranges cross only after complete successful SEARCH. Failed/overflow/partial responses justify no absence or progress.
4. Progress and corresponding facts commit atomically. An unknown commit is treated as either fully committed or not committed, never guessed.
5. Only current coordinator ownership/generation, current account/folder lifecycle and current epoch can publish. No old response restores a placement after later confirmed removal.
6. FLAGS change evidence cannot delete an omitted UID; only complete exact-set membership evidence does. Stale MODSEQ cannot overwrite newer flags.
7. A trigger after a check's captured generation remains due; if trigger delivery fails, periodic polling eventually checks every enabled account/folder without browser activity.
8. No data operation shares its account socket concurrently with another or with IDLE. Maildock-owned healthy sockets stay within configured account/global budget; partition/failover overlap is separately observed, never hidden.
9. History continuation releases busy state and worker opportunity; no network operation holds a DB transaction or session lock.
10. Partial content cannot appear cached/complete. Epoch change invalidates every remote content identity and pending command using that identity.
11. Replays duplicate neither placements nor eligible arrival events. Historical/reset rebuild does not flood arrival notifications; existing preference/move/sent-copy exclusions remain.
12. Under a stable reachable server, finite admitted workload and eventual successful required responses, all still-existing remote placements are ingested and known flags/membership converge. Do not require observing a message that was expunged before any successful discovery.

For frontier oracle assertions, retain command-time membership snapshots at barriers, complete FETCH outcomes and omitted-UID recheck outcomes. Comparing only final counts misses skipped identities and equal-count churn. During remote churn, stale local state is permitted until its repair opportunity; evaluate absence/coverage against the evidence available to the committing operation. After quiescence and completed history/repair passes, require exact current-epoch membership and flags equality.

## 4. Fault-injection scenarios

All scenarios inherit the event instrumentation and invariants above. Each row specifies additional measurements and observable failure conditions. Repeat deterministic boundary injections and at least 30 seeded schedules for each supported profile; retain failures and raw traces, not only averages.

| ID / setup | Workload and injection | Expected invariants | Measurements | Failure conditions / extra instrumentation |
| --- | --- | --- | --- | --- |
| A1: Empty local DB, 50k dense INBOX | Start no-browser worker. Inject ten appends before first SELECT completes, after B capture, during history SEARCH, after UID capture, mid-FETCH, before commit, after commit/before ACK, and just before IDLE. Separate trials at each barrier. | Every still-existing UID covered by history or arrivals; ten after B can commit before history completes. Before-B appends belong to history without false new alerts. | First-use, append/detection/admission/commit, last old-unit occupancy, total time for ten. | Full 50k inventory before first metadata; recent-success gate; new UIDs wait for history completion; lost wake. Record exact B/F/E and barrier oracle. |
| A2: A1 at C=1 with user demand | Inject read toggle plus body/large attachment request during history; repeat without IDLE capability or notification delivery. | One socket; DONE before command; bounded content turns; current category alternation; fresh timer independent of history. | Remote live sockets, command overlap, time to first user turn and ten-arrival commit. | Second connection attempt as normal bypass; attachment holds socket through whole transfer; permanent timer starvation. Include socket lifecycle and content-slice tags. |
| A3: A1 at C=2 and C=5 | Watcher connected; append during active data command and concurrently request user action. | Watcher counted; still one data operation/account; same-folder active work ends before next data command. | Watcher occupancy, detection acceleration, data concurrency, eviction. | Watcher outside cap, double writers or phantom multi-connection preemption. Correlate watcher signals with due generation. |
| D1: 50k already local, begin old repair | Second client expunges 15k old messages in bounded oracle batches while appending ten. Run CONDSTORE and fallback. | Arrival operation performs no 50k known-UID scan; removals apply only to confirmed exact-set absence; repair continues in K pages. | Arrival/user latency against A1, repair-page duration, time to remove 15k and pass completion. | Whole deletion pass retains turn; false removal from incomplete evidence; arrivals gated on pass. Log exact queried page digest and absent count. |
| D2: Equal-count churn | Delete ten and add ten between count observations; suppress EXPUNGE notifications; repeat in another folder. | Membership SEARCH detects known absence despite unchanged counts; destination arrivals eventually discovered. | Identity difference versus oracle, per-folder stale age. | Counts declare synchronized state, lost destination membership. Save identity oracle rather than counts only. |
| F1: Known flags, second client | Change Seen/Flagged/custom flags in recent and old pages during history, before and after FETCH; test stale MODSEQ and NOMODSEQ. | Bounded known-set updates; full fallback when baseline unusable; partial CHANGEDSINCE never means absence; eventually exact flags after quiescence. | Recent/bulk flag lag, bytes with/without optional optimization. | Lower MODSEQ accepted; missing old changes due global checkpoint; unknown UID imports history during repair. Trace page baseline per placement. |
| R1: Bootstrap partially committed | Kill receiving process after first, middle and near-final history units. Restart with only DB/boss state. | Epoch/F/E preserved; continue descending; fresh immediately eligible; no browser gate or MAX-UID shortcut. | Replayed commands/records, oldest coverage, restart-to-first-turn. | Repeated newest-only loop starves oldest; cursor reset or uncovered gap accepted. Capture DB before/after kill. |
| R2: Commit before ACK/enqueue | Kill precisely after transaction commit but before queue ACK; independently suppress continuation send. | Redelivery idempotent; periodic repair discovers remaining work even if ACK happened; event dedup. | Redelivery count, repair delay, duplicate upserts/events. | Missing history continuation, duplicate alerts, reusing frozen job frontier. Correlate boss state to commit event. |
| U1: SEARCH UID present, FETCH missing | Omit middle UID once, reorder later responses, then return it on retry. Repeat with genuine expunge before recheck and persistent omission. | Frontier cannot cross unresolved identity; absence recheck resolves expunged UID; bounded partial metadata may persist without frontier advance. | F/E progression, retries, later records visibility, unresolved error age. | MAX returned UID advances; omission treated as expunge; persistent poison silently skipped. Command-time oracle proves UID stayed present. Persistent omission must fail convergence gate explicitly. |
| U2: Sparse and boundary UIDs | UIDs 1,9,127,128,129,50000 plus billion-sized gaps, UID near 2^32-1, B=1 empty mailbox; place dense region after a widened empty probe. | Complete empty intervals advance; widening overflow advances nothing and shrinks; exact UID identity and no star/reversed-range accident. | Empty probes, span changes, bytes buffered, retries and time to first extant UID. | Millions of linear probes, unbounded SEARCH list, truncated response used as complete, integer overflow. Log requested interval and parsed-result count. |
| U3: UIDVALIDITY reset | After metadata is buffered, reset epoch and reuse UID 9 for different content. Inject reset during history/repair/content and stale-owner completion. | New epoch hides old placements immediately; old callbacks fenced; cleanup bounded; commands/content invalidated; no alert flood. | Epoch switch duration, cleanup unit size, leaked old identities/cache. | Unbounded 50k deletion transaction; UID-reused content shown; old metadata accepted. Trace owner/epoch on each result and cache key. |
| N1: Slow/hung commands | Delay SELECT, SEARCH, FETCH, DONE, FLAGS, content slice and APPEND independently; send trickle bytes or omit tagged OK. Deliver a late callback from an aborted turn after same-owner repair confirms deletion; also stall/cancel an already-started DB commit. | Total deadline rather than socket inactivity controls turn; socket destroyed, no unsupported frontier, fresh/user retried after capacity returns; mutation uncertainty retained; expired turn token cannot publish and unresolved DB writer prevents a new turn. | Deadline-to-destruction, release-to-reconnect, late callback rejection, occupancy maxima, transaction cancellation resolution. | Never-ending trickle prevents yield, promised preemption, deadline resets per subcommand, silent APPEND replay, same-owner stale resurrection or a Promise.race leaving work active. Require actual OS socket-close evidence and server transcript. |
| N2: IDLE interruption | Disconnect before/after EXISTS, fail due persistence, lose wake, reject IDLE, hang DONE, require reauthentication. | Polling/reselect supplies eventual discovery; late wake generation survives; watcher reconnect does not gate fresh. | Notification versus fallback latency, reconnect/backoff and sweep revisit. | IDLE is sole correctness path; late wake cleared by earlier check; infinite reconnect consumes user capacity. Correlate generations and timer due events. |
| M1: Shared resource pressure | Eight accounts with 50k histories; two with continuous controlled arrivals, two with user commands/content; others get occasional appends. W/pool matrices. | One current headroom opportunity where feasible, account rotation, maintenance protected, history uses leftovers only; no DB sessions over network. | Per-account waiting/service, pool wait, renewal delays, skipped-admission reasons, histories paused. | Chatty account monopolizes slots, DB exhaustion blocks due recording/fence renewal, quiet account starves. Add global token/ready-set snapshots. |
| M2: Continuous urgent saturation | Keep current/maintenance demand above history capacity for 10 minutes; then stop arrivals/actions. | History allowed no progress during saturation, resumes from durable E when resources return; no unbounded queue/RSS growth. | History admitted under contention, recovery time, ready set/queue size. | Reserved history quota violates leftovers policy; lack of resumption or queue leak. Do not fail merely because E stays fixed while urgent work is continuous. |
| C1: User and external mutation races | Read/unread, flag, MOVE and destination arrival while history runs; source expunged or conditional conflict from second client. Drop MOVE response after success. | Existing conflict semantics preserved; no stale overwrite or blind uncertain move replay; source/destination converge separately. | User admission/ack lag, duplicate destination copies, overlay lifetime. | New receive engine duplicates moves, masks uncertainty, or clobbers unrelated flags. Include command intent/outcome and COPYUID/MOVE oracle. |
| B1: Oversized/malformed content and metadata | Huge header/MIME tree, part beyond slice cap, multipart transfer-encoding boundary split, slow parser and partial blob write. | Size/time bounds enforced before buffering excess; shrink/retry, unresolved identity reported; content only complete after successful assembly. | Parser RSS/event-loop lag, buffered bytes, decoder output digest, cache finalize/discard. | Library buffers unbounded SEARCH/literals; slice decoding corrupts content; metadata frontier skips poison. Include raw-part and decoded-output oracle hashes. |
| G1: Folder discovery and lifecycle | Many folders, over LIST cap, missing UIDNEXT, rename/delete/disable account while work is active; no browser. | INBOX accessible before LIST completion; partial LIST never proves disappearance; invalid identity prevents publish. | LIST bytes/pages/deadline and first-INBOX latency. | Alphabetic bootstrap dominates INBOX; unsupported boundary guessed; partial listing deletes folders. Include folder topology oracle. |
| P1: Preserved business integrations | Existing conversation threading, attachment descriptors, notification preferences, outgoing/Sent-copy/drafts/OAuth lifecycle; simulated auth expiry and SMTP load. | Receiving change preserves existing behavior; SMTP/local drafts independent; IMAP side effects share account budget. | Regression invariant failures, SMTP delay attributable to shared DB rather than receive locks. | Dropped notification/move suppression, broken OAuth refresh, sending serialized by receive owner, unbudgeted sent-copy client. Reuse existing fixture assertions and inspect job routing. |

## 5. Connection-limit and ownership tests

The fixture must count successful live sessions and denied attempts, including passive IDLE. Do not count only data workers. At C=1, fresh/user/history/DONE cannot overlap; at C>=2, optional watcher plus one data socket fits the budget. C=5 does not imply five data workers. Test global P smaller than number of accounts: watchers must be evicted, polling still visits unobserved accounts, and active work must not inherit unusable watcher reservations.

Start two receiving processes racing to acquire the coordinator lease. Only the winner may own account sockets/issue commands. Pause it beyond expiry; allow takeover; resume old process and deliver buffered FETCH/STORE callbacks. Reject all old database writes and stop old transport before any new command. Kill the process, disconnect its DB while IMAP remains connected, and delay remote detection of a destroyed socket. Record both local planned capacity and server observed accepted sessions. A remote server may reject replacement until the old session expires: this is a recovery delay, not permission to ignore the cap.

The lease fence cannot retract already-issued MOVE/APPEND. Verify mutation uncertainty rather than asserting exactly-once remote side effects. If arbitrary partition causes temporary overlapping sockets across owners, record it as the disclosed failover limitation and decide whether conservative takeover is acceptable; do not mark the strict-cap test passed merely because both owners believed they had a valid budget. Compare grace periods against user/fresh recovery delay. No automatic higher-capacity probing during restrictive-server recovery.

## 6. Crash/recovery matrix

Use barrier-triggered process termination and connection fault injection only inside the future disposable harness. Inspect with a separate DB connection after recovery; the crashed process's logs may be incomplete.

| Crash/fault boundary | Expected durable state | Recovery evidence |
| --- | --- | --- |
| Before epoch initialization transaction | No coverage initialized | Fresh SELECT initializes once; initial messages still reachable. |
| After B/F/E initialization, before first SEARCH | Empty local historical coverage, valid boundary split | History and fresh eligible without initialization-success gate. |
| After SEARCH, before FETCH | No advanced interval | Repeat SEARCH, including previously hit UIDs. |
| Mid-FETCH / before tagged OK | Frontier unchanged; optional complete metadata only if explicitly committed | Repeat interval; incomplete response establishes no absence. |
| After complete result, before transaction | Old frontier | Replay without lost identities. |
| During metadata/progress write | Full rollback or full commit | Fault both before COMMIT and with commit response lost; inspect server DB outcome. |
| Commit succeeded, client believes failed | New facts and boundary | Reload/replay idempotent, no backwards frontier or duplicate notification. |
| After commit, before ACK/continuation enqueue | New facts and boundary, possibly active boss job | Redelivery or periodic repair makes next unit eligible. |
| After wake persisted, before enqueue | Due generation/time retained | Repair creates wake within one completed sweep; no lost late trigger. |
| During known-page deletion/flags transaction | Page atomic; R advances only with complete page evidence | Retried page cannot delete unrelated identities; next page continues. |
| After epoch switch, before cleanup | New active epoch, old invisible rows remain | No old result visible; bounded eventual cleanup. |
| During lease renewal/takeover | Exactly one committed current generation | Old-generation writes rejected; remote overlap recorded separately. |
| After STORE/MOVE/APPEND remote success, before result persistence | Existing intent/outcome may be uncertain | Conditional flag reconciliation or existing uncertain move/APPEND path; no blind duplicate side effect. |
| Mid-body/attachment temporary write | Availability incomplete; temporary bytes may exist | Discard/reassemble safely; digest equals fixture, no stale-epoch reuse. |

Assert both metadata and side-effect notification state at every boundary. ACK tests alone do not prove that progress transactions are atomic or that missed queue insertion is repaired.

## 7. Latency, fairness and initial acceptance hypotheses

Approved requirements are qualitative: current INBOX/user opportunities, bounded expensive work, no silent loss, account fairness, browser independence and history using leftover capacity. The following numerical gates are **proposed laboratory acceptance hypotheses**. Change them only with a written rationale and retained measurements; choosing a generous number after a failure is not evidence of the original design passing.

| Proposed gate | Reference profile / measurement |
| --- | --- |
| First 128-or-fewer useful dense-INBOX records within 5 seconds | Healthy profile, warm credentials; report cold startup separately. No full inventory prerequisite. |
| All ten post-B arrivals visible within 5 seconds with watcher, 20 seconds without watcher | Healthy C=2/C=1 profiles respectively, history active; worst deterministic barrier trial plus p95 across seeded schedules. Explain the 15-second fallback poll and any user turn between check and commit. |
| Individual command or first content slice admitted within 5 seconds under moderate background/user load | C=1/2; current-class policy with known bounded demand. Remote completion separately measured. |
| Healthy operation occupancy p95 <=2 seconds; absolute configured execution deadline 10 seconds | All unit types, including multi-command repair and content; startup has own 10-second cap. No per-subcommand deadline reset. |
| Hung turn releases locally within 11 seconds; no-server-response progress is not required | Watchdog destruction overhead hypothesis 1 second. Report reconnect/admission delay and no provider SLA. |
| Metadata commit p95 <=250 ms; individual lock/statement bound <=2 seconds | DB-pool profiles, conversation/notification integration enabled. Zero network-spanning DB reservations. |
| Recent-known flags/deletions p95 <=45 seconds; bulk 50k pass <=10 minutes | Healthy finite-load profile, one protected maintenance dispatch per eight contested opportunities. 15k deletions converge within a completed pass, not within arrival deadline. |
| Similar-cost eligible accounts have dispatch counts within 2:1 over 60 seconds; each receives a turn within two rotations | W=1/2/4; record cost difference separately. Current and maintenance classes evaluated independently. No history fairness gate under continuous urgent demand. |
| History resumes within one repair sweep plus two selector rotations after urgent demand stops | Proposed repair sweep target <=15 seconds in the eight-account fixture; verify scan pagination at larger populations. |
| Post-crash unresolved work becomes eligible within 45 seconds of service restoration | Includes proposed 30-second lease expiry plus 15-second repair sweep, not arbitrary remote socket expiration/auth outage. Replay latency measured separately. |
| Single uninterrupted empty UID gap crossed with logarithmic probing | At most approximately log2(gap/K)+2 empty probes, plus a bounded overflow/shrink sequence on hitting dense UIDs; no linear billion/K traversal. |
| At most K buffered identities and configured metadata/content byte limits per admitted unit | Measure parser buffers, not only application arrays. Ready set/queued promises must plateau in a 10-minute saturation test; bound total memory as O(W * unit budget + P * transport overhead + enabled-account hints). |

Acceptance of correctness invariants is binary: zero unexplained missing still-existing identities, false deletions, cross-epoch updates, accepted stale fences, duplicate placement/eligible notification or complete-but-corrupt content. Numeric thresholds are empirical selection tools. Persistent server omission, invalid UIDNEXT, oversized metadata or unavailable transport capabilities must fail the relevant compatibility/convergence gate explicitly; they are not allowed to pass by skipping messages.

Report absolute maxima and per-account tails, not just p95/means. Compare C=1 versus C=2/5 and CONDSTORE versus full flags. Run a source-faithful full-inventory model as a comparison, without implementing or modifying v1/v2 application code. Measure why bounded windows improve scheduling and what their sparse/replay cost is. Avoid benchmarking unrelated transport rewrites.

## 8. Risks and limitations

1. **Transport bounds are unproven.** Current source checks and tests show lifecycle/error handling, not parser-level limits, absolute watchdog cancellation, partial-content resumption or bounded server execution. A real ImapFlow/socket experiment is mandatory. Server-side SEARCH can be slow even for a tiny result; closing a socket limits local occupancy but does not accelerate the provider.
2. **Conservative replay can lose liveness on pathological input.** Permanently omitted/oversized identities stall their frontier. Sparse probing may hit dense overflow and reconnect repeatedly. Report identities as unresolved and seek a measured design decision; do not silently add receipts or skip them.
3. **Sequential account execution trades throughput for safety.** Large IMAP APPEND, reauthentication and lease failover can delay current work. Lease fencing protects DB facts, not remote exactly-once mutations or instantaneous socket revocation. Validate these delays against approved product expectations.

A scripted server does not prove provider interoperability or OAuth policy. A local latency result is not a provider SLA. Without QRESYNC, membership repair remains proportional to known placements and old remote changes can lag. Continuous urgent overload intentionally starves history, while finite-load maintenance must still progress. An epoch reset may take many cleanup units; measurements must distinguish immediate invisibility from physical deletion.

Existing inspected Maildock tests provide regression expectations, not a new-engine pass: `incremental-sync-provider.test.ts`, `backfill-sync-provider.test.ts`, `incremental-sync.integration.test.ts`, `imap-conditional-store.test.ts`, `imap-client-lifecycle.test.ts` and content/attachment tests. Existing Thunderbird tests cover IDLE, flags and truncated bodies, but do not supply these 50k/one-socket latency measurements. No tests were run during document creation.

## 9. Minimum evidence gate before production implementation

Require a reviewable validation report containing:

- Exact source/dependency/server/configuration pins, runnable disposable-fixture instructions, all seeds and raw per-scenario traces; explicit separation of model results, scripted-peer experiments and real-server results.
- A1/A2/A3 and D1 results at C=1/2/5 with no browser, concurrent user actions and fallback polling; proof of busy/socket/worker release between real operations.
- Passing frontier/epoch/deletion/idempotency invariants across every crash boundary, missing FETCH, sparse gap and equal-count churn case; preserve any failing seed and its fix rationale.
- Transport proof of total deadlines, trickle/hung command abortion, bounded buffers and MIME slice decoding/finalization. Failure here blocks production implementation of the proposed responsiveness policy.
- Multi-account W/P/DB saturation evidence, ownership takeover/stale-callback rejection and an explicit remote-cap/failover limitation decision. No global limits asserted solely from local per-queue settings.
- Preserved command/notification/conversation/SMTP/draft/OAuth/content behavior, and explicit product approval of freshness, user wait, remote-state lag, size limits and uncertainty presentation.
- A small accepted architecture revision if experiments invalidate assumptions, identifying each added mechanism and the concrete failure it prevents. No prototype or harness result implicitly authorizes shipping.

Outcome may be **validated for implementation planning**, **requires design revision**, or **blocked by a named transport/product conflict**. This task supplies the architecture and validation plan only; production feasibility and performance remain unmeasured.
