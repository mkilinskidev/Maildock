# F12 discovery: production hardening

## 1. Executive summary

**F12: BLOCKED. Discovery only; no fixes implemented.**

The reviewed production image builds and starts successfully. It runs as UID/GID 1001, not root, with no effective Linux capabilities in the observed Docker runtime. The base Compose has exactly app + postgres, publishes neither service, and persists PostgreSQL and attachments. Production HTTPS validation, owner/MFA authorization, Origin checks, Secure cookies and logout revocation survive the container boundary in the focused probes.

Two release-blocking defects were reproduced in the actual image:

- **F12-01 (HIGH): successful uploads can silently contain truncated bytes.** Sending an 11 MiB file, within the documented 15 MiB default, returned 201/ready but registered only 10,455,620 bytes. Next's default 10 MiB proxy body clone ends the forwarded stream early without rejecting the request.
- **F12-02 (MEDIUM): unauthenticated oversized requests disclose their entire request URL in native framework diagnostics.** A synthetic query canary appeared in container stderr despite the route returning 413. This is a concrete additional F11 boundary escape, not a speculative application logger concern.

**F12-03 (MEDIUM)** is also required before closure: the normal database credential is the PostgreSQL bootstrap superuser. SQL against the disposable database confirmed SUPERUSER, CREATEDB and CREATEROLE. Application and migrations need schema authority, not cluster/OS authority.

**F12-04 (LOW)** concerns leftover development package payloads in the final image; **F12-05 (MEDIUM)** concerns the missing security-sensitive restore/update/capacity procedure in the operator contract; **F12-06 (LOW)** concerns documented tuning variables not passed through base Compose. F12-05 requires documentation, not a new backup product or destructive garbage collection.

No general dependency-CVE audit, external platform certification, production access, deployment, commit or push was performed. Findings distinguish application defects from operator-owned ingress, capacity and backup responsibilities.

## 2. Reviewed commit and scope

- Repository workspace: D:\\Projects\\JS\\Maildock; requested repository identity: mkilinskidev/Maildrop.
- Verified HEAD before inspection: **908859ed596c2eda2f956377b084b939626ae272**.
- Baseline subject supplied by the request: security: establish safe diagnostic boundaries.
- Initial git status was clean.
- Review date: 2026-10-06, Europe/Warsaw.
- Built image: maildock-f12-review:908859e.
- Image config ID: sha256:5ceb91e40ac9824a2eb6f4bc9fc0064cb2925947bc12dad6ece48dc46f45ae9c.
- Manifest-list digest from this local build: sha256:d56be5a18f21122d4b71ec5bc7f136f4355dc49c1c9b98e9fba945cb9c5cf6e1.
- Observed Node base digest: sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20.

Scope: Dockerfile/context, both tracked Compose files, entrypoint, configuration, web/worker/migration roots, authentication boundaries, HTTP/header behavior, storage, queues, provider limits, persistence and deployment/security documentation. Local disposable PostgreSQL 18.6 and synthetic credentials only. The existing .env was neither displayed nor used to resolve Compose. A separate synthetic env file under the Windows temporary directory was used.

No new unit/automated tests or test-file changes were made. Ad hoc disposable runtime probes were explicitly permitted by the discovery request. This report is the only repository addition.

## 3. Production architecture / trust boundaries

```text
untrusted browser / Internet
       |
       | HTTPS; canonical APP_ORIGIN
       v
operator-owned ingress + host/platform networking [D]
       |
       | private HTTP, intended host routing; no alternate public backend route
       v
app container [B/C]
  node PID 1: container-entrypoint.mjs
       |
       +-- migration child (must succeed first)
       +-- Next standalone web :3000 [A]
       |       +-- owner/session/MFA/Origin guards
       |       +-- PostgreSQL-backed auth admission
       +-- compiled worker [A]
               +-- wait for verified owner MFA
               +-- pg-boss consumers / polling / IMAP IDLE
               +-- outbound IMAP/SMTP/OAuth over verified TLS
       |
       +-- private PostgreSQL :5432 [B/D]
       |       +-- auth + mail data + encrypted envelopes + pg-boss
       +-- attachments_data volume [B/C/D]
               +-- plaintext mail attachments + outgoing MIME
```

A = application guarantees; B = base Compose guarantees; C = Docker image guarantees; D = operator/platform responsibilities.

A does not authenticate ingress using forwarded headers. Better Auth uses ipAddressHeaders: []; its supplemental shared database HTTP limiter and F8 admission remain enabled. B publishes no host ports. C listens on a wildcard address inside the container, which is compatible with external container ingress. D must verify actual IPv4/IPv6 reachability, private database peers, HTTPS and no raw-backend bypass. EXPOSE/expose are metadata, not access-control lists.

## 4. Docker image findings

**Observed artifact.** Four functional stages follow the shared base: dependencies, build, production-dependencies and runtime. Build runs frozen pnpm installation, Next standalone build, worker TypeScript compilation and relative-import rewriting. Runtime starts from node:24.21.0-bookworm-slim, independently of the build-tool base; Node v24.21.0 was verified inside it.

The final image contains production node_modules, standalone server.js/.next, public assets, dist-worker, db/migrations and the entrypoint. Worker/migrator require modules outside Next's tracing graph, so removing all non-standalone modules without accounting for those roots is incompatible. No application tests, repository .git or .env files were found by the final-image inventory at the inspected application paths. Dependency packages contain their own development/source artifacts.

The Dockerfile adds no runtime OS packages. The inherited Debian runtime includes sh/bash, core utilities, apt/dpkg, libc/TLS libraries and Node's npm/npx/Corepack/Yarn. ps was unavailable. pnpm was not on the runtime PATH. Shell/package-manager removal is optional, not a V1 security requirement.

Runtime user is maildock, UID/GID 1001. /app is root-owned 0755; copied server.js is maildock-owned 0644, and copied trees are application-owned. /var/lib/maildock/attachments is 1001:1001, 0755. /tmp is root-owned 1777.

**F12-04: development payload retention.** Runtime node_modules occupies about 637 MiB, .next about 33 MiB. Although top-level typescript/vitest links were pruned and .bin contained next, pg-boss and pino, physical .pnpm payloads for TypeScript 6.0.3, Vitest 5.0.1, tsx 4.23.15 and drizzle-kit 0.31.11 remain. Real package files were inspected, not just directory names. pnpm prune --prod therefore does not yield a physically minimal runtime here. This is LOW/nonblocking footprint/supply-chain surface, not evidence that development code runs on startup.

7,410 .map files were counted across /app, predominantly packages plus server artifacts. Zero .map files were found in .next/static. Server maps are not automatically public. No externally accessible application source-map leak was established.

**RCE inheritance:** execution as the application user, readable environment secrets, writable copied application files, persistent attachment access, outbound networking, PostgreSQL credentials (currently superuser), Node/shell/package managers and a writable root filesystem. This does not grant Docker API access or host root: no socket/host mount/privileged setting is supplied. Application-owned executable files permit tampering within that compromised container; image replacement restores image files, while changed volume/DB state survives. Root-owned executables and a read-only root filesystem are useful defense-in-depth.

.dockerignore excludes .git, .next*, dist-worker, node_modules, coverage, .env/.env.* except .env.example, README and docs. Tests/config/scripts and other nonexcluded working-tree files can enter the build stage. Only selected products enter runtime. Keep unrelated secret-bearing files out of the build context; exclusion is not a universal secret scanner.

## 5. Container privilege findings

No privileged mode, cap_add, devices, host PID/network/IPC, Docker socket or arbitrary host bind mount exists in either tracked Compose file. Base named mounts are only database and attachment persistence. Observed application CapEff/CapPrm/CapAmb were zero; Docker's default capability bounding set remained and NoNewPrivs was 0.

| Control | V1 classification | Reason / evidence |
| --- | --- | --- |
| Non-root app UID with working attachment ownership | Required; satisfied | Real UID/GID 1001; fresh named-volume upload and readiness worked |
| No privileged / host namespaces / Docker socket | Required; satisfied | Repository Compose inventory |
| Database role without cluster superuser | Required; unsatisfied, F12-03 | Real pg_roles output |
| cap_drop ALL | Recommended defense-in-depth | Startup/health worked with it in the hardened disposable variant |
| no-new-privileges | Recommended defense-in-depth | Same variant worked with it |
| Read-only root + writable attachment volume | Recommended defense-in-depth | Startup, worker queues and HTTP health worked; see limitations below |
| /tmp tmpfs, restrictive flags and size | Recommended defense-in-depth | Used rw,noexec,nosuid,size=32m in the variant |
| Root-owned copied application code | Recommended defense-in-depth | Current user can modify owned executable files after RCE |
| init / subreaper | Recommended if process topology grows | Current supervisor waits for direct children; no shell wrapper |
| Universal loopback publication or mandatory bundled proxy | Not justified | Violates valid external/private ingress model |
| Fully immutable attachment storage / no writable storage | Incompatible | Persistence, publication and readiness need writes |
| Blanket no-egress / Docker internal-only app network | Incompatible | Mail/provider connections require outbound connectivity |

