# R10 — Owner-routed IMAP flag commands

2026-10-15. **PASS for isolated R10**, with the reproduced R09 scheduler timing
failure recorded below. Branch `feature/imap-sync-r10-flag-commands`, based on
accepted R09 `ffb3a685491c9a4e84fdaf04fffa373cc1b405e0`.

## Command lifecycle and authority

`message_commands` remains the only durable source of flag work. Public command
creation, coalescing, automatic read, action/status APIs and the R02 projection
are unchanged. The legacy runner still refuses all enrolled accounts, including
MOVE commands. Entirely unenrolled baseline fixtures retain their legacy path.

The existing elected coordinator scans on acquisition, wakes and its existing
heartbeat control opportunities. Scanning is enabled only when trusted composition
registers `{ flags: true }` handlers for `store` and `exact-lookup`, along with
the saved operation credential loader. Nothing registers these handlers in the
production worker. No feature flag, queue, ledger, process, independent timer,
connection pool or second executor is introduced.

Each bounded SQL selection returns at most 32 eligible rows, ordered by creation
and ID. It filters enabled/non-removing accounts, selectable/active mailboxes,
configuration binding, epoch, frozen path, active source and reconciliation
budget. Each pass submits at most one unit per account. In-flight command IDs
are coalesced in bounded scheduler memory; they are hints, never receipts.
Pending commands become STORE units. Executing or historical R04 failed-with-
uncertainty commands become exact-lookup units, never another STORE.

Preparation reloads the command and uses R04 conflicting recovery locks to
validate its frozen source. The original R04 claim and exact-UUID claim COMMIT
recovery finish before client construction. Post-claim credential/configuration,
account lifecycle and locked source validation run again before the socket.
Network methods and SQL publication retain their original mutually exclusive
phases, cancellation lifetime and ten-second maximum operation envelope.

Append-only migration `0046_receiving_flag_reconciliation.sql` adds narrow
capabilities on the existing command row. The R04 command-result body is extracted
into a locked helper; its public wrapper still establishes the complete original
attempt context. Reconciliation reuses that same body after validating its own
current owner and read admission. Calling the helper without the locked attempt
context fails. Existing exact OLD/NEW permits, default guards, single revision
advance and deferred COMMIT checks remain mandatory. New functions are revoked
from PUBLIC; none is SECURITY DEFINER.

## Actual UID STORE and protocol evidence

The flag descriptor uses the existing single-use owned ImapFlow client, not the
legacy provider helper. It connects, SELECTs the frozen path for write access,
validates raw UIDVALIDITY and the selected library identity, then fetches flags
for the exact UID. A mutation adds or removes only `\Seen` or `\Flagged` using
`uid: true`. It never sends a whole replacement flag set or a sequence-number
STORE. A second exact UID FETCH after successful STORE supplies canonical flags.

One collector observes the installed adapter's existing raw response hook. It
requires correlated tagged completions for SELECT, UID FETCH and UID STORE;
valid numeric identities; complete FLAGS; unique fields and flags; bounded atoms;
and well-formed MODSEQ. Duplicate, unexpected UID, missing, malformed, truncated,
uncorrelated and diagnostic-rejected evidence cannot publish success. A changed
UIDVALIDITY during an operation also rejects evidence. No full-mailbox SEARCH or
scan is involved. Existing line/literal/response and aggregate byte bounds apply;
the collector retains only one bounded UID result.

CONDSTORE requires actual ENABLE state plus selected HIGHESTMODSEQ, without
NOMODSEQ. Missing or contradictory selected evidence fails closed. The pre-STORE
exact FETCH supplies the current MODSEQ for `UNCHANGEDSINCE`, using the installed
adapter's accepted conditional STORE implementation. A tagged OK/NO MODIFIED
must identify the requested single UID to count as a confirmed conflict. Conflict
settles as `failed / flag_conflict`; it does not overwrite concurrent flags or
retry STORE. Plain NO/BAD, disconnects and malformed responses are not relabeled
as conditional conflicts.

Without CONDSTORE, the same single-flag add/remove preserves unrelated flags,
followed by an exact confirmed FETCH. This is idempotent desired-state mutation
without a stronger concurrent-client guarantee. SQL still refuses regressing or
missing MODSEQ when canonical state already requires newer MODSEQ evidence.

## Uncertainty, recovery and projection

Before any mutation can have run, failures use the existing R04
`failed_before_execution` capability and remove optimistic projection. After
possible STORE transmission, a lost/incomplete reply never proves remote failure.
The narrow uncertainty wrapper uses R04 failure validation but retains
`executing`, the original attempt UUID, the explicit uncertainty diagnostic and
null completion time. It advances revision once, preserves canonical flags and
keeps the R02 optimistic projection and source serialization active. Cancellation
or process loss may instead leave the original claimed/executing marker; that
also requires inspection, not replay.

