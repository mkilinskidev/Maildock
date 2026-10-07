# Installation & deployment

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

At minimum set a canonical HTTPS origin and four independent secrets:

```dotenv
MAILDOCK_ENV=production
APP_ORIGIN=https://mail.example.com
POSTGRES_PASSWORD=<strong-random-password>
AUTH_SECRET=<base64-random-secret>
MAILDOCK_BOOTSTRAP_SECRET=<base64-32-byte-secret>
CREDENTIALS_ENCRYPTION_KEY=<base64-32-byte-key>
CREDENTIALS_ENCRYPTION_KEY_ID=v1
```

Generate `AUTH_SECRET`, `MAILDOCK_BOOTSTRAP_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` independently. The following produces the required 32 random bytes in canonical base64:

```sh
openssl rand -base64 32
```

Protect `.env` as a secret. Do not commit it, bake it into an image, paste it into logs, or expose rendered `docker compose config` output.

Build and start the stack:

```sh
docker compose up -d --build
docker compose ps
```

The PostgreSQL init path creates the hardened database authority model before normal application startup. The app waits for PostgreSQL health, validates database authority, runs migrations, then starts web and worker processes.

Configure your reverse proxy/ingress so that the public HTTPS origin in `APP_ORIGIN` reaches the app's internal port 3000. Do not create a second untrusted raw HTTP route to the app. Maildock deliberately does not trust forwarded client-IP headers for authentication decisions.

### First-run owner setup

Open:

```text
https://mail.example.com/setup
```

The setup form requires the bootstrap secret plus the new owner credentials. Setup is single-owner and closes permanently after successful initialization.

Immediately complete the mandatory TOTP enrollment and save the generated recovery codes outside Maildock.

After setup:

1. remove `MAILDOCK_BOOTSTRAP_SECRET` from deployment configuration;
2. recreate/restart the app so the secret is no longer present in its environment;
3. verify sign-in with password + TOTP;
4. verify `/api/health/ready`;
5. configure mail accounts and OAuth providers as required.

The bootstrap secret cannot reset or replace an existing owner.

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

For Coolify, use a Git-based Docker Compose application with the repository root as the base directory and `docker-compose.yml` as the Compose file. Configure the required environment variables in the platform, route the public domain to the `app` service on port 3000, and keep PostgreSQL private. Repository preservation is not required for Maildock runtime file mounts.

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

Application logs are structured JSON on stdout/stderr. Configure bounded, access-controlled container/host log retention. Mail content, secrets and arbitrary dependency errors should not appear in normal diagnostics.

Monitor PostgreSQL space/inodes/growth, attachment volume space/inodes/growth, pg-boss backlog/failures, log storage, and backup age/capacity/success. Deleting message/staged metadata does not currently guarantee immediate physical blob reclamation; do not invent age-only filesystem cleanup jobs.
