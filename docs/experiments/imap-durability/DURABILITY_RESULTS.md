# Atomic persistence, ownership and repair

Measured on 2026-10-12 against real PostgreSQL 17.6 and Dovecot 2.4.3-dev.
Reproduction and scope: [SETUP.md](SETUP.md). This is an isolated experiment,
not production receiving code or a production persistence integration.

## Atomic crash matrix

The final durability runner has **17 passing scenarios**, including a persistence
smoke and ten deterministic process-kill boundaries. Every crash boundary starts
from the same independently inventoried 384-message mailbox. An independent
database connection observes the stopped worker before SIGKILL; a fresh TypeScript
process acquires the next generation, reloads epoch/frontiers and completes the
mailbox. Final comparison includes every UID, message ID, subject, size and permanent
flag, not merely matching counts.

| Barrier                                      | State visible to independent reader before termination | Fresh-process outcome                            |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Before SEARCH                                | 0 rows, history=385                                    | 384 exact identities, history=1                  |
| After SEARCH, before FETCH                   | 0 rows, history=385                                    | Same                                             |
| After FETCH, before transaction              | 0 rows, history=385                                    | Same                                             |
| During insertion, after first row written    | 0 visible rows, history=385                            | Uncommitted insertion rolls back; same           |
| After all metadata insertion                 | 0 visible rows, history=385                            | Same                                             |
| Before frontier statement                    | 0 visible rows, history=385                            | Same                                             |
| During frontier transaction, after statement | 0 visible rows, history=385                            | Uncommitted frontier rolls back; same            |
| After COMMIT                                 | 128 rows, history=257                                  | Remaining 256 rediscovered from durable boundary |
| Before acknowledgment                        | 128 rows, history=257                                  | Same; no continuation payload required           |
| Before scheduling next work                  | 128 rows, history=257                                  | Same                                             |

There are no duplicate current placements, unsupported coverage advances or
unexplained missing current identities in these completed trials. The PostgreSQL
primary key is `(account,epoch,uid)`; uniqueness is a database invariant. ACK and
continuation are experiment control barriers: **pg-boss ACK/redelivery itself was
NOT RUN**. Direct PostgreSQL due-work/state scanning was validated.

`commit-uncertainty.ts` additionally pauses just before COMMIT, then a disposable
plaintext PostgreSQL relay suppresses the actual server `COMMIT` completion frame.
The independent reader sees 128 rows/history=129 for a 256-message mailbox while
the worker has no confirmation. SIGKILL, lease expiry and a fresh process recover
all 256 identities. This is a genuinely lost commit acknowledgment, not an exception
artificially thrown after an acknowledged commit. Duplicate retries are resolved by
reading durable facts and selecting the remaining interval.

Database watchdog testing cancels a real `pg_sleep` and successfully issues the next
query after settlement (about 207–210 ms in the 200 ms tests). The coordinator does
not release the account merely because a Promise.race timer resolved. Native socket
retirement resolves a stalled transaction/commit acknowledgment; uncertainty still
requires durable-state reload. This test does not prove power-loss survival of the
host's filesystem, storage controller or Docker Desktop VM.

Additional native SQL failures reject an out-of-range integer during the second
metadata INSERT and an invalid history boundary during the actual UPDATE/check
constraint. Both roll back all rows, including the first successful insertion.
Normal replay then compares all 32 identities. A different mailbox path cannot
repurpose an account's bound mailbox/epoch facts; that unsupported operation is
rejected without changing the existing epoch.

The integrated input-budget runner performs multiple real metadata FETCHes in one
turn, exceeds the 2 MiB aggregate by a measured 3,441 received bytes, retires transport
and advances no frontier. Each individual literal is below the parser cap. Replay
without the extra fault-injection reads converges eight exact identities. This
separately proves sharing input budget across commands rather than just setting
a cap on each command. Supplemental scripted-peer checks reject tagged OK without
any SEARCH response and accept a genuinely complete empty SEARCH.

## Cancelled database callback: retained correctness failure and repair

The late DB callback reproduction **failed before the final transaction-boundary
fix**. A worker paused after inserting metadata. Native cancellation closed its
connection, but `postgres.js begin(callback)` returned before that callback ended.
When the old callback resumed during a new writer's transaction, its driver's
automatic ROLLBACK used the reused connection. The new turn reported success while
the independent reader found **0/32 rows, history=33 instead of 1**. This is a real
correctness failure, retained with the old store's SHA-256; earlier performance
runs cannot establish safety through this fault.

The final experimental boundary owns BEGIN/COMMIT/ROLLBACK on a reserved client
explicitly. A transaction lifetime guard covers SQL calls **and lazy query execution**;
native retirement invalidates it before allowing a later writer. No automatic old
callback rollback exists, and an obsolete reserved handle is never released into
a newer transaction. The same reproduction now retains all 32 rows/history=1.
A separately prepared old DELETE is also rejected when executed after cancellation.
Post-fix correctness and sustained/constrained-pool repeats are distinguished from
historical measurements in the performance report. This mechanism adds no durable
receipt/operation table; it is a required reviewed DB execution contract.

