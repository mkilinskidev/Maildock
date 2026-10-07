# F12.5: production backup, recovery and update — discovery/design

Date: 2026-10-06, Europe/Warsaw. **Discovery only. No repository remediation was implemented.**

## 1. Executive summary

The smallest supported generic V1 recovery model is **stop every writer, verify it has stopped, then back up the complete database, attachment root, required cryptographic keys and deployment configuration as one recovery set**. Keep PostgreSQL running for a logical dump. Restore into fresh storage with an already provisioned ordinary application owner, verify the set, perform explicit security/remote-operation rollback handling, then start the application and reopen ingress.

Real disposable PostgreSQL 18.6 drills reproduced the existing restore failure and established a schema-level solution. The string-bodied SQL function `maildock_search_vector` resolves an unqualified `maildock_search_addresses` while PostgreSQL prepares the stored generated column `messages.search_vector`. `pg_restore` deliberately clears the session search path. The helper already exists; this is name resolution during inlining, not missing dump data, insufficient privileges or incorrect object order.

Schema-qualified helper calls and text-search configuration restore successfully with ordinary `pg_restore`, without a broad search path. A further candidate qualifying built-in functions also passed a fresh custom-archive restore and the production migrator. Existing installations need a new migration; historical backups need a narrowly scoped compatibility restore procedure because a migration cannot repair a table that restore failed to create.

After destroying the source containers and volumes, a fresh installation recovered its immutable owner, Argon2 password, verified MFA, encrypted provider credential, message/content, draft/outgoing metadata, attachment bytes and pg-boss job. Migrations, authority checks, worker startup and HTTP readiness passed. **A session revoked after backup became usable again after restore: business API returned 200.** Disposable post-restore invalidation changed that to 401, preserved verified MFA, and allowed a fresh password/TOTP login.

F12-05 requires a supported maintenance operation and operator documentation, not just a backup command. Restored queued sends can replay remote effects even if the backup was internally consistent. Missing blobs and a wrong but syntactically valid `AUTH_SECRET` can coexist with readiness 200. Recovery verification must therefore precede operational startup; readiness alone is insufficient.

The design is ready for implementation. F12-05 itself remains open. F12-04/F12-06 are unchanged; no F1–F11 reopening or new application diagnostic leak was established.

## 2. Baseline commit and scope

- Repository requested: `mkilinskidev/Maildrop`; workspace: `D:\Projects\JS\Maildock`.
- Verified clean baseline HEAD: `d98c1d37815f36f95ce5b52a1fac3fdd606dfb6b`, `security: implement authority checks and maintenance scripts`.
- Read the four requested discovery/results/deployment documents before designing the recovery contract. Earlier documents describe earlier commits; this report checks the current implementation.
- Built the current production Dockerfile as `maildock-f125:d98c1d3`; image ID `sha256:a6c691ff3eea2b871e6a3841b42b44c6aa2b2109b12f999a09f695ced4edf3ef`; runtime config digest `sha256:84063fb10831094e498c3ab1404b43156626e222d15375d65deb3050e778055d`.
- PostgreSQL image: `postgres:18.6-bookworm`, local image digest/ID `sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`. Production Node 24.21.0, installed patched Better Auth 1.7.5, Drizzle 0.45.3, pg-boss 12.33.7/schema 42.
- No real `.env`, credentials, provider, deployment or existing application database was used. No ports were published. Synthetic mail accounts were disabled; `.invalid` hosts were never used for real mail.
- All SQL variants and fault injections were disposable experiments outside the repository, not shipped migrations, fixes or automated test files. Only this report was added. No commit, push or deployment.

## 3. Persistent-state inventory

Back up the whole Maildock database, not a hand-picked table list. Current migrations create 35 application tables plus Drizzle metadata; pg-boss adds its own schema and partitions.

| Persistence domain | Actual objects/state | Recovery significance |
| --- | --- | --- |
| Owner/password | `instance_state`, `user`, Better Auth `account` | Immutable owner binding, initialization timestamp, username, Argon2 hash/parameters and preferences. Never synthesize another owner. |
| MFA | `two_factor` | Encrypted TOTP secret and recovery-code list; verified flag, failure count, lock deadline. Depends on `AUTH_SECRET`, not the credential-envelope key. |
| Auth transients | `session`, `verification`, `mfa_replacement` | Sessions including expiry/absolute expiry; login/enrollment challenges; pending replacement authority. Must not be blindly trusted after rollback. |
| Admission | `auth_admission`, `login_throttle`, `rate_limit` | Persisted F8 work/proof budgets, login failures and Better Auth/setup limits. Preserve controls; do not reset budgets to bypass admission. |
| Mail accounts/OAuth | `mail_accounts`, `oauth_provider_configs`, `oauth_authorization_states` | AES-GCM password/token/cache/client-secret/PKCE envelopes, provider IDs, settings, account order and connection state. OAuth authorization state is transient. |
| Mail/content | `mailboxes`, `mailbox_roles`, `messages`, `mailbox_messages`, `message_contents` | Remote UID/UIDVALIDITY identities, sync/backfill checkpoints, addresses, bodies, MIME metadata, search text and generated vector. |
| Conversations/preferences | `conversations`, `conversation_members`, `conversation_references`, `remote_content_senders`, instance preferences | Local interpretation and owner choices; not reliably reconstructed from provider mail alone. |
| Compose/send | `drafts`, `draft_attachments`, `outgoing_messages`, `outgoing_message_attachments`, `message_commands` | Authoritative drafts, immutable outgoing snapshot, MIME source, SMTP/sent-copy uncertainty, remote commands. Remote effects are outside the database snapshot. |
| Attachment registry | `blobs`, `message_attachments`, `staged_attachments` | UUID storage keys, byte counts, SHA-256, source placements and durable references. A row is not a physical file. |
| Signatures | `signatures`, `signature_resources`, `account_signature_defaults` | Rich content and referenced image blobs. |
| Notifications/diagnostics | `notification_events`, `application_events`, instance notification sequence/checkpoints | Notification progress and retained application diagnostics. |
| Migration state | `drizzle.__drizzle_migrations`, sequences, all function/trigger/index/constraint definitions | Recover the schema version together with the data. Current fixture had 32 entries. |
| Queue state | Entire `pgboss` schema, including version, queue, jobs/partitions, schedules/subscriptions/BAM and helpers | Durable work and library schema state. Do not omit, truncate or manually recreate the job schema. |
| Attachment root | Entire `ATTACHMENTS_PATH`; Compose volume `attachments_data` | Plaintext incoming attachments, staged uploads, signature/draft resources and durable outgoing MIME, including files not recoverable from IMAP. |
| Operator configuration | Secrets, key IDs/map, database credentials, origin, effective runtime tuning, release/Compose/helper files | Cryptographic usability and reproducible interpretation of the recovery set. |
| Operator logs | Docker/platform/host storage outside the attachment/database volumes | Confidential diagnostics, but not authoritative application recovery state. Separate retention policy. |