Read-only validation covers startup, initialized worker startup and health, not every future Next cache/image-optimization path. Before making it a supported default, validate those paths and provide any necessary cache mount. The app has no configured external Next image origins. Bind-mount deployments must prepare ownership for UID/GID 1001; readiness rejects inaccessible storage.

No demonstrated zombie accumulation was found. The supervisor explicitly waits for migration and both business children. It is not a general subreaper for arbitrary grandchildren created after compromise.

## 6. Compose findings

The base file contains only app and postgres. Resolving it with the synthetic env file confirmed no ports on either service, default bridge-network membership and production app mode. There is no automatically loaded docker-compose.override.yml in the tracked file inventory.

The dev override must be explicitly selected; it switches MAILDOCK_ENV to development and publishes app/PostgreSQL on IPv4 loopback. README and DEPLOYMENT explicitly say it is not a production template. No regression to F9 was found.

PostgreSQL uses postgres:18.6-bookworm and persists /var/lib/postgresql, appropriate to this repository's PostgreSQL 18 layout. app persists /var/lib/maildock/attachments. PostgreSQL service health gates app creation; app then runs migrations. Both services restart unless-stopped. App health probes readiness with Node fetch, every 10s, timeout 5s, 12 retries, 20s start period. PostgreSQL pg_isready checks every 5s; it establishes accepting connections, not a password/TLS/schema test.

Secrets are runtime environment interpolation, not build args or image credentials. Required Compose substitutions reject missing POSTGRES_PASSWORD, AUTH_SECRET, encryption key and APP_ORIGIN. Empty bootstrap leaves setup closed. compose config outputs interpolated secrets; the operator must treat its output, Docker inspection access, env files and backups as confidential. Protected env injection is supported; *_FILE/mounted-secret reading is not implemented.

Default network isolation does not stop the Docker host or an operator from attaching additional peers. The operator must keep PostgreSQL off shared untrusted ingress networks. Separate app/DB network segmentation is optional; not a required additional infrastructure service.

F12-03 covers database privilege. F12-06 covers tuning passthrough. No default memory/CPU/PID limit, logging rotation, init or stop_grace_period is specified. Those omissions are not individually blockers; the capacity/logging/grace contract needs operational guidance (F12-05).

## 7. Entrypoint / process findings

Actual path: node PID 1 -> compiled migration -> Next web and compiled worker -> first child exit -> SIGTERM to siblings -> wait for all -> exit.

- Invalid MAILDOCK_ROLE exits 1 before starting migration.
- Migration nonzero/signal prevents both web and worker start.
- Runtime HTTP APP_ORIGIN was rejected during migration, emitted a fixed configuration diagnostic and exited 1.
- Kill of the worker PID with SIGKILL caused the entire app container to exit 1.
- Kill of next-server caused worker.shutdown/jobs.stopped diagnostics and container exit 1.
- External docker stop of the hardened variant forwarded SIGTERM, worker shut down and pg-boss stopped. Container exit was 143, not an application startup failure; no OOM kill.
- Arguments are fixed entrypoint/server/worker/migration paths, not secret values. Children inherit environment and stdio.
- Fresh instance did not start business jobs until owner MFA completion. After completion, jobs.started appeared.

Shutdown handlers are installed after migration: stopping during a long migration does not get this supervisor's normal forwarding/drain path. Docker kills remaining container processes when PID 1 exits. The helper does not register child 'error' events and has no internal forced-kill timer; the fixed known Node executable worked, but future spawn failures need attention. A sibling stuck during termination can delay exit until Docker's stop timeout. A child unexpectedly exiting zero can produce container exit zero; unless-stopped still restarts it in base Compose.

The worker's graceful pg-boss timeout is 30 seconds whereas Compose does not extend Docker's usual stop grace. Recommend a grace interval exceeding 30 seconds plus teardown time. Existing send uncertainty/durable MIME safeguards must remain; forcibly interrupted SMTP must not gain a blind retry.

READY -> NOT READY is reread by the worker supervisor about every second; pollers/watchers stop and existing jobs drain via pg-boss. It is not instantaneous cancellation of remote operations. This is existing F2 behavior, not a newly established container regression. No mail-provider operation was exercised.

Readiness can briefly stay green between child failure and supervisor shutdown; it is not a worker heartbeat. Base all-role process coupling bounds that window. Separately deploying role=web requires operator monitoring of the worker, since web health cannot prove an external worker exists.

## 8. Configuration matrix

All application-schema rows below use src/shared/infrastructure/config/config.ts. Invalid schema/configuration causes ConfigurationError and prevents the normal entrypoint from serving traffic. Values in diagnostics are replaced with field/category information. Required means required by schema unless a default is listed. Runtime env values are accessible to Docker/host administrators and application RCE; that is the delivery boundary.

| Variable | Sensitive? | Required? | Production validation | Default | Failure mode | Persisted anywhere? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MAILDOCK_ENV | No | Defaulted | development/test/production enum | schema development; image/Compose production | Invalid enum fails | Runtime env | Explicitly selecting development is possible; documented unsupported for production |
| APP_ORIGIN | No, but private host metadata | Yes | URL; no credentials/path/query/fragment; HTTPS in production | None | Startup fails | Runtime env; OAuth redirect construction | No forwarded-origin inference |
| DATABASE_URL | Yes | Yes | Nonempty postgresql://; client initialization separately checks parsing | None | Startup/connection failure | Runtime env | No password strength or remote TLS enforcement; operator network boundary |
| AUTH_SECRET | Yes | Yes | Base64 decoding at least 32 bytes; no entropy test | None | Startup fails | Runtime env; cryptographic auth state derives from it | Generate randomly; loose base64 decoder does not certify entropy |
| MAILDOCK_BOOTSTRAP_SECRET | Yes | Required for initial provisioning | Empty/absent or canonical base64 exactly 32 bytes | Absent/empty | Missing disables setup; malformed fails startup | Env; SHA-256 digest in process config, not DB | Remove after initial provisioning; missing does not open setup |
| CREDENTIALS_ENCRYPTION_KEY | Yes | Yes | Canonical base64 exactly 32 bytes | None | Startup fails | Env; ciphertext envelopes in DB | Random generation is operator duty |
| CREDENTIALS_ENCRYPTION_KEY_ID | No | Defaulted | v[1-9][0-9]* | v1 | Startup fails | Envelope key IDs | Active key wins over same ID in previous map |
| CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS | Yes | Defaulted | JSON map of valid IDs and 32-byte keys | {} | Startup fails | Env; IDs in envelopes | Preserve needed historical keys; no automatic rotation |
| MICROSOFT_CLIENT_ID | Generally no | Optional | Trimmed string | Empty | Empty disables initial bootstrap | OAuth provider row, env | Environment bootstrap only when no existing provider row |
| MICROSOFT_CLIENT_SECRET | Yes | Optional | String; pair needed to bootstrap | Empty | Missing pair skips bootstrap | AES-GCM encrypted provider secret in DB; env | Updating env does not overwrite existing row |
| ATTACHMENTS_PATH | Path metadata | Yes | Absolute/nonempty | Compose /var/lib/maildock/attachments | Startup on invalid syntax; ready=503 if unusable | Actual files + env | Image creates directory; named volume preserves it |
| LOG_LEVEL | No | Defaulted | fatal/error/warn/info/debug/trace | info | Startup fails | Env; affects stdout | F11 allowlists remain applicable at every level |
| DATABASE_POOL_SIZE | No | Defaulted | Integer 1..50 | 10 | Startup fails | Env | Per postgres-js process; pg-boss uses separate pools; not passed by base Compose |
| WORKER_CONCURRENCY | No | Defaulted | Integer 1..50 | 5 | Startup fails | Env | Discovery concurrency, not one global queue cap; not passed by base Compose |
| MAILDOCK_INITIAL_SYNC_DAYS | No | Defaulted | Integer 1..365 | 30 | Startup fails | Resulting DB sync state | Not passed by base Compose |
| MAILDOCK_MESSAGE_FETCH_BATCH_SIZE | No | Defaulted | Integer 10..500 | 150 | Startup fails | Env | Not passed by base Compose |
| MAILDOCK_BACKFILL_CHUNK_SIZE | No | Defaulted | Integer 1..5000 | 500 | Startup fails | DB checkpoints | Passed by Compose |
| MAILDOCK_MESSAGE_SYNC_CONCURRENCY | No | Defaulted | Integer 1..10 | 2 | Startup fails | Env | Recent/delta queues; not passed by base Compose |
| MAILDOCK_MAIL_POLL_INTERVAL_SECONDS | No | Defaulted | Integer 30..3600 | 300 | Startup fails | Env | Not passed by base Compose |
| MAILDOCK_CONTENT_POLL_INTERVAL_MS | No | Defaulted | Integer 100..2500 | 400 | Startup fails | Exposed nonsecret reader setting | Adaptive wait ceiling 2500ms |
| MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES | No | Defaulted | Integer 1024..20 MiB | 5 MiB | Startup fails | Bounded content stored in DB | Not passed by base Compose |
| MAILDOCK_MAX_ATTACHMENT_BYTES | No | Defaulted | Integer 1024..100 MiB | 15 MiB | Startup fails / BlobLimitError | Blob metadata and bytes | F12-01: independent Next clone truncation is smaller |
| MAILDOCK_MAX_OUTGOING_ATTACHMENT_BYTES | No | Defaulted | Integer 1024..100 MiB | 18 MiB | Startup fails / send validation | Outgoing snapshot | Aggregate selected payload |
| MAILDOCK_MAX_OUTGOING_MIME_BYTES | No | Defaulted | Integer 1024..150 MiB | 25 MiB | Startup fails / construction overflow | Immutable MIME blob | Includes encoding/headers |
| MAILDOCK_ROLE | No | Defaulted | all/web/worker entrypoint allowlist | all | Exit 1 | Env | Each role runs migration; not passed by base Compose |
| NODE_ENV | No | Image sets it | Framework switch, not app security schema | production in image/Compose | Framework-dependent | Env | CSP development unsafe-eval uses this, cookies use MAILDOCK_ENV |
| PORT / HOSTNAME | No | Image defaults | Next standalone consumes them | 3000 / 0.0.0.0 | Listen/start failure if invalid | Env | Changes require matching health/ingress |
| POSTGRES_PASSWORD | Yes | Compose required | Nonempty interpolation; PG initialization | None | Compose rejects empty; DB auth failure for wrong value | PG credential verifier + env | Existing volumes do not automatically change password when env changes |
| POSTGRES_DB / POSTGRES_USER | DB identity | Base constants | Image initialization | maildock / maildock | Startup/auth errors for inconsistent volume | DB catalog | POSTGRES_USER is currently bootstrap superuser |
| PNPM_HOME / PATH | No | Build only | Build tooling | /pnpm | Build failure | Build stage metadata | Not a production secret |

