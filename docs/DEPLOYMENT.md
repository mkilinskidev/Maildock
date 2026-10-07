# Production ingress contract

## PostgreSQL authority (F12-03)

Fresh bundled `docker compose up` runs the read-only
`scripts/postgres/99-maildock-authority.sql` as the **last** initdb step. Keep it
last: it disables the original bootstrap login. The normal TCP server, existing
PostgreSQL health dependency and application authority guard gate migrations and
web/worker startup. Base services remain exactly `app` and private `postgres`,
with the existing persistent PostgreSQL volume and one application `DATABASE_URL`.

The runtime `maildock` is an ordinary login with `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION NOBYPASSRLS`. It owns the Maildock database and
application objects, including Drizzle and pg-boss objects. Database ownership
deliberately allows migration and queue DDL and does not contain SQL injection
within Maildock's own data. The original OID-10 role is `maildock_bootstrap`,
`SUPERUSER NOLOGIN PASSWORD NULL`, retaining system/bootstrap ownership. No
membership connects the application to it. The temporary passwordless NOLOGIN
bridge is dropped before commit; no extra admin/migration credential remains.
The application username, database name and existing password are preserved.
The privileged transition explicitly verifies bootstrap `PASSWORD NULL` before
commit. On subsequent ordinary-login no-ops PostgreSQL hides `pg_authid`, so
verification covers NOLOGIN, catalog attributes, memberships and ownership;
it cannot independently reread the bootstrap verifier. This accepted boundary
does not add a persistent privileged verifier function or credential.

### Existing bundled volume: explicit offline transition

Installations created before F12-03 need an explicit maintenance operation. Do
not run the helper against an external/shared/custom cluster. Use your existing
Compose project name and **the same volumes and credentials** throughout:

1. Stop all writers: `docker compose stop app`, plus any independently launched
   web, worker, migrator or other client writing this database. Keep them stopped
   until every subsequent step succeeds.
2. Take and verify a consistent database/attachment backup, preserving the auth
   secret and every required credential-encryption key. Store backups and keys
   confidentially. Verify against disposable recovery storage using your
   recovery procedure below before changing authority. Historical archives
   require the packaged compatibility bridge below; this authority transition
   alone does not repair their search definitions.
3. Install this version's Compose file and both `scripts/postgres` helpers, then
   run `docker compose up -d --no-deps --force-recreate postgres`. Recreating the
   container retains `postgres_data`; **never use `down -v` or delete the volume**.
   Wait for PostgreSQL to become healthy. Existing PG_VERSION skips initdb
   scripts; changing `POSTGRES_*` variables never upgrades an existing cluster.
4. Run the supported maintenance invocation (the flag confirms steps 1–2):

   ```sh
   docker compose exec -T postgres sh /usr/local/bin/maildock-authority-maintenance --writers-stopped-backup-verified
   ```

   It runs `psql -X -v ON_ERROR_STOP=1` on the local socket, closes that session,
   then opens a **new password-authenticated TCP connection** as `maildock` with
   the existing `POSTGRES_PASSWORD` and verifies the hardened model again. A
   deliberately incorrect password must fail too. The helper uses the private
   `postgres` service address, because initdb's loopback HBA rules may use trust;
   custom passwordless authentication is refused.
   A password mismatch fails this second step without undoing the committed
   hardening. Correct operator configuration, retry verification and keep the
   application stopped until successful.

5. Only after successful verification, run `docker compose up -d --no-deps
--build app`. Normal startup validates authority, runs ordinary migrations,
   then starts web/worker. Direct migration/web/worker process roots also check
   authority before becoming operational.

The helper acquires a dedicated transaction advisory lock and accepts only the
reviewed fresh/legacy bootstrap state or a verified hardened no-op. It refuses
remaining legacy client sessions, collisions, custom roles/schemas/objects,
ownership, grants/default privileges and role settings rather than repairing
them. Known public application objects and optional Drizzle/pg-boss namespaces
transfer explicitly, including sequences/functions/enum and queue partitions;
system objects, `plpgsql`, templates and `postgres` remain with OID 10. User rows
and definitions are not rebuilt. Failures before commit roll back role and
ownership changes together, removing the bridge. A later application migration
failure cannot restore excessive privileges.

