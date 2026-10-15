# R12 — Owner-routed attachment retrieval and CID resources

2026-10-15. **PASS for isolated deterministic R12 implementation and validation.**
Isolated receiving implementation only;
production registration remains R16.

Base: `810ae80a99b9adbdac55cec3872376bddbf4f3b6` (accepted R11).
Branch: `feature/imap-sync-r12-attachments`.

## Lifecycle and authority

The existing AttachmentService/R02 request capability coalesces demand on the
original attachment ID. No replacement intent, persistent execution ledger,
worker, queue, provider client or storage platform is introduced. The elected
coordinator discovers pending/fetching attachment rows on its existing election,
wake and renewal control opportunities, only when trusted attachment composition
and credential bindings exist. A partial ordered index supports keyset pages of
32 candidates, including ineligible rows so stale requests cannot pin the cursor.
At most one candidate per account is submitted per page; an in-memory set
coalesces selected IDs. Scheduler capacity also bounds outstanding submissions.
Lost wakes leave durable rows available on later control opportunities.

R03 validates owner/account/configuration/lifecycle, then the R04 preparation
phase recovers under conflicting locks and claims the exact intent before any
client exists. The descriptor's account/message/mailbox/epoch/UID/part and
configuration remain frozen. Recovery checks original metadata; the settled claim
must retain the recovered path and part. The owned boundary validates lifecycle
and configuration again before creating its single-use installed ImapFlow client.
No SQL reservation or transaction spans network transfer.

A fetching intent can restart from byte zero at most three times, recording
`reads` and `previousAttempt` on the existing attempt marker. Unknown claim
COMMIT responses recover the exact attempt UUID under the established locks;
they never blindly repeat a claim. Old actors, configuration, lifecycle, revision
or source tuples cannot publish. Publication recovery similarly locks and checks
the exact succeeded attempt before accepting a lost acknowledgement or retrying
an uncommitted result. It does not open another IMAP socket.

## Selective MIME transfer and decoding

The owned client EXAMINEs the frozen path and verifies selected UIDVALIDITY. A
UID FETCH of BODYSTRUCTURE is strictly validated by the shared R11 protocol
collector, then normalized using the existing adapter. The original descriptor
must match part, filename, content type, disposition, Content-ID, visibility,
inline flag, encoded size and original encoding. Nested identities remain intact.
Only UID BODY.PEEK of that exact part is fetched. No message source, unrelated
HTML, MIME body, attachment, BINARY command or STORE is requested.

R11's collector has an attachment-only encoded-evidence mode: it retains no raw
chunk array and performs no display charset conversion. Every FETCH must have
one matching UID/body literal, the exact part/offset, a bounded literal, and a
correlated successful tagged completion. Total bytes must equal BODYSTRUCTURE's
encoded size. A final short read must prove EOF; exact window multiples require
an additional successful zero-byte read. Missing/duplicate/wrong-tag/failed
completion, truncation, reordered offsets, extra bytes or ambiguous evidence fail
closed before storage finalization.

A strict continuous attachment decoder handles base64 (including canonical
padding), quoted-printable (hex and CRLF soft breaks), 7bit, 8bit and binary.
Base64 retains at most three carry characters, QP at most two. Transfer decoding
never changes text charsets or flowed lines in downloadable files. Unsupported
or malformed encodings fail. MIME filenames never become filesystem paths and
content is never executed.

## Sizes, staging and verification

| Resource                           | Bound                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| Decoded incoming attachment        | **104,857,600 bytes (100 MiB)**                        |
| Encoded MIME part                  | 419,430,400 bytes (400 MiB)                            |
| Partial UID BODY.PEEK / literal    | 32 KiB                                                 |
| Adapter response / nonliteral line | Existing 256 KiB / 64 KiB                              |
| Attachment wire input              | Encoded cap + 8 MiB protocol allowance                 |
| Decoder carry                      | Base64 3 / QP 2 characters                             |
| Display-content policy             | Unchanged independent 5 MiB                            |
| Upload/outgoing policies           | Unchanged 15 / 18 / 25 MiB                             |
| SQL scopes                         | At most 2 seconds, intersected with operation lifetime |

The encoded allowance covers base64 line wrapping and ordinary QP expansion;
excessive encoded whitespace still fails at a finite boundary. MIME declares
encoded length, not independent decoded length. The decoder counts actual output;
LocalBlobStorage separately counts written bytes and incrementally hashes them.
A file above 100 MiB fails before finalization/publication regardless of allowed
encoded size. R04-B subsequently streams the finalized object again, verifies
exact decoded size/SHA-256/existence, and only then enters result SQL.