`LocalBlobStorage` writes exclusive 0600 temporary files beneath 0700 directories, counts/hashes actual bytes, fsyncs, renames to `blobs/<first-two-key-characters>/<UUID-v4>`, and fsyncs the destination directory. Publication to PostgreSQL follows physical publication. Failed DB publication can leave a complete orphan; hard termination can leave a temporary file. Staged attachments use ordinary final blob files: “staged” is DB lifecycle state, not a separate safe-to-discard directory. Back up the complete root conservatively, including `tmp`; do not interpret temporary files as successfully published data.

## 4. Secret recoverability matrix

| Secret/configuration | Class | Required action and consequence |
| --- | --- | --- |
| `AUTH_SECRET` matching the backup | **A: indispensable for existing protected state** | Preserves Better Auth TOTP/recovery encryption and cookie/signature cryptography. Wrong valid key can let startup/readiness pass but MFA decryption fails. Losing it prevents ordinary recovery of existing factors; do not advise rotating it incidentally. |
| Every credential-encryption key referenced by persisted envelopes | **A** | Preserve actual key bytes and their key IDs, including `CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS`. Losing a referenced key prevents decrypting those passwords/OAuth/provider secrets. External reauthorization is possible for some accounts, but is not complete recovery. |
| Active encryption key and `CREDENTIALS_ENCRYPTION_KEY_ID` | **A for exact configuration; rotation possible only while old keys remain** | Active key governs new writes; envelope IDs select decrypting keys. Preserve the map, not just a value called “current key.” Re-encryption/retirement needs a separate verified rotation operation. |
| `POSTGRES_PASSWORD` / `DATABASE_URL` credential | **B: replaceable on fresh restore** | Logical dumps do not restore role passwords. Provision fresh ordinary `maildock` with a new password if desired and configure both services consistently. Changing env on an existing volume does not change its verifier. Use URL-safe password characters or correctly encoded external URLs. |
| Owner password | **B: knowledge needed for normal login, hash recovered from DB** | Preserve access to it independently. No supported forgotten-password recovery bypass was established; do not edit auth rows. Restoring a hash can restore an older password. |
| Owner's TOTP device / recovery copy | **A for ordinary unattended owner access, with explicit operator recovery below** | A verified restored factor expects its matching authenticator. Old recovery copies must be replaced after disaster restore. A fully authorized offline operator with the DB and keys already holds authentication authority; the proposed command can securely issue fresh codes without disabling MFA. |
| OAuth client secrets and provider credentials | **A if available only inside encrypted DB; B at external provider** | Persisted envelope plus key recovers them. They can often be rotated/replaced/re-authorized at the provider. Restored refresh tokens may have expired or been revoked remotely. |
| `MICROSOFT_CLIENT_ID/SECRET` bootstrap environment | **B after configuration has been persisted** | Bootstrap does not overwrite an existing provider row. Preserve any still-used external configuration, but DB provider row plus key is the durable source. Env changes alone do not rotate it. |
| `MAILDOCK_BOOTSTRAP_SECRET` | **C after completed owner/MFA setup** | Remove from normal runtime/recovery set when setup is completed. It is not needed for a verified-owner restore. Initial provisioning/unfinished enrollment is a different state; preserve the original secret if such a backup must finish initial setup. It must never reclaim an initialized owner. |
| `APP_ORIGIN`, provider client IDs, paths, tuning, image/schema version | Configuration, not cryptographic secrets | Preserve effective values and restore using a compatible release. An origin change may require OAuth redirect reconfiguration. Restore attachment-root contents to the configured mount, not necessarily the old host absolute path. |

No additional persistent secret outside these configuration surfaces was found in the inspected application. Provider passwords/tokens/client secrets are normally encrypted in PostgreSQL; database and attachments themselves are not encrypted at rest by Maildock. Backups remain highly confidential even without the keys.

## 5. Backup consistency model

**Required V1: offline application backup, PostgreSQL online for `pg_dump`.** Stop web, worker, standalone producers, migrators and any other writing clients. Restrict ingress/restart automation, wait for drain and confirm there are no remaining application writers before either copy. A routing maintenance page alone does not stop worker writes.

| Mechanism/timing | Assessment |
| --- | --- |
| Writers stopped → whole DB dump + whole attachment root + keys/config | Primary supported V1 path. Separate copy times are safe while relevant state is unchanged. |
| Online DB dump with app/worker active | PostgreSQL snapshot is consistent internally, but no coordinated blob/remote-effect snapshot exists. Not the supported complete recovery set. |
| DB snapshot newer than blob copy | New rows can point to absent files. Incoming data may be refetchable; drafts, signatures and outgoing MIME can be irrecoverable. |
| Blob copy newer than DB snapshot | Extra immutable files generally become orphans. This is safer in the current no-GC design but is not a general snapshot guarantee; directory-copy traversal and later GC/provider/DB changes are uncoordinated. |
| Upload staged or in progress | Snapshot can miss a file renamed after its shard was traversed, or capture incomplete `tmp` files. A DB reference must have its complete final file. Stop/drain first. |
| Worker active during dump/copy | Attachment publication, sync checkpoints, queues, outgoing states and provider operations can diverge. DB transaction isolation does not coordinate the filesystem. |
| Filesystem snapshot | Valid only with all writers stopped and either a PostgreSQL-aware consistent physical backup or a cleanly stopped PostgreSQL cluster. Do not copy a running PGDATA tree as a generic backup. Snapshot DB/blob domains together or keep writers stopped across both. |
| Generic backup tools | May transport/encrypt/retain the same offline recovery set. No application-level distributed snapshots or particular backup product is required. |

pg-boss application connections also stop. PostgreSQL's own background activity is compatible with a logical dump. A successful offline backup can still be stale relative to subsequent external SMTP/IMAP effects; section 12's recovery treatment is separate from byte consistency.

## 6. Reproduced pg_restore defect and root cause

Reproduction used the current hardened fresh-init SQL and complete production-image migrations. Source state included real Argon2 and encryption primitives, synthetic verified factor/recovery data, an actual successful HTTP password/TOTP login/session, disabled provider account, mailbox/message/body, draft/staged/outgoing references, blob bytes and a pg-boss job.

Dump, using ordinary `maildock` over private service TCP:

```sh
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U maildock -d maildock \
  -Fc --no-acl -f /evidence/baseline.dump
```

Restore into a new, empty, hardened PostgreSQL 18.6 installation:

```sh
PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h postgres -U maildock -d maildock \
  --no-owner --no-acl --exit-on-error --single-transaction /evidence/baseline.dump
```

Exit 1; exact relevant diagnostic:

```text
ERROR: function maildock_search_addresses(jsonb) does not exist
CONTEXT: SQL function "maildock_search_vector" during inlining
Command was: CREATE TABLE public.messages (...
 search_vector tsvector GENERATED ALWAYS AS
 (public.maildock_search_vector(subject, "from", sender, "to", cc, search_body)) STORED
);
```

