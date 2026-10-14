# R04 — Operation-specific fenced publication

2026-10-14. **BLOCKED at the R04-A / R03 operation-phase boundary.**
R04-A contains a tested, isolated SQL/API implementation, but is **PARTIAL** as
an owner-execution checkpoint. R04-B and R04-C were not started, following the
request to stop on a fundamental unresolved safety issue in an earlier
checkpoint. This report does not accept R04 or authorize worker activation.

Base: accepted R03 `4193096cceb6194425da6e63be7108dd78231935`.
Branch: `feature/imap-sync-r04-fenced-publication`.
Checkpoint commit:
`634eb30f70daac6069dd42cc6cc6044327e33241`
(`feat(receiving): add isolated R04-A attempt publication and retain phase blocker`).
The final report is a separate documentation commit. No B/C checkpoint commits
exist. No push, merge, PR, remote operation body or subsequent roadmap stage
was performed.

## Reproduced admission blocker

The accepted `runReceivingOperation` constructs its single owned client before
invoking the trusted handler. Its only handler SQL entry point,
`context.transaction`, requires `socketSettled`, which is set only by completion
of `retireSocket`. Retirement permanently rejects all subsequent client methods,
including `connect`, and reconnect/additional client construction is forbidden.

Consequently, the required sequence cannot be expressed through that context:

```text
durable fenced claim -> remote execution -> socket retirement -> fenced result
```

The new passing negative control
`BLOCKER: R03 cannot durably claim before wire execution through its owned context`
uses the actual operation implementation, installed ImapFlow client, receiving
executor, migrated PostgreSQL functions and an independent reader. It proves:

1. Claim through `context.transaction` before retirement throws
   `Receiving SQL requires retired socket and serial scope`; the command remains
   pending.
2. After actual client retirement, the same SQL claim commits and the independent
   reader observes executing plus its exact attempt ID.
3. Both a subsequent flag mutation and `connect` throw
   `Owned socket is retired or requires retireSocket`.

The client is never connected; no STORE, MOVE, APPEND, BODY.PEEK or provider
request runs. SQL authority is not mocked. The test deliberately leaves the
fixture command executing to demonstrate that a durable claim does not confer
permission to revive the retired client.

Calling `ReceivingPublication` through an unrelated executor before admission
would bypass the operation's lifetime, serial SQL scope and W/C allocation.
Retiring and replacing its client would bypass accepted one-construction and
retirement guarantees. Neither workaround was implemented. R03's guards and
operation implementation are unchanged.

Required follow-up is a narrowly specified pre-network claim/recovery phase
inside the existing owner admission allocation. It must complete SQL before
network I/O, recover an unknown claim acknowledgement before constructing or
using the client, and revalidate cancellation, ownership, configuration and
lifecycle after that phase. Publication must still require actual socket
retirement, with no simultaneous SQL/network work or increased capacity. The
safe phase transition and its races remain unimplemented; downstream execution
must not depend on this checkpoint as complete.

## Implemented isolated SQL capabilities

Append-only migration `0039_receiving_intent_attempts.sql` adds a nullable
`receiving_attempt` JSON value to the three existing intent/cache tables. There
is no new business ledger, general permission framework, unrestricted writer,
security-definer function or runtime registration. The matching schema snapshot
changes only `mail_accounts`, `message_commands`, `message_contents` and
`message_attachments`.

