# R17 — Selectable IMAP mailbox synchronization

Date: 2026-10-16. Base: `48b5c6c277a25d58d5bdb166f503054052568484`.
Branch: `feature/imap-sync-r17-secondary-mailboxes`.

Final decision: **PARTIAL**, with exact validation and limitations below.
R16 remains **PARTIAL**; its report and history are unchanged. This is R17 only,
not a real Gmail acceptance or an R18 cleanup/release claim.

## Architecture audit and reused mechanisms

The starting branch and HEAD matched the requested R16 baseline, the commit was
available locally and the working tree was clean. The new branch was created
directly from that commit, without rewriting history. The capability contracts,
revised plan and R07/R13/R14/R15/R16 reports were checked against the production
implementation. The implementation plan was supplied before editing source.

| Mechanism at R16        | Audit and R17 treatment                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIST/discovery          | R07's complete, correlated, bounded namespace discovery already preserves UUIDs/stable provider IDs, lifecycle and manual mappings. R16 already dispatches requested LIST through the elected operation registry. R17 also makes successful topology eligible for another LIST after 60 seconds, through those same heartbeat/keyset opportunities. |
| Identity/enrollment     | R06 recovery and metadata selection were hardcoded to INBOX; R07 could separately enroll a selected destination. Recovery now resolves the captured mailbox UUID to its exact active path/provider ID under the existing locks. INBOX retains its existing bootstrap and SELECT behavior.                                                           |
| Roles/settings          | Existing `mailbox_roles.source` distinguishes `manual` and `special_use`. Existing role service/API/settings, topology capture and mutation role fences are reused. No role-name heuristics or UI redesign.                                                                                                                                         |
| Durable demand          | Existing account/mailbox due timestamps and generations, original business intents and per-mailbox F/E/R remain authoritative. Mailbox demand now reaches ordinary secondary receiving instead of being retained as deferred.                                                                                                                       |
| Bootstrap/history/live  | R06 bounded windows and R15 exact known-placement observation already provided the required evidence/publication machinery. Their turn now operates on each selectable folder.                                                                                                                                                                      |
| Publication/reads       | R04 executor, account/source/epoch/revision/COMMIT fences and R05 active-source projection already apply to arbitrary enrolled mailboxes. They remain the only publication/read authority.                                                                                                                                                          |
| MOVE/Sent               | R14 already settles accepted source removal, optionally creates a COPYUID-backed destination, and retains missing-UID uncertainty/demand. R13 already provides immutable APPEND and digest-verified read-only lookup. Ordinary secondary synchronization now supplies missing destination metadata.                                                 |
| W/C/D                   | One existing shared selector, elected coordinator and receiving executor. Metadata candidates were previously one INBOX per account; they now include bounded per-mailbox scheduling state with account-wide exclusion. R16's history/SQL admission limits remain.                                                                                  |
| Lifecycle/credentials   | R08/R09 account configuration and lifecycle bindings, owned credential resolution, disable/remove and takeover checks are reused for every selected folder. No per-folder credential service.                                                                                                                                                       |
| Production registration | The normal worker still registers one receiving coordinator with the existing typed operations. SMTP/outgoing remains independent; no legacy receiving executor is registered.                                                                                                                                                                      |

## Implementation

### Discovery, eligibility and mapping

Membership reads at most 129 account rows (128 plus the existing overflow
sentinel). Each account includes at most 128 secondary descriptors as an overflow
check; more than 127 secondaries plus its INBOX scheduling slot is rejected.
The existing R07 bound of 128 retained/observed topology identities remains.
Nonselectable/missing mailboxes are excluded. Ordinary/provider-specific/Gmail
label folders do not need a semantic role to enter receiving.

Periodic LIST uses the existing 32-account keyset, heartbeat, coalescing and typed
operation admission. It is not a new timer, watcher, queue or poller. The 60-second
eligibility threshold is not a promise that every topology change is visible in
60 seconds: account-page rotation, admission, failure/backoff and publication add
latency. A failed/incomplete/oversized LIST still publishes no partial inventory.

