# Maildock

Maildock is a single-user, self-hosted web application intended to bring multiple email accounts into one browser interface.

Maildock is in **early development**. Phases 0–2E provide one-owner authentication, encrypted IMAP/SMTP and Microsoft OAuth accounts, mailbox/message synchronization, isolated message reading, reply/forward, durable sending and Sent-copy, and on-demand incoming/staged outgoing attachments. See [`docs/PHASE_2E.md`](docs/PHASE_2E.md) for attachment storage, limits and acceptance scenarios.

The authoritative design is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), governed by the accepted records in [`docs/adr/`](docs/adr/).

## Requirements

- Node.js 24.15 or newer in the Node 24 LTS line (the container pins 24.21.0)
- pnpm 12.6.0 through Corepack
- PostgreSQL 18 for direct local development
- Docker for the integration tests and Docker workflow

## Configuration and secrets

Copy `.env.example` to `.env` and replace every empty secret. Generate `AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, and `MAILDOCK_BOOTSTRAP_SECRET` independently:

```sh
openssl rand -base64 32
```

Production deployments **MUST configure `MAILDOCK_BOOTSTRAP_SECRET` before exposing an uninitialized instance**. Use canonical base64 encoding of exactly 32 cryptographically random bytes (256 bits); do not use a human password. Enter it in the setup form alongside the new owner credentials. Never put it in a URL, browser storage, logs, or source control. The server retains only a SHA-256 digest in application configuration and does not store the bootstrap secret in PostgreSQL or send it to the browser. Missing configuration leaves provisioning disabled. After setup succeeds, remove the secret from deployment configuration and restart; the persisted initialized state keeps setup closed after restarts. This secret cannot reset an existing owner.

Setup accepts at most 4 KiB per request and allows 10 seconds to read the body. Before Argon2 it checks persisted initialization, bootstrap authorization, and credential bounds. Separate global PostgreSQL fixed-window counters allow five authorized attempts and thirty invalid-secret attempts per minute; invalid-secret traffic cannot consume the authorized budget. A nonblocking transaction advisory lock admits only one setup password hash across web processes. Busy attempts return HTTP 429 with a 60-second retry hint. These controls reuse authentication rate-limit storage and do not depend on client IP or proxy headers. Keep normal reverse-proxy connection/request limits in place for public deployments.

`AUTH_SECRET` must decode to at least 32 bytes. `CREDENTIALS_ENCRYPTION_KEY` must be canonical base64 for exactly 32 random bytes. `CREDENTIALS_ENCRYPTION_KEY_ID` identifies that key (start with `v1`). Do not commit `.env`, place secrets in images, reuse keys, or print them in logs. Production should inject them using a secret manager, mounted secret, or protected orchestrator secret.

Mail account passwords are encrypted with AES-256-GCM using a fresh 96-bit IV, a 128-bit authentication tag, and account/protocol-bound AAD. The JSON envelope records format version, algorithm, key ID, IV, ciphertext, and tag. IMAP and SMTP use these exact AAD formats:

```text
maildock:account-credential:v1:<account-id>:imap
maildock:account-credential:v1:<account-id>:smtp
```

**Backup warning:** `attachments_data` is now authoritative persistent application data. A complete backup requires PostgreSQL, the existing attachment volume, and the corresponding credential encryption keys/deployment secrets. A PostgreSQL backup alone is no longer complete. Preserve matched database/blob backups; keep encryption keys secure and separate. Losing the encryption keys prevents credential recovery.

For controlled future rotation, `CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS` accepts a JSON object such as `{"v1":"<old-base64-key>"}`. Keep the old key available, configure a new active key/ID, restart, re-encrypt every stored credential with fresh IVs through a reviewed operator procedure, verify it, and only then remove the old key. Phase 1A provides the multi-key decryption seam but no rotation UI or job.

`APP_ORIGIN` is the exact canonical browser origin. Production requires HTTPS. `ATTACHMENTS_PATH` must be absolute and readable/writable by Maildock.

To connect Microsoft mail accounts, register a Microsoft Entra application with a **Web** redirect URI of `${APP_ORIGIN}/api/oauth/microsoft/callback`. Enable both organizational and personal Microsoft accounts if you need Outlook.com. Add delegated Exchange Online `IMAP.AccessAsUser.All` and `SMTP.Send` permissions. Put its application (client) ID in `MICROSOFT_CLIENT_ID` and a client secret **value** in `MICROSOFT_CLIENT_SECRET`. Restart the app and worker, then sign in to Maildock and choose **Connect Microsoft account** on `/accounts`. See [`docs/PHASE_1F.md`](docs/PHASE_1F.md) for consent and verification details.

Phase 0 intentionally has no password reset flow. Until a reviewed administrative recovery procedure is added, losing the owner password can require manual operator intervention. Back up PostgreSQL and the attachment volume as one logical recovery set.

## Local development

Start PostgreSQL (or provide another PostgreSQL 18 instance), fill `.env`, then run:

```sh
corepack enable
corepack prepare pnpm@12.6.0 --activate
pnpm install
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000/setup` for first-run owner creation. After setup, sign in at `/login`; `/` is the protected mail-account list. The owner username is immutable.

Useful commands:

```sh
pnpm dev
pnpm build
pnpm start
pnpm start:worker
pnpm lint
pnpm typecheck
pnpm test
pnpm db:generate
pnpm db:migrate
```

Integration tests start a disposable PostgreSQL 18 container and require a working Docker daemon.

## Docker

For a local two-service deployment, put development values in `.env` (including `APP_ORIGIN=http://localhost:3000`) and run:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The development override binds the app and PostgreSQL only to localhost and selects development security mode. It is not a production template. The production-oriented base file contains exactly `app` and `postgres`, publishes neither service on the host, and advertises internal app port 3000 for operator-owned ingress.

