# Stage 2 results — one isolated INBOX metadata window

Date: 2026-10-12. **PASS — isolated Stage 2 complete.** One explicitly invoked
INBOX window obtains complete IMAP evidence and publishes metadata plus history
coverage through Stage 1. The component is unwired: no scheduler, account cutover,
worker registration, global UI query changes, body downloads or Stage 3 work.

## Git and scope

The clean local base was `feature/imap-sync-stage-1-persistence`, actual HEAD
`8c1ec94b8feb69004bf432e8ac87ceba2a6a6876`. Current HEAD and the named base matched;
the ancestry check succeeded before creating `feature/imap-sync-stage-2-window`.
The configured remote is `git@github.com:mkilinskidev/Maildock.git`. No push, merge
or PR was performed. No configured user account or application database was used.

Implementation commits:

- `f97c848d8538fa3ffd72e52e2db0d8912d254ba7` — owned bounded IMAP transport,
  additive dependency adaptation and real-client tests.
- `ceb1173f0943125128a7a4fb3ac8738c418350ff` — fenced one-window publication,
  bounded placement prefetch and PostgreSQL integration tests.

## Changed files

| File                                                           | Purpose                                                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/accounts/infrastructure/imap-metadata-window.ts`  | Exclusive owned-client transport, bounded SEARCH/FETCH, raw and normalized evidence validation, absolute deadline and cancellation.                                                              |
| `src/modules/mail/application/receiving-inbox-window.ts`       | Explicit Stage 1 recovery/initialization/history publication; no orchestration.                                                                                                                  |
| `patches/imapflow@2.0.6.patch`                                 | Additive receiving boundaries, native-close observation, receiving-only FETCH settlement, and five BODYSTRUCTURE extension boundary corrections in both ESM/CJS. Existing STORE patch preserved. |
| `pnpm-lock.yaml`                                               | Updated patch hash only; ImapFlow remains 2.0.6.                                                                                                                                                 |
| `src/modules/mail/application/receiving-persistence.ts`        | Bounded exact-set placement prefetch under the existing authority/mailbox lock.                                                                                                                  |
| `src/modules/mail/application/message-metadata-persistence.ts` | Optional receiving placement snapshot; legacy callers retain their per-record lookup.                                                                                                            |
| `experiments/imap-transport/fixture.ts`                        | Additive endpoint/capability exposure for reusing the scripted TLS peer.                                                                                                                         |
| `tests/fixtures/imap-metadata-peer.ts`                         | Small metadata scripts using that existing TLS fixture and actual installed ESM/CJS clients.                                                                                                     |
| `tests/fixtures/receiving-response-relay.ts`                   | Stage 1's raw reply-loss technique, without a PostgreSQL protocol parser.                                                                                                                        |
| `tests/imap-metadata-window.test.ts`                           | 40 focused real-client transport tests.                                                                                                                                                          |
| `tests/receiving-inbox-window.integration.test.ts`             | 15 focused disposable PostgreSQL integration tests.                                                                                                                                              |
| This report                                                    | Implementation, verification, limitations and next-stage readiness.                                                                                                                              |

## Exact operation and connection lifetime

The caller supplies resolved credentials/configuration, a Stage 1 owner and an
already provisioned mailbox UUID. This API neither resolves credentials nor
enrolls a real account. For an initialized mailbox, `recoverReceiving` obtains
authoritative epoch/revision/F/E/R under Stage 1's conflicting locks before IMAP;
that short transaction ends before connecting.

Each invocation constructs its own ImapFlow client using the existing
`imapOptions`: password/OAuth and TLS/STARTTLS settings remain intact. Normal
ImapFlow setup may issue CAPABILITY, authentication and namespace/LIST/ENABLE
control commands. Compression and automatic IDLE are disabled. The data flow is:

1. `getMailboxLock("INBOX")` issues a fresh **SELECT INBOX**. Observe correlated
   parsed tagged OK and explicit UIDVALIDITY/UIDNEXT response codes; reject absent,
   duplicate or invalid identity evidence. Do not derive B from EXISTS or local
   rows. Compare the selected epoch with saved receiving state.
2. Let E be saved `historyBefore`, or the selected UIDNEXT for a new mailbox.
   For E > 1, set `high=E-1`, `low=max(1,high-127)` and issue
   `UID SEARCH UID low:high`. Require exactly one valid SEARCH response, including
   an explicitly empty one, and the matching tagged OK. The newest numeric range
   is selected; message dates never determine membership.
3. For nonempty SEARCH, issue one UID FETCH for exactly the returned identities.
   ImapFlow packs the explicit set into sequence syntax. Request UID, FLAGS,
   ENVELOPE, INTERNALDATE, RFC822.SIZE, BODYSTRUCTURE and
   `BODY.PEEK[HEADER.FIELDS (REFERENCES)]`; negotiated MODSEQ/provider identity
   fields may also be returned. There is no body-part/source fetch.
4. Exhaust the iterator and await actual background FETCH settlement and tagged
   OK. Validate the selected epoch again. Release the lock only after successful
   work has settled, then destroy the owned client and await native socket close.
   Healthy clients are retired too; this stage intentionally has no reuse pool.
5. Only after transport retirement enter PostgreSQL. For a new empty mailbox,
   initialize `E=UIDNEXT`, `F=UIDNEXT-1`, `R=0`, revision 0 through Stage 1, then
   recover that state. Publish complete metadata and E=low with one guarded
   history transaction, incrementing revision. Initial state proves no coverage;
   initialization and history publication are separate safe transactions.

An initialized exhausted mailbox is selected/validated but has no history
transaction. A new UIDNEXT=1 mailbox initializes to E=1/F=0 without searching a
reversed interval. Sparse and verified empty intervals advance E normally. There
is no automatic continuation. Fresh SELECT bypasses the previously demonstrated
stale selected-folder STATUS cache; STATUS and public NOOP are not used as epoch
or UIDNEXT evidence here.

## Evidence, limits and cancellation

The pinned package's synchronous `receivingResponse` boundary runs before handler
dispatch, lossy formatting and compact ESEARCH expansion, exposing parsed response
and active sent request identity. Exceptions terminally fail the client. SEARCH
UIDs must be distinct, numeric, in the closed interval and at most 128. ESEARCH is
explicitly unsupported and rejected before expansion; an absent SEARCH response
is never an empty interval.

Requested metadata must have one complete raw and normalized identity-matching
record per searched UID. Duplicate fields/UIDs, unexpected identities or sections,
missing fields, invalid numeric data, malformed envelopes/MIME descriptors,
parser diagnostics and missing FETCH results reject the entire window. Missing
UIDs are unresolved; no confirmed absence is invented. Legal FLAGS/MODSEQ/UID-only
and empty sequence FETCH notifications are validated, bounded by input bytes and
filtered before formatting. They are hints with no metadata/coverage authority.
Existing `normalizeMessage` remains the metadata normalization path.

Limits are fixed for this initial operation:

- K=128 sizes the numeric work interval and accepted identities, not parser token
  allocation.
- 256 KiB per response, line and literal; the whole-response cap includes declared
  literals, so an oversized candidate is rejected before its literal allocation.
- 2 MiB aggregate decoded SEARCH/FETCH input, with 64 KiB separately bounded setup
  control traffic. Each chunk is charged in full before the stream retains or
  parses it. Normalized metadata also has a 2 MiB cap, plus Stage 1's own checks.
- The installed parser enforces nesting depth 25. The MIME validator adds a
  recursion guard before normalization.
- A caller-supplied absolute `performance.now()` deadline has at most 10 seconds
  remaining; it spans connection/authentication, SELECT, SEARCH, FETCH, retirement
  and publication. Every DB transaction receives the lesser of 2 seconds and that
  remaining deadline, starting before admission. There is no per-command reset.

These are input/evidence bounds, **not a 2 MiB heap or RSS guarantee**. The current
TLS chunk already exists before the byte hook. Node/TLS/kernel buffers and stream
backpressure retain native overhead independently. ImapStream assembles payload
and literal Buffers; token parsing creates strings, token objects, arrays and
copies; normalization/JSON validation creates additional structures. Byte-derived
token amplification is permitted within a capped response. Neither strict K
token allocation nor a measured whole-process memory ceiling is claimed. Global
memory admission and provider-specific caps remain later integration gates.

AbortSignal cancellation invalidates the scope before destructive retirement.
The timer and boundary guards also check the absolute clock and caller's
`assertCurrent`; network trickle cannot renew the deadline. A caller revoking a
turn while DB work is active must abort the same signal as well as revoke its
guard. Stage 1 then enforces scoped DB lifetime and durable owner/epoch/revision
authority at logical COMMIT point L. An acknowledged COMMIT remains a fact;
cancellation cannot retroactively undo it. Responsive event-loop execution is
required for prompt timers: synchronous CPU stalls/process suspension remain
disclosed limitations, not unconditional wall-clock guarantees.

Warn/error/fatal logger diagnostics and public error events fail the exclusive
operation closed, preserving the underlying error where supplied. This may reject
benign provider warnings conservatively. Native close proves local retirement,
not immediate server-side session disappearance. Failed or uncertain clients are
never reused.

## Small compatibility corrections

The original dense 128-record integration exceeded the unchanged 2-second DB
budget with Stage 1's per-record placement SELECTs. Under `claimReceiving`'s
existing mailbox lock, Stage 1 now preloads only the exact validated metadata UID
set (at most 128) in one query. The original metadata/attachment/conversation/flag
and notification write branches are reused. The tested existing-placement case
preserves placement/message identity and newer MODSEQ flags. No executor,
authority, schema, transaction, revision or frontier guards were weakened.

A separate retained test initially failed because ImapFlow's BODYSTRUCTURE
formatter used `i < node.length - 1` for five optional extension fields. A legal
last disposition/filename was silently dropped and persisted as null. The narrow
ESM/CJS patch changes those five checks to `i < node.length`. The actual installed
entry points now preserve that filename/disposition; normalization functions are
unchanged. Multipart attachment descriptors persist without body/blob readiness.

The additive FETCH adaptation awaits its background command in receiving-mode
iterator cleanup. Early exit closes the client before waiting; successful
exhaustion awaits command settlement without premature close. Existing consumers
without receiving hooks retain their existing iterator behavior. The STORE hunks
are preserved unchanged in substance, and conditional STORE regressions pass.

## Persistence and uncertain COMMIT

All writes use `ReceivingPersistence.initialize/persist`, with expected state
obtained through Stage 1 recovery. Metadata and E/revision are one atomic guarded
publication. Historical windows do not emit arrival notifications. Existing
conversation membership, version-aware flags and attachment descriptor semantics
remain in the shared persistence helper. No IMAP I/O holds a PostgreSQL transaction.
No new read route exposes these records through UI cutover.

The real lost-COMMIT test holds a deferred fixture trigger after Stage 1 authority,
drops reply bytes through a raw relay, releases the barrier and independently
observes the durable outcome. The invocation raises `ReceivingUnresolvedError`;
fresh Stage 1 recovery under conflicting locks obtains revision 1/E=129 and the
two placements. There is no automatic blind replay or assumption that socket
close means rollback. Unknown initialization likewise requires Stage 1 recovery
before retry; callers must determine durable enrollment state rather than repeat
`initialized=false` blindly.

## Validation results

Tests use the real installed ImapFlow/parser/compiler and the existing scripted
TLS fixture. Certificate verification is disabled only by the test factory for
its synthetic certificate; production `imapOptions` retains verification.
Password and XOAUTH2 setup are exercised. PostgreSQL integration always creates
its own `postgres:17.6-alpine` container, migrates the real journal and uses an
ordinary schema-owning role; it deliberately ignores `TEST_DATABASE_URL`.

| Check                                                                                                   | Result |
| ------------------------------------------------------------------------------------------------------- | ------ |
| Dense 128; sparse; complete empty; exhausted UIDNEXT=1                                                  | PASS   |
| Exact metadata; missing/duplicate/unexpected UID/field; malformed envelope/MIME/header/flags; nesting   | PASS   |
| Absent SEARCH versus explicit empty; malformed/duplicate SEARCH; ESEARCH rejection                      | PASS   |
| Epoch mismatch, UIDNEXT regression/missing evidence, fresh SELECT instead of stale STATUS               | PASS   |
| Legal flag-only and sequence-only notifications                                                         | PASS   |
| Tagged FETCH delayed; hung SELECT/SEARCH/FETCH; trickle; cancellation; revoked turn before publication  | PASS   |
| Single-response and aggregate input rejection                                                           | PASS   |
| Atomic Stage 1 metadata/frontier; aborted existing/new mailbox; saved revision/E; newer flags preserved | PASS   |
| Actual lost COMMIT reply and locked recovery                                                            | PASS   |
| Minimal and multipart attachment metadata; installed ESM/CJS MIME extension behavior                    | PASS   |
| Conditional STORE and client lifecycle regressions                                                      | PASS   |
| Pristine 2.0.6 patch application; installed ESM/CJS equality including STORE/tools                      | PASS   |

The broad regression command covered the two new files plus receiving safety,
retirement, conditional STORE, client lifecycle, incremental/backfill providers,
core platform, incremental/backfill integration, conversations and attachments:
**269 tests passed in 13 files** before the last MIME compatibility correction.
After that correction, the focused window/receiving tests plus conditional STORE,
download charset, sent-copy provider and attachment integration selection passed
**160 tests in six files**. The final additional selection (40 transport tests,
attachment provider/MIME, message-content provider, mail provider, outgoing
MIME/provider and message-actions provider) passed **111 tests in eight files**.
The final new-test total is **55 passing cases**: 40 transport and 15 PostgreSQL
integration cases; the selections overlap and their counts must not be added as
unique tests.

`pnpm typecheck`, `pnpm lint`, changed-file `pnpm exec prettier --check` (including
the report and lockfile), and `git diff --check` all passed. Lint has no remaining
warnings. Final patch application was checked against a pristine pinned package
and every changed runtime/type file matched the installed ESM/CJS entry points,
including STORE and BODYSTRUCTURE tools.

Focused reproduction:

```powershell
pnpm exec vitest run tests/imap-metadata-window.test.ts tests/receiving-inbox-window.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/imap-conditional-store.test.ts tests/imap-client-lifecycle.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
```

Earlier failures were not waived: test setup used a nonexistent references column
and an incorrect string-length assertion; both were corrected to inspect the real
schema. The dense DB deadline failure and real last-disposition loss prompted the
small fixes above. Failed scopes retained unchanged coverage or rolled back.

Not run: full repository test suite, new Dovecot benchmark, 50,000-message or
ten-minute load tests, live Gmail/Outlook/user accounts, multi-folder or worker
integration, body/content/mutation cutover, global resource/fairness validation.
Existing unrelated whole-repository formatting debt was not reformatted.

## Compatibility risks and Stage 3

ESEARCH/IMAP4rev2-only SEARCH responses, oversized metadata, excessive MIME nesting,
malformed text structures and diagnostic-producing providers are explicit rejected
inputs, with no progress. Provider tolerance, broad real-server compatibility,
memory plateau, global socket admission, sparse-gap performance and scheduler
policy remain later gates. The single fresh-client operation avoids stale selected
STATUS; a future reusable owner must preserve refresh evidence when reusing clients.

**Stage 3 can begin as isolated implementation against this supported transport
contract.** This report does not approve account cutover or production release and
does not start Stage 3. Stop condition is satisfied: exactly one bounded INBOX
metadata window can be fetched and atomically persisted correctly.