Manual mappings remain above unambiguous SPECIAL-USE metadata. Missing or
nonselectable manual destinations remain explicitly unavailable; discovery does
not silently replace the mapping. Changing a mapping does not change UIDVALIDITY,
erase messages, rebind caches or restart history. MOVE/APPEND retain their frozen
role/path/attempt checks. Names alone never establish Archive, Sent or another
role, including on Gmail.

### Fresh windows, history and observation

The existing single turn recovers its mailbox state before I/O. A selected
secondary identity's first bounded recent window gets a current-priority turn;
older windows then use ordinary/protected history selection. Secondary interval
windows use 32 UIDs within the unchanged 128-UID adapter ceiling. INBOX keeps its
existing window profile. Live observations retain exact next pages of at most
128 current-epoch/current-binding placement UIDs and durable R, including empty
wrap and request-generation CAS.

Every metadata operation uses one owned socket, retires it before publication,
and keeps the existing absolute operation/history/SQL deadlines. Secondary
EXAMINE uses the exact discovered path, suppressing the adapter's implicit LIST
and personal-namespace prefix insertion on that single-use client. Selected
MAILBOXID must agree with stored provider identity when present. All raw numeric,
byte, count, completion and UID-evidence checks remain in force.

The shared selector rotates accounts and their mailboxes. INBOX gets the first
current opportunity; runnable secondary current work is interleaved even while
INBOX remains due. History retains its independent age/protection, health/latency
guards and R16 admission correction. Active metadata and typed operations use
the same account identity exclusion through retirement. Failures retain demand
and per-mailbox exponential backoff. There are no autonomous folder workers.

Every admission still validates DB-clock ownership through the serialized
control gateway. During the first third of a live lease this uses compatible
SHARE validation; the existing heartbeat, or an admission after that threshold,
performs renewal. This avoids issuing a conflicting exclusive renewal for every
folder operation while other accounts publish. Validation failure still retires
the owner. W, C=1, D, control headroom and all logical-COMMIT checks are unchanged.
Control failures now have an explicit diagnostic in the ordinary worker log.

Migration 0054 generalizes only R15's empty-observation and removed-command-
reference functions beyond their former INBOX path restriction. Their exact
scope, state, generation, owner and deferred certificates remain unchanged.
It adds no table, queue, storage identity or alternative publication authority.

### Independent placements and immutable content

Account/mailbox/UIDVALIDITY/UID/configuration remain the placement identity. The
same UID and Message-ID in multiple folders produce independent message/placement
rows. Gmail-like labels use this generic IMAP behavior; no Gmail API or heuristic
cross-folder deduplication was added.

A known COPYUID destination may already share the source message through R14's
proven mapping. Ordinary interval rediscovery updates that exact placement's
flags without rewriting its immutable shared envelope/MIME/cache source from a
single-mailbox scope. New placements still publish complete metadata and MIME
descriptors normally. Epoch/configuration replacement retains physical old rows
but hides them through the unchanged active-source reads/search/cache rules.

The label-overlap workload exposed redundant conversation rebuilding on every
duplicate Message-ID. Migration 0054 preserves header-edit rebuilds and collision
retraction when an existing reference actually used that ID. A duplicate ID with
no such incoming reference needs no component rebuild. Conversation grouping is
not message/placement identity; the existing ambiguity/late-collision tests remain.

### MOVE, APPEND and the application

Accepted MOVE results are not replayed to find a destination. COPYUID-backed
placements are reused; missing-COPYUID destinations are independently discovered
through normal bounded receiving, without fabricating a UID or unsafe Message-ID
link. A settled command can retain `awaiting_uid` provenance even after the
destination is visible: visibility does not prove an exact source/destination link.

