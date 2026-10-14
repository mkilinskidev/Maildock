# R02 — Durable business intents

2026-10-14. **PASS for R02 request creation and projection only.**

Base: `5adda9a04e421b0bf69f4c626adac6faa51f76a5`, from
`feature/imap-sync-stage-4c-worker`. Implementation branch:
`codex/r02-durable-business-intents`. No receiving worker activation, remote
execution, push, merge, PR or R03 work is included. Stage 4C remains blocked on
its other prerequisites.

## Intent-only authority

Append-only migration `0038_receiving_business_intents.sql` extends the existing
Stage 1 guard with C1 field allowlists. It retains the original authoritative
guard and deferred checks; it introduces no bypass setting, unrestricted owner
context, security-definer privilege escalation, new intent table or work ledger.
The generated schema snapshot changes only the six affected existing tables
and describes the existing SQL read view.

The shared SQL source validator locks the enabled account in SHARE mode, then
the source mailbox and placement in UPDATE mode. It verifies mailbox/message
account ownership, selectable/active lifecycle, UID range, current mailbox and
receiving epoch, and configuration binding. An account with any receiving
enrollment cannot fall back to an unenrolled secondary placement. Account SHARE
is never upgraded to UPDATE to record demand.

Minimal additive configuration versions support that request predicate:
initialization freezes the current account version on receiving state; Stage 1
metadata insertion binds placements and attachment descriptors to that state.
IMAP endpoint, credential, authentication and OAuth identity/status changes
increment the account version. Requests reject retained facts after a version
change. Full lifecycle/grant versions, turn admission, rebinding, account deletion
and recovery remain R08/R09; this is not acceptance of those later capabilities.

| Row        | Permitted enrolled request operation                                                                                            | Still forbidden to request code                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Command    | Insert pending with validated frozen source, action, original flags and mapped MOVE destination                                 | Execution/status/result updates, attempts, result UID/epoch, canonical placement flags/MODSEQ/hidden state |
| Content    | Insert pending with null payload and validated source; retry not_fetched/failed with status/error/time and validated provenance | Ready overwrite, in-flight retarget, fetching/ready, body/search/HTML/policy/fetch results                 |
| Attachment | Existing not_fetched/failed to pending, changing only status/error/time                                                         | Descriptor insertion, MIME/part/source/configuration retarget, blob or result fields, fetching/ready       |

Content and attachment UPDATE allowlists compare the complete old/new row after
removing explicitly allowed columns. Unexpected or future authoritative fields
remain forbidden. Pending content insertion and unchanged-payload updates make
the search-body trigger a no-op, preserving existing derived body text.

## Application behavior and projection

`MessageCommandService.create` uses active receiving placement identity instead
of the retired recent-sync readiness field for enrolled accounts. It serializes
requests on the source and preserves the original command ID when an identical
pending/executing action is requested again. Conflicting actions are rejected;
a partial unique source index additionally prevents competing bound commands.
It never updates canonical flags or hiding on the enrolled path.

The read-only `message_placement_projection` view applies desired Seen/Flagged
changes to the current canonical flags, rather than replaying the original flag
array. Pending/executing archive/trash hides the source. Failed commands,
including cancellation represented by the existing failed state, cease to
project. Lists, all-INBOX lists, detail, search, conversation reads/counts and
synchronized mailbox counts consume this projection. An enrolled hidden source
cannot be opened through detail. A newly received unrelated flag survives
terminal removal of the optimistic projection.

`MessageContentService.request` invokes the narrow SQL content request operation.
It returns true for a newly persisted pending request and false for coalesced or
ready work. It retains a ready result even when its HTML policy is old. Enrolled
detail reads existing descriptors and never creates them. The content row now
retains source mailbox/epoch/UID/configuration for wake-loss reconstruction.

`AttachmentService.request` invokes the narrow attachment request operation and
preserves its existing public return shape. It validates the frozen descriptor
source and changes only permitted request fields. Pending/fetching duplicates
coalesce; ready cache is not invalidated or stripped of its blob by request code.
Local staged draft uploads keep their original blob/storage behavior.

Routes retain owner authentication, path validation and their existing response
shapes/statuses. Locked SQL validation failures become existing service domain
errors, which the routes already map to unavailable/conflict responses.

Wholly unenrolled fixtures retain the existing request/execution behavior.
Enrolled request producers send only receiving account wakes, never legacy
business execution jobs. Legacy command/content/attachment run paths refuse
enrolled work before provider I/O, and attachment repair emits an account hint
for enrolled rows. This does not register a new consumer or authorize production
dual-engine routing.

## Atomic demand and wake

