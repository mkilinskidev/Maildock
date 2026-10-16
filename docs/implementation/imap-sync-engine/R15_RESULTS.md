# R15 � Durable demand settlement and live INBOX membership

2026-10-16. **PARTIAL overall validation; focused R15 implementation 37/37 passed.**
The sole remaining regression failure is a historical 128-message metadata SQL
budget failure also reproduced once on accepted R14. No new R15 implementation
blocker remains; R16 activation is not authorized by this result.

Base: accepted R14 `cf6eb1313ae23158255b317eec4641d039515af4`.
Branch: `feature/imap-sync-r15-demand-settlement`.
Production receiving registration remains R16; continuous secondary receiving remains R17.

## Durable demand and settlement matrix

Admission descriptors and wake acknowledgements are transient hints. They never
change the durable request generation, required metadata, business outcome or
coverage. A completed operation promise means its resources retired. PostgreSQL
COMMIT under the original authority establishes each result below.

| Category                  | Durable demand / admission                                                                       | Exact satisfaction and PostgreSQL authority                                                                                                                                                                 | Interrupted or uncertain work                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh INBOX               | Mailbox due/generation, missing enrollment, F behind selected UIDNEXT; existing fresh admission  | Complete adjacent bounded UID interval and all its metadata committed by Stage 1 `claimReceiving` / `ReceivingPersistence`; F advances only for that interval                                               | Recover original locks and F/E/R before another observation; remaining intervals stay discoverable                                                       |
| INBOX history             | E > 1; existing ordinary/protected history allocation                                            | Complete adjacent historical interval and metadata in the same fenced transaction; E=1 establishes exhausted history                                                                                        | No acknowledgement changes E; partial/failed responses commit nothing                                                                                    |
| Live INBOX                | Existing mailbox due/generation and durable R; existing fresh opportunity when F is current      | Exact next local UID page, complete correlated SEARCH and FETCH, same epoch/configuration/revision, then atomic membership/flags/R publication through existing repair capability                           | R identifies the next page across restart; future due time schedules the next bounded observation, not a certificate that a whole mailbox sweep finished |
| Empty live page at R=0    | Same current source and due generation                                                           | `maildock_receiving_observation_due`: exact unchanged state, empty current placement page, exact mailbox OLD/NEW hint certificate and deferred owner/account check; no fabricated revision/frontier advance | Newer generation is untouched; stale scope, expired owner and mixed canonical writes fail closed                                                         |
| Flag commands             | Original pending/executing command/source tuple; R10 STORE or bounded exact lookup               | Desired single flag evidenced at the original UID, committed by R04/R10 command result authority, with canonical flags and command outcome atomic                                                           | Original attempt retained; at most three observations; no blind mutation retry; terminal diagnostics are R14                                             |
| Content                   | Existing pending/fetching content row and frozen source; R11 slice admission                     | Verified complete display group and exact original source committed ready by R04-B                                                                                                                          | No partial ready body; original read budget and attempt retained; explicit retry/terminal repair as before                                               |
| Attachments               | Existing pending/fetching attachment and frozen part/source; R12 bounded slice admission         | Verified complete immutable blob linkage and exact source committed ready by R04-B                                                                                                                          | Aborted staging is not ready; bounded read restart/terminal repair retained                                                                              |
| Sent APPEND               | Outgoing SMTP-sent Maildock-policy pending copy; R13 APPEND admission                            | One original attempt and accepted remote completion settle only the copy result via R04-C; APPENDUID can establish its exact UID                                                                            | Lost/uncertain mutation is read-only reconciliation, never another APPEND or SMTP submission                                                             |
| Sent metadata             | `sent_copy_sync_pending`, frozen destination, original attempt, mailbox due                      | Existing R13 exact lookup may clear the marker only when the original MIME and already committed current placement/metadata agree; R04-C settles atomically                                                 | Successful APPEND without UIDPLUS retains saved/awaiting_uid, no invented UID, and pending metadata; absent metadata remains due for R17                 |
| MOVE                      | Original source-bound Archive/Trash command; R14 MOVE admission                                  | Accepted completion removes only the original source and settles command; mapped placement additionally needs exact original COPYUID and selected target evidence, through R04-C                            | No COPYUID creates awaiting_uid and destination demand; uncertainty never permits MOVE replay                                                            |
| MOVE destination metadata | Existing destination due and attempt marker; no secondary history admitted by R15                | Existing mapped current placement remains usable under R05; further destination discovery requires its own exact evidence                                                                                   | Command success is separate from destination discovery. Due/awaiting_uid survive restart and wake loss for R17                                           |
| Repair / diagnostic       | Existing obsolete or exhausted original intent, bounded R14 repair selection                     | Exact OLD/NEW intent-only repair commits a terminal reason under owner/account authority; original counters and identities preserved                                                                        | Terminal markers are excluded from execution; unresolved remote identity is never reported synchronized                                                  |
| Account / topology demand | Account due/generation and R08 configuration/lifecycle; existing explicit R07 topology admission | Complete R07 LIST publication has its own authority. An INBOX observation does not represent all account/topology/business obligations and never clears the aggregate account hint                          | Account-wide and secondary hints are conservatively retained; no extra LIST polling or secondary inventory is introduced                                 |

