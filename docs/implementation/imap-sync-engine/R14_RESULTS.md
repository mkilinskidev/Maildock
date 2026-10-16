# R14 � Owner-routed MOVE and bounded attempt repair

2026-10-16. **PASS for isolated R14 implementation and deterministic validation.**
Production receiving activation remains R16.

Base: accepted R13 `8d5a42ee4018845252ea177d41eac906a0a4c711`.
Branch: `feature/imap-sync-r14-move-repair`.
No production receiving activation, push, merge, PR or R15 work.

## Owner-routed execution and destinations

Existing Archive and Trash request/status APIs, R02 source-bound commands,
coalescing and optimistic placement projection are unchanged. Archive and Trash
both move to the corresponding role destination; neither permanently deletes mail.
The legacy runner still refuses enrolled accounts before provider work.

Trusted isolated composition registers `{ move: true }` for `move` and includes
`move: true` in the shared `exact-lookup` descriptor. MOVE lookups carry
`lookup: 'move'`; flags and Sent-copy lookup routing remain compatible. Terminal
local repair uses the existing `repair` operation with `{ repair: true }`.
Nothing registers these capabilities in the production worker.

Elected acquisition, account wakes and existing renewal opportunities discover
commands in indexed keyset pages of 32. In-flight IDs coalesce in scheduler memory;
one operation per account is submitted per page. Frozen destination UUID/path
come from the original R02 command, never the current role's new mailbox. Manual
mapping retains R07 precedence. Missing/nonselectable/inactive/mismatched targets
fail before mutation with the existing system-folder error. Unattempted targets
that need selected identity first use a separate R07 owned role-bound SELECT and
enrollment, without fetching destination history. An empty keyset page wraps;
subsequent existing opportunities revisit a command after its target is enrolled.

R04-C claims the original command using one exact attempt UUID before constructing
an ImapFlow client. Claim-COMMIT uncertainty is recovered under conflicting locks
on both original scopes and the command. Only that exact UUID/owner/phase can open
a socket. Saved R09 credentials/configuration/lifecycle are checked again, followed
by a short locked revalidation of original source, role, destination and revisions.
There are no SQL locks or transactions during IMAP I/O. All result/failure SQL
starts after actual socket retirement.

## Actual protocol and publication

The installed ImapFlow 2.0.6 has an automatic COPY/delete fallback in its MOVE
implementation. R02 already requires MOVE support. R14 checks actual negotiated
MOVE capability immediately before calling the guarded `messageMove` method;
the adapter fallback is therefore unreachable. Unsupported servers return a
pre-execution failure. No COPY, STORE Deleted, EXPUNGE, permanent-delete action
or additional fallback subsystem is implemented.

Absolute LIST paths are preserved by disabling personal-namespace prefix insertion
on this single-use adapter; selected paths must equal the frozen paths exactly.
A TLS peer advertising a nonempty personal namespace verifies this boundary.
One owned client EXAMINEs the frozen destination, SELECTs the frozen source for
write access, validates exact raw and adapter UIDVALIDITY, and fetches that exact
source UID/flags. It issues `UID MOVE <original UID> <original destination>` once.
The raw collector requires the actual sent request and correlated tagged OK.
COPYUID may occur once in its untagged OK or tagged OK; epoch, original source UID
and destination UID must be valid single UIDs. Duplicate, contradictory, malformed,
set-valued, wrong-source and wrong-epoch evidence is rejected. UID sets/ranges are
conservatively refused even if they might encode one UID. Normalized adapter maps
and response sequence numbers never supply identity.

With COPYUID, the same client reselects the destination and fetches the exact
mapped UID's flags/MODSEQ. R04-C atomically preserves original message identity,
creates that evidenced destination placement, removes the original placement,
settles the command and advances each affected revision once. Historical command
placement references retain their bounded SET NULL behavior. No arrival event or
message envelope is invented. Destination discovery demand remains due.

A correlated successful MOVE without COPYUID uses an explicit accepted-success
certificate. It atomically removes the source and settles succeeded with marker
`awaiting_uid`, null destination UID/epoch and destination discovery demand. It
creates no target placement or metadata. The old R04 certificate without explicit
accepted success retains its original conservative uncertainty behavior, preserving
existing negative authority tests. Neither path advances F/E/R or mailbox history.

Optimistic hiding remains active while pending/executing. Confirmed results remove
the original source; confirmed pre-execution failure removes only the projection.
Post-execution uncertainty uses the existing failed/uncertain diagnostic and
unwinds optimistic hiding without asserting remote rollback. R05 active-source
rules continue to govern list/search/counts/reader/cache access. Cached bytes from
the removed source are never rebound to the destination merely by message ID.

## Uncertainty and read-only reconciliation

