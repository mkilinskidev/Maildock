# R17 Gmail runtime root cause

Date: 2026-10-17 (Europe/Warsaw). Branch:
`feature/imap-sync-r17-secondary-mailboxes`; starting HEAD:
`d91119797071d065f9e44b8793e502407d7da0c8`.

## Result and root-cause gate

Two independent, proven collector defects explain the reported stages:

| Operation                  | Original exception                       | Responsible invariant                                                                                             | Minimal correction                                                                                                          |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Content `download`         | `Error: Unexpected MIME header identity` | A MIME header was rejected after a body literal in the **same** FETCH because `this.offset` had already advanced. | Check the offset at entry to this FETCH, preserving rejection of headers arriving after an earlier body FETCH.              |
| STORE preflight `fetchOne` | `Error: Unexpected flag FETCH field`     | `FlagCollector` rejected the `X-GM-MSGID` attribute requested automatically by ImapFlow.                          | Allow the library's automatic `X-GM-MSGID` and `EMAILID` attributes; neither supplies UID, epoch, flags or MODSEQ evidence. |

Confidence: high for both specific failures. Both were reproduced against real
Gmail, and the corresponding reads succeeded with the corrected collectors in
an isolated process. This is not acceptance of a redeployed application or a
real Gmail STORE mutation.

## Installation and source verification

