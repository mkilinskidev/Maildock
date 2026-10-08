# Installation & deployment

## Break-glass owner recovery

Administrative access to the host or application container grants owner recovery authority. Protect Docker access as carefully as mailbox credentials. This is an interactive local administrator operation, with no email recovery or public recovery-initiation endpoint.

With PostgreSQL and the application running, use a private terminal:

```sh
docker compose exec app maildock owner-recovery
```

The command displays the immutable owner's login username. Read the warning, type exactly `RECOVER OWNER`, and enter the new password twice. Password input is not echoed or masked. The existing policy requires 12–128 characters. Do not use `-T`, pipes, password arguments, environment variables or terminal recording. The production launcher uses bundled Node, without pnpm.

Recovery preserves user ID, username and owner binding. It changes the password, revokes sessions and pending authentication, invalidates the old authenticator and recovery codes, and clears any remaining setup proof. It does not modify mail accounts, messages, OAuth configuration, application settings or cryptographic keys. An existing owner with unfinished first MFA or interrupted replacement is supported. Uninitialized or inconsistent instances are refused rather than repaired.

Sign in with the displayed username and the new password. This grants only a ten-minute enrollment ceremony. Show the QR code, enroll a new authenticator, verify its six-digit code, and save the new recovery codes privately. Then sign in again with password and MFA. Expiry, closing the browser or application restart does not undo recovery: sign in again to resume the same pending authenticator. Re-login invalidates the preceding browser ceremony. Failed proofs are throttled; a fresh ceremony does not refund the shared factor proof budget. If the completion response is lost, sign in with new password/TOTP and regenerate recovery codes through MFA management.

Normal `owner-recovery` refuses while recovery is pending. If the new password or pending authenticator must be replaced, explicitly restart:

```sh
docker compose exec app maildock owner-recovery --restart-pending
```

The additional warning, exact confirmation and both password prompts are required again. The flag is refused without pending recovery. Restart invalidates the preceding password, pending authenticator and browser authority.

Exit 0 confirms commit; MFA enrollment is still required. Exit 1 means refusal/failure; exit 130 means input interruption before submission. A disconnect during commit can leave the outcome unknown: inspect by rerunning the ordinary command and attempting the new login, without automatically restarting pending recovery. Mismatch or interruption before submission changes nothing. JavaScript strings cannot be reliably zeroized; the short-lived CLI clears references and never persists/logs them.

New authentication is fenced atomically. Already-authorized requests or in-flight mail work can finish; workers pause through the readiness supervisor. For backup restore, always follow [Backup & recovery](BACKUP_AND_RECOVERY.md), including stopped writers and mandatory maintenance. Owner recovery does not replace that procedure.

This document is the operator path for a fresh Maildock installation. Maildock is Docker-first and the supported base stack contains exactly two services: `app` and `postgres`.

## Requirements

- Docker Engine and Docker Compose
- persistent storage for PostgreSQL and Maildock attachments
- a DNS name for production
- HTTPS termination through an operator-managed reverse proxy or ingress
- outbound network access from the app to configured IMAP/SMTP and OAuth endpoints

The base Compose file does not publish app or database ports. A production ingress must reach app port 3000 over a trusted private path. PostgreSQL must remain private.

## Fresh production installation

Clone the repository and create the environment file:

```sh
cp .env.example .env
```

At minimum set a canonical HTTPS origin and three independent secrets:

```dotenv
APP_ORIGIN=https://mail.example.com
POSTGRES_PASSWORD=<strong-random-password>
AUTH_SECRET=<base64-random-secret>
CREDENTIALS_ENCRYPTION_KEY=<base64-32-byte-key>
```

Generate `AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` independently. The following produces the required 32 random bytes in canonical base64:

```sh
openssl rand -base64 32
```

Protect `.env` as a secret. Do not commit it, bake it into an image, paste it into logs, or expose rendered `docker compose config` output.

Build and start the stack:

```sh
docker compose up -d --build
docker compose ps
```

Maildock supports only the PostgreSQL service bundled with this Compose stack; external or independently managed PostgreSQL instances are not supported. The PostgreSQL init path creates the hardened database authority model before normal application startup. The app waits for PostgreSQL health, validates database authority, runs migrations, then starts web and worker processes.

Configure your reverse proxy/ingress so that the public HTTPS origin in `APP_ORIGIN` reaches the app's internal port 3000. Do not create a second untrusted raw HTTP route to the app. Maildock deliberately does not trust forwarded client-IP headers for authentication decisions.

### First-run owner setup