Disconnect, malformed completion or interrupted target verification cannot cause
another MOVE. A new elected exact lookup retains the original UUID, frozen paths,
epochs, source UID and role, adopts the current owner and reserves one observation
before constructing a fresh read-only socket. At most three observations per
mutation are allowed, including failed reads and crash reservations. Unknown
reservation COMMIT must establish the exact observation count before network I/O.

The lookup EXAMINEs the original destination/source and fetches the original source
UID. Source disappearance alone is ambiguous. No Message-ID SEARCH is performed;
duplicate or unique Message-ID matches cannot establish MOVE success. Without
adequate original mapping evidence the command remains uncertain.

If MOVE completed with a validated COPYUID but a subsequent destination read failed,
its complete mapping proof is retained on the same existing command attempt during
fenced failure settlement. A newly admitted lookup can then prove source absence
and fetch the exact original destination UID under its original epoch. Only that
proof and newly completed target evidence permit R04-C success. SQL also rejects
observation success without the matching original mapping. A lost MOVE reply with
no retained COPYUID, an absent target, changed role/configuration/epoch or ambiguous
remote state never fabricates success or retargets the operation.

Unknown result COMMIT is recovered under both original scope locks and the intent
lock. A committed matching terminal phase is acknowledged without another socket
or MOVE. Unproven/rolled-back publication is left for conservative uncertainty and
fresh read-only evidence; wire evidence is never rebased to claim success over a
newer canonical revision.

## Bounded terminal repair

Migration 0051 adds narrow capabilities on existing rows, not a queue or ledger.
Repair scans at most four indexed pages of 32 existing intents, returning only
identities/markers and eligibility, without reading stored body/MIME payloads.
One repair per account/pass is submitted through existing maintenance admission.
Keyset cursors progress past obsolete/ineligible rows and wrap. Terminal markers
are excluded from subsequent execution/reconciliation discovery.

An intent-only repair locks the elected coordinator, discovery mutex, enabled
account, original mailboxes/states and exact intent. It revalidates the reason and
uses an exact OLD/NEW certificate plus the existing deferred owner/account/DB-clock
commit check. It changes no canonical placement, bytes, blob, envelope or frontier;
there is no source revision advance for an intent-only terminal diagnostic.

Supported cases:

- Exhausted flag observations: failed with uncertainty, retained original attempt,
  counters and canonical flags; optimistic projection unwinds. An explicit later
  source-valid user action remains possible.
- Exhausted content/attachment restart chains: failed with an exhaustion diagnostic,
  retained provenance/attempt/read counter, no partial ready bytes or blob linkage.
  Existing explicit reader retries remain possible; repair never resets a budget.
- Obsolete source epoch/configuration/path, destination identity or role: terminal
  diagnostic retaining the original binding; unattempted unavailable MOVE restores
  visibility and reports the existing actionable system-folder error.
- Crashed/executing MOVE: bounded read-only observation, then retained uncertainty
  when exact success cannot be proven. Exhaustion becomes `repair_terminal` with a
  durable reason, never a fresh mutation claim.
- Interrupted/uncertain Sent APPEND: R13's existing bounded exact lookup remains the
  only remote recovery path. Exhausted/obsolete uncertain copies retain SMTP sent
  and Sent-copy uncertain status with a terminal reason. No SMTP/APPEND replay.

Already confirmed saved Sent copies and MOVE awaiting-UID discovery remain due;
repair does not erase them or invent destination metadata. Disabled/removing
accounts remain dormant. Ambiguous mutations, lost mapping proof and unavailable
original identities remain explicitly unresolved. No full-mailbox consistency
scan, user dashboard, new service or automatic mutation-counter reset is added.

## Limits and validation

Global W, per-account C=1, data budget/protected control headroom, startup fresh-first,
current/user rotation and protected history use the unchanged receiving scheduler.
MOVE and repair share its allocations with metadata, flags, content, attachments
and Sent-copy. Original operation lifetime remains 10 seconds and SQL scopes at
most 2 seconds within it. Read-only observation opens one fresh owned socket per
admission; one MOVE opens one socket and at most two selected mailbox identities,
one source FETCH, one UID MOVE and one mapped destination FETCH. Protocol response,
line/literal and aggregate byte limits remain the existing operation budgets.
No full mailbox SEARCH or history scan is used for reconciliation.

**528 distinct selected tests passed**, counting repeated runs only once.

| Selection                                                            | Result                         |
| -------------------------------------------------------------------- | ------------------------------ |
| Full focused R14 PostgreSQL/TLS suite                                | **45/45**                      |
| Selected regressions, 14 files                                       | **483/483**                    |
| Final R04-C MOVE/APPEND authority repeat                             | **65/65**, included in the 483 |
| Application and worker typecheck                                     | Passed                         |
| Repository lint                                                      | Passed                         |
| Changed supported-file Prettier and working/staged whitespace checks | Passed                         |

