# R03 — Unified owned IMAP admission

2026-10-14. **PASS for isolated R03 admission**, subject to the inherited remote
retirement limitation below. Base: accepted R02
`bb42287f0c85a0f3e16f8c155e2fb83483f683cb`. Branch:
`feature/imap-sync-r03-unified-admission`.

## Typed operation contract

`ElectedReceivingCoordinator.submit` feeds the existing `ReceivingScheduler`.
Fresh/history continue through their accepted metadata turn implementation.
Additional kinds are repair, bootstrap, LIST, SELECT, STORE, MOVE, content slice,
attachment slice, APPEND, exact lookup and diagnostic. There is no second IMAP
selector, receiving worker fleet, durable work table or worker activation.

Each request captures an immutable request ID, persisted account/configuration
version and optional mailbox, or a bounded ephemeral diagnostic identity; an
absolute process-local monotonic deadline; and caller cancellation. Work class
is derived from the kind: bootstrap/repair/LIST/SELECT are maintenance, other
submitted units are user work. Submitters cannot provide priority overrides or
execution callbacks. A trusted composition registry supplies typed executors;
R03 registers no production operation bodies. An unregistered kind is rejected.

Business descriptors refer to existing R02 pending IDs. Slices additionally
capture offset and byte limit; APPEND captures the immutable MIME byte budget.
These transient descriptors are admission envelopes, not a replacement work
ledger. Durable scanning, claims and completion remain later capabilities.

At most 128 pending plus active requests are retained, with duplicate live
request IDs rejected. Envelopes are capped at 20 KiB, diagnostic connection data
at 16 KiB, and IDs at 64 characters (persisted identities use UUIDs).
Deadlines include queue wait and cannot exceed ten seconds from submission.
Caller-owned input is cloned; captured identity/connection data is frozen.

## Priority and fairness

Runnable startup accounts receive fresh admission before history or submitted
work. Existing account rotation, backoff, wake generation, history age, oldest
eligible history/tie rotation, fresh wait guard, protected-active exclusion and
no consecutive protected exception policy remain intact.

At the existing current-priority boundary, eligible queued units rotate with
fresh work: when both are available, at most one submitted unit is granted
between metadata opportunities. Safe aged protected history precedes this
rotation and is also considered when only submitted demand competes with it.
FIFO eligible requests skip identities currently occupied by either metadata
or submitted operations. Maintenance uses the same bounded opportunities, so a
finite accepted maintenance request cannot be overtaken by later user requests.

A content/attachment descriptor represents one validated slice of at most
256 KiB. It settles and releases its allocation before a continuation is newly
submitted. The socket response/literal budget is bounded; parsing, decoding,
verified slice continuation and storage are R11/R12. APPEND is one
non-preemptible unit, with the existing default 25 MiB MIME ceiling, admitted
payload-size check and common deadline/cancellation. Later composition must
apply any stricter configured outgoing policy before submission. R03 does not
implement an upload or claim that declared MIME size verifies a durable blob.

These are admission-opportunity guarantees under the existing health and
fresh-age predicates, not a latency guarantee when a provider fails, a handler
does not settle, SQL is saturated or ownership repeatedly changes.

## Resources and control headroom

Elected/typed admission uses `min(W, 2D-1)` occupied data allocations. The same
allocation includes network activity, handler settlement and local receiving
SQL retirement. Persisted accounts share C=1 across metadata and all submitted
kinds, including saved/edited-saved diagnostics and pre-mailbox bootstrap.
Ephemeral identities consume W and their own serial identity slot.

Every data unit may have at most one executing/queued SQL scope. One serialized
coordinator control gateway uses the remaining aggregate position, including
acquisition/membership reconstruction, authority/configuration validation,
renewal and conditional release. Renewal calls coalesce and receive priority
over queued validation/reconstruction. The bounded control request queue holds
descriptors only; at most one of them is admitted to the existing SQL executor.
Publication uses the data allocation. Future membership refresh must use this
same gateway; periodic membership/credential features are still R09 work.

D executing and D waiting remain independent executor limits. In particular,
D=1 admits one data allocation and can queue one control request; it **does not
guarantee an immediately running control connection**. Control wait is inside
its existing two-second/lease budget. A missed renewal deadline loses ownership
and aborts admission; capacity is never increased to rescue renewal.

