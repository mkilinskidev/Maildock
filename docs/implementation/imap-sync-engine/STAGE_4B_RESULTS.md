# Stage 4B — Coordinator election, ownership and takeover

2026-10-14. **PASS for isolated Stage 4B**, with the intermittent regression
limitation disclosed below.
Base: accepted Stage 4A `372e43cc36fd6a1c090f241bb2ed0a2b9d1996a4`.
Branch: `feature/imap-sync-stage-4b-ownership`. Stage 3C is PASS at accepted
`93c1fa948f677ea56c49550a3ec6bab1c776744b`; stale statements in the Stage 4A
report were corrected. No Stage 3C Dovecot run was repeated.

## Lease and generation

Migration `0037_receiving_election` extends the existing Stage 1
`receiving_coordinator` singleton. There is no new ownership table, receiving
ledger or general-purpose lease framework. The original generation guard,
mailbox claim/revision checks and mandatory deferred COMMIT triggers are intact.

`maildock_receiving_acquire` obtains `FOR UPDATE`, compares expiry to
`clock_timestamp()` after locking, and returns NULL for a live owner. Otherwise
it calls the existing takeover function, which increments generation exactly
once and installs the new actor and expiry atomically. Concurrent callers
serialize; only one succeeds. The actor is a new UUID for each coordinator
lifetime. A follower may retry election with its existing actor because it has
never held a term.

Renewal obtains the same UPDATE lock and requires matching actor/generation and
a still-live database lease. It extends expiry without changing generation.
Expired ownership cannot be renewed, including after a lock wait. Validation
uses SHARE and compares database time **after** acquiring the lock inside a
PL/pgSQL function, avoiding a pre-lock SELECT-expression clock comparison.
Release takes UPDATE and checks both identity and generation before setting
expiry to negative infinity. Identity/generation remain recorded; release cannot
reset the counter or retire a replacement term. Public function access is revoked
using the existing Stage 1 convention; the application/database owner remains
within the original trusted SQL-writer boundary.

The isolated lifetime defaults to a 30-second lease, renewed every TTL/3 and
before each scheduler admission. Configurable leases are bounded to 100–60,000
ms; short test leases are fault fixtures, not production latency settings.
Control transactions share the supplied receiving executor and have a maximum
two-second budget. No connection is held across IMAP work.

Local expiry uses monotonic request-start time plus TTL, earlier than the
database extension after lock acquisition. Delayed replies cannot extend a
locally retired term. Local expiry is conservative cancellation; PostgreSQL time
and locks remain the authority for takeover and publication. Failed or unknown
renewal retires the entire lifetime rather than falling back to account retry.
Unknown acquisition similarly terminates locally and relies on database expiry.

## Owner/follower lifecycle and resources

`ElectedReceivingCoordinator` is explicitly invoked by isolated harnesses. Its
transitions are follower → acquiring → follower when another lease is live, or
acquiring → owner when acquisition commits. Owner → lost is terminal. Stopping
any phase cancels it and leads to stopped after retirement and conditional
release. A lost or stopped object cannot elect again; recovery constructs a new
lifetime/actor. Concurrent `elect`, `renew` and `stop` calls are coalesced.

Only a committed elected owner loads candidates or constructs the shared
Stage 3B scheduler. The scheduler has one optional asynchronous admission
boundary: a failed authority check cancels its lifetime before allocating a new
turn. The elected implementation supplies database renewal at that boundary.
Each turn also performs locked validation and Stage 1 enrollment recovery before
constructing an IMAP client, with local guards after awaited steps. Existing
Stage 3 fixtures retain their original authority callbacks.

Loss synchronously aborts admission, adapter cancellation signals and receiving
SQL scopes. `scheduler.stop()` then awaits local socket/transaction retirement.
The original executor revokes late SQL builders and destroys only its owned
clients. Clean shutdown awaits election, renewal and scheduler settlement before
releasing the lease. Failure to confirm release leaves expiry as the fallback;
a stale release cannot affect the new generation. Caller ownership of the shared
executor and unrelated database pools is preserved.

Stage 3B account rotation, backoff, startup fresh barrier and history opportunity
policy are unchanged. W is still capped by its configured worker limit and 2D;
each account has C=1, and the existing executor's D executing/D waiting bounds
remain enforced. Ownership control also consumes this executor: saturation can
cause conservative ownership loss rather than exceed database capacity.

## Reconstruction and wake behavior