Initial command:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
```

`maildock-app-1` and `maildock-postgres-1` were healthy. Port 3000 is loopback
published. App container PID 1 supervises the Next server and PID 26
`node dist-worker/composition/worker-process.js`; PostgreSQL is database/user
`maildock`. No restart, rebuild or volume reset was performed.

The checkout was clean on starting HEAD. The running compiled collectors matched
the local pre-change compiled files byte-for-byte (SHA256):

- `receiving-content.js`: `863212cc79f2f3bc0aa377b46539e5f5e74e249c8db9228880d10776680ba806`
- `receiving-flags.js`: `fe356ac41d86a2cca2a5d088531a7adfa3cfa1195981ff29b864342c13867658`

Local `dist-worker/receiving-operation.js` was stale relative to the container;
its diff showed the OAuth hotfix diagnostics/capabilities additions present in
the container and current TypeScript source. Do not infer a deployed Git SHA
from image naming: there is no embedded Git revision available in this check.
The implicated collector implementations were verified directly.

## Live reproduction procedure and API observation

1. Query only internal bindings and status, never subject/address/body:

   ```sql
   select c.message_id, m.account_id, c.source_mailbox_id, c.source_uid,
          c.source_uid_validity, c.source_configuration_binding,
          c.status, c.error
   from message_contents c join messages m on m.id=c.message_id
   where c.status='failed' limit 1;
   ```

2. Selected message `5732d50f-0be4-4645-9e13-ea4471884c24`, UID `84343`, epoch
   `617834070`, configuration `1`. The source was taken from its durable binding.
3. The supported API is
   `POST /api/accounts/{account}/mailboxes/{mailbox}/messages/{message}/content`.
   `requireOwnerApiAccess` requires an owner session, verified MFA/readiness and
   an Origin exactly equal to configured `APP_ORIGIN`. Its normal accepted
   response is HTTP 202 with `{scheduled: boolean}`. Authentication was preserved.
4. The user signed in and executed the provided same-origin `fetch` in their
   authenticated browser. This was user-assisted: browser automation exposes
   read-only evaluation, and opening this unread message in the reader would
   auto-submit `mark_read` after two seconds. No cookies/session secrets were
   extracted, no preference was changed, and no reader was opened by the agent.
   The user confirmed execution; the HTTP status/body were not independently
   captured, so 202 is the route contract, not an observed response claim.
5. The running worker logged correlation
   `dde33380-2a3b-4301-96ae-11551b72ad4c`, `content-slice`, stage `download`,
   `remote_stage_failed`, elapsed `775.655 ms`; `receiving.publication` with the
   same correlation recorded `failure_result/published`. SQL showed the new
   attempt `72d77175-7f2d-452d-b5df-0738663cfc71`, status/error/phase
   `failed/failed_remote_read/failed_remote_read`, updated `07:40:13.564387 UTC`.
   The starting attempt was `441b5c37-f144-41e9-9a36-d55929305d37`.
   This establishes durable demand admission and failure settlement; individual
   scheduler/connection stages are not separately traced by that worker log.
6. To recover the lost exception, a temporary, separate Node diagnostic process
   inside the app container used the installed compiled `AccountsService`,
   `createOAuthComposition`, encryption composition and
   `resolveReceivingConnection` with captured configuration/lifecycle, deadline
   and AbortSignal. No credentials were printed. This may refresh OAuth through
   its normal rotation mechanism; successful refreshes were observed.
7. It created an owned, bounded ImapFlow client with the production collector,
   `disableAutoIdle`, `disableCompression`, content `disableBinary`, 32 KiB chunks,
   existing literal/response bounds and a 15-second diagnostic abort guard.
   It connected, opened the bound mailbox **read-only (EXAMINE)**, checked epoch,
   performed the production structure FETCH and selected-part `download`.
   Stream chunks were discarded; private content was never printed/exported.
8. A second fresh client ran the exact STORE preflight query
   `fetchOne(String(uid), {uid:true, flags:true}, {uid:true})` under EXAMINE.
   It issued no STORE. This intentionally does not test write selection or the
   real mutation; those are covered by disposable integration fixtures.

Local diagnostic scripts remain in the Windows temporary directory as
`maildock-r17-live-diagnostic.mjs` and `maildock-r17-fixed-live-diagnostic.mjs`.
They contain the selected internal binding, no credentials or retained message
content. They import the installed application modules, not the old engine.
Use `docker cp` to `/tmp/` and `docker exec maildock-app-1 node /tmp/<script>`
with `content` or `flags`. The fixed variant imports separately transpiled
`/tmp/r17-fixed-receiving-{content,flags}.mjs`; it does not replace worker files.
A temporary `/tmp/node_modules` symlink resolves installed dependencies. These
artifacts are diagnostic only and are not used by the application.

## Sanitized exception evidence and call chain

The wrapper catches at `receivingResponse` before ImapFlow consumes the error.
It projects only known local error messages, fixed exception/code categories,
source filename/line frames, allowlisted protocol attribute names, numeric byte
counts/partial offsets and boolean connection state. It never dumps provider
exceptions, raw IMAP responses, header strings, identity extension values or
message data.

Content evidence:

```text
EXAMINE succeeded; selected epoch matched.
UID FETCH fields: X-GM-MSGID UID RFC822.SIZE MODSEQ BODY BODY
BODY[TEXT]<0>: 32768 bytes, then BODY[HEADER]: 4150 bytes
expected section TEXT; headersSeen=false; offset already 32768
Error: Unexpected MIME header identity
receiving-content.js:225:35 -> imap-flow.js:781:45 -> imap-flow.js:689:31
usable=true; closed=false; selected=true; readOnly=true; aborted=false
```

STORE read evidence:

```text
EXAMINE succeeded; selected epoch matched.
UID FETCH fields: X-GM-MSGID UID MODSEQ FLAGS
Error: Unexpected flag FETCH field
receiving-flags.js:140:27 -> imap-flow.js:781:45 -> imap-flow.js:689:31
usable=true; closed=false; selected=true; readOnly=true; aborted=false
```

These are original local `Error` instances with no provider error code. After
the receivingResponse callback throws, the patched ImapFlow boundary emits the
error and closes the connection. The pending caller then receives
`NoConnection` (`tools.js:139:19`, `imap-flow.js:2108:52`, `2114:28`, `2234:37`).
The generic operation logger publishes only `remote_stage_failed`, obscuring
the first exception. Connection retirement is a consequence, not the initiating
failure. Neither capture was a timeout, abort, stale epoch or unusable connection.

Source chain: `ReceivingWorker` handler registration -> elected content/flag
admission -> `runReceivingOperation` credentials/claim/client ownership ->
`prepareReceivingContent` download or `prepareReceivingFlags` preflight ->
ImapFlow FETCH -> patched `receivingResponse` -> collector rejection -> error
listener/retirement -> operation catch -> SQL failure publication.

## Comparison with pre-v2 source

Historical V1 source at `8af87ff` (`feat: complete V1 application functionality`)
was inspected only; it was never connected to Gmail or the active database.
`fetchMessageContent` used `imapOptions`, connect, read-only mailboxOpen,
UIDVALIDITY validation and `download(uid, selectedPart.part, {uid:true,...})`.
Flag preflight requested UID/flags/MODSEQ through fetchOne. V1 used normalized
ImapFlow results and lacked these raw receivingResponse collectors. It therefore
did not impose header-before-body ordering or reject automatic identity fields.

V1 cleaned up with mailboxClose/logout/close; v2 retains typed retirement and
fencing. The implicated call signatures and authentication are compatible.
There is no evidence requiring changes to locks, timeouts, parsers, UID handling,
stream lifecycle, account lifecycle, OAuth safety or scheduler budgets.

ImapFlow 2.0.6 `commands/fetch.js` explicitly adds EMAILID when OBJECTID is
advertised, otherwise X-GM-MSGID for X-GM-EXT-1, independently of query options.
The previous flag fixture advertised neither capability. The previous content
fixture returned body fields in request order (headers first). Thus neither
real-provider behavior was represented by the earlier synthetic suite.

## Minimal correction and validation

Only two production collectors changed. Content snapshots the offset at FETCH
entry; duplicate headers, wrong sections, partial headers, headers after a prior
body FETCH, byte limits, offsets, completion and UID checks remain enforced.
Flags permits only the two automatic identity field names in addition to its
existing fields; frozen source and MODSEQ/flag validation remain authoritative.
No W/C/D, durable demand, OAuth, mutation uncertainty or fencing logic changed.

Four integration regressions were added using synthetic data:

- Gmail body-before-header with 100-byte and 40,000-byte bodies (same-response
  EOF and multiple chunks), with Gmail capability/identity metadata.
- Gmail X-GM-MSGID and OBJECTID EMAILID through actual ImapFlow preflight,
  disposable STORE and readback, with CONDSTORE preserved.

Before production edits: **4 failed**, both content cases at download and both
flag cases at fetchOne, matching the live failure stages. After correction:
**4 passed** (98 unrelated cases deselected), 18.34 seconds, exit 0.

The fixed collectors were separately transpiled into temporary modules and
loaded in a fresh diagnostic process with the installed ESM ImapFlow. Real Gmail
content streaming plus collector/MIME validation passed; a separate flag FETCH
passed. Content was discarded, no ready result was published by that wrapper,
and no real flags were changed. The running worker continues using old code.

Final focused run: **130/130 passed**, four files, zero skipped or unhandled
errors, **137.18 seconds**, exit 0. It includes full content and flags suites
(cancellation, deadlines, ownership, retirement, corruption, fencing, uncertain
STORE and MIME cases), plus adapter lifecycle and ImapFlow charset regressions.

```powershell
$env:DATABASE_URL='postgres://blocked:blocked@127.0.0.1:1/blocked'
node node_modules/vitest/vitest.mjs run tests/receiving-content.integration.test.ts tests/receiving-flags.integration.test.ts tests/imap-client-lifecycle.test.ts tests/imapflow-download-charset.test.ts --maxWorkers=1 --no-file-parallelism
```

All database tests provision disposable containers; the environment guard rejects
accidental default live-database access. Evidence:
`$env:TEMP/maildock-r17-root-cause-focused.log`.

Additional ownership/deadline selection in
`tests/receiving-admission.integration.test.ts`: **3 passed**, 17 deselected,
**7.73 seconds**, exit 0. Cases: cancellation holds W/C until socket/handler
retirement, deadline retains capacity until settlement, and shutdown waits for
retirement without reusing the old client. Run with the same guard/serial options
and `-t 'cancellation holds W|deadline signals cancellation|shutdown waits for typed retirement'`.
Evidence: `$env:TEMP/maildock-r17-root-cause-ownership.log`.

Application and worker TypeScript checks, changed-file ESLint, Prettier and
`git diff --check` passed. No complete 2000+ test suite was run.

## Deployment and controlled retest

Redeployment **is required**. No live application fix is claimed. After user
approval, build/recreate only the app, preserving volumes/PostgreSQL:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml build app
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-deps app
```

Then retry one original content demand through the authenticated same-origin
POST, capture HTTP 202/scheduled, correlate its new operation/attempt, and check
SQL `status=ready` without printing content. Avoid the reader's automatic
mark-read behavior. A live STORE acceptance test requires explicit permission
to change the chosen real message's flag; no such mutation was executed here.
The isolated STORE/readback regressions and read-only Gmail preflight are
separate evidence, not a live STORE success claim. The original failed demand
remains failed until redeployment/retry. No full-suite green claim is made.