Refusal uses a fixed diagnostic: stop writers, verify backup and obtain DBA
review. Never automatically elevate or repair on guard failure. An interrupted
fresh init may leave PG_VERSION and skip scripts on restart; the application
guard rejects the unsafe role. Classify the state and use the explicit supported
operation while offline; do not delete storage. Administrative recovery for the
locked bootstrap requires operator-controlled offline PostgreSQL maintenance,
not a retained application credential. Server audit/query logging and DBA
surfaces must protect password verifiers during provisioning.

### External PostgreSQL

Provide one `DATABASE_URL` for an ordinary **non-bootstrap** login with all five
forbidden flags disabled and no privileged role membership/SET ROLE path.
Ownership is the simplest supported contract. Equivalent scoped authority must
include database CONNECT/CREATE, public USAGE/CREATE, SQL/plpgsql USAGE, ownership
(or inherited ordinary owner authority) over existing application objects and
the optional Drizzle/pg-boss schemas. This permits normal migrations, pg-boss
installation/upgrades and queue partition DDL. Provider-only objects in these
application namespaces may require DBA review. Keep transport private and use
TLS according to the provider/operator environment.

The guard reads actual `pg_roles` identity/attributes and recursive membership,
not the potentially stale `is_superuser` setting. It rejects privileged predefined
roles conservatively, insufficient schema/DDL authority and incompatible object
ownership. It never alters roles, guesses bundled status from a hostname/name or
requests an admin URL/password. It runs once at each process root; request/job
loops do not repeat catalog validation. Connection failures and unsafe authority
produce fixed categories without URL, password, raw SQL error or catalog dump.
No automatic external provisioning or transition occurs.

Maildock V1 is self-hosted and proxy-independent. The base Compose file requires exactly two services, `app` and `postgres`. HTTPS ingress is operator-owned infrastructure: Coolify / Traefik, Caddy, Nginx Proxy Manager, nginx, another equivalent ingress, or private network/VPN infrastructure may satisfy the same contract. None is a Maildock dependency. No proxy, certificates or ACME configuration are bundled.

For Internet-facing production, the supported path is:

```text
untrusted browser -> operator-controlled HTTPS ingress -> Maildock -> PostgreSQL
```

## Required security properties

- Browser-facing production access uses HTTPS. Set `MAILDOCK_ENV=production` and `APP_ORIGIN` to the exact canonical public HTTPS origin, without credentials, path, query or fragment.
- Untrusted clients must have no alternate route to Maildock's raw HTTP listener that bypasses the intended ingress boundary. PostgreSQL must be unreachable from the untrusted/client network.
- The ingress routes only the intended Maildock hostname/origin and controls its forwarding-header policy. Use the ingress product's secure behavior for removing/replacing untrusted forwarding headers. Keep the browser's `Origin` intact; do not fabricate an accepted Origin for rejected clients.
- Maildock does not authenticate a proxy using forwarding headers and does not use caller-selected client-address headers as authoritative identity. Headers are not proof that a request traversed the intended ingress. Syntactically valid chains do not automatically establish trust in a multi-hop proxy/CDN topology.
- `APP_ORIGIN`, exact Origin protection, owner/session validation, MFA and PostgreSQL-backed F8 authentication admission do not depend on original client IP. Maildock does not infer network topology or implement proxy CIDR/socket-peer/XFF-chain trust.
- Production cookies remain `Secure`, `HttpOnly`, `SameSite=Lax` when public TLS terminates at ingress and ingress reaches Maildock over private HTTP. Their settings derive from production configuration, not `X-Forwarded-Proto`. Production still requires HTTPS in private/LAN/VPN deployments; plain HTTP convenience using development mode or modified software is outside this supported production profile.
- Native setup navigates to `<APP_ORIGIN>/login`; JSON setup retains its existing response/client navigation. Do not enable application forwarded-host/proto trust to repair redirects. Canonical origin remains configured regardless of internal Host/port.
- Development Compose overrides are development configuration, not a production template.

