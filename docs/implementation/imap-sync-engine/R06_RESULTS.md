# R06 — INBOX bootstrap and epoch replacement

2026-10-15. **PASS for isolated R06.** The receiving engine remains unregistered
in the production worker.

Base: accepted R05 `6a18c1ddf19e8e3600e9a7567cdb91f41ff60cc2`.
Branch: `feature/imap-sync-r06-inbox-bootstrap`.

## Bootstrap state machine

The existing bounded elected candidate query now includes enabled accounts with
no canonical INBOX. It retains the 128-account bound and overflow refusal. An
in-memory proposed UUID is only a publication identifier; a wake never supplies
mailbox, epoch or coverage evidence. The shared Stage 3B/R03 scheduler grants
its normal startup fresh opportunity, C=1 account exclusion, W/C/D admission,
reserved control capacity and per-account bounded exponential backoff. There
is no bootstrap loop, extra connection pool or submitted duplicate operation.

Every turn first recovers under coordinator SHARE, account SHARE and, when
present, mailbox/state UPDATE locks. Configuration and lifecycle versions from
the elected candidate snapshot must still match before any socket is created.
Bootstrap recovery looks up the canonical INBOX by account/path, so an uncertain
previous publication is recovered even if the restarted actor proposes another
UUID. Non-bootstrap turns still require the configured mailbox UUID.

The installed patched ImapFlow adapter owns one INBOX SELECT. Only a correlated
successful tagged SELECT/EXAMINE completion with explicit valid UIDVALIDITY and
UIDNEXT, agreeing with the selected client state, can publish. Duplicate numeric
codes, invalid bounds and EXISTS exceeding UIDNEXT space are rejected. Empty
INBOX with UIDNEXT=1 is valid. Missing/failed/incomplete SELECT, timeout,
cancellation or stale local authority publishes nothing. Bootstrap collects
SELECT only and retires its socket before opening the publication transaction.

Migration `0043_receiving_inbox_identity.sql` adds the narrow account-bootstrap
function. It validates the elected term, takes the existing account discovery
advisory lock and account UPDATE lock, rechecks captured configuration/lifecycle,
and refuses a competing canonical mailbox or populated legacy account. It inserts
one canonical INBOX and invokes the existing Stage 1 initialization in the same
transaction: revision=0, F=UIDNEXT−1, E=UIDNEXT, R=0. No partial enrollment is
visible. `recentSyncUidValidity` remains NULL. Existing empty canonical mailboxes
continue through Stage 1 initialization; populated legacy conversion is refused.

## Epoch and configuration transitions

A completed SELECT with a different epoch returns SELECT evidence without
SEARCH/FETCH. The turn uses `ReceivingPersistence.persist(kind: 'epoch')`, claims
the exact old epoch/revision/F/E/R under existing fences, checks the captured
account identity and atomically advances revision exactly once, updates mailbox
UIDVALIDITY and installs F=UIDNEXT−1, E=UIDNEXT, R=0. The turn publishes no
metadata. Both shared and single-account coordinators schedule fresh immediately,
including when history encountered the transition. Replacement revokes historical
eligibility and restores the account's startup fresh barrier, so an aged protected
history opportunity cannot precede its first current check. History then resumes
from the new boundary after that current opportunity.

A state binding different from the captured current account configuration uses
the same SELECT-only replacement, including repeated numeric UIDVALIDITY. The
revision guard permits empty-coverage reset only across an epoch or configuration
identity change. A changed binding must equal the current account configuration
and carry the captured account authority. The mandatory deferred COMMIT guard
checks the resulting binding and lifecycle while existing conflicting locks and
the final database-clock lease comparison remain in force. R04 bounded/attempt
guards and their default-deny paths remain intact.

Physical placements are retained. The existing unique remote-identity index is
rebuilt as `(mailbox_id, uid_validity, uid, configuration_binding)`, preserving its
old lookup prefix while allowing retained and current configurations to repeat
epoch/UID without collision. Fresh/history preloads and repair keyset/UPDATE/
DELETE predicates select the current state binding. A new configuration therefore
inserts a distinct message/placement instead of updating retained old identity.
R05 predicates immediately hide old rows and stale caches; they become visible
only for newly evidenced facts. Revision claims reject delayed complete old FETCH
results. Commands, content, attachment requests and uncertain attempt markers
are neither rewritten nor retargeted by replacement.

## Crash, takeover and durable demand

Crash before publication creates nothing. Backend termination while bootstrap
COMMIT is held rolls back both mailbox and enrollment. Lost bootstrap or epoch
COMMIT acknowledgment raises the existing unresolved result; the next invocation
recovers under conflicting locks before SELECT or publication, rather than
replaying initialization or an old FETCH. Restart after a committed replacement
can reconstruct its empty coverage before the first new-epoch FETCH.

The existing elected owner cancellation, database term fence, account locks and
deferred logical COMMIT authority order takeover against publication. SELECT
completed by a former owner cannot create an INBOX. Configuration or disable/
re-enable changes during SELECT invalidate publication, including when an account
editor first holds the conflicting UPDATE lock. A publication that already holds
the account SHARE lock may commit before the subsequent edit, as required by the
existing logical authority contract.

R06 never clears account/mailbox due timestamps or request generations. Stage 4A
account demand remains durable before enrollment, after failure, and after
supported work; a concurrent request retains its exact generation/due value.
R15 owns demand settlement. Scheduler wake generations remain hints, and failed
bootstrap backs off independently while healthy accounts continue receiving.

## Resource efficiency

