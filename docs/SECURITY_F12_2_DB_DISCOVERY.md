# F12.2: PostgreSQL application authority — discovery and design

Review date: 2026-10-06, Europe/Warsaw. Scope: F12-03 only. No remediation implemented.

## 1. Executive summary

**One ordinary database-owner login is sufficient for Maildock V1, including migrations and pg-boss.** It must have `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, own Maildock's application objects, and have no explicit privileged role memberships. Database ownership remains an intentional V1 tradeoff: SQL injection can read, change, destroy and redefine Maildock data and schema, including auth state. It does not become harmless.

**The proposed one-line legacy demotion cannot work in the actual bundled deployment.** `POSTGRES_USER=maildock` makes `maildock` PostgreSQL's bootstrap role, OID 10. PostgreSQL 18.6 refuses to remove that role's `SUPERUSER` attribute. `REASSIGN OWNED BY maildock ...` also refuses because that role owns objects required by the database system. Both failures were reproduced, rather than inferred from documentation.

Recommend one application owner/login named `maildock`, plus the unavoidable bootstrap superuser renamed `maildock_bootstrap`, locked with `NOLOGIN PASSWORD NULL`. Preserve the existing application username and password by creating a new ordinary `maildock` role with the original password verifier. Transfer only Maildock's database and application objects to it; retain system objects and template/postgres databases under the bootstrap role. A temporary `NOLOGIN` superuser, created and dropped inside the same transaction, permits the rename without another login credential. No persistent migration role or additional secret is needed.

Use the same narrowly scoped database-side transition for fresh initialization and an **explicit, offline existing-volume upgrade**. Ordinary application startup checks authority and refuses an unsafe role; it does not mutate cluster roles. The transition was exercised on synthetic auth/MFA/mail/account/job data, with subsequent production-image migrations, web authentication and worker startup succeeding.

A separate existing restore limitation was reproduced: unmodified full `pg_restore` fails while creating `messages`, even under the legacy superuser, because a search function resolves an unqualified helper under the dump's empty search path. A full restore with the restore-session search path corrected succeeded under the ordinary owner. This is an F12-05 operator/restore issue, not a reason to retain application superuser. F12-03's authority design is ready; this report does not close F12 overall or certify an unmodified `pg_restore` procedure.

## 2. Baseline commit and scope

- Repository requested: `mkilinskidev/Maildrop`; checkout: `D:\Projects\JS\Maildock`.
- Verified HEAD: `d740cd61f63ca814bec1629df3a6c72d82f6dd4a`, `security: enforce exact request body boundaries`.
- Initial working tree: clean.
- Inputs read: `docs/SECURITY_F12_DISCOVERY.md` and `docs/SECURITY_F12_1_RESULTS.md`.
- F1-F11 and F12-01/F12-02 are accepted as closed. Their implementations were not redesigned.
- This report is the only repository addition. No code, Compose, Dockerfile, migration, test, XLF or upgrade codeunit was changed. No commit, push or deployment occurred.

Runtime work used exclusively uniquely named disposable local Docker resources, PostgreSQL 18.6, synthetic passwords/keys/accounts and `.invalid` hosts. Neither the checkout's `.env` nor a real database was used. No PostgreSQL or app port was published. Ad hoc scripts and synthetic dumps were temporary artifacts outside the repository, not new automated tests.

All discovery containers, database volumes and the discovery network were removed. Automatic approval review rejected temporary-folder deletion with `blocked by policy` and no further reason; synthetic probe scripts/dumps remain outside the repository at `C:\Users\mateu\AppData\Local\Temp\maildock-f12-2-2152bb4c198c499385ea723aeea281d0`.

## 3. Current PostgreSQL privilege model

`docker-compose.yml` sets `POSTGRES_USER=maildock`, `POSTGRES_DB=maildock` and the operator-supplied `POSTGRES_PASSWORD`. The app's single URL is `postgresql://maildock:<password>@postgres:5432/maildock`. Web, worker, migrator and all pg-boss producers/consumers use this identity.

Fresh unmodified PostgreSQL 18.6 reported:

| Attribute/object                                        | Observed value              |
| ------------------------------------------------------- | --------------------------- |
| Role OID/name                                           | `10 / maildock`             |
| LOGIN, SUPERUSER, CREATEDB, CREATEROLE                  | All true                    |
| REPLICATION, BYPASSRLS                                  | Both true, also unnecessary |
| `maildock`, `postgres`, `template0`, `template1` owners | `maildock`                  |
| `pg_catalog` owner                                      | `maildock`                  |
| `public` owner                                          | `pg_database_owner`         |

Thus this is not merely a normal user accidentally granted three flags. It is the cluster's original bootstrap identity. Ownership of Maildock's database alone does not explain or require its authority over system catalogs, templates, other databases or the database server's operating system.

## 4. Actual privilege requirements by component

Inspected all 32 SQL migrations, database constructors and migration entrypoint, auth factory/schema/admission/session/MFA paths, mail/accounts/diagnostics SQL, worker composition, job runtime and every producer/consumer wrapper. Also inspected installed, patched **pg-boss 12.33.7**, particularly `dist/plans.js`, `migrationStore.js`, `contractor.js`, `db.js`, manager/BAM/notifier paths, and Drizzle 0.45.3's PostgreSQL migration implementation. The pg-boss patch changes fetch predicates, not authority requirements.