Existing R10�R14 result contracts were audited and retained. R15 extends wake repair
eligibility to outgoing Sent-copy work, including saved copies whose metadata is
still pending. It does not reset exhausted observation budgets to repeatedly admit
the same saved/uncertain attempt. Destination metadata missing from local storage
remains pending rather than triggering a full secondary scan.

## Live observation and protocol evidence

Before a socket opens, locked INBOX recovery captures the account/configuration/
lifecycle, selected source state, mailbox request generation and the next 128
current-epoch/current-binding placement UIDs after R. This uses the existing remote
identity index. Old physical epoch/configuration placements do not enter the page.
Fresh metadata and history retain their original adjacent interval rules.

When selected UIDNEXT is already covered by F, a fresh operation now checks that
exact local page even if UIDNEXT and EXISTS are unchanged. It issues bounded
`UID SEARCH UID <exact page>` and fetches the present exact UIDs through the
existing bounded metadata collector. Every response must be correlated with the
actual sent command and tagged OK. Missing/duplicate/out-of-set identities,
incomplete metadata, protocol diagnostics and failed SEARCH/FETCH reject the
whole observation. No wildcard mailbox UID inventory is collected.

Only page UIDs absent from the completed exact SEARCH can be removed. A partial
page never says anything about other placements. Flags and removals plus R and
revision commit atomically. Under the conflicting mailbox lock, publication
rechecks that the captured UIDs are the entire next durable page. Concurrent
publication/MOVE changes the revision and rejects the delayed observation; repair
never inserts placements. An epoch/configuration transition uses the existing
SELECT-only replacement before any new-identity FETCH and retains old physical
rows under R05 visibility rules.

Live flag publication skips pending/executing R10 flag-command sources and never
regresses a stored MODSEQ or replaces a known MODSEQ with an absent one. Command
projection and command settlement remain separate. Page DELETE and flag UPDATE
are set-based bounded statements rather than 128 serial database round trips.

Installed ImapFlow 2.0.6 was inspected locally. CONDSTORE is usable only when
`client.enabled` contains CONDSTORE, the selected mailbox has HIGHESTMODSEQ and
is not NOMODSEQ. Only that case requests/accepts MODSEQ for publication; advertised
capability alone does not qualify. A negotiated FETCH missing MODSEQ is rejected.
MODSEQ is not used to invent disappearance or advance a global changed-since cursor.

The adapter supports QRESYNC behind its explicit `qresync` option and a SELECT
with UIDVALIDITY/changedSince. R15 does not possess a durable complete-mailbox
MODSEQ checkpoint and does not request such a resumption. It deliberately uses
the exact UID fallback even when QRESYNC can be enabled. A TLS case explicitly
enables QRESYNC and injects VANISHED on a non-resumed selection: no removal follows
from that notification. Exact current SEARCH/FETCH remains mandatory. No QRESYNC
incremental/VANISHED optimization or invented evidence is claimed.

## Cadence, membership and resource limits

The established quiet fresh cadence remains **15 seconds**. Each observation owns
one existing scheduler allocation and one socket, and retires the socket before
PostgreSQL publication. An idle empty INBOX uses SELECT only; a populated page
uses at most 128 UIDs, 256 KiB per response, 2 MiB aggregate metadata and the
existing 10-second operation / 2-second SQL limits. A completed matching page
records its next due time using PostgreSQL time in the publication transaction.
The generation is preserved. A request made during I/O cannot be postponed by an
older generation's result. Account/topology and secondary due hints are untouched.

Timers are only the existing scheduler wait and elected lease heartbeat. The
heartbeat reloads durable INBOX due markers and live membership through the same
serialized control gateway; a lost wake cannot strand an eligible account.
Default 30-second lease renewal opportunities occur every 10 seconds. Reload is
bounded at 128 eligible accounts plus one overflow sentinel. A 129th account
fails closed instead of silently truncating membership. New/enabled accounts and
new INBOX identities enter the same scheduler. Removed/disabled/obsolete identities
are retired from selection; active old allocations retain C until settlement.
Re-enabled changed configuration/lifecycle loads a new capture, never rebases old
wire evidence. Shutdown awaits an outstanding membership reload.