No NEXT_PUBLIC secret variable or next.config env export exists. Runtime image metadata contains only nonsecret defaults. Docker build uses freshly generated synthetic AUTH_SECRET/encryption key for build-only config, supplied to that RUN command, not deployed secrets or final ENV. Runtime canary scan found none of four synthetic deployment values in .next/static. This supports the reviewed pipeline, not a claim that arbitrary future build scripts cannot inline secrets.

The README mentions mounted secrets, but the app does not read files automatically: a platform must translate its protected secret delivery into the configured env values. No unencrypted generated secret config file was identified. Provider bootstrap intentionally persists Microsoft secret encrypted in PostgreSQL.

## 9. HTTP / browser header matrix

Production HTTP probes were sent directly to the local container; no ingress headers were added.

| Boundary | Actual policy | Assessment / owner |
| --- | --- | --- |
| Routed documents/API | CSP default-src self; base-uri none; form-action self; frame-ancestors none; object-src none; nonce + strict-dynamic scripts; no production unsafe-eval | Application; suitable V1 script/frame boundary |
| HTML styles | style-src self unsafe-inline | Deliberate rich-mail/app compatibility; not a blocker by itself |
| Parent image policy | self, data:, https:, http: | Ceiling for srcdoc; child policy/filtering controls remote mail |
| Clickjacking | X-Frame-Options DENY globally plus CSP frame-ancestors none | Application; present |
| MIME sniffing | X-Content-Type-Options nosniff globally | Application; present |
| Referrer | no-referrer globally, iframe and links | Application; present |
| Permissions-Policy | Absent | Optional defense-in-depth; missing policy is not a demonstrated V1 exploit |
| HSTS | Absent in raw HTTP | Operator HTTPS ingress responsibility; document/enable there |
| /setup, authenticated /, login/MFA document redirects | Next emits private, no-store/no-cache, max-age=0, must-revalidate | Observed production dynamic responses |
| /api/accounts, health, get-session | no-store | Observed |
| Many other private API successes | Mixed explicit policy | No Next dynamic API caching inferred from absence; recommend consistent private/no-store, especially mailbox/message GETs |
| Unauthorized proxy / unsupported method | Cache-Control absent in observed 401/405 | No private content in those probes; add consistency as defense-in-depth |
| Successful setup JSON | No explicit Cache-Control in observed 201 | Contains only initialized=true; POST response, not a private credential leak |
| Login / initial MFA / factor verification | no-store; Secure/HttpOnly/SameSite=Lax cookies | Observed |
| Ordinary attachment download | octet-stream; attachment Content-Disposition; length; private/no-store; nosniff; sandbox/default-src none | Source verified; authenticated ownership/MFA guard |
| Staged inline compose resources | Only verified safe raster bytes, private/no-store | Source verified; no arbitrary HTML/SVG inline route |
| Static Next assets | Proxy CSP matcher excludes _next/static/_next/image; global nosniff/referrer/XFO still configured | Public assets; no maps found in static artifact |

downloadDisposition normalizes filenames, removes control/bidi characters and path separators, limits length, supplies quoted ASCII fallback plus percent-encoded UTF-8 filename*. Active-content files (HTML/SVG etc.) are forced downloads with inert MIME instead of same-origin inline documents.

HTML mail is sanitized and rendered through an iframe sandbox with allow-popups/allow-popups-to-escape-sandbox, without allow-scripts or allow-same-origin. Child CSP denies scripts, objects, connections, frames, media, fonts, forms and base changes. Remote images are removed unless explicitly enabled; CID content is validated raster data. External links use noopener/noreferrer and no-referrer. The parent http(s) image ceiling does not override the child deny-by-default policy. No contradictory production header was found; no wholesale repeat of the previous HTML-isolation review was undertaken.

Private APIs lacking explicit no-store should not be deliberately cached by ingress. No caching proxy/CDN was supplied or certified. Consistent application headers are recommended; a real shared-cache disclosure was not demonstrated.

## 10. Health / readiness findings

- /api/health/live: unauthenticated 200, {status:alive}, no-store. No DB/storage/provider test. A responding HTTP process is all it claims.
- /api/health/ready: unauthenticated 200 ready or 503 unavailable, no-store. Tests select 1; existence of public.instance_state and drizzle.__drizzle_migrations; creates attachment root if necessary; R/W access; writes/removes an exclusive random 0600 probe file.
- It does not reveal DB URL, error text, owner identity, MFA state, migration hashes, provider information or filesystem paths.
- It does not compare all migration versions. The normal entrypoint's completed migrate call supplies the full migration ordering guarantee before HTTP starts.
- Fresh uninitialized DB had one instance_state row and zero two_factor rows, while ready was 200. This is intentional infrastructure readiness: setup/login/MFA must be reachable before business readiness. Requiring owner MFA for container routing would prevent first-run enrollment.
- The independent business guard returned 401 before MFA; worker remained idle until verified enrollment.
- Changing the attachment root to 0500 caused ready=503/unavailable, then permissions were restored.
- The hardened read-only-root variant with writable named storage returned live=200 and ready=200.
- No worker heartbeat exists. Use all-role coupling or separate worker monitoring. A paused MFA worker with web operational is not an unsafe auth partial state.
- Public readiness polling does cause small DB/file work; normal ingress connection/rate limits cover flooding. No new health-specific unbounded payload was found.

A combined DB-outage/limited-role experiment was rejected before execution; DB-down response behavior is source-reviewed, not runtime-proven here. checkReadiness catches connection errors and returns false; module initialization errors can be converted by the outer boundary to a generic 503.

## 11. PostgreSQL findings

Base Compose exposes no PostgreSQL host port. Only attached default-network peers and Docker/platform administrators can reach the normal DB path, subject to actual host networking. Dev loopback publication is explicitly selected and documented.

**F12-03:** POSTGRES_USER=maildock initializes the cluster bootstrap superuser; DATABASE_URL uses that same identity for web, worker, producers and migration. Runtime SQL returned:

```text
current_user = maildock
rolsuper = true
rolcreatedb = true
rolcreaterole = true
```

Consequently a SQL-capable application compromise has cluster-wide authority, can bypass role boundaries and invoke superuser server facilities, potentially including server-side program execution as the PostgreSQL OS user. This is not host root, nor a new public database exposure. It unnecessarily crosses from application schema authority to the separate DB service/entire PGDATA boundary. pg-boss creates/updates its schema and tables; reviewed migrations create functions/triggers/search objects. No reviewed CREATE EXTENSION or superuser-only migration requirement was found.