## Network topology examples

**A. Platform/container ingress:** `Internet -> Coolify-managed Traefik -> private Docker/network path -> Maildock:3000`. A platform can attach its existing ingress directly to the app network/container; no app host-port publication is necessary. This is the project author's intended VPS model. The operator configures network attachment, public HTTPS routing and backend port 3000. Base Compose does not attach an external proxy automatically.

**B. Host reverse proxy:** `Internet -> host Caddy/nginx/etc. -> loopback/private app publication -> Maildock:3000`. A production app publication bound to `127.0.0.1` may suit this model. Choose and review the actual private path; do not use the development override to obtain it, since that also selects development security mode.

**C. Private/LAN/VPN:** Direct host/container reachability may be controlled by externally managed network boundaries. Non-loopback publication is not automatically a defect: it may be appropriate within a private VLAN/VPN. It is not by itself a safe Internet-facing deployment if untrusted clients can bypass the intended ingress. Review publications in the actual topology while retaining HTTPS `APP_ORIGIN` and production cookie requirements.

These are conceptual examples, not required proxy-specific Compose variants. A multi-hop/CDN setup needs an operator review of the same invariants; Maildock does not certify it from its headers.

Base Compose publishes neither app nor PostgreSQL. `expose: ["3000"]` and image `EXPOSE 3000` identify the internal app port; neither is a host publication or access-control list. The image listens on `0.0.0.0:3000` inside its container. Docker networking alone does not prove Internet isolation. Maildock cannot determine a VPS/cloud firewall, VLAN/VPN, Docker daemon routing, platform routing or external load-balancer policy. No host firewall is presumed. The operator must verify all relevant IPv4/IPv6 paths and authorized network peers.

Keep the app's required outbound mail/provider connectivity when designing network restrictions. App readiness uses loopback inside the container and checks database/storage readiness; it does not certify ingress security.

## Client-address policy

Better Auth 1.7.5 is configured with `advanced.ipAddress.ipAddressHeaders: []`. No address forwarding header is consulted, including `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP` or `True-Client-IP`. Next may preserve or synthesize forwarding headers, but Better Auth ignores them for address selection. `disableIpTracking` is deliberately not enabled, because it would bypass HTTP limiting when no IP resolves.

In a production Node runtime Better Auth resolves no client IP, writes empty session IP metadata, and uses a shared per-path database HTTP limiter key such as `no-trusted-ip|/get-session`. Its ordinary development/test fallback is `127.0.0.1|<path>` with shared loopback metadata. Neither is an invented original-client address. Existing limits remain 100 requests per 60 seconds generally and 10 per 60 seconds for username sign-in; the atomic patched database adapter remains in use. These supplemental shared limits can cause contention among legitimate clients. F8 global/account/factor/challenge/ceremony admission remains authoritative and IP-independent; changing address headers cannot refresh its budgets.

Better Auth may emit its existing warning recommending IP forwarding when it first selects the shared production bucket. The shared bucket is intentional in Maildock V1; that generic dependency warning is not an instruction to enable IP or forwarded-host trust. Session IP metadata cannot be used as authentication/authorization evidence. Logging policy is deferred to F11.

## Operator acceptance checklist

- [ ] Browser-facing URL is HTTPS.
- [ ] `APP_ORIGIN` exactly matches that public HTTPS origin.
- [ ] `MAILDOCK_ENV=production`.
- [ ] PostgreSQL is not reachable from the untrusted/client network.
- [ ] Maildock's raw HTTP endpoint has no alternate untrusted path bypassing ingress.
- [ ] Ingress routes only the intended Maildock hostname/origin.
- [ ] Ingress has a defined policy for removing/replacing client-supplied forwarding headers.
- [ ] Development Compose overrides are not used for production.
- [ ] Custom Docker/network/host publications have been reviewed against actual topology, including IPv4/IPv6 routing and applicable operator-controlled firewall/VPN policies.