`db/migrations/0019_global_search.sql` creates the addresses helper, then vector function using two unqualified helper calls and `'simple'`, then the generated column and its `messages_search_gin_idx` GIN index. `maildock_update_search_body` updates `messages.search_body` from content through a trigger, which causes vector recomputation. `schema.ts` mirrors the generated expression. No other direct helper caller was found. Function bodies are string SQL, resolved at execution/planning rather than storing all body dependencies at creation.

The archive places both functions before `messages`. Its SQL sets `pg_catalog.set_config('search_path', '', false)` and `check_function_bodies=false`. The outer generated expression is already qualified by pg_dump; the nested helper inside the function body is not. SQL inlining/immutability preparation resolves the body while creating the stored generated column. The index is a downstream dependency, not the first failing object. All-or-nothing restore rolled back the failed import.

Official references: [pg_dump format and scope](https://www.postgresql.org/docs/18/app-pgdump.html), [pg_restore behavior/options](https://www.postgresql.org/docs/18/app-pgrestore.html), and [CREATE FUNCTION body/dependency semantics](https://www.postgresql.org/docs/18/sql-createfunction.html).

## 7. Candidate restore fixes

| Candidate | Evidence and disposition |
| --- | --- |
| A. Qualify application helper calls/configuration; qualify built-ins | **Recommended.** `public.maildock_search_addresses`, `'pg_catalog.simple'`, and explicit `pg_catalog` built-in function references work without adding public to the search path. Qualification-only custom archive restored successfully. Expanded built-in-qualified variant also restored freshly and passed production migrations/empty-path calls. |
| B. Function-local explicit path | A disposable full SQL restore with vector function `SET search_path TO pg_catalog, public, pg_temp` succeeded. Function-local setting is better than session guesswork but retains resolution through mutable public and prevents normal SQL inlining. `pg_catalog, pg_temp` alone cannot resolve the current unqualified application helper; it needs A anyway. Not needed for the chosen definitions. |
| C. Restore-session search path | F12.2's trusted rendered-SQL header change is a workaround, not an intrinsic fix. Here `PGOPTIONS='-c search_path=pg_catalog,public'` still failed: pg_restore overrides it. Broad public/session-path instructions are rejected as the primary V1 solution. |
| D. Custom options/order | Reordering cannot fix an existing helper hidden from name resolution. `--no-owner` addresses ownership, not this defect; superuser and trigger disabling do not solve it. Exact function TOC exclusion plus corrected predefinitions succeeded for legacy archives. |
| E. SQL-standard parsed body (`BEGIN ATOMIC`) | Could capture dependencies at definition time and allow dump ordering to track them. More change than required; not runtime-tested here. Post-V1 alternative, not a prerequisite. |

PostgreSQL warns that schemas on a search path trust their CREATE-capable users; see [schema/search-path security](https://www.postgresql.org/docs/18/ddl-schemas.html). Keep the functions SECURITY INVOKER. Do not introduce SECURITY DEFINER, `$user`, extension/untrusted schemas, bootstrap authority or a broad global path. Qualification avoids needing new grants or executable privileged helpers.

## 8. Recommended restore fix

**Required V1:** add a new numbered migration replacing the two search-function definitions with the same signatures/return types/semantics, `IMMUTABLE PARALLEL SAFE`, schema-qualified application calls, explicit `pg_catalog` built-ins and `'pg_catalog.simple'`. Keep existing invoker authority, weighting and address aliases. Do not rewrite historical 0019, remove/recreate the generated column, drop the index or rebuild mail rows.

`CREATE OR REPLACE FUNCTION` under the ordinary owner preserves OIDs and dependent generated-column/index bindings. The tested candidates did not change the resulting token/weight meaning. The normal Drizzle journal applies the new migration once in its pending-migration transaction; use a monotonically later journal timestamp. Definition replacement is independently repeatable. No superuser or role maintenance is required. Implementation must compare representative vectors before/after; a semantic change would require different data/index planning.

**Required legacy compatibility:** old archives cannot reach the new migration until schema restoration succeeds. Provide a packaged, version-checked restore bridge that predefines exactly the two corrected functions in the empty destination and excludes exactly their two FUNCTION definitions from the archive TOC. Validate signatures/counts and archive schema version; reject unknown variants. Restore everything else normally with `--no-owner --no-acl --exit-on-error --single-transaction`. The prelude must use the ordinary owner. Failed remainder restores leave only predefinitions; use fresh disposable destination storage before retry, never reuse an uncertain partial installation.

The exact two baseline TOC FUNCTION entries were excluded in an experiment; helper/vector were precreated from the reviewed migration with scoped substitutions; complete baseline archive then restored successfully, preserving owner/message/draft/outgoing and 32 migration entries. Future implementation should package this operation rather than ask operators to improvise regex changes or edit a dump by hand. The final corrected schema's ordinary dump needs no bridge.

## 9. Supported PostgreSQL backup format and command model

**Required V1 primary: full custom-format `pg_dump -Fc --no-acl`, restored with `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`.** No schema/table/data-only exclusions, `--disable-triggers`, globals, `--create`, or in-place `--clean` restore in this contract. Use the PostgreSQL 18 client from the matching service image and initially restore to the tested major version. PostgreSQL major upgrades are a separate procedure; do not promise downgrade compatibility.

Custom format gives compressed, inspectable archives and exact TOC selection for legacy compatibility. Plain SQL can also represent the complete DB but does not fix the search issue, is easier to accidentally alter, and adds an unnecessary second primary path. Use rendered SQL only for inspection/controlled compatibility tooling. `--no-owner` on custom-format pg_dump is not the ownership mapping mechanism; specify it at pg_restore.

Proposed operator command model (POSIX shell; translate shell syntax for the operator's host):

```sh
# All writers and restart automation already stopped; recovery dir is protected.
docker compose exec -T postgres sh -c '
  umask 077
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -Fc --no-acl -f /tmp/maildock-recovery.dump
'
docker compose cp postgres:/tmp/maildock-recovery.dump ./recovery/database.dump
```

Use a unique temporary name in actual tooling, inspect exit code/stderr, copy in binary-safe fashion, hash the host artifact and remove the container-side temporary copy after verification. Avoid Windows shell binary stdout redirection pitfalls. For large installations, write to a protected operator-provided backup mount rather than filling the container writable layer. Set a passfile with restrictive permissions if preferred. The shown service uses existing synthetic-env-style delivery, not passwords embedded in host command history. `PGPASSWORD` is still sensitive process environment, not protection from Docker administrators.

Restore copies the archive into the private postgres service/backup mount and invokes matching pg_restore there with the destination's ordinary credentials. No public PostgreSQL port or persistent DBA credential is required. A role-check maintenance invocation before and after import is part of the proposed tooling, not a currently shipped CLI switch.

## 10. Attachment backup model

**Required V1:** archive the complete stopped-writer attachment volume/root preserving numeric ownership, modes and relative paths. A one-off existing app image running `tar` is sufficient; it is not a third mandatory service. For example, with a protected absolute host recovery directory mounted at `/recovery`:

```sh
docker compose run --rm --no-deps --user 0 --entrypoint tar \
  -v /absolute/protected/recovery:/recovery app \
  -cpf /recovery/attachments.tar -C /var/lib/maildock/attachments .
```

All long-lived app instances must remain stopped while this helper runs. It only reads the application volume. Extraction is into a fresh attachment volume with the compatible image/helper and preserved UID/GID 1001. Do not overlay older blobs on a live deployment or selectively copy only incoming attachments. Do not garbage-collect removed/expired objects as part of backup.

Store a manifest with recovery-set ID, creation interval, release/image identification, PostgreSQL and migration versions, filenames/sizes/checksums, expected owner identity, key IDs (not public key bytes), volume/path mapping and effective configuration. Protect the manifest as installation metadata. Mark a set complete only after all artifacts/secrets have been copied and verified; failure means keep the previous known-good set.

## 11. Full restore drill and evidence

Temporary evidence root: `C:\Users\mateu\AppData\Local\Temp\maildock-f125-4b4d0c31b18b443daea5d13aae4bb281\evidence`. Scripts/dumps/configuration contain synthetic secrets only. They are not repository files or a supported maintenance product.

1. Fresh `maildock-f125` Compose project used current `99-maildock-authority.sql`, private PostgreSQL 18.6 and the newly built production image. All 32 application migrations completed. No real environment file was resolved.
2. Seeded a single synthetic immutable owner using the repository's Argon2 parameters and provisioning row shape; factor/recovery data used the installed Better Auth symmetric primitive. Fixture factor was inserted as verified, not claimed to exercise initial enrollment. Actual password→TOTP→business HTTP sequence then returned 200/200/200 and created a real session.
3. Created disabled encrypted-password mail account, INBOX/placement/message/plain/search body, draft/staged/draft attachment, outgoing `uncertain` snapshot and attachment reference, expired session, verification/throttle row, actual blob and pg-boss `f125-synthetic` future job. Outgoing fixture demonstrates persisted metadata/references; no MIME delivery or real provider was attempted.
4. Stopped actual all-role app with 60s allowance: approximately **1.07s**, exit **143**, OOMKilled=false; observed `worker.shutdown`/`jobs.stopped`. Dumped DB, archived attachment root and preserved synthetic config/keys.
5. New hardened `maildock-f125-restore` DB rejected baseline archive as above. Qualification-only candidate applied exclusively to source disposable function definition and dumped; default pg_restore then succeeded.
6. Deleted the source's active session after backup (`DELETE 1`) to model revocation. Destroyed source app/postgres containers, both source volumes and network. Also removed the first target DB, then recreated empty target storage. Restored candidate archive and attachment tar into fresh storage after source destruction.
7. Production entrypoint reran migrations and started web/worker. Verified the following:

| Assertion | Observed evidence |
| --- | --- |
| Immutable owner | `d7afb047-b000-4b7d-bff7-450de57c5800` unchanged; readiness's business owner/MFA reader true. |
| Password | Restored Argon2 hash verified the known synthetic password; actual fresh HTTP password/TOTP login succeeded. |
| Credential envelope | Existing AES-GCM envelope decrypted with `maildock:account-credential:v1:<account-id>:imap` to the exact synthetic credential. |
| MFA/recovery | TOTP secret decrypted to expected value; verified owner/factor true; two original synthetic recovery codes decrypted. |
| Attachment | 36,864 bytes, SHA-256 `7e39a6ff6cfd4ada95f8d96321628dfb0da8eb73787c7a690ad0a47e2110de01`; restored file UID/GID 1001/1001, mode 0600. |
| Message/content | Subject `Synthetic restore subject`, search body `Synthetic message body`, reference IDs and generated search vector present. |
| Draft/outgoing | One draft and durable outgoing `uncertain` state/references present; legacy-archive verification also confirmed them. |
| Migrations | 32 metadata entries; production migrator completed. |
| pg-boss | Schema 42; original job `0d4066e3-7ec9-433b-92b0-3a0521018410` retained in `created` state; production worker emitted `jobs.started`. |
| Authority | Ordinary role flags, no memberships; zero application relations/functions owned by another role; real startup authority guard passed. |
| HTTP | Ready 200. Revoked-after-backup cookie recovered business access **200** before invalidation. |

8. Stopped restored app; disposable transaction removed sessions/verification/OAuth states, rotated recovery-code ciphertext and conservatively handled pending remote operations. It preserved verified MFA and owner; sessions/verification count became 0, old recovery code absent, ten new codes decoded. Restart yielded old cookie **401**, ready **200**, and new password/TOTP/business **200/200/200**. This proves primitives and the verified-owner transaction; it is not an implemented production command or complete pending-replacement drill.
9. Separately restored the **unmodified baseline archive** using exact two-function TOC exclusion/predefinitions: ordinary guard passed, owner/hash/draft/outgoing verified. Expanded recommended `pg_catalog`-qualified definitions were dumped and restored into a further fresh `maildock-f125-final` DB; production migrator succeeded; direct vector evaluation with empty session path succeeded.

Artifact SHA-256:

```text
baseline.dump:   184f1a6f5257688bf72ed6e23a5982910279aad4863b70b405690fcb1505d141
candidate-A.dump: ebbdd4a0320d984f1ec27e60b9728a6f820adec5da8a19444b06d41eb89b2b6e
attachments.tar: cc3da7fd3aa3661bb8fee1ea2d904639ea6f1c79ba3434aad958dab4933bf96a
```

Scope limits: representative synthetic installation, not every table populated or every provider exercised. No real initial/replacement MFA enrollment, active SMTP transaction, live IMAP recovery, workload-scale restore, pg-boss upgrade or disk-full PostgreSQL test was run here. No full F1–F11 suite was run or new test files created. These limits do not become invented passes.

## 12. Authentication-state rollback analysis

Logical restore rolls back security history, not just messages. Sessions can become valid again if still within inactivity/absolute lifetime; an expired session remains subject to existing lifetime checks. Deleted challenge rows, consumed recovery codes, old password hashes, old TOTP factors and throttling counters can reappear. Rotating `AUTH_SECRET` alone is wrong: it also destroys restored MFA decryption and does not preserve a usable verified-owner installation.

Any disaster restore must invalidate all business/provisional sessions, verification challenges/attempt rows and OAuth authorization state before ingress or consumers start. Rotate recovery codes so previously consumed/revoked copies cannot be used. Preserve owner binding, password hash and verified TOTP; never create a new owner or disable MFA. Preserve admission/factor lockouts as restored; wall-clock expiry still applies. Resetting them does not reconstruct lost post-backup failures and must not be sold as a security guarantee.

**Pending replacement is special.** `startAuthenticatorReplacement` deletes the old factor, creates an unverified new factor, clears user MFA flag, persists `mfa_replacement`, and deletes sessions. The replacement row intentionally remains even after expiry to prevent password/bootstrap fallback. Deleting that row or marking the factor verified without proof is unsafe. Restore tooling must invalidate its old token but retain the guard/pending factor until explicit completion. Initial unfinished enrollment likewise must remain closed to business operations.

A DB backup cannot know a later password change or factor revocation. After recovery, the owner must review whether restored credentials/factor were subsequently changed or compromised; replace them through supported authenticated management where necessary. Session/code invalidation does not establish that an old TOTP secret is still trustworthy. Lost security history is an accepted backup-age residual, with this explicit recovery obligation.

**External effects:** a snapshot can contain `queued` mail that was sent after backup, or a pending sent-copy/remote command that later completed. Restored consumers would otherwise repeat the old intent. Mark all restored `queued`/`sending` outgoing snapshots `uncertain`, pending/saving sent copies `uncertain`, and pending/executing remote message commands `failed` with a fixed restore-review reason before worker startup. Keep immutable bytes/references and pg-boss jobs. Existing handlers' state checks can safely consume obsolete jobs without repeating those operations. Drafts may also reappear active after later consumption; owner must review before submitting again. No exactly-once SMTP or provider-transaction rollback exists.

## 13. Proposed post-restore security-state invalidation

**Required V1: explicit supported offline application maintenance command**, e.g. a compiled `restore-security-state` entrypoint (proposed name, not available at baseline). Do not infer restoration on every app restart. There is no independent durable restore marker today; automatic session destruction on normal startup would break normal operation.

The command must:

1. Require stopped writers/reviewed recovery set and verify actual database authority. Operate with the ordinary URL; never accept an admin credential or mutate owner identity.
2. Validate current schema, exactly one configured bound owner, password account, factor state and relevant key decryption. Validate referenced blob sizes/hashes through the existing verified-read primitive before any business restart. Missing/orphan registry entries must be reported distinctly from missing referenced bytes.
3. In one READ COMMITTED transaction using existing auth advisory lock 1296125023, recheck state and delete `session`, `verification` and `oauth_authorization_states`. Preserve throttles/factor failure budgets and lifetime rules.
4. For a verified owner, cryptographically generate fresh codes using the installed Better Auth-compatible format, encrypt with the matching secret and replace only recovery-code ciphertext. Preserve the verified TOTP secret and both verification flags. Deliver new codes only to a protected operator terminal/file, never logs/stdout redirected into platform logs. Reexecution invalidates the previous issued code set and reports that fact.
5. For pending replacement, revoke the old token by replacing its digest with an unknown random value and expiring it; **retain the replacement row and unverified factor**. Return a distinct “MFA completion required” state, never business readiness. Offer an explicit offline continuation operation bound to the same owner and pending factor: verify the owner password, decrypt/provide the existing pending enrollment secret only over the protected local operator channel, require a valid TOTP proof, then complete the same verified-factor/user-flag/row-removal transition as existing replacement completion. Recheck under the lock and atomically invalidate sessions/challenges and issue fresh codes. No password-only completion. Unknown/inconsistent states refuse unchanged. Initial unfinished setup uses its original bootstrap/enrollment contract, not a second-owner bypass.
6. Conservatively fence the remote-operation states from section 12 in the same offline operation. Do not delete the durable pg-boss schema or immutable outgoing snapshots. Keep fixed F11-safe diagnostics; no email, URLs, keys, codes or raw SQL errors in ordinary logs.
7. Exit successfully only after verification and committed cleanup; failure keeps writers/ingress stopped. Normal startup does not retry or silently skip it. Document secure code-delivery failure handling: rerun while offline to replace codes, never publish a stale receipt.

No manual SQL editing of owner/auth rows is an operator contract. The disposable mutation probe demonstrates the verified-owner case only. Implementation still needs focused validation of pending/expired replacement and interrupted maintenance/code delivery. These are explicit implementation acceptance criteria, not evidence that such a command already exists.

## 14. Restore and F12-03 authority

Provision fresh destination postgres through current mounted initialization SQL **before** importing data. The database exists, owned by ordinary `maildock`; its bootstrap role is separate and locked. Map imported application ownership to the destination login with `--no-owner --no-acl`, rather than importing global roles/passwords or historical superuser ownership. A new DB password is allowed; matching cryptographic keys are not optional.

Observed ordinary role: LOGIN=true; SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS=false; explicit membership count=0. `maildock_bootstrap` remains OID-10 superuser **NOLOGIN**; fresh init validates PASSWORD NULL. It is not an application credential. Subsequent ordinary checks retain F12-03's accepted boundary: they cannot reread `pg_authid` verifier material, and do not add a privileged verifier function.

Source/destination app relations/functions were owned by `maildock`; production migration and independent roots passed the actual guard. A separate fresh legacy-superuser DB caused the production migrator to exit 1 with category `database_authority`. No elevation was needed to dump, restore, apply candidate definitions or start pg-boss.

Physical restoration of a pre-F12-03 cluster preserves its unsafe historical role model; keep writers offline and use the existing documented authority transition after backup verification. Do not treat restoring old PGDATA as equivalent to fresh hardened logical restore. External PostgreSQL uses its ordinary owner/equivalent scoped authority; do not run fixed-name bundled role maintenance against a shared cluster.

## 15. Production update/migration contract

**Required V1 ordering:**

1. Review/pull/build the new immutable release before downtime where possible; preserve the old image/release and operator configuration. Check compatibility/release notes; do not automatically advance PostgreSQL major version.
2. Restrict ingress and restart/deployment automation. Stop every writer with at least the grace below; verify drain/no remaining application sessions or active migration. Resolve uncertain termination before marking backup complete.
3. Take and verify the offline pre-upgrade DB/blob/key/config recovery set. This backup precedes any new-version schema or pg-boss work. Failed backup aborts the update.
4. Confirm database authority; perform existing explicit F12-03 transition only if a known legacy deployment requires it and its own preconditions are met.
5. Run the new image's migration root alone with the normal credentials (entrypoint overridden to compiled migrator). Inspect exit code and fixed diagnostics; leave workers/web stopped on failure.
6. Start the new all-role app. Its entrypoint repeats the idempotent migrator, then starts web/worker; pg-boss initializes/upgrades through its own lifecycle. Avoid concurrent migrators or mixed-version writers.
7. Verify health/readiness, authority, owner/MFA, required key decryption and attachment access, plus worker startup/queue operation. Reopen ingress only after the release acceptance checks. A readiness 200 is not an end-to-end authentication/provider/worker audit.

Routine successful update does not restore older state and need not revoke all sessions. Disaster restore does. Preserve exact image identity and effective key configuration in each recovery set.

## 16. Migration failure/rollback contract

Drizzle creates its metadata schema/table outside the pending-migration transaction, then applies pending SQL and journal inserts in one transaction. It chooses migrations by journal timestamp; it is not a comprehensive historical SQL checksum validator. Current migration main validates authority first, then Drizzle, OAuth bootstrap and resumable local search conversion. The latter post-migration work is outside the schema transaction. pg-boss migrations/BAM also have their own lifecycle; do not imply the entire upgrade is one transaction.

Real library fault probes, without changing repository migrations:

- Pending synthetic migration created `f125_interruption_probe`, then divided by zero. Rejected; table absent afterward; journal count 32→32.
- Another actual Drizzle call created the same probe then slept; `pg_stat_activity` showed `PgSleep/active`. SIGKILL of that disposable migration container left table absent and count 32. No claim of killing every historical migration instruction.

Retry the new version only after diagnosing a transient failure, verifying no partial nontransactional/post-migration effects require intervention, and confirming no incompatible concurrent writer ran. Do not delete migration rows to force retry.

**Supported downgrade/recovery:** stop new writers, retain the failed deployment for diagnosis, and restore the **entire pre-upgrade recovery set into fresh DB/blob storage**, matching its old release and keys/config. Apply post-restore security/remote-operation handling, then start that old release and verify. Never promise that starting the old image against forward-migrated DB is a rollback. Never restore only DB while retaining post-upgrade blobs or vice versa. Writes accepted after upgrade are lost by this rollback and require explicit operator acknowledgement in the eventual procedure; provider-side sends cannot be undone by restoring files.

If the schema transaction demonstrably rolled back and no later startup/nontransactional work occurred, the unchanged old release may be usable; that is a verified specific failure case, not the default rollback promise.

## 17. Graceful shutdown findings

Current exec-form entrypoint is Node PID 1, spawns migration first, and only installs signal handlers after migration succeeds. Then it forwards SIGTERM/SIGINT to web/worker, stops siblings after first exit and awaits both. It has no internal kill deadline. Shutdown during migration lacks the normal forwarding/drain path; container teardown/disconnected DB transactions are the safety boundary. Verify all writers have gone before backup.

Worker stops pollers/watchers, calls `boss.stop({graceful:true, timeout:30000})`, then ends its database client. Installed Next shutdown stops accepting HTTP and waits for pending connections/cleanup before exiting 143 on SIGTERM. In-flight poll promises and provider/network waits are not a demonstrated universal bounded shutdown. Base Compose has no `stop_grace_period`, so its usual shorter timeout does not honor the 30s boss allowance.

**Required supported minimum: `stop_grace_period: 60s` on app, or equivalent platform timeout; use `docker compose stop -t 60 app` until configured.** This provides budget beyond boss's 30s plus teardown. It is not a mathematical upper bound for every network/provider hang; monitor completion, extend where measured workloads need it, and treat forced termination explicitly. Idle production all-role shutdown was actually observed at 1.07s with worker drain and no OOM. Active real SMTP/IMAP shutdown was not tested.

Forced stop can expire/reclaim active pg-boss jobs, repeat sync work from durable checkpoints, leave attachment tmp/orphans, or leave outgoing `sending` uncertain. Current sending recovery marks uncertain rather than resubmitting; sent-copy recovery tries to reconcile its recorded destination and can also become uncertain. Backups older than remote effects require additional fencing as above. No exactly-once claim. Earlier migration signal forwarding/internal timeout refinements are defense-in-depth if the supported operator procedure already checks quiescence.

## 18. Storage capacity and retention findings

| Growth | Current bound/reclamation | Required operator monitoring |
| --- | --- | --- |
| PostgreSQL mail/body/search/draft/outgoing state | No installation-wide byte quota/mail retention. Indexes, WAL and dead tuples also use capacity. | DB filesystem free bytes/inodes, DB size/growth, WAL/maintenance condition and backup/restore workspace. |
| Attachment/MIME blobs | Per-object limits, no total volume quota or reference-aware GC. | Attachment filesystem free bytes/inodes/growth, retained tmp/orphan inventory; do not automatically delete by age. |
| Staged uploads | 24h expiry controls eligibility, not physical deletion. `removeStaged` marks removed and explicitly retains bytes. | Same attachment capacity; removal/expiry is not a disk-space remedy. |
| Message deletion | FK metadata cascade does not reclaim the physical file or necessarily its `blobs` row. No service call implementing full reference-aware deletion was found. | Expect retained bytes even after account/message/draft cleanup. |
| pg-boss | Observed queue defaults: 1,209,600s (14d) pending retention, 604,800s (7d) terminal deletion; active maintenance and queue settings matter. No independent forever archive was found in this version. | Queue backlog/age/failures, DB space/maintenance. Defaults limit age, not instantaneous ingestion volume or hard disk usage. |
| Application Events | Opportunistic/hourly cleanup: 30d and newest 10,000 rows. | Confirm maintenance runs; these bounds do not rotate stdout. |
| Container/platform logs | Base Compose supplies no rotation/cap. | Host/log filesystem and effective driver policy. |
| Backups | Copies can be as large as complete retained mail; verification needs fresh restore capacity. | Separate recovery-store capacity, successful complete sets, age and a spare verified set during updates. |

**Required V1:** define actionable capacity alerts with enough free space for expected growth, active transactions/WAL, an update and backup/restore headroom; do not prescribe universal percentages as a tested safety threshold. Check filesystem free space and inodes for each storage domain, not just SQL database size. Plan retention for complete backup sets, keeping a known-good set until replacement is verified.

Bounded 64KiB tmpfs fault probe in an actual production web container: LocalBlobStorage returned `ENOSPC`, zero leftover tmp files after its normal cleanup, full-volume readiness 503. This did not fill the host or DB disk. PostgreSQL disk full can prevent commits/checkpoints and cause outages; attachment full fails uploads/sync/send materialization; log/backup growth can exhaust shared host capacity. No universal crash/no-data-loss guarantee was proved. Stop writes and add capacity; do not free space by deleting arbitrary blob/PGDATA files. Conservative future GC is post-V1, not required to make this offline model work.

## 19. Log confidentiality/retention contract

**Required V1:** operator-controlled stdout/stderr retention must be bounded, access restricted and included in host capacity monitoring. F11 constrains application diagnostic content, but logs remain installation-sensitive. Docker administrators, platform members, log agents and exported support bundles are privileged readers. Treat platform live-log/history surfaces identically; no particular stack/product is required.

Use a rotating Docker logging driver (for example `local`) or bounded `json-file` options such as `max-size: "10m"`, `max-file: "3"`, or a platform-equivalent policy. Those values are an illustrative cap, not a measured universal retention requirement. Confirm the **effective** driver/options on recreated containers; daemon changes do not retrofit existing ones. Choose a short justified retention period and restrict viewer/export/backup permissions. Avoid secrets in command arguments, rendered Compose, DB statement/audit logs or manual recovery-command output. No routine log backup is required for application recovery; retained forensic copies get the same confidentiality/retention treatment.

Central log aggregation and longer forensic retention are defense-in-depth. No newly reproduced application leak warrants reopening F11; error output in these probes used existing fixed diagnostics. Preserve F11 rather than suppressing all operational failures.

## 20. Bind-mount ownership

Observed image runtime user is `maildock`, numeric **UID/GID 1001:1001**. Named attachment volumes initialized from the image work and are preferred for the simple contract. Custom attachment bind mounts must be traversable/readable/writable by that identity, private from other local users, and support mkdir, exclusive files, rename and fsync. Recommended dedicated root 0700 owned by 1001:1001; generated directories 0700/files 0600. Image's initial root is 0755; do not make it world-writable to solve permission errors. Preserve numeric ownership during restore; host usernames need not match.

PostgreSQL bind mounts follow the tested image's own postgres OS identity and initialization requirements, not application UID 1001. No blanket chown of the database volume to 1001. Named PostgreSQL 18 volume remains mounted at `/var/lib/postgresql`. Bind mounts are optional, not a prerequisite.

## 21. Secret handling during backup/recovery

**Required V1:** `.env`, platform environment settings, rendered `docker compose config`, Docker inspection, recovery bundles and copies are restricted operator data. On POSIX hosts use protected directories/files (typically 0700/0600); on Windows use equivalent owner/admin ACLs. Keep `.env` and secret-bearing recovery copies out of Git, public web roots, issue attachments and unrestricted shared folders. Use encrypted backup transport/storage or an equivalently controlled confidential destination; protect encryption/decryption material with an independently recoverable copy.

Back up effective key bytes and IDs safely; archive compression/checksums do not encrypt data. Prefer a separate protected key/config recovery copy so data-backup exposure alone does not supply every decrypting key. Ensure it is available during a restore drill. This separation is recommended defense-in-depth; indispensable key preservation/confidentiality is required. Platform environment export remains confidential even when masked in the UI.

Do not run production Compose without the intended environment/project and accidentally select other volumes. Never paste rendered config as a support diagnostic. Avoid passwords on host command lines; reuse protected service environment/passfiles. Maildock does not support native `*_FILE`; a platform may inject env securely through its own mechanism, but adding `*_FILE` or a mandatory external secret manager is not required for V1. F12-06 passthrough stays separate.

## 22. Negative recovery tests

| Case | Evidence | Classification |
| --- | --- | --- |
| Unmodified baseline custom restore | Fresh hardened destination; messages generated-column creation failed; exit 1 and transaction rollback. | **Detected/fail closed**, V1 blocker until definitions/legacy bridge provided. |
| PGOPTIONS search-path workaround | Same restore still failed because pg_restore overrides path. | **Detected**, unsupported workaround. |
| DB without matching blob snapshot / missing blob | Renamed referenced restored file away; verified read rejected but HTTP ready stayed 200. | **Silent installation inconsistency at readiness; detected on use.** Not acceptable as a verified recovery set. |
| Corrupt blob | Same-size substituted bytes rejected by existing SHA-256 verified read, then original file restored. | **Detected/fail closed on consumption.** No claim that health scans all blobs. |
| Missing active encryption env | Production migrator exited 1, fixed `configuration` diagnostic. | **Detected/fail closed.** |
| Missing historical key / wrong key | Existing credential primitive rejected both; no plaintext returned. | **Detected on decryption**, degraded installation possible until full recovery verification. |
| Wrong valid AUTH_SECRET | Real production web started and readiness 200; password challenge 200, TOTP 503 generic, business 401; primitive rejected old factor ciphertext. | **Auth fails closed; readiness does not detect.** Recover matching secret. |
| Wrong DB password/config | Production migrator exited 1 with `database_unavailable`. | **Detected/fail closed.** Existing-volume env changes are not password rotation. |
| Unsafe authority | Production migrator against separate fresh bootstrap-superuser DB exited 1, `database_authority`. | **Detected/fail closed.** |
| Stale revoked session | Source deleted active session after backup; restored old cookie returned business 200. Offline invalidation then 401; fresh MFA login 200. | **Silent restored authority before maintenance; required invalidation.** |
| Old recovery codes | Restored encrypted list contained old codes; disposable replacement produced ten fresh codes, old code absent. | **Rollback risk; required rotation.** Primitive/DB proof, not an HTTP code-consumption race test. |
| SQL migration error | Actual installed Drizzle call: DDL+divide-by-zero; table absent, metadata count unchanged. | **Detected/transaction rollback**, subject to post-migration/pg-boss caveats. |
| Interrupted migration | Actual Drizzle transaction observed sleeping, container SIGKILL; table absent, metadata unchanged. | **Recoverable rollback** for tested transactional SQL. |
| Disk-full attachment/write | Capped tmpfs returned ENOSPC, tmp cleanup worked, full-storage HTTP ready 503. | **Detected/write failure**, PostgreSQL full-disk behavior not injected. |
| Pending/expired replacement restoration | Source reviewed destructive factor replacement and persistent guard; dedicated end-to-end restored replacement not exercised. | **Fails business readiness by design; implementation must validate explicit guarded completion.** |
| SMTP or IMAP effect after snapshot | Inspected durable queued/sending/command handling; no live provider effect test. | **Accepted distributed-effect residual**, requiring conservative restored-operation fencing and owner review. |

Additional not-tested cases: actual PostgreSQL disk exhaustion, host power loss/filesystem corruption, every historical schema/provider variation, active long SMTP drain. Do not turn these into guarantees or artificial infrastructure requirements.

## 23. Required V1 remediation

1. Intrinsic restore-safe search definitions in a new migration, plus packaged exact/version-checked bridge for historical archives.
2. Offline complete recovery-set instructions/tooling: DB, attachment root, indispensable keys and effective config/release, with verification before restart.
3. Supported deterministic post-restore maintenance: all session/challenge/OAuth invalidation, fresh recovery codes, preserved owner/mandatory verified MFA, guarded pending-MFA completion, conservative remote-operation fencing. No operator auth-row edits.
4. Document update/migration ordering and full matched-set failed-update recovery, without an unsupported old-image rollback promise.
5. At least 60s app stop grace or equivalent operator setting, with quiescence checks/forced-stop uncertainty.
6. Document minimal capacity/log rotation/confidentiality, bind ownership and secret handling; verify recovery cryptography and referenced files beyond readiness.

These are bounded single-owner recovery correctness/security blockers. They do not add a backup service, Redis, external secret manager, proxy product or multi-role application deployment. F12-05 cannot close on documentation alone while the default restore and restored-session problems remain.

## 24. Defense-in-depth / post-V1 recommendations

- Automated encrypted backup scheduling/off-host redundancy and periodic disposable drills; V1 needs an executable verified procedure, not a mandatory scheduler product.
- Point-in-time PostgreSQL/WAL recovery and coordinated storage snapshots for lower downtime/RPO; online distributed blob snapshots require separate design.
- Reference-aware GC with durable-reference/race proofs; no age-only deletion. Storage quotas and installation-specific growth forecasting.
- Separate migration/runtime DB roles, stronger container filesystem restrictions, centralized log collection and immutable backup storage.
- Function-local catalog-only paths or parsed SQL bodies if later needed; no broad mutable path. Earlier migration signal handling/internal drain deadlines after measured validation.
- More extensive provider/fault/load drills and operator observability. F12-04 image minimization and F12-06 env pass-through remain their own work.

## 25. Exact files likely to change during implementation

| File | Proposed responsibility |
| --- | --- |
| `db/migrations/0032_restore_safe_search.sql` (proposed new filename) | Replace exact helper/vector definitions as designed. |
| `db/migrations/meta/_journal.json` and new `0032_snapshot.json` if generated by existing tooling | New migration metadata; preserve all historical entries. |
| `src/shared/infrastructure/database/schema.ts` | Explicit public qualification of mirrored generated expression for future schema generation; no new column needed. |
| `src/shared/infrastructure/database/restore-verification.ts` (new) | Owner/MFA/key/blob/schema verification using existing primitives and authority guard. |
| `src/modules/auth/application/restore-security-state.ts` (new) | Scoped transactional transient invalidation/code rotation and guarded pending-MFA continuation. |
| `src/composition/recovery-process.ts` (new) | Offline maintenance entrypoint, safe diagnostics and protected code/proof channel; no HTTP owner bypass. |
| `scripts/postgres/maildock-restore-compatibility.sh` and scoped restore-function SQL resource (new) | Archive version/signature/TOC validation and legacy restore bridge under ordinary role. |
| `tsconfig.worker.json`, `Dockerfile`, possibly `package.json` | Compile/copy/expose maintenance root and compatibility resources explicitly; auth helpers currently are not all present in `dist-worker`. |
| `docker-compose.yml` | App 60s stop grace; explicit reviewed compatibility-resource mount if chosen. No new mandatory service or secret. |
| `README.md`, `docs/DEPLOYMENT.md`, `.env.example` where explanatory comments are needed | Complete operator commands, recovery-set/secret/update/log/capacity contract. |

Exact new filenames are design proposals, not existing commands. Preserve `scripts/postgres/99-maildock-authority.sql`, existing authority maintenance semantics, historical migrations, auth identity/MFA policies and pg-boss durability. New restore classifications should reuse F11 safe diagnostics. No XLF, upgrade codeunit or test-file changes in this session; later test creation requires the user's explicit authorization.

## 26. Regression assessment and cleanup

No tracked implementation changed, so current F1–F11/F12.1/F12-03 behavior was not altered. Focused real-image checks established ordinary authority, real password/TOTP login, stale-session rejection after disposable maintenance, exact verified blob reads and worker/queue startup. They are not an exhaustive regression suite.

Implementation acceptance must retain immutable owner, mandatory MFA, existing admission/Origin/lifetime boundaries, safe fixed diagnostics, exact bounded storage reads/writes, invoker functions and ordinary-owner migrations. Do not drop pg-boss durability or immutable outgoing snapshots to avoid restore work. Preserve generic ingress independence and exactly app+postgres as mandatory base services.

Cleanup: discovery containers/networks/volumes for the `maildock-f125`, `maildock-f125-restore`, `maildock-f125-options`, `maildock-f125-final` projects and standalone capacity/wrong-auth/unsafe/interruption probes are removed after verification. Synthetic evidence and the local build image are retained for reproducibility; no production or preexisting development resources were touched. Evidence retention is outside the repository, not permission to retain real recovery keys this way.

## 27. Final answers

1. **What exactly must be backed up?** Complete Maildock PostgreSQL database including auth/MFA, messages/drafts/outgoing, pg-boss and migrations; complete attachment root; matching AUTH_SECRET and all referenced credential key versions/IDs; effective config and matching release/Compose/helper identification. Preserve owner access material confidentially. Logs are separate optional forensic artifacts.
2. **Must writers stop?** Yes for the supported generic V1 complete backup. PostgreSQL stays running for pg_dump; every application/worker/migrator writer stops across both DB and filesystem copies.
3. **Dump format?** Full custom `pg_dump -Fc --no-acl`; ordinary `pg_restore --no-owner --no-acl --exit-on-error --single-transaction` into fresh provisioned storage.
4. **Cause of failure?** Unqualified nested helper in string-bodied SQL vector function, resolved during stored generated-column preparation/inlining under pg_restore's empty search path.
5. **Schema fix or command only?** Fix the function definitions intrinsically; keep a narrow packaged compatibility path for old archives. No broad search-path workaround as the primary contract.
6. **New migration?** Yes: CREATE OR REPLACE exact definitions, normal Drizzle journal, ordinary owner, preserved data/OIDs/signatures/semantics.
7. **Can a complete installation be restored?** Yes, demonstrated on a representative synthetic installation after source storage destruction; final qualified schema and historical-archive bridge also passed. Full supported maintenance command remains to be implemented/validated.
8. **Indispensable secrets?** Matching AUTH_SECRET and each required credential-encryption key with its ID; preserve configuration/key-map semantics. DB password can change on fresh provisioning; completed-setup bootstrap secret is unnecessary.
9. **Invalidate which auth state?** All sessions/provisional sessions, verification challenges/attempts, OAuth authorization states and pending replacement tokens; rotate old recovery codes. Preserve immutable owner, verified factor and admission controls; retain pending MFA guard until proved completion.
10. **How?** Explicit guarded offline application maintenance command with existing advisory lock/transaction, key/blob verification, protected fresh-code delivery and pending-MFA proof flow. No owner/auth manual SQL instructions or automatic ordinary-startup reset.
11. **MFA/owner preserved?** Verified-owner drill preserved both; fresh login still required password and TOTP. Pending replacement must remain unavailable until password plus factor proof completes the same owner's enrollment.
12. **Least privilege?** Fresh F12-03 provisioning, no global role restore, no-owner/no-ACL import as ordinary maildock; validate attributes, membership/ownership and startup guard. Bootstrap stays locked, never an app credential.
13. **Failed-update rollback?** Stop writers and restore matched pre-upgrade DB+blob+keys/config into fresh storage with its matching old release, run restore maintenance/verification, then start/reopen. Image-only rollback is not promised.
14. **Stop grace?** Minimum 60s app grace/equivalent stop timeout; verify quiescence and treat force-killed provider work as uncertain. Idle actual-image stop passed; no universal network-hang bound proved.
15. **Monitoring?** DB/WAL, attachment bytes/inodes/orphans, queue backlog, host/container logs and backup/restore capacity/age/success. Bounded restricted log retention; removal/expiry does not reclaim blob bytes.
16. **Actual V1 blockers?** Restore-safe definitions/old-backup support, verified consistent recovery-set contract, supported stale-auth and remote-operation cleanup, safe update/rollback/grace and minimal storage/log/secret/ownership guidance. Enterprise backup products/GC/PITR/secret managers are not blockers.
17. **Ready for implementation?** Yes. Scope and acceptance criteria are concrete; no remediation was shipped and F12-05 remains open until implementation and its focused validation pass.

F12.5 RECOVERY DESIGN: READY