Follow the [proxy-independent production ingress contract and operator checklist](docs/DEPLOYMENT.md). Coolify / Traefik, Caddy, Nginx Proxy Manager, nginx and equivalent ingress systems are examples, not dependencies. Production requires canonical HTTPS `APP_ORIGIN`, `MAILDOCK_ENV=production`, private PostgreSQL, and no alternate untrusted raw HTTP path bypassing ingress. Maildock does not trust forwarded client-address headers; F8 authentication admission is IP-independent. Network attachment, routing and actual reachability are operator responsibilities, not guarantees inferred from Docker networking.

The app entrypoint waits for Compose's PostgreSQL health check, runs migrations, then starts the web and worker composition roots. The same image can later run only one role by setting `MAILDOCK_ROLE=web` or `MAILDOCK_ROLE=worker`.

Health endpoints:

- `GET /api/health/live` checks only that the HTTP process is alive.
- `GET /api/health/ready` checks the database, migration foundation, and writable attachment storage without contacting mail providers or exposing internal errors.

Stop the stack with `docker compose -f docker-compose.yml -f docker-compose.dev.yml down`. Named PostgreSQL and attachment volumes are retained unless explicitly removed.

## Current data model

The `mail_accounts` table stores instance-owned account identity, non-secret provider settings, connection/discovery state, relevant IMAP capabilities, and JSONB encrypted password envelopes. The `mailboxes` table stores account-scoped remote observations under an independent local UUID. Neither table has `user_id`, and there are no message tables. Better Auth retains its separate infrastructure `account` table, and pg-boss manages its own schema. See [`docs/PHASE_1B.md`](docs/PHASE_1B.md) for identity, lifecycle, and manual verification details.

## Mail accounts and connection testing

The owner can add, edit, enable/disable, retest, and delete accounts from `/`. Saving does not require a successful connection test: this deliberately permits configuration while a self-hosted provider is temporarily unavailable, and the account remains clearly unverified. Connection tests authenticate to IMAP and call SMTP verification without sending mail. TLS certificates and hostnames remain validated; STARTTLS mode requires a successful upgrade and never downgrades to plaintext.

Stored passwords are never returned to the browser. An empty password field on edit preserves its encrypted envelope; entering a replacement creates new ciphertext with a fresh random IV.

Enabled accounts schedule mailbox discovery after the account transaction commits. The UI shows pending/running/failure state, retains the previous hierarchy after temporary failures, and allows rediscovery. Start the worker (`pnpm start:worker`) alongside a production web process; `pnpm dev` by itself does not execute durable discovery jobs.