The existing storage `put` consumes an async generator with backpressure. There
is one outstanding partial fetch; the next cannot start until the current disk
write finishes. A private random UUID file under `tmp` is written incrementally,
fsynced, closed and atomically renamed to the existing immutable UUID key layout.
The decoder/collector finish before `put` can finalize. SHA-256 uses incremental
updates throughout storage and publication verification. Neither receiving nor
publication concatenates file-sized buffers or serializes payload bytes into JSON.

Admission holds W and account C=1 until all transfer, file verification, socket
retirement and SQL settle. Active staging uses at most 100 MiB per admitted
attachment (less on failure), hence at most `min(W,2D-1) * 100 MiB` in the current
scheduler, with at most one per account. Encoded bytes are never staged to disk.
This bounds active staging, not retained cache capacity or debris across crashes.

Migration 0049 replaces only the attachment result function's size/evidence
checks and adds the attachment restart claim/index. The existing exact source,
revision, lifecycle, attempt, elected authority, original part and deferred COMMIT
checks remain. SQL independently checks the 100 MiB decoded ceiling, finite
encoded ceiling and original declared encoded size. Registry insertion, ready
linkage, revision advancement and incoming draft reference resolution are atomic.
The content-publication policy and global SQL/JSON/socket limits are not raised.

## Deadline and fairness

Attachments have a finite **15-minute absolute operation lifetime**, including
queue wait, credentials/preparation, network, disk fsync, verification, actual
socket retirement and result publication. All other operation envelope lifetimes
remain ten seconds. Credential acquisition retains its existing shorter bound.
There is no configurable scheduling platform or separate attachment connection.

100 MiB over 900 seconds requires at least about 114 KiB/s decoded, with additional
time for disk/SQL; wrapped base64 needs roughly 156 KiB/s on the wire. Sequential
32 KiB windows also impose a latency cost: unencoded 100 MiB needs 3,201 body
commands; unwrapped base64 needs about 4,267. At 100 ms per round trip that alone
costs about 320/427 seconds, so the initially considered five minutes was too
short. Heavily expanded QP, high latency or a slower server can still time out.

Existing startup-fresh priority, user/current alternation and protected-history
selection run at completed operation boundaries. A large attachment is bounded
but nonpreemptible: W=1 or the same account may wait up to the remaining lifetime.
Repeated downloads must yield to that established selection policy after each
settlement. W>1 can use other accounts, never another socket for this account.
The new real 20 MiB W=1 fixture holds an attachment behind a deterministic barrier,
queues actual flags, checks zero concurrent metadata clients/SQL and then observes
fresh/history progress after release. R03 and R10 fairness/cancellation coverage
also remains unchanged and passing in selected regressions.

## Public downloads, CID and local snapshots

The existing authenticated download URL and response headers stay intact. Its
internal service method now verifies disk bytes incrementally, rechecks active
source and blob identity, and returns a backpressured file stream. Valid cached
requests/downloads create zero new receiving transfers. Guessed blob IDs are not
attachment authority; guessed attachment IDs, unauthorized calls and stale
sources cannot expose stored bytes. Disabled accounts can still read valid cache.

Existing CID resolution requests the same attachment intent. Original Content-ID
matching, raster validation, sanitized `data-maildock-cid`, remote-image policy
and isolated document rendering are preserved. There is no external URL fetch or
separate CID downloader. The CID fixture retrieves a real PNG through this path,
publishes sanitized HTML through R04-B and exercises existing rendering APIs.
The established in-process `download`/CID data-URL renderer still materializes its
response bytes; constant-buffer claims here concern receiving, stored-object
verification and the streamed HTTP download. No claim is made that HTML/raster
rendering or compose serialization has constant memory independent of output.

Local upload limits and draft/outgoing MIME limits do not increase. Incoming
publication fills matching null draft references atomically; a local blob snapshot
remains accessible after remote source invalidation. Oversized outgoing MIME
still follows its own existing policy.

## Cancellation, crashes and reclamation

Connection loss, bad evidence, storage write/disk-full errors or failed digest
verification cannot mark an attachment ready. Cancellation retires the owned
socket, unwinds the generator, closes/removes private temporary files, and leaves
durable claims recoverable. Failed noncancelled reads settle through the existing
fenced failure capability. A later user request can retry a failed intent.