Minimal remediation: retain the bootstrap/admin role outside the application credential and initialize a non-superuser login with only the database/schema authority needed by migrations and pg-boss. A separate migration credential is additional defense-in-depth; not required to split web/worker/migration for V1 if a scoped owner role suffices. Existing volumes require an explicit reviewed credential/role transition, not assuming POSTGRES_USER updates a live cluster. A complete non-superuser migration/pg-boss validation remains necessary; it was not performed after the rejected experiment.

Password is required but not entropy-validated. Document random password generation. Compose embeds it in the URL without URL encoding; special URL characters can cause connection failure/misparsing. Base64url/hex generation or correctly encoded URL handling avoids that reliability footgun. It does not silently grant unauthenticated access.

Default database transport is private same-host container TCP without enforced TLS. That is acceptable for this boundary; external/untrusted-network DB deployments need operator-reviewed TLS and peer restrictions. Do not mandate private-network TLS without that threat model.

PGDATA persists independently of app replacement. Backups are sensitive regardless of encrypted account passwords: mail bodies, contacts/addresses, password hashes, sessions and auth state are stored there. No real database or provider was contacted.

## 12. Persistent data / filesystem findings

| State | Intended persistence | Confidentiality / recovery significance |
| --- | --- | --- |
| Owner binding, password hash, MFA factors/recovery data | PostgreSQL | Authentication authority; protect backups; auth cryptography depends on AUTH_SECRET |
| Session tokens, verification/challenge/replacement state, throttles | PostgreSQL | Bearer/revocation/admission state; restoration is a security rollback |
| Account passwords, OAuth caches/tokens, OAuth provider client secrets and PKCE verifier envelopes | Encrypted PostgreSQL envelopes | Requires matching active/previous credential keys; Microsoft bootstrap is persisted encrypted |
| Mail metadata, bodies/search text, drafts/signatures, recipient/Bcc/envelope metadata | PostgreSQL | Not generally encrypted at rest by Maildock; confidential data |
| Incoming/staged/forwarded attachment bytes and outgoing MIME | attachments_data | Plaintext authoritative bytes; may contain sensitive mail/Bcc-related content depending on stored representation |
| pg-boss data/output | PostgreSQL pg-boss schema | Jobs reference local IDs; safeJobHandler constrains failure output; same backup confidentiality |
| Application Events | PostgreSQL | Deliberately owner-readable scoped metadata; cleanup distinct from stdout |
| Operational stdout/stderr | Docker/platform log storage | Operator-owned retention/access/rotation; F12-02 adds a real raw-URL path |
| Deployment secrets / historical keys | Protected operator store | Must survive replacement/restore separately from image |

LocalBlobStorage accepts only UUID-v4 storage keys and derives internal paths; API callers do not supply filesystem paths. Temporary files are exclusive 0600 under 0700 tmp; blob shard directories are 0700; successful physical blob was verified 0600, owned by 1001. Writes count bytes, hash, fsync, rename and directory-fsync. Normal failed writes remove temporary files in finally. Hard crash can leave temporary/orphan files.

Symlinks already planted by a local writer of the trusted storage volume are not independently confined with openat/O_NOFOLLOW. Remote UUID key validation prevents ordinary traversal; controlling the volume is already privileged storage access. Keep the volume private; do not turn it into a shared writable upload directory.

Upload inline validation occurs after physical publication; rejected inline data or DB transaction failures can leave complete unreferenced blobs. removeStaged marks removed and deliberately retains physical bytes; 24-hour expiry is eligibility, not GC. docs/PHASE_2E documents conservative retention. No destructive collector is proposed.

README clearly requires a matched PostgreSQL + attachment backup plus corresponding encryption keys/deployment secrets, and warns that DB alone is incomplete. Loss of credential keys prevents decrypting passwords/OAuth material; loss of AUTH_SECRET also affects auth-protected factor/recovery state. Do not rotate it as an incidental restore step.

F12-05 covers missing operational handling for confidential backups, restored auth state, update rollback and capacity/log retention. The application does not encrypt the whole attachment volume or database; operator disk/backup encryption and access control are appropriate responsibilities.

## 13. Resource-boundary findings

The main production defect is F12-01's upload boundary mismatch, not an unbounded upload implementation.

| Input/work | Existing bound / residual |
| --- | --- |
| Setup/login/MFA | 4 KiB body with 10s deadline plus persisted F3/F8 admission; Next may clone up to 10 MiB before the route consumes its bounded body |
| Routed HTTP body | Installed Next defaults proxyClientMaxBodySize=10,485,760; clone ends at overflow, warns and truncates rather than reliably rejecting |
| Raw staged upload | Streamed storage byte counter; default 15 MiB, max configurable 100 MiB; no multipart prebuffer; broken by smaller clone limit |
| Draft/signature JSON | readDraftRequest counts at most 3,100,000 bytes; no application read deadline there |
| Other settings/accounts JSON/text | Several routes use request.json()/text() with schema validation after read; Next's matched proxy clone supplies a finite 10 MiB ceiling, not a suitable endpoint-specific validator |
| Download / outgoing MIME | Verified size/hash reads, per-file and aggregate limits; bounded full-memory buffers can multiply under owner concurrency |
| Incoming text parts | Default 5 MiB, configurable at most 20 MiB; maxBytes+1 fetch and actual byte counting; stream destroyed on overflow |
| Incoming attachments | Bounded partial wire fetches, actual decoded counter, storage limit and additional wire budget |
| MIME rendering | Bounded selected text input, JSDOM/DOMPurify processing; MIME structure/depth/UID-list work not given a global mailbox quota |
| Worker jobs | Queue-specific localConcurrency; recent/delta use configured 2 default, discovery configured 5; content/attachment queues use 1; WORKER_CONCURRENCY is not a global sum |
| Synchronization/backfill | Fetch batch 150; backfill chunk 500; polling min30s/default300s; coalesced/singleton jobs and persisted checkpoints |
| Database connections | postgres-js pool default10 per web/worker; separate pg-boss pools/producers add connections; not a single installation-wide maximum |
| Persistent bytes/rows | No installation-wide mail/account/attachment quota; intentional retained MIME/blobs and orphan accumulation |
| Log files | Base Compose delegates logging driver/rotation; observed disposable host uses json-file with no per-container options |

No additional convincingly unauthenticated **unbounded per-request** memory/disk path was established after accounting for the actual Next clone ceiling and preauthorization. That ceiling is not a general overload guarantee: many concurrent connections, per-request 10 MiB buffering, log output, slow clients and external mail growth need operator limits/capacity monitoring. Do not disable clone limits or set Infinity to repair F12-01.

An owner can repeatedly upload/remove/reject inline data and consume disk, as can normal retained mail growth. This is finite-per-request but unbounded cumulative storage. Single-owner capacity planning and alarms are justified; adversarial multi-tenant quotas or age-based deletion are not prerequisites. Incoming MIME/IMAP metadata can be larger/complex even when text parts are bounded; no pathological hostile-provider experiment was run. Mailbox-size scaling is a limitation, not a separately demonstrated V1 blocker.

## 14. Supply-chain / build findings

packageManager pins pnpm 12.6.0; Docker activates that exact version and installs --frozen-lockfile. pnpm-workspace.yaml supplies patches for Better Auth adapter 1.7.5, ImapFlow 2.0.6 and pg-boss 12.33.7. patches are copied before install; worker/web consume the patched installation. The reviewed source does not select a remote runtime worker bundle.

Lifecycle allowBuilds is explicit: esbuild, protobufjs and unrs-resolver allowed; cpu-features/ssh2 disabled. Dependencies still run allowed lifecycle scripts in the build environment. No deployment secret is passed to dependency installation. Build-time dummy auth/key generation supplies the production-config evaluation needs without real credentials.

next build plus tsc and scripts/fix-worker-imports.mjs are the actual production compiler chain. The rewrite adds .js to extensionless relative imports, not arbitrary downloaded code. Docker copies reviewed compiled artifacts; local uncommitted source would enter COPY . ., so release builds should use a clean reviewed checkout. The baseline was clean.

Base tags pin versions but are mutable, as is docker/dockerfile:1.7. Digest pins/SBOM/provenance and controlled updates are recommended. The recorded digest identifies this build, not all future tag resolutions. Host Node22/pnpm11 were only inventoried; build executed the Docker Node24/pnpm12 toolchain.

F12-04 proves production dependency pruning leaves extra physical package content. Clean production deployment assembly should include worker/migrator dependencies while eliminating purely development payloads and redundant metadata where practicable. No dependency vulnerability conclusion is made; later dependency gate owns CVE scanning. Telemetry notice appeared during build; NEXT_TELEMETRY_DISABLED is an optional build setting.