An exact lookup is newly admitted through the same W/C/D boundary. Its durable
read reservation retains the original mutation identity and records the elected
reconciliation actor/generation/lifecycle plus a bounded observation counter on
that same attempt. It authorizes no mutation: the owned facade rejects STORE
outside a typed STORE admission with its matching original claim. At most three
reconciliation opportunities are permitted per original attempt, including failed
connection/read opportunities. Unknown reservation COMMIT cannot open a socket.

The lookup SELECTs the same source identity and fetches that UID's current
flags/MODSEQ. Matching desired state settles through the existing R04 result
validation in one atomic transaction. An owner takeover or re-enable may authorize
this read and result against unchanged source/configuration; the original actor
and generation are retained in the marker when result authority is rebound.
Different desired state terminates with `flag_conflict`, preserving unrelated
remote/canonical flags and permitting an explicit new user request. R10 chooses
the conservative existing terminal-conflict behavior instead of an automatic
conditional retry. Obsolete source/configuration never permits replay or stale
publication; the original frozen attempt remains available for diagnosis.

The socket is retired before any result SQL. Confirmed success atomically updates
canonical flags/MODSEQ, settles the matching intent, and advances source revision
once. F/E/R do not change. The projection then resolves to canonical state, without
new message, placement, content, attachment or notification effects. Stale MODSEQ,
source, configuration, lifecycle, attempt and elected owner are fenced.

Command-result and recovery-result SQL scopes are capped at two seconds within
the unchanged operation deadline, leaving time for locked COMMIT recovery. Unknown
result acknowledgement is checked against the original attempt under conflicting
mailbox/intent locks. A committed matching terminal result is acknowledged without
another STORE. An uncommitted result can be published once more only at the same
revision. Old wire evidence is never rebased over a newer canonical revision,
including canonical changes without MODSEQ; a newly admitted remote lookup must
obtain fresh evidence instead.

## Fairness and resources

`ReceivingScheduler` itself is unchanged. STORE and lookup units retain user-class
admission, startup fresh-first behavior, current/user rotation and protected
history opportunities. Metadata, commands and diagnostics share account C=1 and
the same global W limit. Data remains bounded by `min(W, 2D-1)`, with existing
serialized control headroom and allocations held through socket/SQL retirement.
The durable scan uses existing control opportunities rather than another worker.
Larger backlogs are picked up by subsequent wakes/heartbeats; an ACK never clears
durable demand. R15 still owns demand settlement and membership reload.

## Validation and evidence

**404 distinct selected tests passed; one existing scheduler case failed on both
the working source and accepted R09. Total selected: 405 tests in 16 files.**
This is not a claim of one entirely green combined invocation.

| Check                                                                                                                                                                | Result                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Final R10 TLS/PostgreSQL file                                                                                                                                        | 29/29 passed                                        |
| Complete unchanged R03 admission, R04 claim phase and R04-A publication files                                                                                        | 55/55 passed                                        |
| R03 election, R02 intents, R05 active reads, Stage 1 safety, R09 credentials/diagnostics, legacy commands/provider, reader interactions and unread-count regressions | 189/189 passed in nine files                        |
| R04-B cache publication and R04-C bounded publication                                                                                                                | 101/101 passed                                      |
| Complete Stage 3B scheduler                                                                                                                                          | 30/31 passed; healthy-first timing assertion failed |
| One archived R09 comparison of that scheduler case                                                                                                                   | Same assertion failed, 30 unrelated cases skipped   |
| One archived R09 comparison of the earlier R03 queued-cancellation case                                                                                              | 1/1 passed, 19 unrelated cases skipped              |
| Application and worker typecheck                                                                                                                                     | Passed                                              |
| Repository lint                                                                                                                                                      | Passed, no warnings                                 |
| Changed supported-file Prettier and `git diff --check`                                                                                                               | Passed                                              |

The initial broad development run was 265/272, including six new R10 fixture/
implementation failures and the R03 queued-cancellation failure discussed below.
The subsequent focused run passed all 55 R03/R04 cases but exposed three new
R10 fixture errors; after their corrections the complete final R10 file passed
29/29. The final additional run was 160/161 across R10, scheduler and both R04
publication files. Earlier failures are retained, not substituted for passing
evidence. No accepted test, assertion or deadline was weakened.

The scheduler failure is the unchanged assertion at
`tests/receiving-scheduler.integration.test.ts:1145`: the healthy account's first
turn must precede the hung account's first error. Working-source times were
90398.7669 versus 90345.4022; the single accepted-R09 comparison also failed,
11029.0099 versus 10997.7024. The durable-progress and backoff assertions before
that timing check passed. This reproduces the same limitation described in the
accepted R04 phase report. Scheduler source and assertions are unchanged, and no
further retry campaign or unrelated scheduler fix ran.

