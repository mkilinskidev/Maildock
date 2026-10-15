# R13 — Owner-routed Sent-copy APPEND

2026-10-15. **PASS for isolated deterministic R13 implementation and validation.**
Production receiving activation remains R16.

Base: accepted R12 `b6c9abfd6a8835d36f3961e8056180e80eaac345`.
Branch: `feature/imap-sync-r13-sent-copy`.

## Existing policies and SMTP independence

The account schema, API, settings UI and database values remain exactly `server`
and `maildock`. New accounts still default to `server`. Outgoing creation still
captures its own immutable policy; every R13 selection and preparation checks
that outgoing snapshot, independently of the account's current preference.
Changing preferences affects future outgoing messages only.

`server` remains `not_required`: no Maildock APPEND, pending claim or invented
destination UID. Ordinary future receiving may discover a provider-saved copy.
R13 neither asserts that a provider saved it nor falls back to APPEND when it is
not immediately visible. Negative TLS/SQL controls exercise repeated submissions
and a replacement elected owner with zero APPEND commands and zero received copies.

`maildock` retains the original outgoing ID, durable pending intent and original
MIME. The implementation is provider-independent, including a provider that does
not save SMTP submissions automatically; no dpoczta detection or configuration
switch is introduced. The deterministic peer creates a copy only on APPEND.
There was no live dpoczta/provider-account test.

SMTP delivery, composer behavior, MIME generation, attachments and account settings
are unchanged. APPEND only operates on `status='sent'`; it never calls SMTP or
changes SMTP attempts, acceptance or delivery status. Failures preserve the sent
record and snapshot. Existing failure/uncertainty warning text is retained.

## Elected preparation and destination

Trusted composition registers `{ sentCopy: storage }` for `append`; a shared
`exact-lookup` descriptor can contain both `sentCopy: storage` and `flags: true`.
Sent lookup envelopes carry `lookup: 'sent-copy'`, while existing flag lookup
envelopes retain their current behavior. Production composition is untouched.

The existing elected coordinator discovers outgoing work on its existing
election, wake and renewal opportunities. Keyset pages contain at most 32 rows,
including stale rows so they cannot pin the cursor; at most one operation per
account is submitted from a page. Selection reads identifiers, sizes and existing
attempt markers, not MIME payloads. There is no new durable queue, execution
ledger, service, timer, connection pool or SMTP executor.

Fresh destination resolution uses the existing `resolveMappedMailbox` service.
Manual mappings win over special-use candidates. The destination must be active
and selectable. An unenrolled/current-configuration-unselected destination first
uses R07's owned role-bound SELECT/enrollment as a separate admitted operation.
This establishes selected identity without fetching Sent history. Attempted rows
never use that route to replace their frozen destination.

Preparation uses bounded SQL and immutable storage outside SQL. R04-C commits
the exact APPEND claim before constructing the owned ImapFlow client. Locked
`data_recover` confirms that exact attempt UUID and current owner before wire
work, including a lost claim COMMIT acknowledgement. Credentials and account
lifecycle/configuration are revalidated by the existing R09 admission boundary.

Migration 0050 extends the existing outgoing attempt JSON with the exact Sent
role row and immutable blob digest. It preserves the selected mailbox UUID,
path, epoch, configuration, lifecycle, original Message-ID and MIME identity.
Result publication compares those identities again. Role reads take SHARE locks
inside the existing discovery/role mutex. No destination is silently retargeted.

Missing/unselectable Sent or unavailable immutable MIME has a narrow owner-fenced
pending-failure capability. Its exact outgoing-row certificate may only fail an
unattempted pending copy; no remote facts or SMTP result change. It uses the
existing deferred account/owner/DB-clock COMMIT validation without inventing a
mailbox scope or advancing unrelated receiving frontiers.

The legacy Sent-copy runner returns before credentials or provider work for
enrolled accounts, and rechecks enrollment inside its outgoing lock. Baseline
unenrolled execution remains available before R16. No new receiving consumer is
registered in the production worker.

## APPEND, UIDPLUS and uncertainty