A process crash can leave a temporary file or a complete unregistered immutable
object. `LocalBlobStorage.reclaimWhileQuiescent` is a narrow maintenance seam for
startup/offline use **with all web/worker/storage writers stopped for the entire
call**. It walks bounded directory iterators, skips symlinks/unrecognized names,
removes private temporary UUID files and deletes only finalized keys for which
the durable blobs registry callback returns false. Every registered key is kept,
even without an incoming reference, protecting shared local snapshots. It must
never run concurrently with uploads or publication, or from a heartbeat. There
is no automatic age-based deletion or claim that crash debris has a global disk
quota. Operators must arrange this quiescent maintenance before resuming writers
when reclamation is needed; production startup wiring remains outside R12.

Crash tests reconstruct durable claimed/partial/finalized boundary states and
create a new elected coordinator/LocalBlobStorage instance. They prove restart
and takeover behavior without killing the test OS process. Separate actual TLS
cancellation and PostgreSQL response-loss relays test transport/COMMIT faults.
The inherited arbitrary-process-suspension/remote-session-retirement limitation
remains; database fencing cannot instantly retract a paused remote socket.

## Validation record

Selected completed-code coverage is **511 distinct passing scenarios**. Reruns
and filtered checks are not counted twice.

| Selection                                                                   | Result                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Complete R12, real PostgreSQL/TLS/storage/API, plus decoder/policy controls | **53/53 passed**                                                     |
| Complete R04-B cache publication regressions                                | **40/40 passed**                                                     |
| Selected regression invocation, 19 files                                    | **415/415 passed**                                                   |
| Specified R03 scheduler startup/history/cancellation cases                  | **3/3 passed**, 28 unrelated cases skipped                           |
| Final download/CID/source compatibility recheck                             | **94/94 passed** (already included above)                            |
| Final W=1 observer-accounting check after strengthening the fixture         | **1/1 passed**, 52 unrelated cases skipped (already included in R12) |

The 415 regression cases comprise R11 67, R05 active reads 21, R10 flags 29,
R03 admission 20, R04 preparation 17, R04-A publication 18, Stage 1 safety 26,
attachments 66, outgoing messages 47, attachment storage 11, attachment API 7,
attachment MIME 9, compose preparation API 10, rendering service/UI/API 24/10/5,
display selection 6, sanitizer 18 and selective provider 4.

Application/worker typecheck, repository lint, changed-supported-file Prettier
and working/staged `git diff --check` pass. SQL has no configured Prettier plugin;
its migration runs against real PostgreSQL in the focused and regression suites.
No existing security assertion was relaxed. The R03 attachment oversize negative
control now rejects above the requested 100 MiB; content remains independently
rejected above 5 MiB. Download API tests retain authentication, headers and exact
response-byte assertions while supplying a stream through the internal mock.

### Actual large-file evidence

Each fixture generates only the next 32 KiB window. Protocol counters independently
measure transferred literal bytes; HTTP-service stream reads and on-disk `stat`
confirm decoded size. An independent incremental SHA-256 of the expected bytes
matches the registered, verified physical file. Exact multiples require the extra
empty command counted below; each transfer uses exactly one IMAP client.

| File          | Literal bytes | Body FETCH commands | Largest literal | Fixture end-to-end time |
| ------------- | ------------- | ------------------- | --------------- | ----------------------- |
| 20 MiB        | 20,971,520    | 641                 | 32,768          | 2,235.88 ms             |
| 80 MiB        | 83,886,080    | 2,561               | 32,768          | 4,585.89 ms             |
| Exact 100 MiB | 104,857,600   | 3,201               | 32,768          | 5,610.12 ms             |

Those times include fixture setup, admission, transfer, storage/publication and
independent subsequent download verification; they are local deterministic results,
not a provider throughput guarantee. 100 MiB + one decoded byte is actually
transferred and rejected without ready publication. A separate 20 MiB transfer
exercises W=1/metadata/flags fairness.

Registered and independently verified digests:

- 80 MiB: `033761d859f36050455c4bcc387fe6f5383e2ac326b65a18dea83df763ff311e`.
- 100 MiB: `cd1f2a4b7893d1c70893ed2ba347e140d34bdcd2794097424083d9367fa5caa6`.