Validate reachability from the relevant networks using your own authorized infrastructure checks. Repository tests verify resolved Compose defaults and application behavior; they cannot certify those operator-owned boundaries or a hypothetical custom override.

## Coolify / Traefik compatibility

The repository supports an external ingress connected to the app container/network, routing to port 3000, terminating TLS externally, without host publication and with platform-supplied forwarding headers. Set the canonical public HTTPS `APP_ORIGIN`, production environment and independent deployment secrets; preserve persistent database/attachment storage and configure ingress attachment/routing without exposing PostgreSQL or alternate raw app ingress. The image's internal wildcard listener, standalone Next output, configured canonical auth URL and explicit Secure cookies fit this topology; address headers are unnecessary for authentication correctness.

This is a repository/configuration compatibility assessment, not certification of a particular Coolify/Traefik version or live installation. No live instance or version-specific routing/firewall configuration was supplied or contacted. The operator must configure and verify their platform against the checklist. No Coolify/Traefik runtime dependency is added.

## V1 matched backup and recovery set

The supported generic V1 backup is offline for **all application writers**.
Restrict ingress and automatic restarts/deployments, stop/drain `app` and every
independently started web, worker, producer, migrator or database writer, and
verify they stopped. Keep PostgreSQL running for logical `pg_dump`. A maintenance
page alone does not stop workers. Online DB-only backup is not a complete
Maildock recovery set.

A complete set contains the entire PostgreSQL database (including Drizzle and
pg-boss), the entire attachment root, the matching `AUTH_SECRET`, all credential
encryption key bytes **and their key IDs** needed by stored envelopes, effective
configuration, and matching release/image/Compose/helpers. Preserve previous
credential keys too. Completed owner/MFA installations do not need
`MAILDOCK_BOOTSTRAP_SECRET`; unfinished provisioning retains its existing
bootstrap contract. Losing `AUTH_SECRET` loses existing protected MFA state;
changing it incidentally is not a recovery operation. The destination DB login
password can change when provisioning fresh storage; cryptographic keys must
match the restored data.

Store a protected manifest containing a set ID, capture interval, archive/blob
filenames, sizes and SHA-256 checksums, PostgreSQL/migration versions, immutable
owner user ID, key IDs, image digest/release, helper identity, effective config
and volume mappings. Keep the previous known-good set until the new set is
complete and verified in disposable storage. Checksums and custom-archive
compression provide no confidentiality. Test recovery periodically.

Use the intended Compose project and protected environment explicitly. Examples
below use a POSIX operator shell and the matching PostgreSQL 18 service client;
Windows operators must translate host shell syntax and use private ACLs. Use
binary-safe `docker compose cp`, not PowerShell binary stdout redirection.
Preserve numeric ownership and modes for the full attachment root, including
temporary/orphan bytes; do not select only IMAP attachments or delete files by
age. For large databases, use a protected backup mount instead of filling the
container writable layer. A protected `.pgpass` is also supported by PostgreSQL.

```sh
# Writers/restart automation already stopped; use a unique protected set path.
docker compose stop app
docker compose exec -T postgres sh -c '
  umask 077
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -Fc --no-acl -f /tmp/maildock-recovery.dump
'
docker compose cp postgres:/tmp/maildock-recovery.dump /absolute/private/set/database.dump
docker compose run --rm --no-deps --user 0 --entrypoint tar \
  -v /absolute/private/set:/recovery app \
  -cpf /recovery/attachments.tar -C /var/lib/maildock/attachments .
```

Inspect exit codes; hash and verify host artifacts, copy keys/config confidentially,
and remove the container temporary archive after verification. Never copy a
running PGDATA directory as a generic physical backup. Filesystem snapshots
require stopped application writers and PostgreSQL-aware physical consistency
or a cleanly stopped PostgreSQL cluster.

## Restore into fresh storage, before operational startup