| Component/operation                 | Actual SQL/activity and minimum authority                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup migrator                    | Drizzle creates `drizzle` and `__drizzle_migrations` with a SERIAL sequence, reads metadata, applies pending SQL and metadata inserts transactionally. Needs database `CREATE`, schema `USAGE/CREATE`, and ownership of altered objects. Metadata schema/table creation precedes the pending-migrations transaction.       |
| Post-migration startup work         | Microsoft OAuth configuration bootstrap and bounded local search-body conversion use ordinary SELECT/INSERT/UPDATE. Neither needs administrator privileges.                                                                                                                                                                |
| Web                                 | SELECT/INSERT/UPDATE/DELETE, conflict handling, row locks, transactions, function calls and sequence allocation across application tables. Job producers also initialize pg-boss lazily and create queues.                                                                                                                 |
| Worker                              | Same DML; session and transaction advisory locks; pg-boss startup, queue creation, fetch/complete/fail/retry, retention/maintenance and scheduler operations. No cluster administrative SQL.                                                                                                                               |
| Better Auth patched Drizzle adapter | DML on `user`, `account`, `session`, `verification`, `rate_limit`; Maildock hooks add persisted owner, throttle, admission and MFA checks. Adapter queries and its patched atomic limiter do not create roles/databases or extensions.                                                                                     |
| MFA                                 | DML/locks on `two_factor`, `mfa_replacement`, session/account/user/instance state and admission tables; credential encryption occurs in application code. Real setup, initial enrollment, TOTP login and logout were exercised.                                                                                            |
| Table/column/constraint changes     | CREATE TABLE, ALTER TABLE, checks, NOT NULL changes, foreign keys, renames and drops require schema CREATE and table ownership; foreign keys additionally require REFERENCES on the referenced table, implicit for this common owner.                                                                                      |
| Indexes and search                  | Ordinary/unique/partial/GIN/expression indexes and generated search vectors. Index creation/alteration follows table ownership. Future concurrent index creation also works as owner, but outside a transaction.                                                                                                           |
| Sequences/identity                  | Mail-account ordering uses `mail_account_order_seq`, `nextval`, `setval`, sequence ownership and an owned-by table dependency. Drizzle uses SERIAL; representative identity and SERIAL allocation passed. Ownership supplies USAGE/SELECT/UPDATE and sequence DDL.                                                         |
| Functions/triggers                  | SQL/plpgsql functions in migrations 0012, 0015, 0017 and 0019; triggers enforce immutable snapshots, reconcile conversations and update search bodies. Need trusted-language USAGE, schema CREATE, function ownership/EXECUTE and table ownership/TRIGGER. All eight application functions observed were SECURITY INVOKER. |
| pg-boss initialization              | Creates `pgboss`, `job_state` enum, tables/partitions/indexes/constraints and SQL/plpgsql helper functions. Database CREATE, schema ownership and ownership of its objects suffice. Current schema version is 42.                                                                                                          |
| pg-boss migrations/maintenance      | Owner DDL, function replacement, catalog inspection, transaction advisory locks and BAM's concurrent index operations. Installed upgrade definitions include asynchronous index work; this is not all one application migration transaction. A real 41→42 upgrade passed.                                                  |
| pg-boss runtime                     | DML, `FOR UPDATE SKIP LOCKED`, functions that can create/delete queue partitions, catalog queries and normal locks. A permanently DML-only role is not a drop-in replacement for current defaults.                                                                                                                         |
| Advisory locks                      | F8 uses `pg_advisory_xact_lock(1296125023)` at READ COMMITTED; account ordering/mailbox locks and coalesced enqueue use hashed keys. Built-in function EXECUTE, available by default, is sufficient. No superuser requirement.                                                                                             |
| Isolation                           | Normal transactions and READ COMMITTED are used; a representative SERIALIZABLE transaction also passed. Isolation-level selection does not need administrator authority.                                                                                                                                                   |
| LISTEN/NOTIFY                       | No direct application SQL usage found. Installed pg-boss supports notifications (`pg_notify` and a listener connection); its notify-enabled worker passed. Maildock constructors do not explicitly enable this option. No cluster privilege is required.                                                                   |
| Extensions                          | No application or pg-boss CREATE EXTENSION found. Only initdb's existing `plpgsql` extension was present. UUID generation uses PostgreSQL's available built-ins. No `pgcrypto`, untrusted language or superuser extension is required.                                                                                     |

The 35 application tables are: `account`, `account_signature_defaults`, `application_events`, `auth_admission`, `blobs`, `conversation_members`, `conversation_references`, `conversations`, `draft_attachments`, `drafts`, `instance_state`, `login_throttle`, `mail_accounts`, `mailbox_messages`, `mailbox_roles`, `mailboxes`, `message_attachments`, `message_commands`, `message_contents`, `messages`, `mfa_replacement`, `notification_events`, `oauth_authorization_states`, `oauth_provider_configs`, `outgoing_message_attachments`, `outgoing_messages`, `rate_limit`, `remote_content_senders`, `session`, `signature_resources`, `signatures`, `staged_attachments`, `two_factor`, `user`, `verification`.

These are requirements derived from executed/generated SQL and application calls, not ORM names. Test fixture administrative SQL is not a production requirement.