APPENDUID and digest-verified read-only lookup remain R13's authority. Saved copies
awaiting metadata no longer spend their three lookup observations while ordinary
receiving has not yet published a candidate. A Message-ID candidate only enables
the existing read-only lookup; exact UID constraints/full immutable MIME digest
verification still decide linkage/settlement. Ambiguous matches remain unresolved.
Server-copy policy never invokes a Maildock APPEND.

Existing folder/message/search/counter queries keep their active-source projection.
Secondary folder views now expose `receiving.mode = mailbox`, historical completion
and fresh coverage; refresh is enabled. Existing UI copy describes older-mail
progress for either INBOX or secondary folders. Incomplete coverage is not called
complete. Legacy/deferred compatibility branches are retained for later cleanup.
Nonselectable/missing folders receive no live receiving-progress object, so a
container does not appear to have perpetual message history in progress.

## Validation evidence

### Closed-source focused controls

The final focused run completed **99/99 tests in seven files**, without skips,
in 302.37 seconds. It includes all 12 new real PostgreSQL/TLS R17 integration
cases, R03 election, R07 topology, R05 active reads, the actual production-process
test, all three SQL/fairness controls and a native fixture cleanup regression.

The two new perpetual-demand controls originally failed: independent folder
cursors were coupled, starving a secondary folder (zero turns), and INBOX got
only one opportunity. Account rotation now precedes each account's independent
INBOX/secondary/history selection. The final control run passed 3/3, retaining
the original R16 admission regression and asserting C=1/resource retirement.
A separate startup case proves that INBOX can receive again before all 20
secondary folders complete their first opportunity.

During validation a mapping/restart test completed its body but hung in fixture
cleanup. The TLS fixture tracked secure connections only; an accepted TCP socket
waiting for a TLS handshake escaped cleanup. A new raw TCP control failed before
the fix and passed afterwards. The fixture now owns accepted sockets immediately.
Production transport, deadlines and timeout assertions were not changed for this
fix. The final mapping/restart case completed in 3.976 seconds.

### Development failures and baseline comparison

The development full run finished **2030 passed / 13 failed / 2043 total** in
133 files, with one unhandled rejection, in 2466.90 seconds. Source was still
changing during that run; it is retained as failed development evidence. Failures
were the obsolete R07 secondary wire fixture; R03/R10/R11 SELECT barriers after
an initially over-generalized EXAMINE change; the two new rotation controls;
R03's blocked-renewal fixture; R15 idle flags; scheduler W1 history-return and
healthy-versus-hung ordering; R13 mismatched APPENDUID pending-versus-uncertain;
R04 lease-expiry publication timeout; and MFA expired-session status 200 versus 403. The unhandled rejection accompanied the blocked-renewal assertion. Restoring
the original INBOX SELECT and explicitly initiating the tested renewal preserved
the original transport/cancellation assertions. Six selected diagnostic failure
controls passed afterwards, but their 210 unselected cases are not acceptance
coverage. The first official focused run was 97/98, failing only the subsequently
proven raw-TCP fixture cleanup; it is not replaced in the evidence record.

A bounded comparison ran all 107 cases in the unchanged R15 demand-settlement,
scheduler and MFA-management files, serially, first on an archive of accepted
`48b5c6c`, then on R17. All three test files were byte-identical between trees;
dependencies and worker count were shared. No Compose/build workload ran alongside
either selection. The baseline finished **103 passed / 4 failed**, 338.62 seconds:

- W4 unavailable-account startup barrier, plus its 120-second cleanup hook;
- W1 complete history E remained 129 rather than 1;
- W1 returning-history fresh barrier;
- healthy completion occurred 54.285 ms after the hung-account error.

All 37 R15 and 39 MFA tests passed in that baseline selection. These observations
establish baseline variability; they do not classify any later R17 failure as
harmless or retroactively resolve R16's release decision.