Keep ingress and writers stopped throughout. Preserve the failed installation
for diagnosis; select a **new** Compose project and fresh PostgreSQL/attachment
storage with the matching release and keys/config. Start only PostgreSQL so the
last F12-03 init script provisions the ordinary owner. Do not start `app` before
verification. Do not import global roles, use `--create`, `--clean`, trigger
disabling, superuser credentials, a public DB port or search-path workarounds.
Treat archives as confidential trusted executable SQL from your own verified
recovery sets; shape validation does not make arbitrary third-party SQL safe.

```sh
docker compose up -d postgres
# Wait for PostgreSQL health, then validate ordinary fresh destination authority.
docker compose exec -T postgres sh /usr/local/bin/maildock-restore-compatibility \
  --check-fresh-destination
docker compose cp /absolute/private/set/database.dump postgres:/tmp/maildock-recovery.dump

# Current archives, captured after migration 0032:
docker compose exec -T postgres sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_restore -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-acl --exit-on-error --single-transaction /tmp/maildock-recovery.dump
'

docker compose run --rm --no-deps --user 0 --entrypoint tar \
  -v /absolute/private/set:/recovery:ro app \
  -xpf /recovery/attachments.tar -C /var/lib/maildock/attachments
docker compose run --rm --no-deps --entrypoint node app \
  dist-worker/shared/infrastructure/database/migrate.js
```

Historical **baseline** archives (32 migrations through `0031_auth_admission`,
release `d98c1d37815f36f95ce5b52a1fac3fdd606dfb6b`, PostgreSQL/pg_dump 18) require
the packaged bridge **instead of** the ordinary restore command above:

```sh
docker compose exec -T postgres sh /usr/local/bin/maildock-restore-compatibility \
  --fresh-destination-writers-stopped /tmp/maildock-recovery.dump
```

The bridge checks archive versions/custom format, exact two FUNCTION signatures,
the complete reviewed function definitions, public table inventory and all 32
migration hashes/timestamps. It predefines only the corrected address/vector
functions with the ordinary role, excludes exactly their historical FUNCTION
TOC entries, and runs the rest with `--no-owner --no-acl --exit-on-error
--single-transaction`. Unknown archive releases, overloaded functions, changed
bodies or shapes fail closed. Operators never edit a dump. A failed/uncertain
restore requires **fresh destination storage before retry**: the predefinitions
can remain outside the remainder transaction. No privileged helper or broad
mutable `search_path` is installed. External clusters must provide the ordinary
authority contract; this strict fresh preflight also requires the bootstrap
login disabled. Obtain DBA review for a different external cluster shape.

For an old-release failed-upgrade rollback, retain this recovery tooling image
with the set and use it offline on its compatible schema. The shipped command
verifies the exact 33-migration schema; baseline archives first require the
bridge and **only** the additive 0032 qualification/receipt migration. Run this
release's migrator/maintenance image alone, then start the matching baseline
application image. This exact baseline path was exercised with the original
`d98c1d3` production image: authentication, worker/pg-boss startup and readiness
passed after maintenance. It preserves old table/function/index contracts;
it does not certify arbitrary forward-migrated schemas for old images. Other
historical schemas/releases require explicitly compatible retained recovery
tooling and review; keep ingress closed if compatibility is not established.
Never silently skip maintenance.

### Explicit offline security maintenance

Use a dedicated local operator directory on a POSIX filesystem mounted at
`/operator`, owned by **1001:1001**, mode **0700**. Output files are created
exclusively at **0600**, without symlink following; inputs must be private,
owned regular files with one link, at most 16 KiB. The shipped channel refuses
native Windows POSIX-mode emulation; use the Linux production container with a
private POSIX directory/volume. On Windows Docker Desktop, a dedicated named
operator volume can provide those Linux permissions; protect host exports with
equivalent owner/admin ACLs. Never use app logs, stdout, a web root or a shared
folder for recovery codes/password/TOTP material. Do not put proofs on command
lines or in ordinary environment variables.