## Lease and generation fencing

Two independently launched TypeScript processes race a single PostgreSQL UPDATE
of the expired coordinator row. Exactly one acquires authority; the other receives
denial. Renewal succeeds only for the live generation. Graceful release closes
local transports before releasing the lease; the next generation is larger.

An old worker pauses after a complete real FETCH. Its PostgreSQL backend is
terminated while its IMAP connection is retained; its lease expires and a fresh
worker takes over/completes coverage. Resuming the old buffered callback produces
`Stale owner fenced`, including after DB reconnection. A separate transaction
expires its lease during metadata/frontier work and rolls back.

**A final pre-COMMIT application check is insufficient to express the desired
expiry rule if the client stalls before sending COMMIT.** This harness therefore
adds a deferred PostgreSQL constraint trigger for authoritative mailbox revisions.
It checks matching transaction owner/generation and DB-time expiry inside COMMIT,
with a shared lease lock conflicting with takeover. The test deliberately delays
COMMIT beyond a 300 ms lease and receives `COMMIT authority fenced`; revision and
facts stay unchanged. This is a proposed minimal architecture clarification,
recorded in [implications](ARCHITECTURE_IMPLICATIONS.md), not a modification of
the approved architecture.

During remote-cap takeover, the old worker plus nine independent retained IMAP
sessions occupy the synthetic account's limit of ten. `doveadm who` observes all
ten. The new owner is rejected, commits no revision, and recovers after those
sessions close. A DB lease establishes exclusive durable authority; it cannot
instantly revoke a remote IMAP session across a partition. Local socket retirement,
server sessions and database generation authority are distinct measured facts.
There is no assertion of a strict global remote socket cap during arbitrary failure.

## Epoch, reconciliation and late-wake protection

The reconciliation runner uses complete, exact known-UID SEARCH evidence and
bounded complete metadata/flags retrieval. FETCH omission alone changes neither
coverage nor membership. Conservative replay searches again on a fresh connection;
confirmed expunge resolves the hole without a receipt table. PostgreSQL epoch and
revision checks prevent an earlier result from restoring a placement after later
confirmed deletion, even within the same owner generation.

The fresh check captures the wake generation. A durable wake inserted after FETCH
keeps `fresh_due` eligible when that older check commits. History remaining after
commit is discoverable directly from `history>1`; there is no history enqueue chain.
Epoch switch updates active UIDVALIDITY/frontiers atomically, immediately hides
old physical rows through `current_placement`, and rejects old epoch results.
Old epoch cleanup is deferred; a production bounded cleanup integration is unproven.

Final reconciliation measurements and exact identities are recorded in
`outputs/reconciliation-summary.json` and its compressed per-operation trace.
They cover actual sparse holes, equal-count delete/arrival, remote flags,
restart during membership persistence, supported mailbox delete/recreate and
15,000 deletions concurrent with ten independent new arrivals.
The final post-fix deletion run converges **37,419** exact identities in 75.00 s
(including setup/drain/repair), with **322.14 ms** worst arrival availability.
A retained intermediate run measured 21.62 s while a newly restored 15,000-message
fresh backlog was still outstanding; the finite drain helper now completes its
observed fresh frontier before declaring completion. That backlog trial is retained
and is not presented as the no-backlog reference latency.

## Preserved development failures

All failed/partial runs remain in `outputs/`; they are not counted as passing safety
trials. Early failures included a 2 s accelerated lease expiring through the DB
relay, a fixed 600 ms leadership-observation sleep racing process startup, and a
disconnect cleanup handler overriding a successful child's exit code. Those were
corrected with an appropriate 30 s uncertainty-test lease, actual IPC outcome
barriers, and cleanup-handler removal before orderly child disconnect.

The netem runner's first coordinator stage collided with a concurrently running
uncertainty test's lease and was not executed; it was rerun sequentially. Bulk import
preparation initially hit PowerShell's empty-argument forwarding, an existing empty
INBOX and a too-short parent import timeout; an experiment-local shell argument and
empty-fixture checks were used, and the completed server import was verified before
proceeding. No partial import was treated as an initialized mailbox.

## Limits

- No production queue/notifications/conversation or command-intent persistence.
- No arbitrary DB network partition during host/process suspension beyond the
  explicit lost-COMMIT relay, backend termination and stale callback scenarios.
- A lease cannot provide exactly-once remote STORE/MOVE/APPEND effects.
- A real permanently oversized header stalls the durable frontier on repeated
  attempts and remains explicitly unresolved until the independent fixture actor
  expunges it. Permanently omitted FETCH with otherwise valid metadata still has
  no persistence-backed real-server recovery measurement.
- Billion-sized real UID gaps and near-2^32 allocation are NOT RUN: server UID
  files/indexes were never fabricated. Actual holes and adaptive empty spans run.
- One trial per deterministic crash barrier and one leadership race are evidence
  of those cases, not statistical significance or an exhaustive schedule proof.
