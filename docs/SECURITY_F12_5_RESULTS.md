# F12.5: backup, recovery and update implementation results

Date: 2026-10-07, Europe/Warsaw. Scope: **F12-05 only**.

## Baseline and scope

Baseline HEAD is `d98c1d37815f36f95ce5b52a1fac3fdd606dfb6b`, repository
`mkilinskidev/Maildrop`, workspace `D:\Projects\JS\Maildock`. The requested five
discovery/deployment documents were read. The supplied untracked recovery
discovery document was preserved unchanged. Automated tests and disposable
Docker/PostgreSQL resources were explicitly authorized by this request.

No commit, staging, push or real deployment occurred. Production drills used
unique disposable Compose projects, explicit synthetic environment files,
disabled `.invalid` mail accounts and fresh volumes. They contacted no real
provider or installation. No F1–F11/F12-01/F12-02/F12-03 policy was redesigned.

## Search migration and schema

`0032_restore_safe_search.sql` is a normal numbered Drizzle migration, with
generated journal entry 32, timestamp `1791350253217`, and a new generated
`0032_snapshot.json`. Historical migration 0019 and all older migration SQL and
snapshots remain unchanged.

The migration uses `CREATE OR REPLACE FUNCTION` for the exact address-helper and
vector signatures. It preserves text/tsvector returns, SQL language,
IMMUTABLE/PARALLEL SAFE, SECURITY INVOKER, weighting A/B/C/D and alias semantics.
It explicitly qualifies application calls with `public`, ordinary built-in
functions with `pg_catalog`, and the configuration with `'pg_catalog.simple'`.
`coalesce` remains PostgreSQL syntax. There is no function/session broad mutable
search path or SECURITY DEFINER helper.

It does not recreate messages, its generated column, GIN index or existing rows.
The upgrade test preserves table/index/vector-function OIDs and representative
vector output including Unicode subject text, sender/recipient address aliases,
body tokens and weights. The vector also works with an empty session search
path. A current custom dump restores ordinarily into fresh hardened storage;
subsequent migrations and verification succeed. `schema.ts` and the new
snapshot mirror the qualified generated expression without shipping the
column rebuild proposed by generic schema generation.

The migration also adds a singleton `recovery_maintenance` receipt table, binding
receipt generation, owner, factor, encrypted-code digest, verified/pending status
and commit time. It stores no plaintext codes/proofs. The F12-03 SQL inventory
allowlist adds **only that reviewed table name**; the existing authority model,
transition, role flags, credential contract and refusal rules remain intact.
Its populated transfer/DDL/queue regressions pass unchanged.

## Packaged historical archive bridge

`scripts/postgres/maildock-restore-compatibility.sh` and the reviewed resources
under `scripts/postgres/recovery` are copied into the application image and
mounted read-only into the existing PostgreSQL service. No service is added.

The bridge supports the known baseline custom archive: PostgreSQL/pg_dump 18,
32 exact migration hashes/timestamps through 0031, the expected public table
inventory, all eight public FUNCTION TOC signatures and the exact two historical
search function definitions. Unknown schema namespaces, overloaded/changed
functions, added tables, altered migration data and unsupported source versions
fail before predefinition/import. Locale-independent comparison uses `LC_ALL=C`.
This validates a trusted recovery set's compatibility, not arbitrary hostile SQL.

It checks a fresh ordinary owner/destination, predefines only the corrected two
search functions, excludes only their two FUNCTION TOC definitions and restores
everything else using `--no-owner --no-acl --exit-on-error --single-transaction`.
The role is the existing ordinary `maildock`; no DBA password, privileged role,
search-path workaround or dump editing is required. The fresh-destination
preflight is separately exposed as `--check-fresh-destination`.

All failures emit a fixed refusal plus a fixed stage category, suppressing raw
PostgreSQL/pg_restore output. A failed remainder can leave the predefinitions;
the operator contract requires fresh destination storage before retry. The
already populated destination test refuses reuse. Unknown older releases need
separate compatibility review; the bridge does not guess how to restore them.

## Offline maintenance, verification and protected delivery

`dist-worker/composition/recovery-process.js` is the explicit compiled process
root. It supports `maintain`, `verify`, `resume-mfa`, `complete-mfa` and read-only
`audit`. It is never invoked by ordinary startup. Worker compilation includes
the root; the existing import fixer now resolves the reused auth-admission
module's static source aliases to relative runtime paths.