| Capability                           | Permitted fields and restrictions                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maildock_receiving_attempt_claim`   | One existing pending command/content/attachment; writes its attempt marker, executing/fetching status, cleared error and update time. Commands additionally increment bounded attempts (maximum three) and record start time. Flag commands only; MOVE claims are rejected pending R04-C. No payload, placement or frontier change.                                                                        |
| `maildock_receiving_attempt_failure` | Exact claimed attempt to failed, with terminal marker, bounded diagnostic category and update time; commands also record completion time. No canonical rollback. `uncertain_remote_execution` applies only to commands and records durable repair demand atomically; read intents use `failed_remote_read` or local pre-execution failure.                                                                 |
| `maildock_receiving_command_result`  | One exact executing flag-command attempt plus complete matching epoch/UID evidence. Desired Seen/Flagged state must be evidenced; flags are bounded to 128 entries / 64 KiB evidence, duplicate flags and stale MODSEQ are rejected. Writes only flags, MODSEQ and update time on the original placement, plus command success/error/time/terminal marker. No envelope, MIME, UID or destination mutation. |
| `maildock_receiving_attempt_recover` | Read-only recovery under the same conflicting locks, returning current receiving state and the original intent row. A failed recovery remains unresolved. It never reclaims or resends an executing operation.                                                                                                                                                                                             |

`ReceivingPublication` provides typed isolated claim, failure, STORE result and
recovery entry points through the existing executor. It captures bounded
evidence before the first await and creates a fresh UUID for each application
claim. It is not wired into an admitted handler or application worker.

Exact old/new row comparisons gate each capability's internal write. Subsequent
mixed canonical writes in the same attempt transaction are rejected. Attempt
transactions cannot modify epoch, configuration binding or F/E/R. Existing R02
request producers cannot create or alter an attempt marker; they retain the
original request allowlists and demand behavior. Retrying failed content retains
the old terminal marker until a fresh owner claim replaces it.

## Authority, revision and lifetime

Lock order is coordinator SHARE, account SHARE, mailbox UPDATE, receiving state
UPDATE, then the intent UPDATE; STORE results additionally lock the original
placement. The common conflicting mailbox lock serializes these paths with R02
requests and Stage 1 metadata. No account SHARE lock is upgraded to record
demand. Claims and settlements are separate short database transactions; no
filesystem, decoding, transfer or network work occurs inside them.

Each claim/failure/result compares actor/generation, database lease time, enabled
account, exact epoch/revision/F/E/R, current configuration binding, active source
mailbox/message/account/UID and selected path. Each successful mutation increments
the source revision once. F/E/R and epoch remain unchanged.

A claim marker freezes UUID, operation kind, original actor/generation, account,
mailbox/path, epoch/UID, configuration, claim revision and lifecycle version.
Matching settlements also validate the current captured lifecycle. A minimal
monotonic `mail_accounts.receiving_lifecycle_version` increments only on enable/
disable transitions and rejects manual edits. This closes disable/re-enable ABA
for these new SQL attempts; it does not implement R08 account service
orchestration or R09 membership/admission capture.

The original deferred COMMIT validation and logical point L remain. Attempt
transactions additionally compare configuration and captured lifecycle at
COMMIT, including changes made within that transaction. The final database-clock
lease comparison remains after authority checks, with conflicting locks held
through transaction completion (D15 Variant A). A new deferred command UPDATE
trigger makes command-only writes participate in that validation.

R02's fixture-only executing-row seed now flushes deferred events with
`SET CONSTRAINTS ALL IMMEDIATE` before re-enabling its guard; this is needed
because PostgreSQL rejects ALTER TABLE with pending deferred events. No existing
authority assertion or timeout was removed or relaxed.

## Attempt uncertainty

Executing/fetching is not permission to execute again. Duplicate claims fail,
and a terminal or replaced attempt cannot be settled by its old UUID. Local
pre-execution failure and uncertain remote mutation use distinct durable marker
phases/diagnostics. The latter settles failed-with-uncertainty and requests repair
without claiming a remote rollback or restoring old canonical flags.

The existing executor reports an unknown transaction/COMMIT outcome through
`ReceivingUnresolvedError`. Locked recovery returns the durable revision and
intent together. The real reply-loss fixture drops the actual COMMIT response,
recovers the committed fetching attempt and rejects another execution claim.
Admission-level enforcement of claim recovery before any socket construction,
and takeover reconciliation/adoption of an old executing mutation, remain part
of the unresolved phase boundary and later operation integration. This isolated
API is not advertised as a complete retry controller.

## PostgreSQL evidence and validation

Fixtures use disposable PostgreSQL 17.6, an ordinary non-superuser database owner,
all actual migrations and guards, and independent postgres.js readers. They do
not use an application database or replace SQL negative controls with mocks.

Final focused publication file: **18/18 passed**, including the admission blocker
negative control. Covered controls include concurrent claims for all three
intent kinds; matching failures and duplicate callbacks; mixed forbidden writes
rolling back; wrong attempt/actor/generation/state/configuration/kind; late
content failure against a newer attempt; expired authority; changed account
configuration; disable/re-enable ABA; uncertainty without canonical rollback;
desired STORE evidence; expiry before L on a claim; and actual lost COMMIT reply
followed by locked recovery.

Selected validation:

| Run                                                      | Result                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Publication, R02 boundary, Stage 1 safety and retirement | 73/73 passed across four files (publication had 17 cases before adding the final blocker case).       |
| Final publication, R03 admission and election            | 51/51 passed across three files (18 publication, 20 admission, 13 election).                          |
| Application and worker typecheck                         | Passed, including after the final serializer type cleanup.                                            |
| Repository lint                                          | Passed.                                                                                               |
| Changed supported-file Prettier checks                   | Passed, including schema, API, both test files, journal and snapshot; no SQL formatter is configured. |
| Working/staged `git diff --check`                        | Passed.                                                                                               |

There are **107 distinct selected passing tests in six files**; publication
overlaps between the two runs. Original Stage 1 metadata, 32-row late-callback
and before/after-L races were rerun. New paths have a before-L claim expiry
control, but their own complete 32-row late-callback oracle and after-L races
are **not complete**. Passing the inherited tests is not substituted for those
missing R04 controls. R02 request-only negative controls still pass.

Development runs corrected SQL dollar-quote/string-generation and CASE syntax,
retained the Stage 4A hint-only mailbox trigger instead of recreating a broader
trigger, flushed fixture-only deferred events, and corrected the relay to match
`commit\0` rather than the word `commit` inside BEGIN READ COMMITTED. Those failed
development runs are not acceptance evidence. No open-ended retry campaign or
deadline increase occurred.

Commands:

```text
pnpm exec vitest run tests/receiving-publication.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-publication.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