Set `OWNER_USER_ID` to the immutable ID recorded in the protected set manifest.
The confirmation flag asserts stopped writers and a reviewed matched recovery
set; the process also rejects another connection using the application role.
SQL cannot prove that disconnected producers/restart automation are disabled.

```sh
docker compose run --rm --no-deps --entrypoint node \
  -v /absolute/private/operator:/operator app \
  dist-worker/composition/recovery-process.js maintain \
  --writers-stopped-recovery-set-verified "$OWNER_USER_ID" /operator/recovery.json

docker compose run --rm --no-deps --entrypoint node \
  -v /absolute/private/operator:/operator app \
  dist-worker/composition/recovery-process.js verify \
  --writers-stopped-recovery-set-verified "$OWNER_USER_ID" /operator/recovery.json
```

Maintenance verifies authority, exact migration/schema compatibility, exactly
one bound owner/password/factor, protected-state decryption and every referenced
blob's existence/size/SHA-256 using existing verified reads **before mutation**.
It uses the existing auth advisory lock and READ COMMITTED recheck transaction.
For a verified owner it removes all sessions, challenges and OAuth authorization
states and replaces encrypted recovery codes. It preserves owner identity,
Argon2 password hash, verified TOTP, mandatory MFA and all restored admission,
throttle/factor budgets. It marks queued/sending SMTP and pending/saving Sent
copies uncertain, and pending/executing remote commands failed with the fixed
restore-review reason. It preserves outgoing bytes/references and pg-boss.
Existing job handlers check durable states so obsolete jobs become harmless.

The private receipt binds the committed maintenance generation to that owner,
factor and encrypted code set. `verify` additionally checks receipt completion,
transient invalidation and remote fencing; it runs **offline before startup**.
Maintenance never runs on normal startup. Repeating `maintain` issues another
set and invalidates the prior set/receipt. Use a new exclusive output filename
each time. If COMMIT succeeded but delivery/fsync failed, keep writers stopped
and rerun with a new output name; discard incomplete or stale receipts. Store
fresh codes in the owner's protected recovery copy, remove proof/enrollment
files after use, and never paste receipt contents into support diagnostics.

Exit **0** permits the next verification step; exit **1** refuses recovery;
exit **2** means pending MFA, which still blocks business/worker readiness.
Do not treat HTTP readiness alone as successful recovery: wrong auth keys or
missing blobs can coexist with an HTTP 200.

### Pending authenticator replacement

Maintenance retains the pending guard and unverified factor, changes the old
token digest to unknowable random material and expires it. It does not restore
business readiness. Initial unfinished enrollment is refused by this completed
installation recovery command and retains the existing bootstrap contract.

If the pending authenticator is already available, place a private JSON proof
file at `/operator/proof.json` containing `password` and six-digit `code`. To
resume enrollment first, provide only `password` and run `resume-mfa`; it writes
the pending authenticator URI exclusively to the protected output file. Password
proof alone cannot complete replacement. Read/enroll that URI through a secure
local operator channel, then create the password + pending TOTP proof file.

```sh
docker compose run --rm --no-deps --entrypoint node \
  -v /absolute/private/operator:/operator app \
  dist-worker/composition/recovery-process.js resume-mfa \
  --writers-stopped-recovery-set-verified "$OWNER_USER_ID" \
  /operator/pending-enrollment.json /operator/password-proof.json

docker compose run --rm --no-deps --entrypoint node \
  -v /absolute/private/operator:/operator app \
  dist-worker/composition/recovery-process.js complete-mfa \
  --writers-stopped-recovery-set-verified "$OWNER_USER_ID" \
  /operator/completed-recovery.json /operator/proof.json
```

Continuation requires committed maintenance for that same immutable owner and
pending factor, checks persisted proof/work/factor lockouts, verifies Argon2
password and pending TOTP under the auth lock, then performs the same verified
factor/user-flag/guard-removal transition as ordinary completion. It issues
fresh encrypted recovery codes, revokes transients and rechecks fencing.
Wrong proofs commit bounded failure budgets without completing enrollment.
There is no password-only completion, second owner, bootstrap fallback or
manual auth-row editing. Run `verify` against the completed receipt before
starting the app.