The R17 comparison finished **104 passed / 3 failed**, 199.76 seconds. The failures
were the same W1 E=129, W1 returning-history barrier and healthy-versus-hung
ordering cases seen on the baseline; the latter missed by 57.045 ms. All 37 R15
and 39 MFA tests passed. The W4 startup case passed on R17. This is explicit
comparison evidence for unresolved timing-sensitive validation, not a passing
107-case run. No retry, assertion change or timeout increase was used to remove
these failures.

### Complete closed-production-source regression

The complete serial run finished **2041 passed / 5 failed / 2046 total** in
**134 files** (131 passed, three failed), with **zero skipped tests**, in
2034.92 seconds. There was no concurrent Compose, build or other test workload.
Production behavior was unchanged during and after this run (final migration EOF
whitespace cleanup changed no SQL statement). It is a failed full run;
focused controls are not added to its passing count.

The exact failures were:

1. Scheduler W1 returning-history fresh barrier (also failed on the baseline).
2. Scheduler healthy-versus-hung ordering, 9.462 ms late (also failed on the
   baseline; the health gate itself passed).
3. R04 claim phase D1: executor executing count 1 versus expected 0 at line 396.
4. The same R04 count assertion at D2. The preceding assertions for one client,
   one STORE, succeeded command, exact revision/frontiers and zero active
   scheduler operations passed.
5. R11 2 MiB HTML afterEach exceeded its unchanged 120-second limit during
   coordinator stop. The body published/validated the content in 2178.58 ms.

All 12 R17 cases passed in this full run, including quiet visibility 1874.35 ms
and six large histories across two accounts in 25.623 seconds. R07 topology 45,
R03 election 15/admission 20, R06 bootstrap 31, R15 demand/observations 37,
R13 Sent 35, R14 MOVE 45, R04 bounded publication 65/publication 18, R05 reads 22,
R08 lifecycle 20, R09 credentials 37, attachments 53, cache publication 41 and
conversation collision/grouping 28 all passed. MFA-management passed all 39.

An immediate three-case diagnostic on the unchanged baseline passed all three;
the same selection on R17 repeated both R04 count failures while R11 passed.
Each selected run had 81 unselected cases; it is diagnostic evidence only.
The R11 hook failure therefore remains unresolved by that passing selection.

Public-executor call-stack instrumentation then identified the outstanding R04
scope as `admissionAuthority -> beforeAdmission -> ReceivingScheduler.run`: the
next secondary mailbox's control validation, not the settled command's SQL scope.
The instrumentation reproduced both failures and was removed. Only these two
phase-isolation cases now finish both startup metadata opportunities before the
command, using an explicit failing metadata factory and a 60-second fixture-only
retry backoff, and disable automatic flag dispatch so their explicit command is
the only mutation under test. The installed typed-operation client, actual
PostgreSQL claim/result, all existing resource/revision/retirement assertions and
all test/operation/SQL deadlines are unchanged. Other claim-phase cases keep their
original concurrent fixture. This is a test fixture correction after the full
run, not a production change or a passing replacement full-suite total.

The entire unchanged R11 file passed **67/67 on the baseline**, 95.84 seconds.
After the R04 fixture correction, the entire two-file R04/R11 control passed
**84/84**, no skips, in 112.63 seconds. No R11 code, fixture, deadline or assertion
was changed. The failed full-run R11 shutdown hook remains an inconclusive
resource-retirement observation: these passing controls do not prove its cause
or eliminate it from acceptance evidence. There is no demonstrated remaining
data-loss, epoch/ownership or repeated-mutation defect, but validation is not
fully green.

### Normal production Compose

The definitive run used isolated project `maildock-r17-complete`, fresh volumes,
the normal entrypoint and compiled worker, W=2/C=1/D=2, and all 55 migrations.
Built image and running container image both identified
`sha256:6de949ec3b55d3ea589c85fce4b5bd4e1a2037c3e9f3dddb8c817a6f5f54df35`.
Production behavior was closed before this build; later changes concern tests,
documentation and migration EOF whitespace only. Development Compose attempts
are not combined with these results.