The root requires the stopped-writers/reviewed-set confirmation, validates the
F12-03 authority guard, and rejects another application-role DB connection.
Operator confirmation additionally covers filesystem writers, disconnected
producers and restart automation which a SQL query cannot prove stopped.

Before security mutation it verifies migration hashes/timestamps, table and
column inventory/types/nullability, exact corrected search bodies/properties,
the stored search column and valid ready GIN index; exactly one immutable owner,
finite initialization timestamp, supported Argon2 credentials/parameters and
consistent mandatory MFA; Better Auth secret/code decryption; all stored account,
OAuth-cache, provider-secret and authorization-state credential envelopes; and
referenced attachment/MIME/staged/draft/signature blob existence/size/SHA-256.
It uses the existing verified-read primitive and checks outgoing attachment
size/hash metadata against the registry. Missing referenced registry/bytes,
corruption, wrong auth secret or missing referenced credential keys refuse.

The application service rechecks under the existing auth advisory lock
`1296125023` in READ COMMITTED. Verified-owner maintenance deletes every session,
verification/challenge and OAuth authorization state. It preserves immutable
owner binding, Argon2 password, verified TOTP secret and mandatory flags, restored
admission/throttle/factor budgets and durable mail/blob/job data. It generates
ten cryptographically random Better Auth-compatible 5-5 recovery codes, encrypts
their JSON using the installed symmetric primitive and replaces only the code
ciphertext. Rerunning invalidates the previous codes and receipt generation.

The deliberately protected local channel requires a POSIX directory owned by
the process UID, mode 0700, with no symlink resolution. It creates output
exclusively at 0600 with O_NOFOLLOW. Inputs must be private owned regular files,
without extra hard links, at most 16 KiB. Native Windows execution refuses this
POSIX permission contract; Windows operators use the Linux container's private
POSIX directory/volume and protect any host export with equivalent private ACLs.

Output is reserved before DB mutation and synced after commit. Codes, password
proofs and pending enrollment URI never go to stdout/application logs. Failure
after commit or uncertain delivery requires rerunning offline with a **new**
output filename and discarding stale/incomplete receipts. The fixed diagnostic
does not reveal secrets, URLs, message contents, SQL errors or dependency stacks.
The private receipt supplies current generation/owner binding to `verify`, which
also checks code ciphertext, transient invalidation and fencing before startup.

## Pending replacement and remote effects

For pending authenticator replacement, maintenance retains the guard, unverified
factor and cleared mandatory-MFA user flag, expires the old token and replaces
its digest with unknowable random material. It returns exit 2/MFA completion
required; business readiness remains false. Unknown/inconsistent states and
unfinished initial enrollment refuse without adding a provisioning bypass.

Offline continuation requires committed maintenance for the same bound owner
and factor, owner Argon2 password proof and valid **pending** TOTP proof, under
the same lock/recheck. `resume-mfa` requires password proof and delivers only the
pending enrollment URI over the private channel; it cannot complete MFA. Wrong
proofs commit bounded admission/factor-stage failures. Completion sets the same
factor verified and user MFA flag true, removes the guard, invalidates transients
and issues fresh codes. There is no password-only completion, bootstrap fallback,
second owner or operator auth-row editing. The installed secret alphabet includes
`-` and `_`; the regression exercises these characters deterministically.

In the maintenance transaction, queued/sending SMTP snapshots become uncertain,
pending/saving Sent-copy work becomes uncertain, and pending/executing remote
commands become failed with `Restored operation requires owner review.` Immutable
outgoing bytes/references and pg-boss survive. Real existing outgoing, Sent-copy
and command handlers receive stale IDs in the focused tests; no provider/account
resolution is invoked after fencing. No exactly-once SMTP or provider rollback
is claimed.

## Operator contract and update/rollback

`README.md` links the complete contract in `docs/DEPLOYMENT.md`. Primary commands
are `pg_dump -Fc --no-acl` and `pg_restore --no-owner --no-acl --exit-on-error
--single-transaction`. A matched recovery set includes the entire database and
attachment root, matching AUTH_SECRET, all required credential keys/key IDs,
effective configuration and matching release/image/Compose/helper identity.
Completed installations do not require the bootstrap secret. All writers stop
for capture; PostgreSQL remains running for logical dump.

Updates prepare the release, restrict ingress/restarts, drain every writer,
capture/verify the pre-upgrade set, validate authority, run the new migrator alone,
audit owner/MFA/keys/blobs, start/verify application and worker/queue/readiness,
then reopen ingress. A routine update does not run restore invalidation.