Successful intent guards call the existing Stage 4A
`maildock_receiving_request(account, mailbox)` inside the same PostgreSQL
transaction as the intent. The mailbox due/generation update and business row
therefore commit or roll back together. Identical coalesced work retains the
original pending row and generation. Retrying failed content advances generation
once, without INSERT/ON CONFLICT firing two demand increments.

After commit the web assembly's transport-only `PgBossReceivingWakeProducer`
sends a best-effort account wake. It does not record demand a second time.
Queue errors are swallowed without changing the intent. Actual duplicate and
completed pg-boss jobs leave all business rows and due/generation untouched.
Repair eligibility now also includes pending/fetching attachment rows. No
database transaction spans queue delivery, filesystem access or IMAP/network I/O.

## PostgreSQL evidence and negative controls

The extended `receiving-cutover-boundary.integration.test.ts` has **26 passing
R02/control scenarios**, using disposable PostgreSQL 17.6, a non-superuser
database owner, all actual migrations, application service APIs, actual pg-boss
and an independent postgres.js reader. Complete canonical message, placement,
mailbox and receiving-state rows are compared separately from expected demand
changes.

Verified cases include concurrent command and content deduplication, conflicting
pending/executing commands, Seen/Flagged/MOVE projection, fresh canonical flags
surviving terminal projection removal, read-only detail, exact content and
attachment provenance, ready-result retention, failed retry, missing/foreign/
secondary/stale-epoch/stale-configuration sources, local staged upload, and
committed requests surviving real pg-boss sends to a nonexistent queue. Wakes
are fetched and completed through pg-boss, with independent checks proving
that ACK does not complete the intents.

Actual SQL guards reject canonical flag/hidden/MODSEQ writes, pending insertion
with body payload, content ready/body/search publication, attachment fetching,
blob/part/source changes, command executing/attempt/result updates, and stale
frozen sources. Mixed operations roll back the intent and its demand together.
Stage 4C legacy LIST and secondary metadata publication remain failing negative
controls. The original request-blocker assertions changed only for the four
approved request cases; their forbidden-write coverage remains explicit.

Terminal/ready fixture states are seeded with explicitly scoped database-owner
DDL and immediate constraint checks. Those seeding operations are not available
through application services and do not claim that owner result publication has
been implemented. Enrolled canonical flag updates used to test projection
failure are published through the actual Stage 1 receiving persistence API.

## Validation

**237 distinct selected tests passed across 11 files.** The selected regression
run passed nine files / 203 tests, then exposed the historical global-search
fixture's use of the newest schema before the final migration. Its placement
helper now seeds the same legacy columns through SQL; no assertions changed.
The final affected-file run passed **61/61**: R02 26, search 8 and conversations
27 (the conversations overlap the 203-test regression result).

The selected regressions cover Stage 1 safety/retirement, Stage 4A wakes,
commands, attachments, outgoing messages, conversations, search, sent-copy jobs
and worker logging boundaries. Application/worker typecheck, repository lint,
changed-file formatting and whitespace checks are recorded before the commit.
No broad suite, provider connection or integrated worker cutover ran.

On Windows the disposable tests require the Linux engine and an unnormalized
named-pipe path. Process-local settings were:

```powershell
$env:DOCKER_HOST='npipe:////.\pipe\dockerDesktopLinuxEngine'
$env:TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
```

Initial runtime attempts stopped before fixtures because the default engine
used Windows containers; ordinary URL dot normalization also made Testcontainers
fall back to that engine. These are explained environment failures, not SQL
acceptance evidence. Test development also corrected repair-page wrap and
deferred-trigger seeding mistakes, and replaced a host-clock assertion with an
independent PostgreSQL-clock due check. A baseline attachment regression exposed
Drizzle's nullable-first-column join mapping: provenance columns now follow the
existing row identity. Bigint defaults use SQL literals so Drizzle Kit can
generate the snapshot. No timeout or authority check was relaxed.

Local final test logs: `$env:TEMP/maildock-r02-final-focused.log` and
`$env:TEMP/maildock-r02-regressions.log`. The latter retains the explained search
fixture failure after its nine successful regression files.

## Deferred dependencies

R03 owns admission and selector operation types; R04 owns fenced intent claims,
terminal/result CAS and multi-mailbox publication. R10 executes STORE and later
MOVE dependencies; R11 retrieves/finalizes content; R12 downloads/publishes
attachments. Full cache/read provenance, body-only search filtering and compose
references remain R05. Existing retained stale cache is not claimed to satisfy
that later complete read contract. R08/R09 complete lifecycle and credential
admission. R02 provides durable requests and optimistic projection only.

**Stop after R02.**