Open the Maildock **app container logs** (Coolify: the app's Logs view):

```sh
docker compose logs app
```

Find **Maildock first-time setup** and copy the **Setup secret**. Open `https://mail.example.com/setup`, enter that secret, and create the owner account. No setup secret needs to be configured before starting Maildock.

The secret is temporary and authorizes only initial instance provisioning. Owner creation permanently closes owner setup and freezes the existing setup secret for mandatory first MFA enrollment. Keep the copied secret until enrollment finishes; MFA completion clears its digest from PostgreSQL. Sign in as the owner, immediately complete mandatory TOTP enrollment using the same setup secret, and save recovery codes outside Maildock. Then verify password + TOTP sign-in, `/api/health/ready`, and configure mail accounts/OAuth providers.

Before owner creation, one web process holds a 60-second database lease and renews it every 10 seconds. Other web replicas use that same credential; workers never generate secrets. Their startup message directs you to the active web container's logs. If its process stops or cannot renew, a surviving or restarted web process generates and logs a replacement after the lease expires (up to approximately 70 seconds). Use the latest setup message from that process; earlier secrets are invalid after replacement. A follower restart leaves the active secret unchanged. Database outages can delay takeover; setup fails closed while the lease is expired.

After owner creation, restarts never generate or print setup secrets. Until first MFA enrollment completes, the same secret remains valid only together with the authenticated owner session and password/TOTP; retrieve it from the original setup logs if needed. An upgrade from the previous manually configured bootstrap flow must complete any pending first MFA enrollment before deploying this version. The setup secret cannot reset or replace an existing owner. Protect access to container logs and avoid forwarding the intentional setup message to public log destinations.

## Local Docker evaluation

For localhost-only testing use the development override:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Set `APP_ORIGIN=http://localhost:3000`. The override changes `MAILDOCK_ENV` to development and binds app port 3000 and PostgreSQL port 5432 to `127.0.0.1` only.

This override is not a production template.

## Ingress security contract

Production is safe only when all of these are true:

- the browser uses exactly the HTTPS origin configured in `APP_ORIGIN`;
- the only untrusted route to Maildock passes through the intended TLS ingress;
- the app's raw HTTP listener is not independently reachable by untrusted clients;
- PostgreSQL is not exposed to untrusted networks;
- ingress does not rewrite Maildock's security-relevant Origin semantics;
- normal connection/request limits exist at the edge;
- logs and platform inspection output are access-controlled.

Caddy, Traefik, nginx, Nginx Proxy Manager, Coolify-managed ingress and similar systems can satisfy this contract. Maildock does not require a particular proxy product.

## Platform deployments

Git-based Docker Compose platforms such as Coolify may build the stack directly from the repository. The production Compose definition is self-contained at runtime: PostgreSQL authority, maintenance and recovery helpers are baked into the Maildock PostgreSQL image instead of bind-mounted from the repository checkout. Only the named `postgres_data` and `attachments_data` volumes carry persistent application data.

For Coolify, use a Git-based Docker Compose application with the repository root as the base directory and `docker-compose.yml` as the Compose file. Configure the five deployment variables shown above in the platform, route the public domain to the `app` service on port 3000, and keep PostgreSQL private. Advanced tuning variables are intentionally absent from the base Compose interface. Repository preservation is not required for Maildock runtime file mounts.

Do not replace the named data volumes with ephemeral container storage. Platform-managed persistent storage is not a backup; keep using the matched database/blob recovery procedure described in [Backup & recovery](BACKUP_AND_RECOVERY.md).

## Existing installations from before database hardening

A PostgreSQL volume created before the database-authority hardening cannot be fixed by merely replacing the image. This is a one-time transition for old volumes, not a normal startup procedure.

With all application writers stopped and a verified matched backup available:

```sh
docker compose up -d --no-deps --force-recreate postgres
docker compose exec -T postgres sh /usr/local/bin/maildock-authority-maintenance --writers-stopped-backup-verified
docker compose up -d --no-deps --build app
```

Keep the same PostgreSQL volume and credentials. Never use `down -v` for this transition. If the helper refuses the cluster, keep the application stopped and investigate rather than trying to elevate the application role manually.

Fresh installations do not need this operation.

## Updating Maildock

Before an update:

1. restrict ingress and automatic restart/deploy automation;
2. stop/drain all application writers;
3. create and verify a complete matched recovery set as described in [Backup & recovery](BACKUP_AND_RECOVERY.md);
4. retain the old release/image and recovery helpers until the update is verified.

Then update the repository/image and run the new migrator before reopening traffic. The normal Compose image does this on startup, but production procedures may run migration separately when tighter control is required.

After startup verify:

- database authority validation succeeds;
- owner password + MFA still work;
- required encryption keys can decrypt stored state;
- referenced blobs are available;
- worker/pg-boss starts normally;
- `/api/health/ready` returns success.

Do not assume an old image can run safely against a database after forward migrations. The supported failed-upgrade path is restoring the complete pre-upgrade recovery set into fresh storage with the matching old release.

Restoring local state cannot undo mail-provider side effects that happened after the backup.

## Shutdown

The base app service uses `stop_grace_period: 60s`. Platforms that replace Compose should allow at least the same graceful-stop window.

A forced stop can leave an SMTP send, Sent-folder copy or other remote operation uncertain. Maildock records and recovery procedures are designed to avoid blindly repeating uncertain remote effects, but no SMTP exactly-once guarantee exists.

## Persistent storage

The base stack uses:

- `postgres_data` — PostgreSQL database;
- `attachments_data` — attachment, staged MIME and related blob objects.

Both are required application data. A PostgreSQL dump alone is not a complete Maildock backup.

For a host bind mount used as the attachment root, the application container runs as numeric UID/GID `1001:1001`; provide private ownership/permissions compatible with that identity.

## Health and diagnostics

```sh
docker compose ps
docker compose logs app
docker compose logs postgres
```

Health endpoints:

- `GET /api/health/live` — process liveness only;
- `GET /api/health/ready` — database/migration/storage readiness.

Application diagnostics are structured JSON on stdout/stderr. The intentional first-time setup announcement is a short plaintext message containing the temporary setup secret. Configure bounded, access-controlled container/host log retention. Mail content, secrets and arbitrary dependency errors should not appear in normal diagnostics.

Monitor PostgreSQL space/inodes/growth, attachment volume space/inodes/growth, pg-boss backlog/failures, log storage, and backup age/capacity/success. Deleting message/staged metadata does not currently guarantee immediate physical blob reclamation; do not invent age-only filesystem cleanup jobs.