Default failed-upgrade recovery preserves the failed deployment and restores the
complete pre-upgrade set into fresh storage with matching old release and
compatible retained helper. The tested baseline path uses the bridge, only
additive 0032, offline maintenance, then the original baseline application image.
This is not permission to run an arbitrary old image on forward-migrated data.
Provider effects cannot be rolled back locally; writes after the backup are lost.

Compose sets `stop_grace_period: 60s`; equivalent platform timeouts must allow at
least 60 seconds. Existing pg-boss graceful shutdown is preserved. Actual fixture
stop times were 1.013–1.640 seconds, exit 143, OOMKilled false; worker shutdown and
jobs-stopped events were observed. This does not guarantee every external network
operation completes; forced termination can leave remote work uncertain.

Capacity guidance covers PG free space/inodes/growth, attachment capacity/growth,
queue backlog/age/failures, host/container log storage and backup capacity/age/
success. Message/staged removal or expiry need not reclaim physical blob bytes;
no age-only GC is implemented. Logs require bounded/restricted retention and
rotation without a prescribed logging stack. Private attachment binds use numeric
1001:1001 ownership. `.env`, platform environment, rendered Compose/inspection,
recovery sets and key copies remain confidential. No `*_FILE`, third service,
Redis, mandatory secret manager, backup or proxy product is introduced.

## Disposable production evidence

The actual Dockerfile builds and base Compose runs without published app/DB ports.
The fixture includes an immutable owner, real Argon2 password, encrypted verified
factor/codes, actual HTTP-created session, disabled encrypted credential account,
message/content/search vector, draft, staged blob, immutable outgoing references,
all four pending send/copy states, two remote command states and a real future
pg-boss job. The complete attachment volume is archived with numeric ownership.
Known attachment: 36,864 bytes, SHA-256
`11abe378d6d7f23b72d94b5176168f55c951ce3d14b9b4ea5e83aa8079655cfe`.

Current ordinary restore drill `8df93614` destroyed source containers and both
source data volumes before import into fresh target volumes. Archive SHA-256:
`e959d4f5306c5e16610c510487510e7027eb9a94973f1e520c395f6b9fb1b7ff`.
Historical baseline-shaped drill `92bfd955` also destroyed the source before
running the packaged bridge. Its custom archive was synthesized exclusively in
the disposable source by restoring reviewed baseline functions/32-entry metadata
and removing the new receipt table, not by editing a dump. Archive SHA-256:
`1b509331f5ddca3335c5e176555ae5fe4f84337e8c82d61ad5f3e5a505f0ec24`.

Both drills verified authority, migrations, explicit maintenance/receipt,
old-session HTTP rejection, old-code rejection, fresh password/TOTP login, new
recovery-code login, exact blob bytes/hash, persisted job, pg-boss worker startup,
readiness and preserved fencing. Wrong **syntactically valid** AUTH_SECRET and
missing referenced credential key were rejected by the real compiled process
before DB cleanup; no canary/URL/raw dependency error appeared in diagnostics.
The real Linux image also passed private-channel mode/symlink/hard-link/size/
existing-output tests. The baseline rollback drill subsequently started original
image `sha256:a6c691ff3eea2b871e6a3841b42b44c6aa2b2109b12f999a09f695ced4edf3ef`
and verified password/TOTP/business access, worker startup and readiness.

The two recorded drills used implementation image
`sha256:8b35a33a257ed3f4f5a5cb6d4e697249960aa90eb56082d22110fc1cf18aa58c`
and subsequently
`sha256:852381ed2fa7f23370465dd55fa5f843f30092211dc9c2da51f97488c4aa66c9`.
Later final review additionally rejects PostgreSQL infinite initialization
timestamps; its real-PostgreSQL negative assertion passes in the focused suite.
Final production image `maildock-f125-implementation:d98c1d3`:
`sha256:f723c090addce277a9c3032f5d4766bacf0a71c6b68a684b5f571244790e7fdf`.
Its actual Dockerfile build includes that final refusal and passed.

All uniquely created drill containers, volumes and networks were removed. Images
and ignored `.security-results/f125-*` synthetic evidence are retained. Existing
user containers/volumes and images were not deleted. No live SMTP/IMAP provider,
load-scale restore, power-loss or PostgreSQL disk-full guarantee is inferred.

## Validation