The owned client EXAMINEs the frozen destination and verifies actual UIDVALIDITY.
Only the prepared R13 capability authorizes APPEND, once, with the exact original
Buffer, `\Seen` and original SMTP-acceptance/internal date. A bounded raw collector
checks the actual sent command and correlated successful tagged completion.
APPENDUID must contain one valid UID and the selected epoch; invalid values,
UID sets, wrong tags and mismatched epochs cannot publish a mapping. Normalized
library return values and its sequence-number fallback are not identity evidence.

After actual socket retirement, R04-C atomically publishes the outgoing result
and advances only the destination revision. A confirmed APPENDUID records its
real UID/epoch, `saved` and durable pending metadata lookup. Successful tagged
APPEND without UIDPLUS records `saved`, no invented UID, `awaiting_uid` on the
existing marker and `sent_copy_sync_pending=true`. The old R04 certificate with
no explicit accepted-success evidence retains its conservative uncertain behavior.

A dropped reply produces uncertainty, never an unconditional second APPEND.
Restart/takeover admits a separate read-only exact lookup and adopts the original
attempt UUID with the new fenced owner. Resume COMMIT recovery must establish its
exact phase and observation number before opening the socket. Original path,
epoch, role, configuration and lifecycle must still agree.

Lookup performs one bounded Message-ID SEARCH and, only for a single candidate,
one bounded BODY.PEEK[]/UID/FLAGS fetch. Exact original MIME length and SHA-256
must agree. Message-ID alone is never proof; duplicate matches, absence, changed
bytes, malformed evidence or incomplete completion cannot establish a new mapping.
A known saved UID cannot be replaced. Raw optional CONDSTORE MODSEQ is validated.

There are at most three admitted lookup observations per original attempt. An
unresolved attempted copy remains `uncertain`; an already confirmed saved copy
remains `saved` with pending lookup. Exhaustion cannot cause APPEND or SMTP replay.
Lost result COMMIT acknowledgement recovers the same attempt under the accepted
conflicting locks; no socket is reopened to repeat the mutation.

## Targeted metadata and demand

The original `sentCopySyncPending` survives wake/queue loss, admission and a mere
successful remote APPEND. R04 demand is retained on the original destination.
A later exact lookup can associate an existing current validated placement only
when original bytes, RFC Message-ID, UID/epoch, flags and MODSEQ agree. R04-C then
settles the outgoing marker and clears the pending flag atomically, preserving
that placement and saved UID/epoch. Missing metadata or changed flags does not
clear the flag or fabricate an envelope, placement or synchronized Sent history.

No legacy full-folder sync is launched for enrolled accounts. Acquisition of
otherwise absent remote envelope/MIME metadata remains due; this implementation
does not add secondary-folder inventory to satisfy that demand. R15 owns due
settlement and R17 owns continuous secondary receiving. R04's saved-UID-without-
metadata behavior remains intact and is covered by its unchanged regression suite.

## Resource bounds

Installed ImapFlow 2.0.6 APPEND accepts a Buffer/string, not a stream. R13 reuses
the existing verified immutable blob reader (now cancellable) or bounded legacy
base64 snapshot; it does not regenerate MIME or add an adapter/storage platform.
The existing 15 MiB upload, 18 MiB outgoing attachment and **25 MiB MIME** policies
remain unchanged. Oversized stored metadata is rejected before opening the blob.

The APPEND/lookup operation keeps the original **10-second absolute lifetime**,
including admission, credentials, reads, socket retirement and publication. SQL
scopes remain at most two seconds within it. No global or SQL deadline increases.
An actual **26,214,400-byte** immutable blob passes through installed ImapFlow and
TLS with independent received length/SHA-256 verification inside that lifetime.
This is local deterministic evidence, not a slow-provider throughput guarantee.

Remote source lookup is bounded to the original MIME length, with 256 KiB
per-response protocol allowance, 64 KiB nonliteral lines and 1 MiB aggregate
protocol allowance. MIME verification, the installed parser/adapter and the test
peer may hold buffers proportional to the fixed 25 MiB limit. This is not a
constant-memory streaming APPEND or process-wide RSS claim. A single APPEND is
nonpreemptible until completion/cancellation and actual retirement; existing W,
account C=1, D and control headroom remain in force throughout.