## 15. Documentation / operator-contract findings

README/.env.example/DEPLOYMENT correctly cover independent auth/encryption/bootstrap random generation, HTTPS, canonical APP_ORIGIN, production mode, external ingress, no raw bypass, private PostgreSQL, no forwarded-IP security trust, persistent volumes, matched DB/blob backup, key loss, MFA enrollment and development override separation.

**F12-05:** production instructions lack a concise security-sensitive update/restore/capacity procedure:

- DB + blobs contain plaintext mail and bearer/auth state; backups and operational logs need explicit restricted access, confidentiality and retention.
- Restoring an earlier DB can restore a previously revoked, still-in-lifetime session or old recovery/factor state. The configured AUTH_SECRET remains valid. Ordinary F6 revocation does not magically survive restoring an older database. Before reopening ingress, an operator must invalidate restored sessions/challenges through a reviewed procedure and verify restored owner/MFA state. Never edit owner binding or invent a second owner.
- Stop/quiesce writers for a consistent recovery set, preserve required key versions, and take that set before automatic forward migrations. An old image is not automatically compatible with a migrated DB; rolling back only the image is not a defined recovery procedure.
- Capacity guidance must say expiry/removal does not reclaim attachment bytes, and the operator must monitor DB/attachment disk space and define stdout/stderr rotation. A database/blob backup must preserve all durable references.
- Custom bind mounts need UID/GID1001 access. Mounted-secret guidance must explain env translation; no native *_FILE support exists.
- Recommend a stop grace exceeding pg-boss's 30s drain and explain forced-stop recovery/SMTP uncertainty.

These are operator responsibilities; the finding is the incomplete documented release contract. Minimal remedy is explicit requirements and a reviewed restore/update procedure, not mandatory backup software, a proxy, automatic blob deletion, or changes to F1-F11 algorithms. The restoration consequence is inferred directly from stored session validation/revocation semantics; backup restoration was not exercised.

**F12-06:** .env.example lists DATABASE_POOL_SIZE, WORKER_CONCURRENCY, initial-sync days, fetch batch size, message sync concurrency, mail poll interval and max text-part bytes, but base Compose does not interpolate/pass them. Editing .env alone cannot tune those values inside the base app. The defaults are bounded; this is LOW/nonblocking configuration accuracy/capacity friction. Pass through the supported values or clearly document a production override.

README's current-data-model text is stale about no message tables, but that is not an F12 security blocker. HSTS, ingress connection/body/time limits, backup confidentiality, disk/log capacity and Docker admin access belong to the platform contract, not a bundled ingress dependency.

## 16. F1-F11 regression assessment

| Finding | Container-focused result |
| --- | --- |
| F1 setup secrecy/closure | Fresh setup required synthetic bootstrap; no runtime secret in browser canary scan; initialized-state closure remains persisted/source-verified |
| F2 mandatory MFA | Before MFA business API=401; enrollment required; after TOTP full session API=200; worker jobs began after verification |
| F3 setup Argon2 DoS | Source limits/admission preserved; 11MiB setup request returned413; framework prebuffer up to10MiB remains, not another unbounded hash path |
| F4 CSRF | Foreign Origin authenticated upload=403; configured HTTPS origin accepted |
| F5 lifetime | Source retains12h inactivity/30d absolute cap and DB revalidation; production cookie Max-Age43200 observed; no time-travel test repeated |
| F6 logout | Initial probe without proper JSON protocol returned415; corrected JSON logout=200 and replay of revoked cookie=401 |
| F7 username consistency | Same normalization/immutable username plugin and schema remain; not exhaustively retested |
| F8 work admission | Persisted atomic admission and patched limiter remain in build; no new IP-dependent bucket introduced; no load benchmark repeated |
| F9 ingress/IP | No base public ports; production HTTP origin rejected; Secure cookies observed; ipAddressHeaders=[] intact |
| F10 immutable owner | Existing readiness/owner/session readers and DB binding unchanged; no production container bypass found; overbroad DB credential is F12-03 privilege amplification |
| F11 diagnostics | **Concrete new framework escape F12-02**; synthetic query appeared in stderr. Other inspected migration/worker/web diagnostics retain finite fields |

F11 RESULTS explicitly accepted conditional framework-internal residuals. This review does not claim those earlier application fixes failed; it turns an additional reachable native request-body warning into concrete evidence under F12. Do not weaken the F11 contract or suppress all errors to conceal it.

## 17. Findings table

| ID | Severity | Blocks V1/F12? | Affected boundary | Observed behavior / realistic consequence | Minimal recommendation / constraints |
| --- | --- | --- | --- | --- | --- |
| F12-01 | HIGH | Yes | Application + Next proxy + production uploads | 11,534,336 bytes sent;201 ready;10,455,620 bytes saved. Accepted file can be forwarded/sent missing bytes, with hash only certifying truncated storage | Make body boundary reject overflow/incomplete transfer or support full configured upload safely; retain finite memory/byte/time limits, auth/Origin and immutable MIME |
| F12-02 | MEDIUM | Yes | Next native stderr, before application diagnostic boundary | Oversized unauthenticated setup request logs full path/query canary; arbitrary sensitive query values can enter retained diagnostics; warnings uncoalesced | Remove request URL from this reachable native warning using a narrow reviewed framework boundary/patch or bounded pre-framework rejection; retain useful safe diagnostics and F3/F8, do not rely exclusively on optional ingress limits |
| F12-03 | MEDIUM | Yes | Compose DB credential / PostgreSQL cluster | App login is SUPERUSER+CREATEDB+CREATEROLE; SQL compromise gains DB-service authority beyond app schemas | Non-superuser scoped DB role; validate migrations/pg-boss and existing-volume transition. No mandatory new service, no owner/MFA redesign |
| F12-04 | LOW | No | Final image dependency tree | Physical dev package files survive prune; unnecessary bytes/tools and supply-chain surface | Clean deployable dependency tree covering Next+worker+migrator; retain native Argon2 and patches |
| F12-05 | MEDIUM | Yes, operator contract | README/DEPLOYMENT/backup/update/capacity | Restored bearer/auth authority and retained plaintext/blob/log growth have no release procedure; competent backup/restore can reopen stale access or lose authoritative bytes | Document confidential consistent recovery set, restored-session invalidation, owner/MFA/key verification, migration rollback and capacity/log ownership; no destructive GC or auth-policy redesign |
| F12-06 | LOW | No | .env.example vs Compose | Several tuning env values silently stay defaults in normal Compose | Pass through or explain override; retain schema bounds and two-service baseline |

F12-01 evidence: installed /app/node_modules/next/dist/server/body-streams.js and config-shared.js; src/proxy.ts matcher; src/app/api/attachments/staged/route.ts; AttachmentService.upload and LocalBlobStorage.put; actual returned JSON and file permissions.

F12-02 evidence: same installed body-streams.js calls console.warn with readable.url; /api/setup?f12=F12_SYNTHETIC_DIAGNOSTIC_CANARY; 413 response with canary in docker logs. This contains no real secret.

F12-03 evidence: docker-compose.yml POSTGRES_USER/DATABASE_URL and actual SELECT from pg_roles. F12-04 evidence: Dockerfile prune/copy chain and actual .pnpm file inventory. F12-05 evidence: README/DEPLOYMENT/PHASE_2E and session-validation/logout/session-policy persistence. F12-06 evidence: config schema/.env.example compared with actual resolved Compose environment keys.

## 18. Required V1 remediations

1. F12-01: align framework forwarding and application upload limits, with explicit failure for truncation/overflow and exact-byte publication. Validate at/below/above every configured boundary, including chunked requests; no Infinity workaround.
2. F12-02: close the demonstrated native URL diagnostic escape. Preserve normalized F11 output and no logged Request/URL/body. Validate the same synthetic oversized-request query canary.
3. F12-03: provide a non-superuser application DB credential and validated initialization/existing-volume transition. Confirm actual migrations and pg-boss startup/work under the scoped role.
4. F12-05: publish the smallest explicit secure restore/update/storage/log contract, including restored-session revocation before public reopening, key preservation and non-destructive capacity management.

Do not implement fixes in this session. No mandatory Redis/proxy/backup service, extra owner, revised MFA policy, forwarded-IP trust or weakening of HTTPS is needed.

## 19. Recommended defense-in-depth

cap_drop ALL, no-new-privileges, read-only root with tested writable mounts/tmpfs, root-owned executable files, adequate stop grace, optional init, Docker resource/PID budgets sized for mail parsing, private app/DB network segmentation when ingress attachment merits it, log rotation/access controls, consistent private API no-store, ingress HSTS/connection/time/body limits, minimal physical runtime dependency tree, digest pins and reproducible clean release builds.

