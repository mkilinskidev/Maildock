# R04 phase unblock — durable claims before owned network construction

2026-10-14. **PASS for the narrowly scoped phase blocker.** The new prepared
operation path can claim, confirm/recover, execute on its single owned client,
retire that client and publish a matching R04-A result within one elected W/C
allocation. The selected regression run had Stage 3B failures, documented below;
its three affected cases passed in a bounded final comparison without changing
assertions or deadlines. This is not acceptance of the whole R04 roadmap task.

Base: `e739699d064e520a4bc0fa00494201b0eadea310`.
Branch: `feature/imap-sync-r04-fenced-publication`.
The historical [R04 report](R04_RESULTS.md) retains its BLOCKED result and only
links to this follow-up. R04-B, R04-C, R05 and worker cutover were not started.
No production STORE/MOVE/content/attachment/APPEND body, new worker, push, merge
or PR is included.

## Narrow preparation and publication ports

The trusted `ReceivingOperationHandlers` registry now also accepts a prepared
descriptor with `preNetwork` and `execute`. Submitters still provide only the
existing bounded operation envelope; they cannot supply either callback.
Preparation receives `ReceivingPreNetworkContext`, containing lifetime signal,
deadline and typed `claim(source)` / `recover(source)` methods. It contains no
client, factory, database facade, arbitrary SQL callback or result writer.

The intent kind and ID are derived from the admitted operation: STORE uses its
command ID, content slice its content/message ID, and attachment slice its
attachment ID. Source mailbox and configuration must match the captured account
identity. MOVE/APPEND have no R04-A preparation capability and fail closed; their
SQL capabilities remain R04-C work.

A prepared descriptor must obtain exactly one confirmed fresh claim before its
execution callback can run. Claims are single-use, SQL/recovery calls are serial,
and failed preparation stays failed even if the trusted callback catches its
rejection. Detached preparation is rejected and awaited during local retirement.
Recovering an old executing/fetching row does not satisfy the fresh-claim gate
and does not authorize remote replay.

The existing R03 callable handler form remains compatible for admission-only
fixtures and no-claim operations. Its raw SQL port still requires retirement.
Remote mutation methods additionally require a prepared durable STORE command
claim; unprepared handlers cannot transmit a mutation. MOVE/APPEND transmission
remains disabled until their separately authorized claim capabilities exist.
The original R04 negative control proving that it cannot serve as a claim-before-
network port remains unchanged and passing. New R04-A business execution uses
the prepared descriptor. No production registry body is added by this task.

Prepared execution exposes a frozen claim receipt and typed
`publication.commandResult(evidence)` / `publication.fail(outcome)`. These call
the existing `ReceivingPublication` API with the captured owner, intent, attempt
and confirmed receiving state. Prepared handlers cannot use the generic result
SQL callback; existing no-claim R03 handlers retain their original post-retirement
callback. No general pre-network SQL access was introduced.

## Enforced lifecycle and ownership

```text
ADMITTED -> PRE_NETWORK_CLAIM -> CLAIM_SETTLED -> NETWORK
         -> RETIRING -> NETWORK_RETIRED -> RESULT_PUBLICATION -> SETTLED
```

| Phase              | Enforced boundary                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMITTED           | The existing elected selector already holds W and account C=1. Initial validation uses its existing serialized control gateway.                                                                                                                |
| PRE_NETWORK_CLAIM  | No IMAP client has been constructed. Only bound claim/recovery APIs can use one serial data SQL scope.                                                                                                                                         |
| CLAIM_SETTLED      | Preparation has returned, all issued pre-network work has settled and a fresh exact claim is confirmed. Revalidate owner/configuration/lifecycle through the control gateway, then confirm the attempt again under conflicting recovery locks. |
| NETWORK            | Construct exactly one guarded client after all prior scopes settle. Network methods reject other phases and concurrent data SQL; connect remains single-use.                                                                                   |
| RETIRING           | Revoke network methods and await the installed client's actual `retireReceiving` promise. This phase retains W/C.                                                                                                                              |
| NETWORK_RETIRED    | Result access requires completed retirement, the exact receipt and no executing/queued data SQL scope.                                                                                                                                         |
| RESULT_PUBLICATION | Serialize the existing R04-A capability through the same executor. A terminal publication is single-use; an unknown result outcome cannot trigger automatic failure or another publication.                                                    |
| SETTLED            | Revoke all capabilities and release the selector allocation only after socket, handler, issued pre-network work, provider work/iterators and local SQL have settled.                                                                           |