The existing startup barrier, current/user rotation, history age/protection,
backoff, W, account C=1, D and aggregate control headroom are retained. Flag demand
now uses an indexed `(created_at,id)` keyset, as other business selections already
do, so one occupied account's full first page cannot pin discovery indefinitely.
Deterministic controls queue commands 1 and 33 while a metadata socket holds
that account, and skip an entire page of 32 actually terminalized commands to
reach command 33. No STORE is sent by either blocked-admission control. Candidate
pages are materialized before eligibility checks, so obsolete/terminal rows cannot
cause an unbounded filtered scan or pin the keyset cursor. Empty keysets wrap without clearing any demand.

A sweep is O(current placements / 128) observations plus its empty wrap. The
15-second page cadence is bounded background progress, not a claim that a huge
mailbox is fully reconciled every 15 seconds. New-UID metadata has priority while
its fresh coverage is behind; history retains existing protected progress. No
latency SLA under sustained arrivals/failing providers or huge mailbox size is
introduced. The conservative collector fetches bounded metadata for present page
UIDs; no whole-mailbox buffers, extra always-on connection or tuning UI is added.

## Failure recovery and SQL authority

Before-network crash, interrupted observation, rejection and cancellation leave
durable markers/frontiers unchanged. After an unknown COMMIT, the next operation
recovers under the original coordinator/account/mailbox/state locks before new
wire work; it never resends frozen old evidence. A committed matching result is
therefore observed once, and an uncommitted result leaves the original demand.
The focused relay test drops a real PostgreSQL publication COMMIT response after
a deferred barrier, independently observes committed flags, then holds the state
row while recovery is independently observed waiting in `pg_stat_activity`.
Recovery returns exactly the committed revision and unchanged F/E, with zero
STORE/MOVE/APPEND commands.

Migration 0052 adds invoker-only empty-observation hint and bounded placement-reference
capabilities, plus a proven global flag-page index. Empty observation uses exact mailbox OLD/NEW and
unchanged receiving-state certificates, existing source/owner locks and mandatory
deferred account/lifecycle and DB-clock owner validation. It cannot authorize a
canonical write or another mailbox. The existing COMMIT function gains this
narrow branch; its accepted R14 fallback body and all negative authority checks
remain. Nonempty repair and its due CAS share the original Stage 1 publication
transaction. External disappearance also needs to release existing command placement
foreign keys. A deterministic TLS/PostgreSQL case first demonstrated that the
ordinary FK SET NULL was rejected by the command guard. The added membership
reference function runs only inside the original claimed INBOX scope, accepts at
most 128 referenced commands / 2 MiB, and reuses exact OLD/NEW attempt permits to
change only `placement_id` to NULL. Original source UID/epoch/configuration,
command status, attempts and marker are untouched. A mandatory deferred check
requires the referenced placements actually absent and the command rows exactly
unchanged otherwise. A claimed reference release without placement removal rolls
back, as does an unclaimed call. A 32-terminal-command page control exercises
actual R14 terminal repair after this removal and reaches the following valid
command page. Overflow retains demand and fails closed.

No network runs inside SQL. No account hint is written, so there is no account
SHARE-to-UPDATE upgrade behind a producer waiting for the mailbox.

## Validation

**759/760 distinct selected cases passed across 25 files**, including **37/37 R15**
and **722/723 regressions**. Repeated cases are counted once using the latest
relevant result, including the bounded W=4 comparison described below.

| Selection                                                           | Result                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| Focused R15 PostgreSQL/TLS, full final run                          | **37/37**                                               |
| Final typed SQL timestamp binding check, both R15 keysets           | **2/2**, already included above                         |
| R03 admission / scheduler / election / coordinator / wakes          | **89/89** across the runs; W=4 bounded comparison below |
| R04 claim / operation / cache / bounded / safety / retirement       | **170/170**                                             |
| R05 active reads                                                    | **21/21**                                               |
| R06 bootstrap and INBOX windows                                     | **45/46**, historical dense-window failure below        |
| R07 topology / R08 lifecycle / R09 credentials                      | **45/45**, **20/20**, **37/37**                         |
| R10 flags / R11 content / R12 attachments                           | **29/29**, **67/67**, **53/53**                         |
| R13 Sent-copy / R14 MOVE and repair                                 | **35/35**, **45/45**                                    |
| R02 receiving cutover boundary                                      | **26/26**                                               |
| Installed adapter metadata windows                                  | **40/40**                                               |
| Application and worker typecheck                                    | Passed                                                  |
| Repository lint, changed supported-file Prettier, whitespace checks | Passed                                                  |