Regression counts: durable commands 16, R02 boundary 26, R03 admission 20,
scheduler 31, R04 preparation 17, operation publication 18, cache publication 40,
bounded MOVE/APPEND/topology authority 65, R05 active reads 21, R07 topology 45,
R10 flags 29, R11 content 67, R12 attachments 53 and R13 Sent-copy 35.
The full scheduler passed 31/31, including the historical healthy/hung timing
case; no baseline comparison, assertion relaxation or timing retry campaign
was needed.

Fixtures use disposable PostgreSQL 17.6, all real migrations, an ordinary
non-superuser schema owner, independent postgres.js readers, installed ImapFlow
2.0.6 and deterministic TLS peers. Actual command counters prove exactly one
`UID MOVE 1 Archive` for Archive and Trash, no COPY/STORE/EXPUNGE/CLOSE fallback,
and destination UID 42 from COPYUID/FETCH despite response sequence number 12.
Without COPYUID the command succeeds with no destination placement/UID/epoch,
source removal and retained destination demand. Source/target epoch and wrong
UID controls cannot publish success.

Actual PostgreSQL response-loss relays discard claim/result COMMIT responses.
An independent reader holds the original destination lock and observes
`maildock_receiving_data_recover` waiting in `pg_stat_activity`. Before lock
release there are zero MOVE commands for claim recovery and exactly one for
result recovery. Both settle without another mutation. A peer that executes MOVE
then drops its reply leaves uncertainty through repeated separately admitted
read-only observations, with exactly one MOVE and the original attempt UUID.
A completed COPYUID followed by lost target FETCH is recoverable from its retained
mapping proof and a new exact source/target observation. Takeover/configuration/
epoch/role races reject stale publication. New repair controls additionally verify
counter preservation, explicit later user requests, account isolation, atomic
rollback of forbidden mixed canonical writes, and no socket for terminal repair.

Commands (all Vitest runs use `--maxWorkers=1 --no-file-parallelism`):

```text
node node_modules/vitest/vitest.mjs run tests/receiving-move.integration.test.ts
node node_modules/vitest/vitest.mjs run tests/receiving-move.integration.test.ts tests/receiving-bounded-publication.integration.test.ts
node node_modules/vitest/vitest.mjs run tests/receiving-bounded-publication.integration.test.ts tests/message-commands.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-active-reads.integration.test.ts tests/receiving-topology.integration.test.ts tests/receiving-flags.integration.test.ts tests/receiving-content.integration.test.ts tests/receiving-attachment.integration.test.ts tests/receiving-sent-copy.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-cache-publication.integration.test.ts
pnpm typecheck
pnpm lint
node node_modules/prettier/bin/prettier.cjs --check <changed supported files>
git diff --check
git diff --cached --check
```

The final focused run includes the added personal-namespace case. The two-file
acceptance run passed 109/109 before that last case; its unchanged 65 R04-C cases
remain part of the distinct regression count. Final focus exercises the finished
MOVE/repair code, including the terminal-selection filter. No existing negative
authority test was changed. SQL has no configured Prettier formatter and is checked
by actual migrations and integration execution.

Process-local Docker settings use
`DOCKER_HOST=npipe:////.\pipe\dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. JSON evidence is
retained outside the checkout in the TEMP folder recorded in the ignored
`.r14-evidence-location.log`; development/final logs use ignored `.r14-*.log` files.

Development failures are not counted as passing evidence: the first run could not
find Docker before Desktop started; new evidence initially spread an extra UID
field into the strict SQL certificate; a fixture disabled the wrong mailbox
trigger; an epoch fixture initially used the wrong persist shape; and a targeted
enrollment test needed an explicit existing-opportunity pass after keyset wrap.
Those implementation/fixture defects were corrected without weakening old tests,
increasing deadlines or retrying scheduler failures. The final focused and selected
regression runs have zero failures. No full application suite or Dovecot benchmark
ran.

## Remaining dependencies and limits

R15 retains due-demand settlement/live membership; R16 retains production registry
and coordinated receiving cutover; R17 retains continuous secondary synchronization
and destination inventory/history. Successful no-COPYUID MOVE can therefore leave
its destination metadata undiscovered until that authorized demand is serviced.
No full-mailbox repair or quiet-INBOX membership implementation from the historical
plan is added: the current request explicitly excludes R15 membership work.

Deterministic TLS peers and disposable PostgreSQL establish protocol/SQL behavior;
there is no live provider test or Dovecot benchmark. Arbitrary suspension of an
already admitted remote process retains the inherited retirement limitation: SQL
fencing cannot instantly retract an old remote socket. Server-rewritten/missing
identity evidence remains conservative uncertainty, without provider-specific hacks.

Stop after R14.