Process-local Docker settings used the accepted Linux engine named-pipe path:
`DOCKER_HOST=npipe:////.\pipe\dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
Local logs: `$env:TEMP/maildock-r04-a-final.log`,
`$env:TEMP/maildock-r04-blocker.log`, `$env:TEMP/maildock-r04-typecheck.log` and
`$env:TEMP/maildock-r04-lint.log`. No Dovecot benchmark, full application suite or
unrelated provider test ran.

## Unimplemented capabilities and dependencies

R04-B is absent: content ready/sanitized/search publication, complete payload
evidence, attachment ready/blob registration/linkage, finalized physical blob
verification and atomic draft references were not implemented. Existing
publication restrictions remain; partial payloads were not enabled. The search
and conversation triggers were inspected, but no derived-only shared-message
exception or new ancillary scope was granted. New negative controls 8–11 await B.

R04-C is absent: Stage 1 still permits one mailbox per transaction. There is no
two-mailbox MOVE/APPEND claim/result capability, deterministic dual-scope recovery,
complete bounded topology scope, or terminal whole-account deletion function.
Ordinary receiving-state deletion/reset stays forbidden. Account removal remains
incompatible with retained authority, as recorded in C6; no deletion service was
changed. New negative controls 12–16 await C, as do complete source/destination
atomicity and opposing-lock-order tests.

R05 read/cache provenance, R06 bootstrap/epoch replacement, R07 complete bounded
topology/destinations and R08 physical removal cannot treat R04 as accepted.
R09 must retain ownership/lifetime and control-headroom requirements while the
pre-network phase is resolved. R10 cannot send STORE/MOVE using this isolated
claim API outside owned admission; takeover and uncertain-effect reconciliation
remain required. R11/R12 have no ready-content/attachment finalization capability.
R13/R14 have no APPEND/MOVE publication capability. R15 due settlement and R16
cutover remain later work. None was begun.

**Stop after this blocked R04 checkpoint.**