Maximum sampled ArrayBuffer growth across the three final fixtures was
49,939,176 bytes; maximum sampled transient heap growth was 23,923,528 bytes.
These include test peer/TLS/command history and GC scheduling. After yielding to
the event loop and collecting twice, maximum retained buffer growth was 167,842
bytes and maximum retained heap growth 828,592 bytes. Assertions bound retained
buffers to 4 MiB and retained heap to 8 MiB when worker GC is exposed. This is
not a process-wide RSS ceiling; the fixture retains command records whereas the
receiving worker does not retain a per-window history.

### Development failures and resolution

The initial 26-case development run passed 23 and failed three new fixture
assertions: an arbitrary 48 MiB transient ArrayBuffer ceiling for 20/100 MiB,
and a truncation injection that removed zero bytes from an already empty final
window. The injection now truncates the preceding nonempty window. The memory
check now distinguishes sampled transient allocations from retained memory,
using real event-loop/finalizer settlement plus exposed worker GC. An intermediate
82-case run and a filtered large-file check caught that an immediate GC reading
still preceded buffer finalizers; two event-loop/GC turns resolved that measurement
error. Retained bounds are fixed independently of attachment size.

Two expanded development invocations retained the same pair of new fixture
failures: asserting the second fresh opportunity before the selector ran again,
and trying to set terminal removal without its required transition certificate.
The fixture now awaits observable fresh/history progress and constructs a valid
terminal fixture state in one guarded transaction. The targeted pair then passed
2/2, followed by complete passing R12 invocations. An admission observer now
records maximum active count and asserts outside the callback, because production
diagnostic callbacks deliberately swallow observer exceptions; its final recheck
passes. None of these required a production scheduler change or relaxed authority
assertion.

All three requested existing scheduler scenarios passed on the first targeted
R12 invocation. No intermittent existing scheduler failure triggered a baseline
comparison or retry campaign. Historical R11 validation exceptions remain in its
own report and are not reclassified by R12.

### Commands and retained evidence

```text
node node_modules/vitest/vitest.mjs run tests/receiving-attachment.integration.test.ts tests/receiving-cache-publication.integration.test.ts --maxWorkers=1 --no-file-parallelism --execArgv=--expose-gc --reporter=verbose --reporter=json --outputFile.json=.r12-final.json
node node_modules/vitest/vitest.mjs run tests/receiving-content.integration.test.ts tests/receiving-active-reads.integration.test.ts tests/receiving-flags.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-safety.integration.test.ts tests/attachments.integration.test.ts tests/attachment-storage.test.ts tests/attachment-api.test.ts tests/attachment-mime.test.ts tests/compose-preparation-api.test.ts tests/outgoing-messages.integration.test.ts tests/email-rendering-api.test.ts tests/email-rendering.test.ts tests/email-rendering-ui.test.tsx tests/display-parts.test.ts tests/sanitize-email-html.test.ts tests/message-content-provider.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile.json=.r12-regressions.json
node node_modules/vitest/vitest.mjs run tests/receiving-scheduler.integration.test.ts -t "targeted startup barrier W=4 D=1|W=1 bounds simultaneous|W=1 selects due fresh" --maxWorkers=1 --no-file-parallelism
node node_modules/vitest/vitest.mjs run tests/receiving-active-reads.integration.test.ts tests/attachments.integration.test.ts tests/attachment-api.test.ts --maxWorkers=1 --no-file-parallelism
node node_modules/vitest/vitest.mjs run tests/receiving-attachment.integration.test.ts -t "holds W=1" --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

No full Dovecot benchmark or unrelated application-wide suite was run.
Test logs use ignored `.r12-*.log` local files; JSON reports are moved to a
TEMP evidence directory at completion (its path is retained in
`.r12-evidence-location.log`). Commands run with Node 24.21.0,
installed ImapFlow 2.0.6,
disposable PostgreSQL 17.6 and real LocalBlobStorage fixtures.

All Vitest runs use `--maxWorkers=1 --no-file-parallelism`. The final focused run
also uses `--execArgv=--expose-gc`. Docker settings are process-local
`DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.

## Remaining stages

R13 owns sent-copy APPEND; R14 owns MOVE/general repair, including policy for
exhausted restart attempts; R15 owns demand settlement/live membership; R16 owns
production registry/credential composition, coordinated worker cutover and VPS
measurements. Secondary continuous synchronization remains R17. No production
receiving registration, feature flag, R13 work, push, merge or PR is included.