The original metadata-only Stage 3B fixtures have no coordinator control request
and retain their accepted `min(W,2D)` profile. All elected lifetimes, including
ones without injected operation bodies, reserve control headroom. The executor
change is an additive read-only executing/waiting snapshot; SQL revocation,
transport retirement, authority and deferred COMMIT checks are unchanged.

## Owner-only construction and retirement

Only the elected coordinator exposes submitted admission. Followers reject it
without loading configuration or constructing clients, and remain eligible for
future election. Lost/stopped lifetimes cannot restart. Each selected unit
renews authority, validates the PostgreSQL term and enabled account/captured
configuration/optional mailbox lifecycle in a short bounded scope, then checks
the local lifetime after the scope settles and before constructing its client.
Metadata also validates the captured acquisition configuration and has a
one-construction guarded factory.

Submitted helpers receive one guarded method-only client facade, not a provider
factory or raw socket. Private client properties are absent even through
JavaScript property-descriptor reflection. Reconnect, additional construction via the context, raw transport
access, late method calls and late SQL admission are rejected. The composition
factory and handlers are trusted injected dependencies, not a JavaScript sandbox
against code importing its own network library. Legacy provider/SMTP paths and
their pools are unchanged and are not registered as alternative enrolled routes.

SQL publication cannot begin until `retireSocket()` has actually settled; a
second simultaneous SQL scope is rejected. No receiving network connection is
held inside that SQL transaction. Detached provider promises/SQL are rejected
and awaited during retirement. Cancellation and expiry revoke the operation
signal and start socket retirement, but do not resolve its request or release
W/C before the handler, socket retirement and issued local SQL settle.

Queued cancellation removes only its own descriptor. After awaited renewal,
the selector checks that the selected request still exists; cancellation cannot
splice another request or revive the removed one. Shutdown rejects pending
units, aborts active units and waits for settlement before conditional lease
release. A replacement term never reuses an old client/context.

As in accepted Stage 4B, arbitrary process suspension can retain a remote socket
until the process/server resumes or closes it. PostgreSQL fencing does not
instantly revoke a remote session; strict cross-process simultaneous remote W/C
during suspension is not claimed. Actual authority locks and deferred COMMIT
checks, rather than local retirement observations, order database publication.

## R09 diagnostic RPC contract

`ReceivingDiagnosticRequest` and `ElectedReceivingCoordinator.diagnose` are the
internal typed boundary. Request fields are request ID, expected owner
actor/generation, persisted account/configuration/optional mailbox or ephemeral
identity, monotonic deadline, disconnect cancellation, and optional in-memory
connection override. A saved test without override uses the DB-only operation
configuration loader; edited-saved input still uses the saved account C slot.
An unsaved test requires a connection override and creates no account.

Expected R09 HTTP behavior (transport is **not implemented** here):

- Authenticated internal HTTP RPC over TLS or an equivalently protected local
  channel, routed to a term-bound private endpoint advertised by the existing
  coordinator. Followers refuse execution. Advertisement/cleanup must match
  actor/generation and carries no credentials.
- A bounded request contains `requestId`, `expectedOwner` (generation encoded as
  a decimal string), a saved/ephemeral target, captured configuration version,
  optional edited/unsaved connection, expiry and remaining budget. R09 validates
  wire types/authentication/size before admission and converts the remaining
  lifetime to this process's monotonic deadline without extending the caller's
  original expiry. Process-local `performance.now()` values are never sent
  between hosts as absolute timestamps.
- Caller disconnect, explicit cancellation, expiry and owner loss abort the
  in-memory request. Cancellation is not a durable row or queue message. Request
  or response loss returns retryable unavailable/unknown; there is no automatic
  replay or direct web IMAP fallback, even after ownership moves.
- A successful admission promise means its executor and resources settled,
  not that a diagnostic succeeded. The later diagnostic handler may return the
  typed `{success:true}` or `{success:false,category}` result. R03 canonicalizes
  this response and omits arbitrary server messages/additional fields. Void
  fixture completion is not a successful diagnostic result.