## Validation

Selected coverage is **499 distinct passing tests**; repeated invocations are
not counted twice.

| Selection                                                     | Result      |
| ------------------------------------------------------------- | ----------- |
| Full focused R13 PostgreSQL/TLS/storage integration           | **35/35**   |
| Full R04-C bounded APPEND/MOVE/topology authority regressions | **65/65**   |
| Selected compatibility regressions, 21 files                  | **399/399** |
| Application and worker typecheck; repository lint             | Passed      |
| Changed supported-file Prettier; working/staged diff checks   | Passed      |

The 399 comprise Sent-copy provider/UI/jobs/migration 9/4/2/1, outgoing
messages/provider/MIME/jobs/API 47/13/15/2/6, account settings/API 3/4,
R07 topology 45, R09 credentials/diagnostics 37, R10 flags 29, R03 admission 20,
R04 claim phases 17, R12 attachments 53, attachment storage/MIME/business
11/9/66, and draft API 6. The R12 suite also transferred actual 20/80/100 MiB
incoming attachments; no incoming-memory result from this invocation is used
to claim constant-memory APPEND.

Final focused execution uses:

```text
node node_modules/vitest/vitest.mjs run tests/receiving-sent-copy.integration.test.ts tests/receiving-bounded-publication.integration.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json --outputFile.json=.r13-complete.json
pnpm typecheck
pnpm lint
node node_modules/prettier/bin/prettier.cjs --check <changed supported files>
git diff --check
git diff --cached --check
```

All Vitest invocations use `--maxWorkers=1 --no-file-parallelism`. Process-local
Docker settings are `DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Logs remain in
ignored `.r13-*.log` files; JSON evidence is retained outside the checkout at the
TEMP directory recorded in `.r13-evidence-location.log`. SQL has no configured
Prettier formatter; it is executed by actual migrations in the integration suites.

Fixtures use disposable PostgreSQL 17.6, an ordinary schema owner, all actual
migrations, installed ImapFlow 2.0.6, deterministic TLS peers, original immutable
LocalBlobStorage and independent PostgreSQL readers. Actual response-loss relays
drop claim/result COMMIT acknowledgements. A second reader holds destination
locks and observes recovery blocked in `pg_stat_activity`; claim-loss recovery
has zero copied messages before lock release, result-loss recovery has exactly one.

The regression selection covers existing sent-copy provider/settings/jobs and
migration, outgoing SMTP/MIME/snapshot/API/jobs, account policy API/settings,
R04-C, R07 topology/SELECT, R09 credentials, R10 flags/admission, R04 preparation,
R12 attachment/storage, draft and MIME attachment behavior. No full application
suite or Dovecot benchmark ran. Existing assertions and deadlines were not relaxed.

Development failures were retained in local logs: a new SQL role alias conflicted
with a PL/pgSQL record; JSON null needed explicit comparison to absent role rows
in R04 compatibility fixtures; the new fixture initially reused a unique outgoing
Message-ID and tried to assign NULL to a required role mailbox. Those fixture/SQL
issues were corrected. The first large-buffer equality assertion exhausted the
test worker heap; the peer now accumulates bounded chunks and the assertion uses
independent byte count and SHA-256. No production MIME limit or deadline changed.

## Remaining stages and limitations

R14 retains general repair policy, including exhausted reconciliation and stale
configuration/role identities. R15 retains demand settlement; R16 retains
production registry/credential composition and coordinated worker cutover.
Secondary continuous receiving and full Sent history remain R17. Missing validated
metadata intentionally remains pending rather than being reported synchronized.

Servers that rewrite MIME bytes can leave exact lookup uncertain. There is no
provider-specific relaxation or duplicate-producing fallback. Crash tests use
durable state, actual transport faults and replacement coordinator instances;
they do not kill the OS process. The inherited arbitrary-process-suspension and
remote-session-retirement limitation remains: SQL fencing cannot instantly
retract an already paused remote socket.

No push, merge, PR or R14 implementation is included. Stop after R13.
