# F12.2: PostgreSQL application authority — implementation results

Date: 2026-10-06, Europe/Warsaw. Scope: F12-03 only.

## 1. Baseline and scope

Baseline HEAD: `d740cd61f63ca814bec1629df3a6c72d82f6dd4a`,
`security: enforce exact request body boundaries`.
Checkout: `D:\Projects\JS\Maildock`; requested repository: `mkilinskidev/Maildrop`.
Both discovery documents were read as authoritative. The initial status contained
only the supplied, untracked `docs/SECURITY_F12_2_DB_DISCOVERY.md`; it is preserved.
No commit, push or deployment was performed. All runtime database work used
disposable local PostgreSQL 18.6 containers and synthetic credentials/data.
Existing development containers/volumes and real mail providers were untouched.

F1–F11 and F12-01/F12-02 remain accepted as closed. This implementation neither
redesigns their security policies nor closes all of F12. The attached task
explicitly authorized automated tests, overriding the general no-tests default.

## 2. Implementation and final role model

`scripts/postgres/99-maildock-authority.sql` implements the reviewed database-side
transition. Compose mounts it read-only as the final bundled initdb SQL step and
mounts the explicit maintenance shell helper separately from initdb.

| Role                        | Final authority and ownership                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maildock`                  | New non-bootstrap OID; LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; owns Maildock database/application objects; no explicit memberships |
| `maildock_bootstrap`        | Original OID 10; SUPERUSER, NOLOGIN, PASSWORD NULL; retains system/bootstrap objects and postgres/template databases                                                 |
| `maildock_hardening_bridge` | Temporary NOLOGIN SUPERUSER with no password; absent after commit or rollback                                                                                        |

One application URL and the existing operator password remain. No persistent
bridge, migration/admin role, additional administrator password or mandatory
service was introduced. Application database ownership still permits destructive
DDL/DML inside Maildock's own installation; this is the reviewed V1 tradeoff.

## 3. Fresh installation

The official PostgreSQL initdb path executes the mounted SQL before starting its
normal TCP server. The existing health dependency then permits app startup;
authority validation precedes migrations, then web/worker each validate their
own process identity. Fresh installations can contain no application objects.
Database ownership moves immediately; later migrations/pg-boss create their own
objects under the ordinary owner. Base services remain exactly app + postgres,
without host port publication, with persistent database/attachment volumes.

An init failure can leave PG_VERSION present. Restarting PostgreSQL may skip
init scripts; the application guard rejects bootstrap authority. The supported
offline maintenance path is required, never storage deletion or automatic
application-side repair.

## 4. Existing-volume maintenance

The supported command is:

```sh
docker compose exec -T postgres sh /usr/local/bin/maildock-authority-maintenance --writers-stopped-backup-verified
```

`docs/DEPLOYMENT.md` requires stopping every writer, taking/verifying the matched
database/attachment backup and preserving required keys, installing/recreating
the PostgreSQL service configuration while retaining its volume, then explicitly
running maintenance. The confirmation flag represents the operator's completed
offline/backup steps; it does not claim to inspect external backup storage.

The helper closes the socket maintenance connection and opens a new TCP
password-authenticated `maildock` connection using the original application
password. It reruns the hardened-state validator before allowing normal
migration/web/worker startup. Changed POSTGRES_* environment variables never
retrofit an existing volume. A mismatched environment password fails new
connection verification without reversing an already committed hardening.
The helper uses the private `postgres` service address and requires an incorrect
password probe to fail before accepting the correct password. This explicitly
avoids initdb's loopback trust rules and fails closed for custom passwordless
authentication. A real negative-password probe caught the initial loopback
implementation; the service-address correction and trust rejection are covered
by the committed maintenance regression.

## 5. Read-only application authority guard

`database-authority.ts` reads actual session/current identity, pg_roles attributes,
recursive pg_auth_members reachability, database CONNECT/CREATE, public
USAGE/CREATE, trusted SQL/plpgsql USAGE and application schema/object ownership.
It also rejects application ownership of system catalog/schema objects or the
bootstrap plpgsql extension. Membership traversal conservatively follows every
edge, including NOINHERIT and SET-capable paths; privileged predefined roles
are rejected even without the five role flags. OID 10 and changed session role
identities are rejected. An already authenticated session's stale is_superuser
GUC is not consulted; the stale-GUC regression is tested.

Existing Drizzle/pg-boss schemas must provide USAGE/CREATE and inherited ordinary
owner authority; existing public/Drizzle/pg-boss relations, functions and types
must be owned by the login or an inherited ordinary owner. Empty installations
remain valid. Equivalent scoped external provisioning is supported without
requiring database ownership, cluster administration or an extra connection URL.

The smallest independent roots are migration main, worker-process main before
cleanup timers/business work and Next's Node instrumentation register hook.
Each performs one catalog query; request/job loops do not repeat it. The web
hook closes its validation connection and explicitly exits 1 after a fixed F11
diagnostic, because throwing alone was observed to leave Next's process alive.
Worker/migrator failures also exit nonzero before business/migration work.

Unsafe authority is `database_authority`; connection/catalog-validation failure
is `database_unavailable`. Messages/categories are fixed. Neither the guard nor
the diagnostic mapper emits URL, password/verifier, underlying SQL error,
arbitrary catalog state, cause or dependency stack. The guard never changes roles.

## 6. State classification and scoped ownership

The helper accepts the inventoried OID-10 legacy/fresh state, or a verified
hardened no-op. It rejects unexpected roles/collisions, role settings/limits,
explicit memberships, custom database/schema/default/object ACLs, unknown
databases/application schemas, unsupported object kinds/ownership and unknown
public/Drizzle/pg-boss objects. It refuses other legacy client/walsender sessions;
PostgreSQL's internal logical replication launcher is not an authenticated
application client. Template ACLs are checked against PostgreSQL's actual
initdb defaults. It also checks system ownership and rejects newly allocated
custom pg_catalog relations/functions.

Public transfer uses the reviewed 35 tables, standalone application sequence
and eight exact function signatures. Drizzle metadata ownership transfers when
present. pg-boss handles its known base tables, functions, job_state enum and
partitions recognized through parent dependencies, without a fragile queue or
partition count. Table ownership carries indexes, constraints, row types and
attached dependencies; sequences/functions/schema/enum ownership is explicitly
handled and checked after transfer. Unknown ownership is rejected before any
transfer rather than repaired. No REASSIGN OWNED, object/data rebuild or change
to application function definitions is used. Public remains pg_database_owner.
System catalogs, template/postgres databases and plpgsql remain with OID 10.

The original verifier stays inside the database transaction, is never selected
to the client and is cleared from the local variable after role creation. Stock
statement/duration/error-statement logging is suppressed locally while executing
verifier-bearing DDL. Operator-controlled server auditing/DBA surfaces remain a
confidential provisioning boundary.

**Accepted re-verification boundary:** the privileged transition checks bootstrap
PASSWORD NULL before commit. PostgreSQL hides pg_authid from the ordinary login,
so later no-op verification checks NOLOGIN, attributes, memberships and ownership
without rereading the bootstrap verifier. The user explicitly accepted this
boundary in this session; no persistent privileged verifier was added.

## 7. Transactions and failure behavior

One explicit transaction with ON_ERROR_STOP acquires dedicated advisory lock
1296125024, validates preconditions, creates the passwordless bridge, changes
session authorization, renames OID 10, creates the ordinary login with the
preserved verifier, transfers scoped ownership, locks bootstrap, returns session
authorization, drops the bridge and verifies the final model before commit.

Fault injection while the bridge exists and immediately before commit restores
the original role/database ownership and leaves no bridge/new role. A later
failed application DDL transaction leaves the hardened role intact. Successful
reexecution is a no-op. Mixed/custom states fail closed with a fixed actionable
diagnostic requiring stopped writers, verified backup and DBA review; no repair,
elevation or privilege restoration occurs on application failure.

## 8. External PostgreSQL

Operators supply an ordinary non-bootstrap login with all five forbidden flags
disabled, no privileged membership/SET path and ownership/equivalent scoped
authority sufficient for migrations and pg-boss. The read-only guard applies to
every deployment and accepts an ordinary externally provisioned database owner.
The bundled transition is never invoked by application startup and is explicitly
restricted operationally to bundled clusters; no bundled status is inferred
from hostname, username or database name. Private/TLS transport remains the
provider/operator's environment contract. No DBA password/admin URL is required.

## 9. Migration, jobs and data compatibility

Focused real PostgreSQL tests cover all 32 application migrations and rerun,
ordinary owner future table/identity/column/index/concurrent-index DDL, Maildock's
advisory lock, pg-boss initialization/current schema 42, dedicated queue partitions,
enqueue/fetch/completion/retry/terminal failure and a real downgrade to the
installed version-41 definition followed by normal pg-boss upgrade to 42.
pg-boss's production privilege model/options were not changed.

The populated legacy test preserves every application/Drizzle/pg-boss table's
ordered JSON row hash, relation OID/name/kind and function definitions across the
transition. Fixtures include real owner setup/password/session state, stored
representative MFA state, synthetic mail/account/encrypted-envelope/body data and
a queued job subsequently fetched/completed by the ordinary login. Separate
MFA-management regressions now use fresh hardened PostgreSQL and retain their
real enrollment/login/replacement/recovery and worker pause/resume assertions.
Only disposable fixture provisioning and the F11 worker mock were adapted to
the new role contract; auth/MFA/F8 policies were not redesigned.

## 10. Negative security assertions

The ordinary login receives 42501 for CREATE DATABASE, CREATE ROLE, ALTER of an
unrelated role, SET ROLE bootstrap, pg_read_file and COPY TO PROGRAM. Bootstrap
TCP authentication with the application password fails with 28P01. Role inventory
and ownership checks prove bridge absence and no application membership path.
The guard rejects each forbidden attribute individually, transitive privileged
NOINHERIT/SET membership, server-file predefined role membership, incompatible
object ownership and the legacy superuser. Hardened and ordinary external owner
states pass. Connection errors retain only fixed diagnostics.

## 11. Production Docker/Compose evidence

Built the actual production Dockerfile as `maildock-f122:local` with Node 24.21.0
and PostgreSQL 18.6. Fresh project `maildock-f122-validation` used synthetic env
files and only an image-selection override; the production base topology, private
network, SQL read-only mount, health dependency and volumes were unchanged.
Migrations completed and live/ready both returned 200. Catalog state reported
ordinary maildock and locked OID-10 bootstrap before web/worker became operational.

Separate project `maildock-f122-existing` first initialized a disposable legacy
volume without init scripts, populated all migrations and a synthetic verification
row, and created an offline custom-format dump. Its archive inventory and
representative fixture preservation were checked; this is not a full restore
certification. Recreating postgres with the reviewed mounts retained the same
volume. The supported maintenance command transitioned it, verified a new TCP
connection, preserved the row/32 migration entries, and ordinary app startup
reached readiness 200. No changing POSTGRES_* upgrade mechanism was used.

Direct production migrator, worker and web roots against a separate disposable
legacy database each exited 1 with only fixed database_authority diagnostics.
The web explicit-exit correction was verified in the actual rebuilt image.
The final image ID is
`sha256:80dad737ffffcbfad22e8525078cee2ed353d0055d81a8d262acf85ed752a123`.
Local checks used Node 22.22.3/pnpm 11.19.0; the production Docker build/runtime
used the repository's pinned Node 24.21.0/pnpm 12.6.0. The final maintenance helper
was also checked against the mounted production service: wrong password exit 2,
correct password exit 0, unchanged hardened role/data state.

## 12. F1–F12.1 and remaining findings

No auth/session/MFA/F8/F9/F11/F12.1 redesign, application migration changes, XLF
edits or upgrade codeunits were introduced. Full security and repository runs,
focused authority/data/jobs tests, ordinary MFA/worker regressions, typecheck,
lint and production builds are recorded below. Development containers were not
reconfigured or used as test databases.

The independent maildock_search_vector/maildock_search_addresses/pg_restore
search_path defect is explicitly deferred to **F12-05**. Neither function nor its
migration was changed merely to make restore pass. Complete confidential
backup/recovery/update/storage/log operations remain F12-05 work. F12-04 image
payload and F12-06 environment pass-through findings remain outside this task.
F12 overall is not closed.

## 13. Exact validation results

| Command / evidence                                                                                         | Final result                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run tests/security/f12-database-authority.integration.test.ts`                           | 19/19 tests, 1 file; 60.86 s; real PostgreSQL 18.6, including maintenance password/trust assertions                                       |
| Authority + web + F11 worker focused run                                                                   | 24/24 tests, 3 files; 70.39 s before the added maintenance case; final full/security runs include that additional case                    |
| `pnpm exec vitest run tests/security/mfa-management.integration.test.ts tests/security/f11-worker.test.ts` | 42/42 tests, 2 files; 78.30 s; real ordinary-owner MFA/worker flow                                                                        |
| `pnpm exec vitest run tests/security --maxWorkers=2`                                                       | 379/379 tests, 27 files; 204.40 s; final helper/root versions                                                                             |
| `pnpm exec vitest run --maxWorkers=2`                                                                      | 1205/1205 tests, 100 files; 322.66 s; final helper/root versions                                                                          |
| `pnpm typecheck`                                                                                           | PASS; web and worker TypeScript checks                                                                                                    |
| `pnpm lint --ignore-pattern '.security-results/**' --ignore-pattern '.search-results/**'`                  | PASS; full source tree excluding generated diagnostic artifacts                                                                           |
| `pnpm build` with synthetic production environment overrides                                               | PASS; Next production build, worker compilation and import rewriting                                                                      |
| `docker build -t maildock-f122:local .`                                                                    | PASS; actual production Dockerfile, pinned Node/pnpm                                                                                      |
| Fresh production Compose / existing-volume maintenance                                                     | PASS; readiness 200; same volume and preserved 32 migration records/fixture row; correct TCP password accepted and wrong password refused |
| Production direct migrator / worker / web against legacy role                                              | PASS; each exited 1 with fixed database_authority diagnostics                                                                             |
| `sh -n` on mounted maintenance helper                                                                      | PASS                                                                                                                                      |
| Prettier check of all changed/new supported-format files                                                   | PASS                                                                                                                                      |
| `pnpm format:check`                                                                                        | FAIL on 22 pre-existing, untouched files; no task file remains in warnings                                                                |
| `git diff --check`                                                                                         | PASS                                                                                                                                      |