## 5. Official PostgreSQL 18.6 initialization behavior

Actual local image: `postgres:18.6-bookworm`, digest `sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`. Server reported PostgreSQL 18.6, Debian `18.6-1.pgdg12+2`, linux/amd64. Inspected the image's actual `/usr/local/bin/docker-entrypoint.sh`; SHA-256 `9c440299ae04a0a79d55b8bf03307036d890a40979d2fb698073c9050d4b20a5`. Evidence identifies the tested tag resolution, not an immutable promise about future tag contents.

The script passes POSTGRES_USER and POSTGRES_PASSWORD to `initdb`. POSTGRES_DB defaults to POSTGRES_USER; a missing requested database is created by that user. Fresh initialization runs a temporary server restricted to its Unix socket, then processes init-directory files in glob order. SQL uses psql with ON_ERROR_STOP; shell files run or are sourced according to executable permissions. The normal TCP server starts after initialization finishes. PostgreSQL 18's PGDATA is `/var/lib/postgresql/18/docker`; Compose correctly mounts `/var/lib/postgresql`.

A nonempty PG_VERSION marks an existing cluster. Initdb, database setup and init scripts are then skipped. Changing POSTGRES_USER, POSTGRES_DB or POSTGRES_PASSWORD does not rename existing roles/databases, reset their password, change ownership or replay scripts. A disposable container recreated with the same volume and three different variables logged “Skipping initialization”; the original username/password still worked and the new requested role/database did not exist. The [official image contract](https://hub.docker.com/_/postgres) agrees with this observed behavior.

PostgreSQL specifically protects OID 10 from NOSUPERUSER; see the exact [18.6 role-command source](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/commands/user.c). This restriction was introduced before PostgreSQL 18, as recorded in the [PostgreSQL 16 release notes](https://www.postgresql.org/docs/release/16.0/). Adding a second superuser does not make bootstrap demotion legal.

## 6. Candidate role models

| Design                                                         | Assessment                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A: one ordinary Maildock owner for migrations/web/worker       | Sufficient and recommended application model. Removes cluster/server authority while preserving current DDL and queue defaults. A fresh initdb identity must first be separated from this login.                                                                                           |
| B: separate migration/owner and runtime roles                  | Can reduce runtime DDL authority, but requires additional credentials, object/default grants and coordinated pg-boss install/upgrade/queue behavior. Current lazy producer initialization and queue helper DDL mean separation needs actual architecture changes. Not the smallest V1 fix. |
| C: bootstrap/admin plus a non-owner runtime role               | Stronger confinement is possible, with the same grant/pg-boss lifecycle costs as B. An administrator identity is unavoidable for bootstrap, but a permanently non-owner runtime is not necessary to close F12-03.                                                                          |
| Selected: locked bootstrap plus one ordinary application owner | A's application model with explicit lifecycle treatment of the mandatory bootstrap identity. One application URL and one existing operator-supplied database password. No external management service or extra persistent migrator credential.                                             |

**Runtime database/schema ownership is acceptable for the single-owner V1 contract.** It is authority over the installation's own durable data and schema, not a complete SQL-injection containment boundary. A future role-split project must justify and validate its additional operational complexity.

## 7. Recommended V1 role model

Final bundled state:

```text
maildock             LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
                     NOREPLICATION NOBYPASSRLS
                     owns maildock DB and application objects
                     no explicit role memberships
maildock_bootstrap   OID 10; SUPERUSER; NOLOGIN; PASSWORD NULL
                     owns system objects and postgres/template databases
temporary bridge     absent after commit
```

INHERIT's default does not add authority when there are no explicit memberships; Maildock does not require INHERIT or privileged predefined-role grants. The bootstrap role's other initial attributes can remain: NOLOGIN, no password and no membership path prevent application use. They must not be misrepresented as runtime privileges. The cluster necessarily retains a superuser; the application has no usable superuser credential.

No permanent admin password is retained in environment, files or the app. The existing POSTGRES_PASSWORD is used transiently by initdb, then belongs only to the ordinary application login. Keep bootstrap NOLOGIN even on a trusted local socket: PASSWORD NULL alone would not prevent trust authentication. Administrative recovery requiring superuser uses operator-controlled offline database maintenance/single-user mode, not an app credential. Routine migration, owned-schema backup/restore and queue maintenance need no such recovery.

## 8. Fresh-install design

Keep the current two-service topology, POSTGRES_USER/DB values, URL and secret model. Mount a final init SQL file, proposed path `scripts/postgres/99-maildock-authority.sql`, read-only at `/docker-entrypoint-initdb.d/99-maildock-authority.sql`.

On fresh `docker compose up`:

1. Official initdb creates the temporary bootstrap identity `maildock` and database using the supplied password.
2. The final init script classifies the state and executes the atomic transition in section 9. There are no application objects yet; database ownership moves to the new ordinary login, while system objects stay with OID 10.
3. The init process completes. Normal TCP availability precedes app startup through the existing health dependency.
4. The application checks authority, runs schema migrations and local bootstrap work, then starts web/worker. Worker business jobs retain the existing READY/MFA gate.

The script needs no fixed password: it carries the existing verifier inside the database transaction. Use correctly quoted identifiers/literals, fixed diagnostics, no psql echo of verifier-bearing statements and no verbose secret output. Treat server administrator query/audit logging as an operator-controlled secret boundary too.

The script must be last among bundled initialization tasks because the former bootstrap login is disabled by its commit. Reexecution against the complete hardened state returns a verified no-op before privileged reads. Unexpected/mixed states fail rather than improvising repairs. An init failure can leave PG_VERSION present and therefore suppress init scripts on restart; the app authority check must catch an unsafe partial installation. The explicit transition command can finish this state without deleting the volume.

This sequence was tested through a real `/docker-entrypoint-initdb.d` mount, not merely hand-created role attributes.

## 9. Existing-volume upgrade design

**Use an explicitly documented maintenance operation, outside the app migration runner.** It can be one psql invocation inside the bundled service, plus normal stop/backup/restart steps. New files must be installed and the postgres service recreated to acquire the init-script mount; the persistent volume is retained. Recreating that service does not rerun initialization.

Preconditions for the bundled helper:

- app/worker and other writers are stopped; a consistent DB/blob backup and required keys are preserved;
- connected database is the bundled `maildock`; expected legacy role is OID 10 with LOGIN/SUPERUSER;
- no remaining connections authenticated as the legacy bootstrap role, apart from this maintenance connection;
- expected schemas/objects are owned as inventoried; no role-name collision, unexpected privileged memberships, customized grants/default privileges or unmanaged object kinds are silently accepted;
- alternatively, the complete hardened ownership/attribute/bootstrap state is recognized and verified as a no-op.

Exact transition, in **one explicit transaction**, with ON_ERROR_STOP:

1. Acquire a dedicated transaction advisory lock; recheck preconditions under the lock.
2. Save the original password verifier in a transaction-local temporary table. Do not print it. Preserve relevant role login settings if present; baseline has default settings and no custom expiry/connection limit.
3. Create `maildock_hardening_bridge NOLOGIN SUPERUSER`, without a password or grants.
4. `SET SESSION AUTHORIZATION maildock_hardening_bridge`. A role cannot rename its own session identity; changing the session authorization to this bridge was tested and works. See [SET SESSION AUTHORIZATION](https://www.postgresql.org/docs/18/sql-set-session-authorization.html).
5. Rename the original OID-10 `maildock` to `maildock_bootstrap`.
6. Create new `maildock LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, with the original verifier. Its final name equals the original name, so SCRAM continuity is proven and MD5's name-based salt need not change. Do not reset the password from a possibly changed environment variable. MD5 itself was not exercised; the supported image's default SCRAM path was.
7. `ALTER DATABASE maildock OWNER TO maildock`.
8. Transfer only the known application namespaces' objects: tables and partition tables, remaining sequences, SQL/plpgsql functions by identity argument signature, and pg-boss enum. Transfer `drizzle` and `pgboss` schemas. Keep `public` owned by `pg_database_owner`. Table owner changes carry associated indexes/constraints and dependent ownership; verify standalone sequences/types/functions explicitly. Do not transfer system namespaces, plpgsql extension, tablespaces or postgres/template databases.
9. Set `maildock_bootstrap NOLOGIN PASSWORD NULL`, verify no membership path to it and verify the final ownership/role matrix.
10. Set session authorization back to `maildock_bootstrap`, drop the temporary bridge, commit and immediately close the privileged maintenance connection.
11. Open a **new password-authenticated TCP connection** as `maildock`, verify its attributes/ownership, and start the application. Startup runs the ordinary migrator and pg-boss under that new identity.

Do not use `REASSIGN OWNED`: actual execution against OID 10 returned `cannot reassign ownership of objects owned by role maildock because they are required by the database system`. Explicit application-object ownership transfer is necessary, not a gratuitous rewrite. User rows, object definitions, table identities, foreign keys, trigger definitions, encrypted envelopes, mail bytes and job IDs are not recreated by this transition. Only the application role OID and ownership references change.

Existing credentials keep the same username, password and database name. No second owner is provisioned and no immutable application-owner binding is changed. Old authenticated bootstrap sessions would remain dangerous after NOLOGIN; stopping writers, verifying remaining sessions and closing the helper are mandatory, not optional conveniences.

## 10. Migration/privilege-drop ordering

Recommended order is **database authority transition → fresh ordinary connection and authority validation → Drizzle migrations → OAuth/local search bootstrap → web/worker → normal pg-boss initialization**.

The authority transition commits separately. Do not hide it in a numbered Maildock schema migration: it changes the session identity lifecycle, needs bundled-cluster preconditions, and cannot be assumed legal on external PostgreSQL. None of the current 32 migrations requires authority lost by the transition. All succeeded under the ordinary owner.

Drizzle wraps pending schema migrations and their metadata inserts in a transaction; its metadata schema/table bootstrap is outside that transaction. Keep this behavior. pg-boss has its own advisory-locked install/version migration path and BAM work outside a single schema transaction. Do not wrap pg-boss concurrent index operations inside Drizzle's transaction.

Add a read-only authority guard before the migrator and at independently launched web/worker roots. Do not rely solely on container-entrypoint ordering when `db:migrate`, a standalone web process or a separately deployed worker can be launched directly. Guard on pg_roles attributes and membership capability, not on the `is_superuser` GUC alone.

## 11. Failure and restart semantics

| Situation                                        | Required/resulting behavior                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupted before transition commit             | Transactional rename/create/ownership/login changes roll back together. Explicit rollback was tested on a populated legacy clone. Retry starts from legacy state; app remains stopped or rejects unsafe authority. A kill at every individual instruction was not injected.                   |
| Transition commits; later schema migration fails | Role stays hardened. Schema transaction rolls back; no elevation is restored. A representative failed DDL transaction left no created table and role flags remained false. Repair the actual migration and retry.                                                                             |
| Repeated transition/startup                      | Complete hardened state is a no-op; migration runner remains idempotent. Hardened helper reexecution, repeated production migrator and app restarts passed. Full implementation must validate ownership as well as flags before no-op.                                                        |
| Old image starts after hardening                 | Same username/password/database remain usable. The retained pre-F12.1 image's actual migrator passed against the hardened database. Baseline all-role image also repeatedly restarted successfully. This proves authority compatibility, not arbitrary rollback across future schema changes. |
| Existing volume, new POSTGRES_* values           | No retrofit. Original credentials and hardened roles remain. The environment-change/volume reuse probe also survived PostgreSQL crash recovery.                                                                                                                                               |
| Init script fails after initdb                   | PG_VERSION remains. Init scripts can be skipped next time; authority guard prevents serving under bootstrap authority. Run the explicit repair/transition command after classifying the state. Never prescribe volume deletion.                                                               |
| Helper fails while using bridge                  | Transaction rollback removes the bridge and restores original role/ownership state. One probe deliberately encountered an ownership-dependent DROP ROLE failure; rollback preserved the original state.                                                                                       |
| Custom/mixed cluster or collision                | Fail with a fixed actionable diagnostic. Operator DBA review is required; no automatic rename, revoke or ownership transfer outside the bundled contract.                                                                                                                                     |

For a **non-bootstrap** superuser, self-demotion does work transactionally. A disposable separate role successfully demoted itself, remained query-capable and immediately lost CREATE ROLE permission; rollback restored its flags. `current_setting('is_superuser')` misleadingly stayed `on` in that existing session even after committed demotion, while pg_roles showed false and CREATE ROLE was denied. This reinforces using catalog attributes and real capability checks. It does not make self-demotion available to the actual OID-10 legacy role.

## 12. External PostgreSQL contract

External operators supply one application DATABASE_URL for a non-bootstrap, non-superuser login. That identity must have CONNECT and database CREATE for `drizzle`/`pgboss`, USAGE/CREATE on `public`, trusted SQL/plpgsql language/function access, and ownership of existing application objects. Database ownership is the simplest supported model; a managed-service DBA can supply equivalent scoped grants where database ownership is unavailable.

Require NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS and no privileged membership/SET ROLE path. The app reads attributes and refuses an unsafe credential. It must not create/rename/demote cluster roles automatically, infer “bundled” from a role name, or demand an admin URL. Operators perform any needed provisioning/ownership correction using their own DBA access.

For an ordinary legacy external superuser, its DBA may demote it directly after establishing the scoped privileges; for a bootstrap identity the DBA must separate it as described above or use their own approved provisioning procedure. Do not run the bundled fixed-name helper against an external/shared cluster.

Bundled Compose still has app + postgres only, one DATABASE_URL and the existing password secret. No separate migration/admin URL, additional Docker secret, mandatory proxy or public DB publication is needed. Keep PostgreSQL private and use the external provider's private transport/TLS requirements.

## 13. Ownership and default-privileges matrix

| Object                                                | Legacy bundled owner       | Fresh hardened / upgraded owner                                      |
| ----------------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `maildock` database                                   | `maildock` OID 10          | ordinary `maildock`                                                  |
| `public` schema                                       | `pg_database_owner`        | unchanged; ordinary database owner has its privileges                |
| 35 Maildock tables                                    | bootstrap `maildock`       | ordinary `maildock`                                                  |
| Application indexes, constraints, table row types     | bootstrap/table ownership  | follow ordinary table ownership                                      |
| `mail_account_order_seq`                              | bootstrap `maildock`       | ordinary `maildock`, OWNED BY dependency retained                    |
| Eight application functions / five triggers           | bootstrap / table attached | ordinary owner / unchanged attachment; SECURITY INVOKER              |
| `drizzle`, metadata table/index/SERIAL sequence       | bootstrap `maildock`       | ordinary `maildock`                                                  |
| `pgboss` schema                                       | bootstrap `maildock`       | ordinary `maildock`                                                  |
| pg-boss tables/partitions/indexes/job_state/functions | bootstrap `maildock`       | ordinary `maildock`; six helper functions observed, SECURITY INVOKER |
| `pg_catalog`, initdb system objects, `plpgsql`        | bootstrap `maildock`       | original OID 10, now `maildock_bootstrap`                            |
| postgres/template0/template1                          | bootstrap `maildock`       | original bootstrap role; not application-owned                       |
| Explicit default ACLs                                 | none                       | none required                                                        |
| Explicit application role memberships                 | none                       | none required; temporary bridge absent                               |

Observed after hardening: public had 35 ordinary tables, 79 indexes and one sequence; drizzle had one table/index/sequence. The probe's pgboss had two partitioned tables, eleven ordinary tables and partitioned/ordinary indexes; those counts depend on created queues and are not a fixed Maildock schema contract. Catalog queries confirmed all application relations/functions had the new owner and all fourteen application/pg-boss functions were SECURITY INVOKER.

PostgreSQL 18 initializes public under `pg_database_owner`, grants PUBLIC USAGE but not PUBLIC CREATE. No blanket default grant is needed for the ordinary database owner. PUBLIC function EXECUTE defaults are not evidence of a multi-tenant breach in this dedicated installation; do not add unrelated roles or shared schemas to the trusted search path. Older/custom external database ACLs need DBA inspection. See [PostgreSQL 18 schemas](https://www.postgresql.org/docs/18/ddl-schemas.html).

Other databases normally grant PUBLIC CONNECT/TEMP. Removing SUPERUSER does not deny connection to every database automatically. It does remove application ownership of postgres/templates in the selected design. An explicitly restricted unrelated database and an unrelated private schema both denied access; public catalogs and other explicitly public objects remain visible according to PostgreSQL ACLs. Do not promise universal cross-database secrecy from three role flags.

## 14. Runtime validation performed

Used PostgreSQL 18.6 and retained production image `maildock-f12-1:local` (`sha256:925a5be97d1c2eb4cb1fe6c7ef2e2ed4103876ffaa959f281af52c1e604dd894`), Node 24.21.0, installed patched pg-boss 12.33.7. All 32 SQL migration file hashes in that image matched the baseline checkout. Also used `maildock-f12-review:908859e` for the old-image migrator check. No image was rebuilt or application code altered for this discovery.

| Probe                                                | Result                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy OID-10 direct NOSUPERUSER                     | Rejected; bootstrap protection reproduced                                                                                                                                                   |
| Legacy REASSIGN OWNED                                | Rejected; system-object ownership restriction reproduced                                                                                                                                    |
| Non-bootstrap self-demotion, rollback, session reuse | Passed; real CREATE ROLE denied afterward despite stale GUC                                                                                                                                 |
| Atomic bridge/rename/new-owner transition            | Passed; no persistent bridge or admin credential                                                                                                                                            |
| Fresh official init-script path                      | Passed, then 32 migrations and idempotent rerun passed                                                                                                                                      |
| Populated legacy transition                          | Passed; preserved existing password over TCP, existing MFA login and jobs                                                                                                                   |
| Complete restored legacy clone                       | All application/Drizzle/pg-boss table row counts and ordered JSON row hashes identical immediately before/after transition                                                                  |
| Transition rollback on populated clone               | Restored original OID-10 login/authority; no lasting bridge/new role                                                                                                                        |
| Post-hardening migration failure                     | DDL rolled back; role remained hardened                                                                                                                                                     |
| Normal CRUD / owner migration DDL                    | CREATE schema/table, ALTER, indexes, concurrent index, identity/SERIAL, FK, insert/update/delete, rename/drop passed                                                                        |
| Locks/isolation                                      | Advisory transaction lock and SERIALIZABLE DDL/DML transaction passed; actual compiled Maildock coalesced enqueue returned true then false under its transaction/advisory boundary          |
| Better Auth / MFA                                    | Real HTTP fresh setup, initial enrollment, username/password + TOTP business login, accounts GET, logout and session deletion passed on fresh and legacy-hardened DBs                       |
| pg-boss                                              | Schema 42 initialization, restart, actual 41→42 upgrade, enqueue/fetch/complete/retry/exhausted failure, partitioned stately worker completion, notifications and schedule insertion passed |
| Normal all-role startup                              | Migrator, Next web and worker restarted; worker logged jobs.started only after verified owner MFA                                                                                           |
| Old production-image migrator                        | Passed using unchanged credentials against hardened DB                                                                                                                                      |
| Existing volume and changed environment              | Initialization skipped; original password works, ignored role/database absent; hardened state survives restart/recovery                                                                     |

No real provider delivery/sync was attempted. The synthetic mail account was disabled. OAuth remote authorization, MFA recovery/replacement races, every historical pg-boss upgrade, full F1-F12.1 suites, load/fault fuzzing and external-provider certifications were not repeated. Their authority requirements were inspected; representative runtime paths were executed.

### Backup/restore evidence and compatibility limit

The ordinary owner successfully made a full custom-format dump of application/drizzle/pgboss schemas. Standard direct pg_restore into a disposable legacy-superuser database failed on the generated `messages.search_vector`: `maildock_search_vector` calls `maildock_search_addresses` without a schema qualifier; pg_restore sets an empty search_path, and function inlining cannot resolve that helper. This failure exists independently of role hardening. A data-only dump also warned about circular conversation/queue foreign keys; recommending --disable-triggers as the runtime role would incorrectly require additional authority for system constraint triggers.

A verified full-restore workaround was: render the trusted archive to SQL with pg_restore, change only its initial `pg_catalog.set_config('search_path', '', false)` restore-session setting to `public, pg_catalog`, and execute the full SQL with psql ON_ERROR_STOP in one transaction. It succeeded as the hardened owner; stored function bodies and schema definitions were unchanged. The same corrected full dump was restored into a legacy bootstrap clone, then transitioned with every table row hash unchanged. Restore only reviewed application-owned schemas, without untrusted CREATE-capable peers in public. This workaround is a documented compatibility requirement, not permission to import untrusted SQL or blanket-transform arbitrary backup content.

For old backups, preserve the destination's hardened roles, use application-owner mapping/no-owner as appropriate, and do not blindly replay superuser globals. Physical legacy volume restoration needs the same explicit authority transition. Session/challenge invalidation, owner/MFA verification and DB/blob/key consistency remain F12-05 responsibilities before reopening access. The preexisting search-path defect needs its own restore procedure or scoped correction; it is not silently counted as a normal pg_restore pass here.

### Probe corrections and limits of evidence

Initial probe failures were corrected without repository changes: a negative-test URL replacement accidentally changed the username; a multi-statement concurrent-index command caused an implicit transaction; an unrelated marker table accidentally belonged to the temporary bridge and prevented DROP ROLE (proving rollback); and the first data snapshot differed in pg-boss version housekeeping after an intervening app restart. Final probes used the correct database pathname, separate concurrent-index command, separately provisioned unrelated fixtures, and a completely quiescent restored legacy clone for byte-equivalent row-hash comparison. A query issued in an aborted migration transaction was rechecked in a fresh session. No failed/partial restore or failed probe is represented as a pass.

## 15. Negative privilege tests

Using the new ordinary login over TCP:

| Attempt                                          | Observed rejection |
| ------------------------------------------------ | ------------------ |
| CREATE DATABASE                                  | SQLSTATE 42501     |
| CREATE ROLE                                      | 42501              |
| ALTER unrelated role                             | 42501              |
| Grant own CREATEROLE                             | 42501              |
| Read unrelated private schema/table              | 42501              |
| CONNECT unrelated DB with PUBLIC CONNECT revoked | 42501              |
| Read password verifiers from pg_authid           | 42501              |
| COPY TO PROGRAM                                  | 42501              |
| pg_read_file on server file                      | 42501              |
| SET ROLE maildock_bootstrap                      | 42501              |
| TCP login as locked bootstrap with app password  | 28P01              |

These tests validate cluster/server restrictions and explicitly protected unrelated objects. They do not imply that database-owner DDL, PUBLIC CONNECT or readable PostgreSQL catalog metadata are forbidden.

## 16. Required implementation changes

1. Deliver the guarded transactional authority script and final fresh-init read-only mount. State classification must validate the full expected baseline/final state, with fixed diagnostics and no credential logging.
2. Document the explicit maintenance transition for existing bundled volumes and restoration; expose a short supported invocation rather than requiring operators to invent SQL. Retain volumes, data, username/password and existing keys.
3. Add read-only authority validation before migrations and at independent web/worker process roots. Refuse excessive flags or privileged membership; avoid any automatic cluster mutation on external PostgreSQL.
4. Verify ownership closure, password authentication on a fresh connection, bridge absence and bootstrap lock. Migration and pg-boss versions continue through their existing mechanisms.
5. Publish the ordinary-owner external database contract and distinguish role-hardening rollback from application schema rollback. Include the observed restore-session search-path requirement in the F12-05 procedure or resolve that independent defect separately.

No new permanent secret, database-management service, migrations of user rows, pg-boss redesign, reverse proxy or exposed port is required. Implementation should separately validate the complete preflight/fail-closed behavior; the disposable candidate proved the underlying PostgreSQL operations, not an already-shipped production helper.

## 17. Rejected alternatives

- Changing POSTGRES_USER only: does nothing to existing volumes and does not provision a separate ordinary fresh login by itself.
- Directly demoting current bootstrap role: PostgreSQL rejects NOSUPERUSER even when another superuser exists.
- Dropping only CREATEDB/CREATEROLE on bootstrap: SUPERUSER still supplies the dangerous effective authority.
- REASSIGN OWNED from bootstrap: rejected for system dependencies; attempting cluster-wide ownership reassignment would also exceed scope.
- Renaming the active session role without changing session authorization: rejected by PostgreSQL. A transaction-local NOLOGIN bridge solves this without another password.
- Retaining a bootstrap LOGIN with the application password: application compromise could authenticate as superuser. PASSWORD NULL without NOLOGIN is also insufficient under local trust.
- Creating a permanent privileged migration role/admin URL: not needed; increases the secrets available to the application deployment.
- New runtime username while locking the old one: technically feasible, but changes existing application credentials/URL unnecessarily. The tested bridge approach preserves the supported connection contract.
- Destroying/recreating the volume or dumping/reloading data merely for hardening: unnecessary; ownership-reference transfer preserves data in place.
- Automatic app-side mutation based on role name: unsafe for external databases and incapable of ordinary bootstrap self-demotion; maintenance is an explicit bundled contract.
- Non-owner runtime by default: deferred until pg-boss initialization, queue DDL, future grants and operator complexity justify a separate project.
- Superuser retained to “fix” backup restoration: the observed restore failure also occurs with superuser; authority does not solve name resolution.

## 18. Regression assessment and backward compatibility

| Boundary                           | Assessment                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable owner / F10              | No owner row, cardinality rule, username or binding change. New PostgreSQL role OID is not a new Maildock user.                         |
| Better Auth sessions / F5-F6 / MFA | Tables, hooks, keys and lifetimes unchanged; real enrollment/login/logout passed.                                                       |
| F8                                 | Admission tables, transaction scopes, advisory lock keys and READ COMMITTED remain; no added IP dependency.                             |
| F11 events/diagnostics             | DML authority remains; fixed hardening diagnostics must use existing safe logging conventions. No arbitrary SQL/error/password dumping. |
| F12.1 body boundary                | No matcher/framework/body/storage change required.                                                                                      |
| Attachments                        | No blob references or persistence path changes; database ownership transfer does not alter filesystem bytes.                            |
| Worker READY gating                | Unchanged; real all-role startup and post-MFA jobs.start observed.                                                                      |

Fresh deployment is supported by the automatic final init script. Current pre-V1 volumes use the explicit non-destructive transition. A current DB backup can be restored without giving the application cluster authority, subject to the independently reproduced restore-session limitation above; restored legacy physical clusters are classified and transitioned before access. External PostgreSQL is operator-provisioned and never cluster-mutated by Maildock. Future ordinary schema migrations remain owner-capable; introducing untrusted extensions or cluster-level SQL later would require a separate reviewed administrative contract, not silent privilege expansion.

An old image against the already-hardened DB retains valid credentials and demonstrated migration compatibility. Future schema-version rollback compatibility must still be established independently. No claim of a complete F1-F12.1 rerun is made; source boundaries are unchanged and focused runtime authority regressions passed.

## 19. Exact files likely to change during implementation

| File                                                                        | Proposed purpose                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scripts/postgres/99-maildock-authority.sql` (new)                          | Fresh-init and explicit bundled transition, classification and ownership checks                 |
| `docker-compose.yml`                                                        | Read-only final init-script mount; preserve two services/URL/secret/private network             |
| `src/shared/infrastructure/database/database-authority.ts` (new)            | Read-only role/membership validation with fixed safe failure                                    |
| `src/shared/infrastructure/database/migrate.ts`                             | Validate authority before existing migrator work                                                |
| `src/shared/infrastructure/database/database.ts` / `runtime-database.ts`    | Wire validation into independently launched web initialization                                  |
| `src/composition/worker-process.ts` or its database initialization boundary | Validate before independent worker business activity                                            |
| `README.md`, `docs/DEPLOYMENT.md`, `.env.example`                           | Fresh/existing/external role contract, explicit maintenance invocation and unchanged secret use |

Final placement of asynchronous web validation must follow its actual startup boundary; the synchronous database constructor alone cannot await a catalog query. No Dockerfile change is intrinsically necessary for the selected database-side Compose mount. The existing Dockerfile copies only `scripts/container-entrypoint.mjs` to the final runtime; adding a separate app-side script would require an explicit copy. New database-authority code imported by the existing process roots can use the normal compilation/bundling path.

No numbered SQL migration, journal/snapshot, auth schema, pg-boss patch, queue handler, upgrade codeunit or prior security results file needs modification for this design. Any separate repair of the restore name-resolution defect belongs to its own narrowly reviewed scope.

## 20. Final answers

1. **Exact required role attributes:** LOGIN; NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS. No privileged memberships. Database/schema/object authority comes from ownership or equivalent external scoped grants, not additional cluster flags.
2. **SUPERUSER required?** No, for application, migrations, auth or pg-boss. Initdb's unavoidable OID-10 role remains locked and separate.
3. **CREATEDB required?** No; the installation database is provisioned before application startup.
4. **CREATEROLE required?** No.
5. **One non-superuser database owner sufficient for V1?** Yes, as the single application login; retain the separate locked bootstrap identity required by PostgreSQL.
6. **Can actual legacy maildock drop its own excessive attributes?** Not all of them: OID 10 cannot lose SUPERUSER. A non-bootstrap role can self-demote, but that is not the bundled legacy state.
7. **Exact upgrade sequence:** stop writers → consistent backup → install/mount reviewed transition → classify/quiesce → one transaction creates NOLOGIN bridge, changes session authorization, renames bootstrap, creates ordinary same-name/password login, transfers only application ownership, locks bootstrap, drops bridge and commits → close privileged session → verify new TCP login → ordinary migrations/bootstrap → web/worker and pg-boss.
8. **pg-boss afterward?** Yes; tested initialization/version upgrade, enqueue/fetch/complete/retry/failure, worker, notifications, scheduling and actual coalesced enqueue.
9. **Normal future migrations afterward?** Yes for owner DDL/functions/triggers/sequences/indexes/FKs; concurrent index DDL needs its normal nontransactional placement. No blanket promise for future cluster-administrative SQL.
10. **Residual SQL-injection impact?** Full compromise/destruction of Maildock's own data/schema/auth/jobs and owner-capable DDL, including trigger/constraint changes. Direct cluster role/database creation, bootstrap escalation and server-file/program operations were denied. Other objects follow their ACLs.
11. **Bundled changes?** Final init-script mount, deterministic explicit existing-volume transition, read-only startup authority guard and operator documentation. One existing URL/password; no additional service or persistent secret.
12. **External operator requirements?** Provision ordinary scoped application authority, correct ownership/grants, private/TLS access and safe restore/update procedures using operator DBA access. Maildock performs no cluster-wide role mutation.
13. **Remediation design ready?** Yes for F12-03, with the bootstrap separation above. Implementation and its safety gates remain future work. The independent existing restore-session defect is explicitly carried into F12-05; standard direct pg_restore was not certified or silently treated as passing.

F12.2 DB DESIGN: READY