| Check                                                                                     | Observed result                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused recovery suite                                                                    | 10/10; final run 45.77s, including unsafe role, malformed archive/version, invalid initialization date, preserved budgets, rollback/retry, pending proofs and key/blob failures |
| F12-03 plus recovery focused run                                                          | 28/28 before the final extra rollback case; unchanged authority transfer/DDL/queue tests passed                                                                                 |
| `pnpm test:security --maxWorkers=4`                                                       | 389/389 across 28 files, 144.96s                                                                                                                                                |
| `pnpm test --maxWorkers=4`                                                                | 1215/1215 across 101 files, latest broad run 220.19s                                                                                                                            |
| `pnpm typecheck`                                                                          | PASS, application and compiled worker/recovery roots                                                                                                                            |
| `pnpm lint --ignore-pattern '.security-results/**' --ignore-pattern '.search-results/**'` | PASS; only ignored diagnostic artifacts excluded                                                                                                                                |
| `pnpm build`                                                                              | PASS with synthetic production core configuration                                                                                                                               |
| Actual production Dockerfile builds                                                       | PASS; final identity below                                                                                                                                                      |
| Actual Compose current and historical destroyed-source recovery drills                    | PASS, evidence above                                                                                                                                                            |
| Protected operator channel in production Linux image                                      | PASS                                                                                                                                                                            |
| Mounted restore helper `sh -n`                                                            | PASS                                                                                                                                                                            |
| Prettier on changed supported-format files                                                | PASS; final report checked after writing                                                                                                                                        |
| `git diff --check`                                                                        | PASS                                                                                                                                                                            |

An early unconstrained security run, simultaneous with heavier local work,
returned 503 rather than expected 403 in one existing expired-session test.
Assertions and existing test files were not weakened or edited. The bounded
four-worker security run and both full-suite runs passed. Earlier new-fixture
failures exposed incomplete fixture setup, locale-dependent sorting, missing
direct pg_restore destination and the installed TOTP alphabet; these were fixed
and their positive/negative paths rerun.

Repository-wide `pnpm format:check` also ran. After task files were formatted,
the remaining 23 warnings are pre-existing: 17 historical snapshot JSON files
0010–0026; IMAP_CONDITIONAL_STORE, PHASE_2K, SECURITY_F12_DISCOVERY,
SECURITY_F4_ROUTE_AUDIT; account-connection-fields.tsx; and the supplied unchanged
untracked recovery discovery. Unrelated formatting was preserved.

## Exact working-tree status

Tracked diff statistics and complete short status are recorded below. New files
remain untracked; `git diff --stat` therefore does not include their contents.
HEAD remains the baseline and nothing is staged.

`git diff --stat`:

```text
 Dockerfile                                   |   2 +
 README.md                                    |   4 +-
 db/migrations/meta/_journal.json             |   7 +
 docker-compose.yml                           |   3 +
 docs/DEPLOYMENT.md                           | 298 ++++++++++++++++++++++++++-
 scripts/fix-worker-imports.mjs               |  11 +-
 scripts/postgres/99-maildock-authority.sql   |   2 +-
 src/shared/infrastructure/database/schema.ts |  30 ++-
 tsconfig.worker.json                         |   1 +
 9 files changed, 350 insertions(+), 8 deletions(-)
```

`git status --short`:

```text
 M Dockerfile
 M README.md
 M db/migrations/meta/_journal.json
 M docker-compose.yml
 M docs/DEPLOYMENT.md
 M scripts/fix-worker-imports.mjs
 M scripts/postgres/99-maildock-authority.sql
 M src/shared/infrastructure/database/schema.ts
 M tsconfig.worker.json
?? db/migrations/0032_restore_safe_search.sql
?? db/migrations/meta/0032_snapshot.json
?? docs/SECURITY_F12_5_RECOVERY_DISCOVERY.md
?? docs/SECURITY_F12_5_RESULTS.md
?? scripts/postgres/maildock-restore-compatibility.sh
?? scripts/postgres/recovery/
?? src/composition/recovery-channel.ts
?? src/composition/recovery-process.ts
?? src/modules/auth/application/restore-security-state.ts
?? src/shared/infrastructure/database/restore-verification.ts
?? tests/security/f12-recovery-channel.mjs
?? tests/security/f12-recovery-production-fixture.mjs
?? tests/security/f12-recovery-production.mjs
?? tests/security/f12-recovery.integration.test.ts
```

## Remaining findings and result

F12-04 image/development payload minimization and F12-06 environment tuning
passthrough remain separate and open. This report does **not** close F12 overall.

F12.5 RECOVERY: PASS