Address F12-06 tuning accuracy. Document pg-boss's separate pool/concurrency/retention rather than treating DATABASE_POOL_SIZE/WORKER_CONCURRENCY as installation-wide ceilings. Backup/disk/log responsibilities are required contract content; the choice of a specific platform mechanism remains discretionary.

## 20. Explicitly rejected / unnecessary hardening

- Bundled nginx/Traefik/Caddy or mandatory Redis.
- Requiring every valid app backend path to be127.0.0.1.
- Treating EXPOSE3000 or internal0.0.0.0 as public ingress regression.
- Trusting forwarded IP/proto/host to repair deployment behavior.
- Plain HTTP production APP_ORIGIN, including LAN convenience.
- Requiring MFA-ready health routing before initial enrollment.
- Private same-host PostgreSQL TLS without an additional threat model.
- Blanket egress denial, immutable/no-write attachment volume, automatic age-only GC.
- Calling every absent optional Docker/browser header a release blocker.
- General CVE audit, wholesale HTML-mail re-review or repeating every F1-F11 test.
- Treating an application RCE as automatically host-root compromise.
- Silent dependency/proxy limit removal to get successful large uploads.

## 21. Validation performed

Successful production Docker build used the existing cached dependency install/prune layers and freshly compiled application source. Inspected image config/history/files, identity, permissions, Linux capability status, package payloads/maps and browser assets. Resolved base Compose using only synthetic input. Started disposable PG and full app, completed native setup+MFA and owner login without real accounts/providers.

Verified pre-MFA denial, post-MFA owner API, production cookie attributes, Origin rejection, corrected JSON logout and revoked-cookie replay. Reproduced11MiB silent upload truncation and native URL logging. Verified fresh readiness without MFA, storage-failure503, read-only/cap-drop/no-new-privileges startup+health, invalid HTTPS config fail-closed, direct config rejection of six malformed settings, and whole-container exit on either child failure.

Limitations: no real SMTP/IMAP/OAuth connection; no load/OOM/full-disk flood, full restore, historical-session lifetime experiment, forced migration interruption, external ingress test, ARM build, universal image-cache write-path test, or scoped-role migration/DB-outage runtime proof. No automatic test suites were run. Shell inventory commands produced benign missing-path/glob/ps errors; those are noted below rather than counted as successful validations.

## 22. Exact commands / probes executed

The following is the literal disposable runtime command/probe inventory. Synthetic credentials are intentionally nonproduction values. The actual local .env was excluded. Commands using Windows PowerShell and commands fed to Linux container Node/sh are distinguished by their wrappers. Output/observations appear above; failures are included.

### Baseline, build and tooling

```powershell
Get-Content -LiteralPath 'C:\Users\mateu\.codex\attachments\48a9249d-c10f-40dd-ab83-6387f3286c57\Wklejony tekst.txt'
Get-Location; rg --files -g AGENTS.md -g package.json -g README*
git rev-parse HEAD; git status --short
docker version; node --version; pnpm --version
docker build -t maildock-f12-review:908859e .
```

Read-only source inventory used rg --files for Docker/Compose/entrypoint/config/env filenames, src/scripts/docs, and git ls-files '*compose*' '*Docker*' '*env*' '*AGENTS*'. Files were read with Get-Content/Select-Object/Select-String; searches used rg -n. Inspected paths are named in each report section and the source-inspection command log below. No dependency install/build was run on the host and no local .env content was printed.

### Synthetic Compose and disposable infrastructure

```powershell
$taskTemp = Join-Path $env:TEMP 'maildock-f12-review'
New-Item -ItemType Directory -Force -Path $taskTemp | Out-Null
@'
APP_ORIGIN=https://f12.invalid
POSTGRES_PASSWORD=f12-disposable-only
AUTH_SECRET=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=
CREDENTIALS_ENCRYPTION_KEY=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=
MAILDOCK_BOOTSTRAP_SECRET=Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M=
DATABASE_URL=postgresql://maildock:f12-disposable-only@maildock-f12-db:5432/maildock
ATTACHMENTS_PATH=/var/lib/maildock/attachments
'@ | Set-Content -LiteralPath (Join-Path $taskTemp 'synthetic.env')
docker compose --env-file (Join-Path $taskTemp 'synthetic.env') -f docker-compose.yml config --format json | Set-Content -LiteralPath (Join-Path $taskTemp 'compose.json')
$c = Get-Content -Raw -LiteralPath (Join-Path $taskTemp 'compose.json') | ConvertFrom-Json
$c.services.PSObject.Properties | ForEach-Object { [pscustomobject]@{Service=$_.Name;Ports=$_.Value.ports;Networks=$_.Value.networks;EnvironmentMode=$_.Value.environment.MAILDOCK_ENV} } | ConvertTo-Json -Depth 5
docker network create maildock-f12-net
docker volume create maildock-f12-attachments
docker run -d --name maildock-f12-db --network maildock-f12-net --env-file (Join-Path $taskTemp 'synthetic.env') -e POSTGRES_USER=maildock -e POSTGRES_DB=maildock postgres:18.6-bookworm
docker image inspect maildock-f12-review:908859e --format '{{json .Config}}'
docker run --rm --entrypoint sh maildock-f12-review:908859e -c 'id; node --version; stat -c "%a %u:%g %n" /app /app/server.js /var/lib/maildock/attachments /tmp; command -v npm; command -v pnpm; command -v sh; find /app -maxdepth 2 -type d; find /app -name "*.map" | wc -l; test -d /app/node_modules/.pnpm/typescript*; ls /app/node_modules/.pnpm | grep -E "^(typescript|vitest|tsx|playwright|drizzle-kit|pnpm)@"'

```

### Image and database inspection

```powershell
$taskTemp = Join-Path $env:TEMP 'maildock-f12-review'
docker exec maildock-f12-db pg_isready -U maildock -d maildock
docker run -d --name maildock-f12-app --network maildock-f12-net --env-file (Join-Path $taskTemp 'synthetic.env') -v maildock-f12-attachments:/var/lib/maildock/attachments -p 127.0.0.1:33012:3000 maildock-f12-review:908859e
docker exec maildock-f12-db psql -U maildock -d maildock -c "select current_user, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname=current_user;"
docker run --rm --entrypoint sh maildock-f12-review:908859e -c 'ls -l /app/node_modules/typescript /app/node_modules/vitest /app/node_modules/.bin; du -sh /app/node_modules /app/.next; find /app -maxdepth 2 -name ".env*" -o -name ".git" -o -name "tests"; find /app/.next/static -name "*.map" | wc -l; cat /proc/self/status | grep -E "Cap|NoNewPrivs"; ls /usr/local/bin; find /app/.next -maxdepth 3 -type f -name "*.map" | head -5'
docker inspect maildock-f12-app --format '{{json .HostConfig}}'
docker history --no-trunc maildock-f12-review:908859e --format '{{.CreatedBy}}'

```

### Initial HTTP and readiness probes

```powershell
docker logs maildock-f12-app
docker exec maildock-f12-app sh -c 'cat /proc/1/status | grep -E "Cap|NoNewPrivs"; ps -eo pid,ppid,user,args; dpkg-query -W; find /app/node_modules/.pnpm -maxdepth 1 -name "*playwright*" -o -name "*vitest*" -o -name "*typescript*"; find /app -maxdepth 2 -type f'
$paths = '/api/health/live','/api/health/ready','/setup','/login','/initial-mfa','/api/accounts','/api/auth/get-session'
foreach ($probePath in $paths) {
  $r = Invoke-WebRequest -Uri ('http://127.0.0.1:33012'+$probePath) -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction SilentlyContinue
  [pscustomobject]@{Path=$probePath;Status=[int]$r.StatusCode;Headers=$r.Headers;Body=if($probePath.StartsWith('/api/')){$r.Content}else{'[HTML omitted]'}} | ConvertTo-Json -Depth 4
}
docker exec maildock-f12-db psql -U maildock -d maildock -c "select count(*) from public.instance_state; select count(*) from public.two_factor;"

```

### Installed framework and process inventory

```powershell
docker exec maildock-f12-app sh -c 'grep -R -n "proxyClientMaxBodySize\|middlewareClientMaxBodySize" /app/node_modules/next/dist/server/next-server.js /app/node_modules/next/dist/server/body-streams.js /app/node_modules/next/dist/server/config-shared.js; find /app/node_modules/.pnpm/typescript@6.0.3 -maxdepth 3 -type f | head -3; find /app/node_modules/.pnpm/vitest@* -maxdepth 3 -type f | head -3'
docker exec maildock-f12-app node --input-type=module -e 'import fs from "node:fs"; for (const p of fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x))){try {const c=fs.readFileSync("/proc/"+p+"/cmdline","utf8").replaceAll("\0"," ");if(c.includes("node")) console.log(p,c)}catch{}}'

```

### Native diagnostic canary