Error paths may retire without ever entering NETWORK. They cannot construct a
client afterward. Timers and caller/owner cancellation are active throughout
preparation, including SQL waits. Cancellation revokes the existing executor
scope and network facade; it does not release the allocation early.

Initial elected validation now returns the existing account lifecycle counter
alongside connection configuration, under its account SHARE lock. Prepared
operations require that captured counter. Post-claim validation and recovery
compare it again, closing disable/re-enable ABA during this operation. The
recovery API additionally reads current configuration, lifecycle, path and the
active-source predicate inside its already locked transaction. Confirmation
checks the exact UUID, actor/generation, account, kind, mailbox/path, epoch/UID,
configuration, lifecycle and executing/fetching status. Credentials are not
exposed to the preparation port.

The coordinator election, generation checks, renewal queue/headroom,
`min(W,2D-1)` data allocation limit, D executing/D waiting limits and Stage 3B
fresh/history selection code are unchanged. Preparation and result publication
use the operation's original executor, not another executor or nested selector.
The small internal transaction adapter only tracks/guards calls to that executor;
it is never exposed to preparation callbacks.

No SQL migrations, R04-A SQL allowlists, Stage 1 deferred COMMIT functions or
logical authority point L were changed. Each claim/settlement still has the
original mailbox/state/intent locks and revision advancement. F/E/R behavior and
D15 Variant A remain as implemented in the accepted authority path.

## Unknown outcomes and failures

The operation creates the claim UUID before entering SQL and passes it to
`ReceivingPublication.claim`. Each pre-network SQL scope is bounded by the
original operation deadline and a two-second ceiling, leaving a bounded recovery
opportunity inside the same lifetime. This adds no capacity or deadline extension.

An unresolved claim is never resent. Locked recovery must find that exact UUID
and its matching active authority before construction. Pending, failed, foreign,
stale, terminal or older executing rows cannot pass this gate. Recovery failure
or cancellation creates zero clients. After any successful claim, a second
validation/recovery check precedes the first client construction.

A preparation or connection failure before a mutation delegate is entered uses
the existing matching `failed_before_execution` capability when authority and
lifetime still permit settlement. A mutation delegate is conservatively marked
as potentially transmitted before invoking the installed adapter. Losing its
response retires the socket and settles `uncertain_remote_execution` through
R04-A, preserving repair demand and canonical flags rather than asserting rollback.
The typed failure port refuses pre-execution failure after possible mutation.
Read failures use the matching read-failure category.

If cancellation, expiry, takeover or changed source/configuration prevents legal
failure publication, the durable executing/fetching attempt remains for locked
recovery. It is uncertainty, never permission to resend. Result ACK loss likewise
blocks another publication; no automatic retry or new client is introduced.
Remote reconciliation/adoption remains the later business execution contract.

Prepared client errors retire the network capability while retaining an otherwise
valid lifetime for matching failure publication. Existing no-claim R03 handlers
retain their previous error cancellation. Neither path permits network revival
or SQL publication before actual retirement.

## Actual PostgreSQL and installed-adapter evidence

`receiving-claim-phase.integration.test.ts`: **17/17 passed**. Fixtures use
disposable PostgreSQL 17.6, an ordinary non-superuser owner, the complete migration
journal, actual R04-A functions, the elected coordinator and an independent
postgres.js reader. The installed patched ImapFlow client connects to the existing
scripted TLS peer. No remote operation body is implemented in production.

The positive fixture runs with D=1 and D=2, W=1. Its independent reader observes
the committed executing row/UUID before the first construction; construction
also observes no executing data SQL. One real UID STORE fixture command runs,
the client retires, and the typed matching result commits command success and
revision 3 with unchanged F/E/R. Both late client and preparation callbacks fail
after SETTLED.

