# R07 — Elected mailbox topology and destination identities

2026-10-15. **PASS for isolated R07.** Receiving capabilities only;
production worker registration remains deferred to R16.

Base: accepted R06 `feb99f3998b60391e5412bc23af8fe469a03766f`.
Branch: `feature/imap-sync-r07-mailbox-topology`.

## Admission and complete LIST evidence

`receivingTopologyHandlers` provides trusted `list` and `select` descriptors for
the existing `ElectedReceivingCoordinator` registry. Submitters provide typed
operation envelopes, never clients or callbacks. The existing scheduler owns
W/C/D, account exclusion, fresh/history priority, cancellation and the ten-second
absolute operation lifetime. There is no new polling loop, transport, discovery
executor, worker registration or durable queue. Discovery runs on explicit LIST
admission; it is not added to every receiving turn.

Preparation captures the account configuration, lifecycle, entire bounded mailbox
and receiving-state identity, and complete role rows through actual R04
`maildock_receiving_topology_capture`. This commits before constructing the owned
IMAP client. Each operation uses one existing owner-controlled ImapFlow client.
All remote work completes and the native socket retires before result SQL.

The narrow adapter issues exact `LIST "" "*"`. It bypasses the installed
adapter's namespace-prefix insertion, localized-name role guesses and XLIST/LSUB
fallbacks, while using its installed command runner, parser, bounded raw hooks
and transport retirement. SPECIAL-USE return metadata is requested when supported.
OBJECTID plus LIST-STATUS requests only `STATUS (MAILBOXID)` inline. OBJECTID
without LIST-STATUS uses at most 128 sequential, correlated identity-only STATUS
commands on the same socket and within the same operation/byte limits. This
follows [RFC 8474, sections 4.2–4.3](https://www.rfc-editor.org/rfc/rfc8474.html#section-4.3).
No STATUS message counts, UID inventories, SEARCH, FETCH or content are loaded.

Raw observation validates the actual sent request tag and successful tagged OK
before constructing correlated complete-namespace SQL evidence. Invalid numeric
or string shapes, null bytes, malformed delimiters/flags/encoding, duplicate paths
(including INBOX case aliases), duplicate provider identities, unmatched STATUS,
failed/partial command completions and parser diagnostics fail the operation.
There is no fallback publication of a collected prefix.

Bounds are 128 observed identities and 128 identities in the union of retained
and observed folders, 2 MiB aggregate raw operation input, 64 KiB per parsed
response/line and the existing 2 MiB normalized SQL evidence/snapshot bounds.
Oversized topology is an explicit error; missing retained folders still count
toward the union. Cleanup beyond this bound needs later lifecycle work rather
than silently dropping identities. SQL transactions remain bounded to two seconds
within the original operation deadline.

## Atomic publication, identity and roles

Completed LIST uses the unchanged R04 topology result function. Its existing
coordinator SHARE, discovery/role advisory mutex, account UPDATE, UUID-ordered
mailbox/state and role locks compare the captured snapshot and publish additions,
metadata changes, evidenced missing/nonselectable transitions and eligible
autodetection atomically. The accepted Stage 1/R04 guards, SQL allowlists, tables,
indexes and migrations are unchanged.

Existing receiving epoch, configuration binding, F/E/R, placements and remote
caches are preserved. R04 advances each existing enrolled scope's revision once
for a successful topology publication. New LIST identities remain unenrolled.
Failed LIST and stale captured identity publish nothing, including no missing
transition. Account/mailbox due timestamps and generations remain durable; R15
owns settlement.

INBOX paths normalize to canonical `INBOX`. Unambiguous existing provider IDs
retain the UUID across rename, including missing/reactivated folders. Active
path-only matches retain identity at that exact path. A path-only rename creates
a new UUID and marks the old folder missing. A missing path-only folder that
reappears receives a new UUID. A changed stable provider ID creates a different
secondary identity rather than transferring coverage. Conflicting canonical INBOX
or ambiguous stable identities fail closed; LIST cannot replace an enrolled epoch
or silently transfer an INBOX provider identity. SELECT and lifecycle work must
resolve such a conflict before discovery can proceed.

All five product roles (Sent, Trash, Archive, Drafts, Junk) retain the existing API
and UI shapes. Automatic mapping uses explicit, case-normalized server special-use
flags and requires exactly one active selectable candidate. Names alone do not
create mappings. Manual rows always win, even when their destination becomes
missing/nonselectable; the existing role view reports them unavailable. A manual
change during LIST/SELECT invalidates publication. Existing R04 MOVE/APPEND
attempts retain frozen role/destination bindings and are not retargeted by LIST.

## Targeted secondary selection

Typed `select` admission requires an exact account/configuration/mailbox UUID and
may bind a product role. Preparation verifies active/selectable topology and,
when supplied, the exact manual or unambiguous automatic role mapping. Its owned
adapter issues one exact-path read-only EXAMINE, including modified UTF-7 encoding
and paths outside the personal namespace, without an implicit folder LIST.

Correlated tagged OK, explicit bounded UIDVALIDITY/UIDNEXT/EXISTS and agreement
with a stored provider MAILBOXID establish selected evidence. Duplicate/missing
numeric codes, impossible EXISTS, provider mismatch or same-epoch UIDNEXT
regression below committed coverage fail. After socket retirement the existing
R04 capture is rechecked under the same locks, in the transaction that invokes
existing Stage 1 initialization or R06 epoch/configuration replacement.

New enrollment is revision=0, F=UIDNEXT−1, E=UIDNEXT, R=0. Replacement advances
revision once with empty new-identity coverage. A validated unchanged identity
does not advance revision or manufacture progress. Existing nonempty legacy
enrollment restrictions remain. No message rows or ordinary interval coverage
are fetched, and recent/delta/backfill statuses remain `not_started` for a new
targeted destination. This capability prepares R13/R14 publication; it does not
claim secondary synchronization, history or membership repair. R17 owns those.
Future operation execution must still claim its current frozen scopes/role and
validate its own remote outcome; enrollment is not a durable execution permit.

## Crash, uncertainty and recovery

Independent PostgreSQL readers verify whole-account folder/role/state/demand
snapshots before and after faults. Explicit protocol gates coordinate edits,
cancellation and takeover. Deferred COMMIT triggers plus observed PostgreSQL
advisory waits coordinate publication crashes and actual dropped replies; fault
ordering does not depend on arbitrary sleeps.

Backend termination before COMMIT rolls back all topology and roles. A lost
publication reply triggers a separate read-only R04 capture under conflicting
locks on the same executor admission path, after socket retirement. Recovery
checks complete equivalent topology, roles and exact one-step enrolled revisions;
selected recovery checks the expected identity/revision/coverage and current role
and lifecycle. It never resends old evidence or opens another IMAP connection.
Unchanged, superseded, canceled, expired or otherwise unproven outcomes remain
unresolved and retain due demand. Restart captures persisted topology and reuses
UUIDs; R06 remains responsible for normal INBOX bootstrap/receiving.

## Resource cost and remaining dependencies

Normal LIST costs one owned connection, authentication/namespace control traffic,
one complete LIST, one bounded capture transaction and one bounded result
transaction. OBJECTID without LIST-STATUS adds up to one identity-only STATUS per
selectable folder. Uncertain outcomes add one locked recovery capture. Work and
storage scale with the bounded folder set, not message count. Targeted enrollment
costs one owned connection/EXAMINE and two bounded database transactions; it does
not periodically poll destinations. No new services, caches, indexes or ledgers
are introduced. The adapter intentionally depends on the pinned installed
ImapFlow command runner and raw hook contract, covered with real protocol fixtures.

Unrecognized LIST extensions, conflicting/withdrawn stable identities, excessive
folder cardinality/bytes and populated legacy conversion are explicit bounded
refusals. Safe path-only continuity cannot distinguish an unseen delete/recreate
without selected epoch evidence; SELECT replaces coverage when that epoch changes.
Large-account cleanup/removal and lifecycle orchestration remain R08; targeted
business outcomes remain R13/R14; demand reconciliation remains R15; production
cutover remains R16; ordinary secondary synchronization remains R17. No R08 work,
push, merge or PR is part of this change.

## Validation

All integration fixtures use disposable PostgreSQL **17.6**, actual repository
migrations/R04 SQL, an ordinary non-superuser schema owner and independent
postgres.js verification. R07 tests submit through actual elected R03 admission
and use the installed ImapFlow parser/command runner over deterministic TLS peers.

| Check                                            | Result                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Final R07 topology integration file              | **45/45 passed**, including actual topology and secondary-enrollment lost-COMMIT reply recovery |
| Ten-file Stage 1/R03/R04/R06/role regression run | **238/238 passed**                                                                              |
| Application and worker typecheck                 | Passed                                                                                          |
| Repository lint                                  | Passed                                                                                          |
| All six changed supported files, Prettier check  | Passed                                                                                          |
| Working and staged `git diff --check`            | Passed                                                                                          |

The regression run includes receiving safety, admission, election, retirement,
publication, cache publication, bounded publication, claim-phase, INBOX bootstrap
and mailbox-role files. This covers the existing W=1/2/4, D=1/2 admission and
fresh/history ordering, R04 frozen MOVE/APPEND role/scope authority and R06 epoch
isolation. No historical scheduler assertion or timeout was weakened, and the
selected regression run had no failures. No Stage 3C Dovecot benchmark or unrelated
application-wide test suite ran.

During development an advertised but unimplemented fixture authentication method
was corrected. The parallel-account oracle was set to D=2 because the accepted
D=1 control reservation permits only one data operation. The actual lost-COMMIT
test exposed a new wiring defect: topology result SQL initially inherited the
operation deadline instead of its two-second publication bound. The topology
result phase now explicitly retains the two-second bound, leaving time for
conflicting locked recovery within the unchanged operation lifetime. The final
45-case run includes these corrections and the same-epoch UIDNEXT and withdrawn
stable-identity negative controls.

Commands:

```text
pnpm exec vitest run tests/receiving-topology.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-safety.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-cache-publication.integration.test.ts tests/receiving-bounded-publication.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-inbox-bootstrap.integration.test.ts tests/mailbox-roles.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check <six changed supported files>
git diff --check
git diff --cached --check
```

Process-local Docker settings were
`DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Logs are in TEMP:
`maildock-r07-final-focused.log`, `maildock-r07-regressions.log`,
`maildock-r07-typecheck.log`, `maildock-r07-lint.log`; earlier development evidence
remains in `maildock-r07-focused.log`, `maildock-r07-one.log` and
`maildock-r07-recovery.log`.

**Stopped after R07.** No push, merge, PR, worker cutover or R08 implementation.