| Phase                 | Result / measured duration                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Initial sync          | PASS; 3124 placements, 24 selectable folders, 11.971 s                                                 |
| Quiet external change | PASS; visible after 42.744 s without wake                                                              |
| MOVE                  | PASS; 27.363 s, with/without COPYUID, manual Archive `Przechowalnia`                                   |
| Sent                  | PASS; 24.016 s, manual Sent `Projects`, APPENDUID and digest-only reconciliation                       |
| Reader/search         | PASS; 8.849 s, secondary MIME body, body search, cross-folder rejection and authenticated render 200   |
| Additional topology   | PASS; 80 new folders, 104 selectable total, visible with completed history after 71.132 s without wake |
| Restart               | PASS; retained history/manual roles/new elected owner, 1.024 s check                                   |
| Ingress               | PASS; health 200/200, unauthenticated account API 401, 0.091 s                                         |

The peer observed at most two simultaneous connections globally and one per
account. Three SMTP submissions produced exactly two Maildock APPENDs; server-copy
policy added no APPEND. Exactly two MOVEs occurred. Mutation counters stayed
unchanged across restart. Before final shutdown, all 104 enrolled folders had
completed history, with 3127 current placements and owner generation 2.

Worker RSS samples were 400.91 MiB after sync and 384.44 MiB with 104 folders;
the observed process high-water mark was 447.21 MiB. These are real process
measurements, not a promised small-VPS memory ceiling. Explicitly labelled
inspector-GC retained-heap samples were 60.54 MiB at 24 folders and 63.28 MiB at
104 folders (about 2.74 MiB increase). GC sampling is diagnostic and is not normal
worker behavior. This bounded workload supports that idle folder descriptors do
not retain full histories; it does not establish an asymptotic memory guarantee.
The database measured 20,477,631 bytes; cached blobs occupied 36 KiB in this run.

Compose stop completed in 814.610 ms. The application container exited **143**;
Compose itself returned 0. Worker logs recorded SIGTERM and jobs stopped for both
restart and final stop, with no receiving control errors. After stop the owner
lease was non-live, receiving database backends and peer connections were zero.
Containers and the isolated project network were removed; evidence/volumes were
retained. No unrelated Docker workloads were removed.

Raw local logs are outside the checkout under the `maildock-r17-*` TEMP paths;
definitive Compose logs are in `maildock-r17-production/complete`. Generated
deployment/setup secrets are not committed. The curated evidence manifest records
measurements and report/source hashes without credentials or session cookies.

## Remaining limits and decision

Final application/worker TypeScript checks, ESLint, changed-file Prettier and
Git whitespace checks passed. The normal production image build passed; migrations
were applied against real PostgreSQL in tests and the fresh Compose database.
No assertion or operation/SQL/test deadline was relaxed to obtain these results.

Real Gmail/provider acceptance remains the next activity. Generic deterministic
IMAP labels are not proof of real Gmail compatibility. Existing topology,
metadata, attachment, operation and new-install enrollment limits remain; no
populated legacy migration, retention cleanup, QRESYNC checkpoint optimization,
per-folder push/SLA or R18 work is included.

R16's two unresolved broad-run failures remain historical evidence: the first
R15 quiet-observation barrier and the scheduler health-gate COMMIT timeout. A
passing later selection does not retroactively resolve R16 or replace a failed
complete R17 run.

**Decision: PARTIAL.** All new mailbox functionality and the normal production
Compose workload passed. Full-repository validation did not: the two reproduced
baseline scheduler failures and the R11 shutdown hook remain unresolved evidence.
The R04 fixture defect was diagnosed and corrected without weakening assertions;
its complete control passed, but there was no subsequent complete repository run.
No PASS is inferred by adding separate runs. Further diagnosis of those timing/
retirement observations and real Gmail acceptance remain required. R18 has not
been started; no push, merge or pull request was performed.