The initial complete 25-file run recorded 747/757 passes and ten failures. Three
Stage 3B oracle expectations treated any revision change as history; its fixture
now records exact old/new R and independently verifies the precise page and tagged
SEARCH for every repair while preserving all original F/E checks. The old wake
case expected due never to settle; it now preserves exact canonical identity,
F/E, messages and unique events while explicitly checking R and settled due.
These are positive semantic updates for R15, not relaxed authority checks.
The other five logical failures revealed that the new pending-command and strict
MODSEQ suppression had initially also affected explicit legacy repair capabilities.
Both suppressions are now limited to live observation settlement. All unchanged
R10 and R02 assertions subsequently passed.

After fixes, the complete 11-file affected selection ran **319 cases**: 315 passed,
two new keyset fixture assertions failed, and two timing cases failed. The keyset
fixtures now put their commands in an exact deterministic timestamp interval
before retained rows from older tests. That validates the new bounded selector's
real behavior of paging past ineligible older accounts instead of assuming SQL
filters them before LIMIT. The full final focused run then passed **37/37**;
a final two-case check follows the explicit timestamp parameter type correction.

The W=4 sustained-current/history timing case passed in the first full run but hit
SQL admission/COMMIT budgets in the affected run. Exactly one bounded paired
comparison ran afterwards: accepted R14 **1/1**, current R15 **1/1**, both with the
original deadlines. This is passing bounded evidence, not proof that the earlier
failure was pre-existing. No scheduler assertion, health guard or deadline changed.

The dense `atomic first window` case with UIDs 129..256 exceeded the existing
2-second SQL budget in both current runs. Exactly one comparison selected its
three original atomic-window cases on an archive of accepted R14: **2 passed,
1 failed with the same dense-window budget exhaustion**. It remains a reported
failure; no deadline increase, reduced assertion or retry campaign hides it.
The large R15 fixture seeds history using explicitly reduced 32-identity metadata
units within the same ceiling and deadlines, then proves actual **128-UID** live
reconciliation across 300 placements. A full sweep publishes the changed flags,
removes only UID 150 on its page, and wraps R without changing F/E.

Quiet TLS cases mutate the peer after the coordinator is already running and
wait only for independent PostgreSQL visibility. Deletion/MOVE-out retain the
same UIDNEXT; flag changes retain both count and UIDNEXT. No API call, notify,
new message or unrelated account drives those cycles. Restart/lost-wake cases
retain durable generation/due, and an in-flight newer generation stays due after
old publication. Independent locks and actual relay response loss prove COMMIT
recovery; the final reference tests prove pending intent retention and mandatory
placement removal at COMMIT.

Fixtures use disposable PostgreSQL 17.6, actual migrations, an ordinary
non-superuser schema owner, independent postgres.js readers and installed ImapFlow
2.0.6 against deterministic TLS peers. There is no mocked-success membership
oracle. No existing negative authority assertion was changed.

All Vitest runs use `--maxWorkers=1 --no-file-parallelism`. The broad file list is
the 25 files represented by the table and retained JSON `testResults`; the affected
rerun selects R15, scheduler, election, flags, R02 cutover, safety, operation/bounded/
cache/claim publication and INBOX windows. Quality commands are `pnpm typecheck`,
`pnpm lint`, changed supported-file `prettier --check`, `git diff --check` and
`git diff --cached --check`. Process-local Docker settings use
`DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
Logs remain in ignored `.r15-*.log`; JSON evidence is retained outside the checkout
in the TEMP directory recorded by `.r15-evidence-location.log`. The accepted-R14
archive location is recorded by `.r15-baseline-location.log`. SQL has no configured
Prettier parser and is validated by actual migrations and negative authority tests.
No full Stage 3C Dovecot benchmark or unrelated application-wide suite ran.

## Remaining boundaries

The unresolved dense historical-metadata publication budget is the validation
limitation preventing an overall PASS. It also affects accepted R14 and needs a
separate bounded persistence-performance correction; R15 does not enlarge its
budget or alter the old metadata-window assertion.

R16 must register the new receiving engine and perform coordinated legacy cutover.
R17 retains secondary inventory/history and outstanding unknown destination metadata.
Full Sent/Archive/Trash synchronization is excluded. Account aggregate hints are
retained conservatively, not claimed satisfied by a narrower INBOX result.
QRESYNC changed-since optimization is not implemented; supported exact UID fallback
provides correctness and bounded progress. Arbitrary process suspension can retain
a remote socket until that process/server resumes; PostgreSQL fencing does not
instantly revoke it, as in R14.

No production worker registration, SMTP/UI change, push, merge, PR or R16 work.
Stop after R15.