| Required control                                                    | Evidence                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim before first construction / failed claim creates zero clients | Positive D=1/2 receipts and independent rows; stale claim deliberately swallowed by preparation still rejects execution.                                                                                                |
| Unknown claim ACK recovered before wire                             | Raw response relay drops the actual claim COMMIT reply once. The committed row is independently visible while client count remains zero; locked exact-UUID recovery precedes the single STORE.                          |
| Unresolved claim cannot execute                                     | After lost ACK, an independent mailbox UPDATE lock blocks recovery until its unchanged scope deadline. Zero clients; durable attempt count stays one.                                                                   |
| Cancellation during claim                                           | Explicit mailbox lock and PostgreSQL wait observation; cancellation revokes the scope and creates zero clients.                                                                                                         |
| Takeover during claim                                               | Independent coordinator lock queues takeover before the old claim; the old term cannot execute.                                                                                                                         |
| Configuration / disable / disable ABA                               | Three post-claim source/lifecycle changes each prevent construction and stale settlement.                                                                                                                               |
| Post-claim network failure                                          | Lost STORE response yields matching failed-with-uncertainty after retirement and exactly one fixture remote mutation. A subsequent claim is rejected.                                                                   |
| Cancellation after potential transmission                           | Hung STORE is observed on the peer before cancellation; executing uncertainty remains and a new claim cannot resend it.                                                                                                 |
| Result before retirement                                            | Both typed result and generic SQL access are rejected before retirement.                                                                                                                                                |
| Blocked retirement retains W/C                                      | Gate the actual adapter retirement. Matching failure publication remains forbidden, command remains executing, and a second same-account request stays pending until retirement and publication settle.                 |
| Late callbacks / invalid transitions                                | Retired client, retired preparation context, simultaneous claim/recovery, second claim and detached preparation all fail closed.                                                                                        |
| No excess data SQL / network overlap                                | Preparation has no client port, construction follows settled SQL, network methods require NETWORK, and serial pre/result scopes share the existing executor. D=1/2 and blocked W/C controls retain the existing bounds. |

## Regression results and bounded comparison

Final impacted run: phase, R03 admission and R04-A **55/55 passed** in three files
(17 phase, 20 admission and 18 publication). The phase-only run also passed
**17/17**, including the blocked-result scope control.
The retirement/C=1 case was then verified with W=2 (one pass, sixteen skipped),
so its same-account exclusion was observed with a spare global allocation.
Selected regression run: seven files, **135 passed / 3 failed out of 138**.
All six Stage 1/R02/R03-election/admission/R04-A files passed (107 cases). Stage
3B scheduler passed 28/31, including fresh visibility and sustained history
controls at W=1/2/4. The three failed cases were:

- Unavailable-account startup barrier W=4: unchanged 120-second test and teardown
  timeouts.
- W=1 cancellation/restart: historical E remained 129 at the unchanged complete-
  history barrier rather than reaching 1.
- Hung-account backoff: its existing timing assertion required the healthy
  first turn to precede the unavailable account's first error.

A single bounded comparison ran only these three cases on an archived copy of
base `e739699` using the same installed dependencies: **2 passed / 1 failed**.
The same healthy-first timing assertion failed on the base. One matching run on
the final working source then passed **3/3**, without modifying those tests,
assertions, timeouts, scheduler code or authority checks. The earlier combined
run remains a recorded failure; this report does not claim one clean complete
seven-file run or general timing stability. No further retry campaign ran.

Across the final focused run, the six passing regression files, the 28 passing
scheduler controls and the bounded three-case final comparison, **155 distinct
selected cases have passing evidence in eight files**. Original Stage 1 late-
callback/L controls and R02/R04-A guards remain intact. This phase task does not
complete the broader outstanding R04 publication/race coverage from B/C.

Application/worker typecheck, repository lint (no warnings), changed-file
formatting and `git diff --check` passed. Development corrected a copied fixture
database URL and replaced a transaction-cached pg_stat_activity observation with
an independent reader; neither failure was accepted as test evidence. The first
baseline pnpm invocation refused a junction as its hoist directory before tests
started; the comparison used the installed Vitest CLI directly, with no package
installation or dependency changes.

The temporary base archive remains in TEMP: automatic command review rejected
its cleanup with `blocked by policy`, without a more detailed reason. The
rejected cleanup did not execute.

Commands:

```text
pnpm exec vitest run tests/receiving-claim-phase.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-claim-phase.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-publication.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-publication.integration.test.ts --maxWorkers=1 --no-file-parallelism
node <installed-vitest>/vitest.mjs run tests/receiving-scheduler.integration.test.ts -t 'targeted startup barrier W=4 cannot be held|W=1 bounds simultaneous operations|backs off one hung account' --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed files>
git diff --check
```

The comparison command ran once in the base archive and once in the working
source. Local logs are `$env:TEMP/maildock-r04-phase-final-focused.log`,
`maildock-r04-phase-final-impacted.log`, `maildock-r04-phase-regressions.log`,
`maildock-r04-phase-baseline.log`, `maildock-r04-phase-scheduler-comparison.log`,
`maildock-r04-phase-typecheck.log` and `maildock-r04-phase-lint.log`.
The W=2 C=1 control is recorded in `maildock-r04-phase-final-c1.log`.
Docker settings were process-local, using the accepted Linux engine named pipe
and `/var/run/docker.sock` override. No Dovecot benchmark, full application suite
or unrelated provider test was selected.

**Stop after resolving this phase blocker.** Full R04 remains incomplete; B/C,
remote business bodies and worker activation require their later authorized work.