All integration fixtures use disposable PostgreSQL 17.6 with actual migrations
and an ordinary schema-owning application role. Independent readers verify
durable status/attempts, canonical flags, revision/frontiers and protocol counters.
The R10 peer uses actual TLS and installed ImapFlow 2.0.6. Concurrency uses explicit
gates or PostgreSQL wait observations, not arbitrary sleep-based ordering.

Coverage includes all four actions, no-CONDSTORE preservation, conditional success
and both OK/NO conflicts, missing/duplicate/wrong/truncated FETCH evidence, epoch
mismatch, durable discovery after a lost wake, the legacy enrolled refusal,
optimistic uncertainty, post-claim configuration fencing, actual metadata/STORE
C=1 with W=2, sustained wire STORE versus fresh/history traffic, stale canonical
revision, negative locked SQL authority, original-attempt replay refusal, crash
after STORE, takeover fencing, stale configuration publication, lost claim COMMIT,
and lost result COMMIT with recovery blocked on an independent mailbox lock.

Existing reader interaction tests separately verify automatic mark-as-read's
immediate/delayed/manual behavior and the exact account/mailbox action request.
That unchanged action enters the same durable `mark_read` path exercised against
TLS/PostgreSQL here; no new browser-to-TLS end-to-end harness is claimed.

Development failures remain in TEMP logs. They exposed duplicate SQL scope
acquisition in initial reconciliation, an overlong result SQL scope, and metadata
diagnostic cancellation incorrectly preventing pre-execution failure settlement.
These were corrected without changing existing authority assertions or deadlines.
New fixture corrections used an authorized complete repair page, an actual
initialized INBOX for metadata fairness, and a PostgreSQL JSON object parameter.
An initial R03 queued-cancellation failure occurred while development scanning
also ran for registries without flag descriptors. Discovery now requires the
explicit trusted flag descriptors; the complete unchanged R03 admission file
subsequently passed 20/20. A single comparison of that case on archived accepted
R09 passed 1/1; this does not establish that its earlier failure was pre-existing.

Commands (Vitest uses `--maxWorkers=1 --no-file-parallelism` throughout):

```text
pnpm exec vitest run tests/receiving-flags.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-active-reads.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-credentials-diagnostics.integration.test.ts tests/message-commands.integration.test.ts tests/mail-interactions.test.tsx tests/mail-client-unread-count.test.tsx tests/mail-provider.test.ts
pnpm exec vitest run tests/receiving-flags.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-claim-phase.integration.test.ts
pnpm exec vitest run tests/receiving-flags.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-cache-publication.integration.test.ts tests/receiving-bounded-publication.integration.test.ts
node <installed-vitest>/vitest.mjs run tests/receiving-admission.integration.test.ts -t "queued cancellation during locked renewal"
node <installed-vitest>/vitest.mjs run tests/receiving-scheduler.integration.test.ts -t "backs off one hung account"
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
```

The two comparison commands ran once each in an archive of accepted R09 with the
same installed dependencies. Docker settings were process-local:
`DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Logs/JSON remain in
TEMP under `maildock-r10-impacted`, `maildock-r10-final-focused`,
`maildock-r10-final-additional`, `maildock-r10-r09-admission-comparison`,
`maildock-r10-r09-scheduler-comparison`, `maildock-r10-typecheck`,
`maildock-r10-lint` and `maildock-r10-format`. Intermediate R10-only development
logs also remain there. No Dovecot benchmark or unrelated application-wide suite
ran.

## Limits and R11–R16 dependencies

This is deterministic isolated integration evidence, not a real-provider release
or production receiving activation. The existing process-suspension/remote-socket
retirement limitation remains; SQL fencing alone cannot retract a remote STORE.
Non-CONDSTORE providers have only the stated single-flag concurrency guarantee.
After three unsuccessful reconciliation opportunities, an unresolved attempt
remains visibly executing/uncertain and source-serialized for diagnosis; there is
no automatic counter reset, false failure/success, or unlimited retry campaign.
Obsolete-source attempts likewise remain retained and fail closed.

R11/R12 must keep content/attachment bodies on the existing owned operation and
publication contracts. R13 must compose its sent-copy lookup handling without
replacing flag reconciliation. R14 owns MOVE/general repair, including any future
explicit handling of retained obsolete or exhausted attempts. R15 owns due and
live-membership settlement. R16 must register the two flag descriptors, saved
credential bindings and this elected lifetime in the coordinated worker cutover,
while removing competing legacy consumers. No R11–R17 execution, SMTP/draft/local
attachment change, production registration, push, merge or PR is included.

Stop after R10.