Full repository coverage includes the relevant database/migration, pg-boss,
auth/MFA and F1–F12.1 test files. Earlier runs identified fixture assumptions
(bootstrap worker credentials, old worker mocks and new snapshot assertions),
which were corrected without weakening their security assertions. Startup hook
failure behavior and maintenance loopback trust were additionally corrected
from actual production probes; their regressions are included in final runs.
The first unmodified local build rejected the existing development environment's
HTTP origin in production; the synthetic production environment build passed.

Plain `pnpm lint` was interrupted because it traversed a pre-existing generated
`.security-results/f12/next-patch` payload. The listed lint invocation checks the
source tree while excluding only ignored diagnostic artifacts. Global Prettier
warnings are 17 migration snapshot JSON files (0010–0026),
`docs/IMAP_CONDITIONAL_STORE.md`, `docs/PHASE_2K.md`,
`docs/SECURITY_F12_DISCOVERY.md`, `docs/SECURITY_F4_ROUTE_AUDIT.md` and
`src/components/account-connection-fields.tsx`. These files were not changed.
Twenty warnings reproduce on HEAD contents; two are pre-existing worktree
formatting/line-ending differences. Unrelated formatting was left untouched.

Local evidence logs and the synthetic archive/env files remain in ignored
`.security-results/f122-*`; they contain no real provider/operator credentials.
All manually created disposable containers, volumes and networks were removed.
The final locally tagged production image is retained for reproducibility.