After acquisition, a bounded PostgreSQL query reconstructs all enabled,
selectable, active INBOX account identities, including unenrolled and quiet
accounts that must remain available for polling. It reloads due/history hints
from Stage 4A and Stage 1 records. Candidate input includes those hints; they are
not trusted as F/E evidence. Every admitted turn reloads committed epoch,
revision and F/E/R under Stage 1 conflicting locks. No predecessor candidate set,
wake list, retry phase or frontier is reused.

At most 128 account candidates are accepted; reading one extra row detects
overflow and fails closed instead of silently dropping accounts. The injected
account loader resolves configuration using only the bounded, revocable SQL
scope; it must not open receiving sockets or perform network I/O. Returned
account/mailbox identity is checked against PostgreSQL. Each runnable account
receives its startup fresh opportunity before history, including after takeover.
History resumes from committed E only after that fresh recovery.

The elected boundary implements the existing `ReceivingWakeTarget.notify`.
A follower returns successfully without loading candidates, opening sockets or
retaining notifications. An owner confirms database ownership before forwarding
the hint into the same shared scheduler. The ready set stays bounded by the
candidate cap. A local per-account wake generation preserves a notification
received while a fresh turn is active: its eventual result cannot postpone that
new hint until the ordinary poll deadline.

Neither notification, ACK, election, retirement nor successful receiving turns
clear durable due or request generation. Duplicate notifications cause bounded
checks of current state; committed F/E and existing placement/event uniqueness
avoid duplicate authoritative publications. Polling discovers arrivals when the
local hint is missing. A restart discards abandoned local notifications and
reconstructs state from PostgreSQL. Stage 4A repair and producer functions remain
unchanged.

## Independent PostgreSQL evidence

The new suite always creates a disposable PostgreSQL 17.6 container and ordinary
`lane` database owner, runs all migrations and uses an independent postgres.js
reader. Child processes run the real elected coordinator, shared scheduler,
receiving executor and installed ImapFlow adapter against scripted TLS IMAP
peers. No configured application database/account is accessed.

Suspension is deterministic: the coordinator process blocks its event loop on an
Atomics barrier while a helper thread accepts the explicit release signal.
It cannot renew or run socket callbacks until released. Database races use
conflicting locks, advisory barriers and observed `pg_stat_activity` states.
Small polling waits observe barriers or database expiry; they do not time the
injected operation or assume a sleep completed the fault.

| Required scenario                 | Independently observed result                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simultaneous processes contend    | Both acquire calls are observed waiting behind one UPDATE lock; after release, exactly one returns an owner and the other remains a follower.                                                                                                                |
| Owner-only admission              | Only the winning process emits admission and reaches SELECT; follower peer has zero sockets.                                                                                                                                                                 |
| Wake delivered to follower        | Actual pg-boss consumer forwards a Stage 4A delivery to the follower process and ACKs; due, generation and metadata snapshot remain unchanged.                                                                                                               |
| Renewal without generation change | Database generation remains equal to the acquired term after successful renewal.                                                                                                                                                                             |
| Expiry takeover                   | Frozen owner's database lease expires; follower acquires generation old+1.                                                                                                                                                                                   |
| Delayed renewal/release           | Both SQL operations return false for the old term after takeover; resumed old process cannot renew or re-elect. Renewal and validation also reject expiry crossed while waiting for a lock.                                                                  |
| Frozen FETCH                      | Replacement commits epoch 7, revision 2, F=2, E=1, R=0, exactly two messages/placements and one fresh event. Explicit old-term publication fails with PostgreSQL `Receiving owner fenced`; resumed old peer closes and the durable snapshot stays identical. |
| Pause before COMMIT/L             | Old revision/F update remains invisible while a new process waits for its lease lock. Expiry before the deferred authority check rejects old COMMIT; revision stays 0 and F=1.                                                                               |
| Pause after L                     | A fixture deferred barrier ordered after the production authority check holds COMMIT through expiry. New election waits; old COMMIT succeeds first, yielding revision 1/F=2/E=2/R=0, then generation increments.                                             |
| Process crash/restart             | Killed process leaves epoch 7, revision 0, F=2/E=3 and due intact. Restart's first search is fresh UID 3; final revision 2/F=3/E=1 has three messages/placements and one event.                                                                              |
| Missing/duplicate wakes           | Missing local delivery is repaired by a poll; four duplicate hints leave revision 1, one message/placement, one unchanged event identity and durable request generation 1/due true.                                                                          |
| Loss/shutdown during FETCH        | Old sockets close; old conditional release leaves replacement actor/generation/live expiry intact. No metadata/event is published by the abandoned FETCH.                                                                                                    |
| Loss during receiving SQL         | After local retirement the blocked old backend still has its lease SHARE lock; takeover waits. Releasing the SQL barrier rolls the abandoned write back; replacement publishes revision 1/F=1, one message/placement/event.                                  |
| Startup priority                  | Crash/takeover first admission is fresh, and UID 3 is committed before history resumes from E=3. Existing W=1/2/4 startup/fairness regressions validate the original selector.                                                                               |
| In-flight wake                    | With an ordinary poll deadline of 60 seconds, a wake during paused fresh SEARCH survives its result; the next fresh turn commits UID 2 within the bounded test, yielding revision 2 and two unique placements/events.                                        |