```powershell
docker exec maildock-f12-app sh -c 'sed -n "1,180p" /app/node_modules/next/dist/server/body-streams.js; sed -n "1270,1305p" /app/node_modules/next/dist/server/next-server.js'
docker exec maildock-f12-app node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3000/api/setup?f12=F12_SYNTHETIC_DIAGNOSTIC_CANARY",{method:"POST",headers:{Origin:"https://f12.invalid","Content-Type":"application/json"},body:"x".repeat(11*1024*1024)});console.log(r.status,await r.text());'
docker logs --tail 15 maildock-f12-app

```

### Native enrollment and upload probe

```powershell
@'
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
const jar=new Map();
const password='F12-disposable-password-2026';
async function call(path,body){
 const r=await fetch('http://127.0.0.1:3000'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://f12.invalid','Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 for(const c of r.headers.getSetCookie()){const [kv]=c.split(';');const i=kv.indexOf('=');jar.set(kv.slice(0,i),kv.slice(i+1));}
 const t=await r.text();console.log(path,r.status,r.headers.get('cache-control'),r.headers.getSetCookie().map(c=>c.replace(/=[^;]*/, '=[REDACTED]')));
 if(!r.ok) {console.log(t);throw Error('probe failed');}
 return t?JSON.parse(t):null;
}
await call('/api/setup',{username:'f12owner',password,bootstrapSecret:process.env.MAILDOCK_BOOTSTRAP_SECRET});
await call('/api/auth/sign-in/username',{username:'f12owner',password});
console.log('business before MFA', (await fetch('http://127.0.0.1:3000/api/accounts',{headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}})).status);
const enrollment=await call('/api/auth/initial-mfa/start',{password,bootstrapSecret:process.env.MAILDOCK_BOOTSTRAP_SECRET});
const secret=new URL(enrollment.totpURI).searchParams.get('secret');
function totp(){
 let bits='';for(const c of secret.toUpperCase()) bits+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0');
 const key=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const h=createHmac('sha1',key).update(counter).digest();const o=h[19]&15;
 return String((h.readUInt32BE(o)&0x7fffffff)%1000000).padStart(6,'0');
}
await call('/api/auth/initial-mfa/complete',{code:totp(),bootstrapSecret:process.env.MAILDOCK_BOOTSTRAP_SECRET});
await call('/api/auth/sign-in/username',{username:'f12owner',password});
await call('/api/auth/mfa/totp',{code:totp()});
await call('/api/accounts');
fs.writeFileSync('/tmp/f12-cookie',[...jar].map(([k,v])=>k+'='+v).join('; '),{mode:0o600});
const upload=await fetch('http://127.0.0.1:3000/api/attachments/staged',{method:'POST',headers:{Origin:'https://f12.invalid',Cookie:fs.readFileSync('/tmp/f12-cookie','utf8'),'Content-Type':'application/octet-stream','X-Attachment-Filename':'f12-synthetic.bin'},body:Buffer.alloc(11*1024*1024,65)});
console.log('upload sent',11*1024*1024,'status',upload.status,'body',await upload.text());

'@ | docker exec -i maildock-f12-app node --input-type=module
```

### Caching, Origin and first logout probe

```powershell
@'
import fs from 'node:fs';
const cookie=fs.readFileSync('/tmp/f12-cookie','utf8');
for(const p of ['/','/login','/initial-mfa','/api/accounts','/api/outgoing','/api/auth/get-session']){
 const r=await fetch('http://127.0.0.1:3000'+p,{headers:{Cookie:cookie},redirect:'manual'});
 console.log(p,r.status,JSON.stringify({cache:r.headers.get('cache-control'),csp:!!r.headers.get('content-security-policy'),permissions:r.headers.get('permissions-policy'),hsts:r.headers.get('strict-transport-security')}));
}
const r=await fetch('http://127.0.0.1:3000/api/attachments/staged',{method:'POST',headers:{Origin:'https://evil.invalid',Cookie:cookie},body:'synthetic'});
console.log('foreign origin',r.status);
const logout=await fetch('http://127.0.0.1:3000/api/auth/sign-out',{method:'POST',headers:{Origin:'https://f12.invalid',Cookie:cookie}});
console.log('logout',logout.status);
console.log('replay',(await fetch('http://127.0.0.1:3000/api/accounts',{headers:{Cookie:cookie}})).status);
let leaks=[];const needles=[process.env.AUTH_SECRET,process.env.CREDENTIALS_ENCRYPTION_KEY,process.env.MAILDOCK_BOOTSTRAP_SECRET,'f12-disposable-only'];
function scan(p){for(const x of fs.readdirSync(p,{withFileTypes:true})){const q=p+'/'+x.name;if(x.isDirectory())scan(q);else if(needles.some(n=>fs.readFileSync(q).includes(n)))leaks.push(q);}}
scan('/app/.next/static');console.log('browser runtime canary matches',leaks);

'@ | docker exec -i maildock-f12-app node --input-type=module
docker exec maildock-f12-app sh -c 'stat -c "%a %u:%g %n" /var/lib/maildock/attachments/tmp /var/lib/maildock/attachments/blobs /var/lib/maildock/attachments/blobs/*/*; grep -R -n "F12_SYNTHETIC_DIAGNOSTIC_CANARY" /app/.next/static || true'

```

### Invalid configuration and hardened runtime

```powershell
$taskTemp = Join-Path $env:TEMP 'maildock-f12-review'
docker run --name maildock-f12-invalid --env-file (Join-Path $taskTemp 'synthetic.env') -e APP_ORIGIN=http://f12.invalid maildock-f12-review:908859e
docker inspect maildock-f12-invalid --format '{{.State.ExitCode}}'
docker run -d --name maildock-f12-ro --network maildock-f12-net --env-file (Join-Path $taskTemp 'synthetic.env') --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=32m -v maildock-f12-attachments:/var/lib/maildock/attachments maildock-f12-review:908859e

```

### Corrected logout, storage failure, worker exit and stop

```powershell
@'
import fs from 'node:fs';
const cookie=fs.readFileSync('/tmp/f12-cookie','utf8');
const r=await fetch('http://127.0.0.1:3000/api/auth/sign-out',{method:'POST',headers:{Origin:'https://f12.invalid',Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
console.log('JSON logout',r.status,await r.text());
console.log('revoked-cookie replay',(await fetch('http://127.0.0.1:3000/api/accounts',{headers:{Cookie:cookie}})).status);
'@ | docker exec -i maildock-f12-app node --input-type=module
docker logs --tail 8 maildock-f12-ro
docker exec maildock-f12-ro node --input-type=module -e 'for(const p of ["live","ready"]){const r=await fetch("http://127.0.0.1:3000/api/health/"+p);console.log(p,r.status,await r.text())}'
docker exec maildock-f12-app chmod 500 /var/lib/maildock/attachments
Invoke-WebRequest http://127.0.0.1:33012/api/health/ready -SkipHttpErrorCheck | Select-Object StatusCode,Content
docker exec maildock-f12-app chmod 755 /var/lib/maildock/attachments
docker stop -t 5 maildock-f12-ro
docker inspect maildock-f12-ro --format '{{json .State}}'
docker exec maildock-f12-app node -e 'process.kill(26,"SIGKILL")'
docker wait maildock-f12-app
docker inspect maildock-f12-app --format '{{json .State}}'
docker logs --tail 6 maildock-f12-app

```

### Unsuccessful scoped-role attempt

```powershell
docker start maildock-f12-app
docker exec maildock-f12-db psql -U maildock -d maildock -c "CREATE ROLE f12_scoped LOGIN PASSWORD 'f12-scoped-only' NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE DATABASE f12_scoped OWNER f12_scoped;"

```

### Configuration and web-child failure

```powershell
docker logs --tail 8 maildock-f12-ro
docker exec maildock-f12-app node --input-type=module -e 'const {parseConfig}=await import("./dist-worker/shared/infrastructure/config/config.js");for(const patch of [{APP_ORIGIN:"http://f12.invalid"},{AUTH_SECRET:"short"},{CREDENTIALS_ENCRYPTION_KEY:"bad"},{WORKER_CONCURRENCY:"51"},{ATTACHMENTS_PATH:"relative"},{MAILDOCK_ENV:"typo"}]){try{parseConfig({...process.env,...patch});console.log(Object.keys(patch)[0],"UNEXPECTED_ACCEPT")}catch(e){console.log(Object.keys(patch)[0],e.name)}}'
docker exec maildock-f12-app node --input-type=module -e 'const fs=await import("node:fs");for(const p of fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x))){try{const c=fs.readFileSync("/proc/"+p+"/cmdline","utf8").replaceAll("\0"," ");if(c.includes("next-server")){console.log("terminating web",p);process.kill(Number(p),"SIGKILL");break;}}catch{}}'
docker wait maildock-f12-app
docker logs --tail 5 maildock-f12-app

```