After offline verification, start the matching release, verify fresh
password/TOTP login, old-session/old-code rejection, new recovery-code login,
attachment access, worker/pg-boss startup and readiness; then reopen ingress.
The owner must review restored drafts, uncertain operations and whether the
restored password/TOTP was later changed or compromised. Backup-age security
history cannot be reconstructed. Restoring local data cannot roll back provider
effects or guarantee exactly-once SMTP; do not automatically resend uncertain
mail or repeat remote commands.

## Production update and failed-upgrade recovery

1. Prepare the new immutable release and preserve the old release/config.
2. Restrict ingress and restart automation; stop/drain **all writers**.
3. Capture and verify a complete matched pre-upgrade set before schema/queue work.
4. Validate ordinary database authority; use the existing explicit F12-03
   transition only for a reviewed legacy installation.
5. Run the new migrator alone with ordinary credentials. Leave everything stopped
   on failure; do not mix releases or delete migration rows to force retries.
6. Run the offline read-only audit (no session/code invalidation for a routine
   update), then start the new app, whose startup migrator is idempotent:

   ```sh
   docker compose run --rm --no-deps --entrypoint node app \
     dist-worker/composition/recovery-process.js audit \
     --writers-stopped-recovery-set-verified "$OWNER_USER_ID"
   docker compose up -d --no-deps app
   ```

7. Verify authority, mandatory owner MFA, key/blob access, worker/queue operation
   and HTTP readiness. Reopen ingress only after acceptance.

An image-only downgrade after forward migrations is not promised. Default
failed-upgrade recovery stops new writers, preserves the failed deployment for
diagnosis, restores the **entire matched pre-upgrade DB/blob/key/config set into
fresh storage**, uses its matching old release and compatible recovery helper,
runs post-restore maintenance/verification, starts/verifies and finally reopens
ingress. Acknowledge loss of writes accepted after that backup. Provider-side
sends/IMAP mutations cannot be rolled back by restoring local state. Only a
specifically verified transaction rollback with no later nontransactional work
can justify reusing unchanged old storage. PostgreSQL major upgrades are separate.

## Shutdown, capacity, logs and private mounts

Base `app` has `stop_grace_period: 60s`; set equivalent platform/orchestrator
termination timeouts to at least 60 seconds. Preserve the pg-boss graceful stop
and verify writers really stopped. This allowance does not guarantee every
network operation completes. Forced termination can leave SMTP/IMAP work
uncertain; resolve/review that uncertainty before capture or operational reopening.

Monitor PostgreSQL filesystem free bytes/inodes, DB growth and maintenance/WAL
capacity; attachment volume free bytes/inodes/growth; pg-boss backlog, oldest-job
age and failures; host/container log storage; and backup capacity, age and success.
Current message/staged-attachment removal or expiry does **not necessarily
reclaim physical blob bytes**. Plan for retained blobs/tmp/orphans. Do not add
unsafe age-only GC or delete pg-boss to suppress restored jobs.

Configure bounded stdout/stderr retention and log rotation with restricted
operator access using your platform's facilities; no particular logging stack
is required. Application diagnostic bounds do not bound Docker/host storage.
Attachments contain plaintext confidential data. Dedicated attachment bind
mounts should be owned by **UID/GID 1001:1001**, root mode **0700**, directories
0700/files 0600, and support exclusive creation, rename and fsync. Preserve
numeric ownership during restore; do not make them world-writable. PostgreSQL
mounts use the PostgreSQL image's own OS identity, not 1001.

Protect `.env`, platform environment, `docker compose config`/inspection output,
recovery sets and secret/key copies from Git, public roots, shared folders and
support posts. Use 0700/0600 or equivalent Windows owner/admin ACLs and
confidential backup transport/storage. Keep independently recoverable key copies.
The V1 contract requires no third service, Redis, external secret manager,
specific backup/proxy product or native `*_FILE` support. F12-04 image footprint
and F12-06 tuning passthrough remain separate findings.