Snapshot comparisons include epoch, revision, F/E/R, due, request generation,
current UID placements, total placement/message counts and notification sequence
plus mailbox/epoch/UID identities. Diagnostics are not used as evidence of a
database commit.

## Validation

Final combined run: **6 files, 96/96 tests passed**, exit 0, 132.91 seconds.
This includes 12 Stage 4B tests and 84 relevant Stage 1, Stage 3A/3B and Stage 4A
regressions. The final run used the exact committed source without temporary
diagnostics. Application/worker typecheck, lint, changed-file formatting and
whitespace checks passed.

Two earlier validation runs retained an intermittent cancellation failure in the
existing Stage 3B test `cannot be held by unavailable accounts`: W=2 in the
five-file regression run (83 passed/1 failed), then W=4 in a scheduler-only run
(30 passed/1 failed). Both timed out in the test and cleanup hook; their limits
were not relaxed. Targeted W=1/2/4 passed 3/3, a startup/cancellation subset
passed 13/13, and a further full scheduler run passed 31/31. Temporary SQL
retirement observation produced no delayed-retirement report and was removed.
The Stage 1 executor remains byte-for-byte unchanged. No root cause or repair
of those intermittent timeouts is claimed; they remain a validation limitation
for Stage 4C's broader retirement/readiness lifecycle testing.

```text
pnpm exec vitest run tests/receiving-election.integration.test.ts
pnpm exec vitest run tests/receiving-election.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-coordinator.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-wakes.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check src/modules/mail/application/receiving-election.ts src/modules/mail/application/receiving-scheduler.ts src/modules/mail/application/receiving-coordinator.ts tests/receiving-election.integration.test.ts tests/fixtures/receiving-election-process.ts db/migrations/meta/_journal.json docs/implementation/imap-sync-engine/STAGE_4A_RESULTS.md docs/implementation/imap-sync-engine/STAGE_4B_RESULTS.md
git diff --check
```

## Stage 4C requirements and remaining limits

`worker-process.ts` has no changes. No new receiving consumer, repair timer,
startup/readiness integration or old consumer retirement is registered. Stage 4C
must stop and settle old authoritative receiving writers before starting the
elected route; wire durable wake/repair delivery, readiness, bounded follower
election retries and worker shutdown; refresh candidate membership when account
configuration/readiness changes; and decide completion/due CAS with captured
request generation. ACK and this stage cannot declare synchronization complete.

Default lease/heartbeat values are isolated implementation settings, not a
validated production recovery SLA. Stage 4C needs control-capacity accounting
and candidate/cardinality/readiness handling. Capacity overflow or slow account
configuration loading currently terminates election safely; it is not a scalable
pagination policy for arbitrary account populations. PostgreSQL/query load,
queue retry/cache delays and repeated failovers can delay progress or reset
ephemeral history age. Network credential refresh belongs outside the loader's
database transaction.

A suspended/partitioned old process can retain a remote socket until resumed or
the server closes it. PostgreSQL cannot revoke remote IMAP sessions instantly;
new admission is fenced and stale database publication rejected, but strict
simultaneous remote socket C/W limits through arbitrary process suspension are
not claimed. The deterministic FETCH suspension test retains that counterexample.
Existing remote-cap rejection/backoff remains necessary. No optional IDLE,
folder lifecycle, command/content routing, SMTP/draft behavior or scheduling
fairness redesign is included.

Stage 1's logical authority semantics remain: an old transaction authorized at
L can become physically durable after lease expiry, but takeover serializes
after it. Local retirement is not evidence that the backend disappeared.
No physical-durability-before-expiry guarantee, provider release acceptance,
Dovecot smoke, full-suite benchmark, open-ended stress, push, merge or PR is
claimed. Work stops at Stage 4B.