### Container cleanup

```powershell
docker rm -f maildock-f12-app maildock-f12-ro maildock-f12-invalid maildock-f12-db
```

### Named storage and network cleanup

```powershell
docker volume rm maildock-f12-attachments
docker network rm maildock-f12-net
```

The combined scoped-role command returned CREATE ROLE followed by "CREATE DATABASE cannot run inside a transaction block"; the transaction rolled back, so no scoped-role validation succeeded. A later grouped command (separate CREATE ROLE, CREATE DATABASE, new scoped app, stopping/restarting disposable PG and DB-down probes) was rejected before execution by automatic approval review with only "blocked by policy". It is not counted as runtime evidence. No permission workaround was attempted.

Additional exact inspection commands included:

```powershell
Get-Content Dockerfile,.dockerignore,docker-compose.yml,docker-compose.dev.yml,scripts/container-entrypoint.mjs,package.json,next.config.ts,.env.example,docs/DEPLOYMENT.md
Get-Content src/shared/infrastructure/config/config.ts,src/composition/worker-process.ts,src/composition/worker.ts,src/modules/platform/infrastructure/readiness.ts,src/app/api/health/live/route.ts,src/app/api/health/ready/route.ts,src/shared/infrastructure/database/migrate.ts,src/shared/infrastructure/database/runtime-database.ts,src/proxy.ts,src/shared/infrastructure/security/content-security-policy.ts
Get-Content -LiteralPath 'src/app/api/attachments/[attachmentId]/download/route.ts'
Get-Content -LiteralPath 'src/app/api/auth/[...all]/route.ts'
Get-Content src/modules/mail/application/attachment-metadata.ts,src/modules/mail/application/draft-api.ts
rg -n 'request\.(json|formData|text|arrayBuffer)|Cache-Control|process\.env' src
rg -n 'download|simpleParser|maxMessageText|maxBytes|Buffer.concat|fetchOne|bodyParts' src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts
rg -n 'cleanup|expires|delete|limit|size' src/modules/mail/application/attachment-service.ts
Get-Content src/shared/infrastructure/logging/web-boundary.ts,src/modules/auth/application/initial-mfa-http.ts
Get-Content src/modules/mail/application/attachment-service.ts,src/modules/accounts/infrastructure/oauth-provider-configs.ts,src/modules/accounts/infrastructure/microsoft-oauth.ts,src/modules/accounts/infrastructure/google-oauth.ts
Get-Content src/modules/auth/application/api-access-check.ts,src/modules/auth/application/session-validation.ts,src/modules/auth/application/instance-readiness.ts,src/modules/mail/domain/attachments.ts
rg -n 'max|timeout|buffer|logger|debug|tls|rejectUnauthorized' src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts
rg --files .github
Get-Content scripts/fix-worker-imports.mjs
Get-Content src/shared/infrastructure/database/schema.ts | Select-String -Pattern 'export const|encrypted|token|secret|cache|recovery|backup'
Get-Content tsconfig.json
git ls-files '*compose*' '*Docker*' '*env*' '*AGENTS*'
Get-Content src/app/api/setup/route.ts,src/app/api/auth/initial-mfa/start/route.ts,src/app/api/auth/initial-mfa/complete/route.ts
Get-Content src/modules/auth/application/initial-mfa.ts | Select-Object -First 220
Get-Content -LiteralPath 'src/app/api/signatures/route.ts'
Get-Content src/modules/mail/application/signature-service.ts | Select-Object -First 110
Get-Content src/modules/mail/infrastructure/coalesced-sync-job.ts
Get-Content src/modules/auth/application/instance-auth.ts | Select-Object -First 75
Get-Content src/modules/auth/application/mfa-login.ts | Select-Object -First 85
Get-Content src/modules/auth/application/initial-mfa.ts | Select-Object -Skip 75 -First 45
Get-Content src/modules/auth/domain/password-policy.ts
Get-Content src/modules/mail/infrastructure/idle-watchers.ts | Select-Object -First 80
rg -n 'CREATE EXTENSION|create extension|SECURITY DEFINER|security definer|CREATE TRIGGER|create trigger' db patches
Get-Content src/modules/mail/infrastructure/content-jobs.ts | Select-Object -First 90
Get-Content src/modules/mail/infrastructure/attachment-jobs.ts | Select-Object -First 90
Get-Content docs/SECURITY_F11_RESULTS.md | Select-Object -First 65
Get-Content docs/SECURITY_F11_RESULTS.md | Select-String -Pattern 'framework|retention|rotation|Next' -Context 1,3
rg -n 'isInstanceReady|assert.*Ready' src/modules/accounts/application/accounts-service.ts src/modules/mail/application/outgoing-message-service.ts src/modules/mail/application/sent-copy-service.ts
rg -n 'max.*|timeout|buffer' patches/imapflow@2.0.6.patch
Get-Content src/shared/application/attachment-limits.ts
Get-Content src/modules/auth/domain/session-policy.ts
Get-Content docs/PHASE_2E.md | Select-Object -Skip 75 -First 24
Get-Content docs/SECURITY_F11_RESULTS.md | Select-Object -Skip 118 -First 21
rg -n 'schemaVersion|retentionSeconds|deleteAfter|retryLimit|expireInSeconds|localConcurrency' src/modules/mail/infrastructure/*jobs.ts
git status --short
```

Some earlier multi-path Get-Content reads used PowerShell Path expansion and produced a misleading missing-path diagnostic while still returning other requested contents; the attachment download route was then read successfully with -LiteralPath. rg --files .github reported no such directory. The final wildcard *jobs.ts path did not expand in rg on Windows; selected queue files were already read directly. ps was absent in the image; /proc was used instead. These failed inventory commands made no changes.

Container cleanup removed all four live/created review containers and the explicitly named attachment volume/network. The locally tagged review image and synthetic temporary command inputs were retained for reproducibility; Docker may retain the PostgreSQL image-declared anonymous data volume after container removal. No application instance remains running.

Final repository verification:

```powershell
git diff --check
git status --short
git rev-parse HEAD
```

## 23. Final answers

1. **Does the production container run with least privilege appropriate for V1?** App OS identity does: non-root1001, no effective capabilities, no host/socket privileges. The complete deployment does not yet: database access is a bootstrap superuser (F12-03). Optional cap-drop/read-only/no-new-privileges are validated defense-in-depth, not individual blockers.
2. **Can PostgreSQL become publicly reachable using normal production configuration?** No host publication in base Compose. Operator changes, shared networks or host routing can expose it; those must meet F9. The explicitly selected dev override is not production.
3. **Can the raw backend become unintentionally exposed by base production configuration?** No app host publication. Internal wildcard listening and expose3000 do not bypass ingress by themselves. Actual platform attachment/routing remains operator-owned.
4. **Are production secrets kept out of image and browser bundle?** Yes for the reviewed pipeline: no deployment build args/ENV, excluded env files, nonsecret runtime metadata and negative static runtime-canary scan. Docker/Compose env/inspection/config output remain confidential operator surfaces.
5. **Are persistent data and attachment requirements safe and documented?** Basic matched persistence/backup/key requirements and0600 blob publication are sound. F12-01 breaks exact-byte upload integrity; F12-05 must complete confidential restore/update/capacity guidance.
6. **Are health/readiness semantics safe for orchestration?** Yes for infrastructure/startup gating with normal entrypoint. They intentionally do not certify owner MFA, ingress isolation, complete migration versions or an independently deployed worker. Business authorization remains separate.
7. **Are browser headers sufficient for V1?** Reviewed nonce CSP, frame prevention, nosniff/referrer policy, auth no-store, inert downloads and isolated mail are appropriate. Permissions-Policy/consistent private API cache headers are recommended; HSTS belongs at HTTPS ingress.
8. **Is the process model fail-closed enough for V1?** Reproduced migration config rejection and either-child failure close the container. Migration signal handling and longer graceful-stop timeout merit improvements; no independently demonstrated release-blocking process defect.
9. **Are concrete unbounded resource paths blocking V1?** No additional per-request unbounded path was established; framework clone is finite but incorrectly truncates/logs. Cumulative mail/blob/log growth is real and requires the F12-05 operator capacity contract; no automatic destructive GC requirement.
10. **Does the artifact preserve F1-F11?** Focused production evidence/source review preserves F1-F10. A concrete additional F11 native framework disclosure is F12-02; the other F11 application diagnostic boundaries remain intact.
11. **What exactly must be fixed before F12 closes?** F12-01 exact-byte uploads, F12-02 native request-URL diagnostics, F12-03 scoped non-superuser application DB authority, F12-05 explicit secure restore/update/storage/log operational contract. Validate fixes in the actual image without weakening F1-F11.
12. **PASS or BLOCKED?** **BLOCKED.** No fixes were implemented, committed, pushed or deployed.