No tables, persistent ledgers, services, flags, workers or new index count are
introduced. The existing placement index gains one bigint key (eight raw key
bytes per entry, plus PostgreSQL index overhead); rebuilding it requires normal
migration index-build work and locking. Retained configurations/epochs consume
additional existing placement/message rows as intended; reclamation is deferred.

Candidate loading remains one bounded query plus the existing DB-only loader per
account; versions are returned in that same query. Recovery adds a lease check
and account identity read to the previous mailbox recovery, with no per-message
queries. Bootstrap inserts one mailbox and one state row and uses no metadata
buffer. Ordinary windows retain 128 identities, 256 KiB response and 2 MiB
aggregate limits. No PostgreSQL transaction spans IMAP I/O. No production memory
or latency benchmark is claimed.

## Validation

Fixtures use disposable PostgreSQL 17.6, ordinary non-superuser database ownership,
the real receiving executor and migrations, the installed patched ImapFlow adapter
and a deterministic TCP IMAP peer. End-to-end candidate/scheduler tests use the
elected coordinator; publication fault tests also invoke its owned receiving turn
directly under a real database lease. Race assertions use independent SQL, server
command barriers, conflicting locks and actual process/backend termination.

The R06 file covers canonical bootstrap/restart, UIDNEXT=1, partial/hung/failed/
malformed/duplicate/inconsistent SELECT evidence, cancellation, stale account and
disable/re-enable ABA, concurrent demand, owner takeover, retained old epochs,
repeated configuration epoch/UID with current-only repair, complete delayed old
FETCH rejected specifically by the revision fence, old frozen business requests,
sparse intervals, crash before publication, lost bootstrap/replacement COMMIT
responses, fresh new-epoch visibility and scheduler history-to-fresh transition.
Two additional independent-process election cases contest bootstrap and crash
during SELECT before takeover. A failed account does not block healthy metadata.

Development checks found an obsolete Stage 3A expectation that epoch replacement
must fail; it now asserts committed empty coverage before FETCH. New request
fixtures initially omitted canonical original flags, and a repair fixture used a
number instead of the provider's UID string. These inputs were corrected. The
configuration repair case also caught an unfiltered old-binding keyset scan; the
production query and mutation predicates now restrict the current binding. An
intermediate joint run imported persistence before that edit and discovered the
new test afterward, reporting that failure; the stable focused rerun passed.
No guard or assertion was removed and no deadline was increased.

The final joint run passed **303/303 cases across 13 files**. After the final
startup-barrier refinement, the three affected suites passed **82/82** again,
including the additional elected history-to-fresh case. The installed-adapter
transport suite separately passed **40/40**. Together these cover **344 distinct
passing cases across 14 files**; repeated cases are not counted twice.

| Suite                                                  | Passing cases |
| ------------------------------------------------------ | ------------: |
| R06 INBOX bootstrap / replacement                      |            31 |
| Stage 1 receiving safety                               |            26 |
| Stage 1 retirement gate                                |             4 |
| Stage 2 INBOX window                                   |            15 |
| Stage 2 installed adapter ESM/CJS                      |            40 |
| Stage 3A coordinator                                   |            11 |
| Stage 3B scheduler                                     |            31 |
| Stage 4A durable wakes                                 |            12 |
| Stage 4B election, including two new R06 process cases |            15 |
| R03 bounded admission                                  |            20 |
| R04 pre-network claims                                 |            17 |
| R04 bounded publication                                |            65 |
| R04 cache publication                                  |            36 |
| R05 active reads                                       |            21 |

Application/worker typecheck, repository lint, changed-supported-file Prettier,
and working/staged `git diff --check` passed. SQL is checked by actual migrations
and integration assertions; Prettier has no SQL parser in this repository.

Commands (test runs use `--maxWorkers=1 --no-file-parallelism`):

```text
pnpm exec vitest run tests/receiving-inbox-bootstrap.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-active-reads.integration.test.ts tests/receiving-inbox-window.integration.test.ts tests/receiving-coordinator.integration.test.ts tests/receiving-wakes.integration.test.ts tests/receiving-bounded-publication.integration.test.ts tests/receiving-cache-publication.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-claim-phase.integration.test.ts
pnpm exec vitest run tests/receiving-inbox-bootstrap.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-admission.integration.test.ts
pnpm exec vitest run tests/imap-metadata-window.test.ts
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

Final logs and JSON results are in TEMP: `maildock-r06-final.{log,json}`,
`maildock-r06-final-scheduler.{log,json}`, `maildock-r06-transport.{log,json}`,
`maildock-r06-typecheck.log`, `maildock-r06-lint.log` and
`maildock-r06-format.log`. Intermediate fault-development logs use the same
`maildock-r06-` prefix. Docker settings were process-local:
`DOCKER_HOST=npipe:////.\pipe\dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.

## Limitations and next dependencies

The candidate set still comes from bounded owner acquisition. R08/R09 own live
membership/configuration orchestration, credential refresh and their cancellation
policy; a changed captured configuration is rejected until a current lifetime is
loaded. Existing approved configuration/lifecycle fields are used as implemented;
this is not a complete account lifecycle cutover. R07 owns LIST, roles, missing/
nonselectable canonical topology and operation destinations. No secondary
inventory or legacy discovery fallback is added.

R10–R14 retain execution/recovery of dormant old source-bound business requests.
Old active command uniqueness and notification deduplication policies are retained;
R06 does not settle old commands or redesign cross-configuration notification
identity. R15 owns due settlement; R16 owns production registration. The historical
incremental-sync failures documented in R05 were not rerun or repaired. No full
Stage 3C Dovecot benchmark or unrelated application-wide suite was run.

No push, merge, PR or R07 work is authorized or performed. **Stopped after R06.**