## 14. Exact working-tree evidence

The standard `git diff --stat` includes tracked edits only; new implementation,
test and result files remain untracked because staging/commit was not requested.
The supplied discovery file is also untracked and unchanged.

Exact `git diff --stat`:

```text
 docker-compose.yml                                |   2 +
 docs/DEPLOYMENT.md                                | 106 ++++++++++++++++++++++
 src/composition/worker-process.ts                 |   7 ++
 src/shared/infrastructure/database/migrate.ts     |   2 +
 src/shared/infrastructure/logging/diagnostics.ts  |   7 +-
 tests/security/f11-worker.test.ts                 |  29 +++++-
 tests/security/mfa-management.integration.test.ts |  11 ++-
 7 files changed, 160 insertions(+), 4 deletions(-)
```

Exact `git status --short`:

```text
 M docker-compose.yml
 M docs/DEPLOYMENT.md
 M src/composition/worker-process.ts
 M src/shared/infrastructure/database/migrate.ts
 M src/shared/infrastructure/logging/diagnostics.ts
 M tests/security/f11-worker.test.ts
 M tests/security/mfa-management.integration.test.ts
?? docs/SECURITY_F12_2_DB_DISCOVERY.md
?? docs/SECURITY_F12_2_RESULTS.md
?? scripts/postgres/
?? src/instrumentation.ts
?? src/shared/infrastructure/database/database-authority.ts
?? tests/security/f12-database-authority.integration.test.ts
?? tests/security/f12-web-authority.test.ts
```

HEAD remains the baseline commit. Nothing was staged, committed or pushed.

F12.2 DB AUTHORITY: PASS