- HTTP responses should carry only request/term identity and bounded sanitized
  outcome: completed diagnostic result, unavailable, cancelled or expired.
  They must exclude credentials, raw provider exceptions and unsaved input.
  Transport authentication, endpoint advertising and response mapping are R09.
- No unsaved credentials enter wakes, ordinary jobs or database rows. Local
  descriptor references are discarded at cancellation/settlement. Diagnostic
  success confers no epoch/frontier/result publication authority. Edited-saved
  success cannot verify persisted configuration; exact saved status publication
  needs the later owner/configuration CAS. SMTP diagnostics remain independent.

## Independent test evidence and validation

Fixtures use disposable PostgreSQL 17.6, all migrations, an ordinary database
owner, actual election/receiving executor and an independent postgres.js reader.
Typed operation executors and retirement are deterministic fixtures; metadata
and the two-process diagnostic fixture also use scripted TLS IMAP with the
installed adapter. No application database/account or external provider is used.

The R03 suite exercises all eleven additional kinds under W=1/2/4 and D=1/2;
C exclusion across kinds/accounts; bootstrap without a mailbox; ephemeral
no-row diagnostics; saved diagnostic startup/C exclusion; stale configuration,
disabled lifecycle and expired/follower construction rejection; captured RPC
term/result; bounded slice/APPEND/unregistered-kind rejection; raw socket,
reconnect and late callback negative controls; queued cancellation during locked
renewal; active cancellation/deadline/shutdown retirement and takeover; D=1
missed control deadline; D=2 publication saturation with independently observed
two PostgreSQL transactions and two executor waiters; and continuous fresh plus
24 sequential user slices with repeated history progress. Barriers control
cancellation and ownership races. Small polling waits observe explicit states.

Selected regression run: **seven files / 123 tests passed**, including Stage
3B W=1/2/4, Stage 4B fencing/election (13 tests, including the new two-process
R03 diagnostic scenario), Stage 1 safety/retirement, coordinator/wakes and the
26 R02 intent/negative-control tests. The combined development invocation also
ran the then-19-test R03 file and recorded the explained fixture failure below.
Final focused R03: **20/20 passed**, exit 0, 31.42 seconds. Across that run
and the seven successful regression files, **143 distinct selected tests passed
in eight files**. The final R03 source includes iterator retirement and the
method-only facade reflection negative control. Application/worker typecheck,
repository lint, all ten changed-file formatting checks and `git diff --check`
passed on the final source. Local evidence is retained in `$env:TEMP/maildock-r03-validation.log` and
`$env:TEMP/maildock-r03-final-focused.log`.

Commands used:

```text
pnpm exec vitest run tests/receiving-admission.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-coordinator.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-wakes.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check <the ten changed files>
git diff --check
```

Windows test processes used the Linux Docker engine with
`DOCKER_HOST=npipe:////.\pipe\dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`, following the
accepted R02 fixture environment. No machine-wide Docker setting was changed.

The development combined run recorded 141 passes/one R03 fixture failure:
24 prequeued slices shared the same nine-second deadline and later pending
requests correctly expired. The fixture now submits each continuation at the
previous unit's settlement with its own deadline; no production or regression
deadline was increased. Earlier development fixture corrections supplied valid
encrypted credential rows, changed configuration via the actual version trigger
and waited for both SQL callbacks before counting PostgreSQL transactions.

No historical Stage 3B teardown timeout reproduced in the selected regression
run. No test/authority check was weakened, no open-ended retry campaign or Stage
3C Dovecot benchmark ran, and no unrelated suite was selected.

## Remaining boundaries

R04 owns fenced business claims/results and multi-mailbox publication. R05–R08
own epoch/read/account/topology/lifecycle features. R09 owns credential refresh,
live membership, HTTP transport, endpoint advertising and web wiring. R10–R14
own STORE/MOVE, MIME/content, attachment and sent-copy remote bodies/results.
R15 owns durable pending/due settlement integration; R16 owns the worker cutover.

`worker-process.ts`, worker registrations, SQL migrations and legacy business
operation bodies are unchanged. No feature flag, push, merge or PR is included.
**Stop after R03.**
