# Maildock

Maildock is a single-user, self-hosted web application intended to bring multiple email accounts into one browser interface.

Maildock is in **early development**. Phase 0 provides the application skeleton, one-owner setup/login, PostgreSQL migrations, health checks, a pg-boss worker lifecycle, and Docker deployment foundations. It does **not** yet synchronize mail, manage IMAP/SMTP accounts, send messages, fetch attachments, search mail, or render message content.

The authoritative design is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), governed by the accepted records in [`docs/adr/`](docs/adr/).

## Requirements

- Node.js 24.15 or newer in the Node 24 LTS line (the container pins 24.21.0)
- pnpm 12.6.0 through Corepack
- PostgreSQL 18 for direct local development
- Docker for the integration tests and Docker workflow

## Configuration and secrets

Copy `.env.example` to `.env` and replace every empty secret. Generate `AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` independently:

```sh
openssl rand -base64 32
```

`AUTH_SECRET` must decode to at least 32 bytes. `CREDENTIALS_ENCRYPTION_KEY` must decode to exactly 32 bytes. Do not commit `.env`, place secrets in images, reuse keys, or print them in logs. Production should inject them using a secret manager or protected orchestrator secret. Back up the credential key separately and securely; losing it will make future stored mail-account credentials unrecoverable.

`APP_ORIGIN` is the exact canonical browser origin. Production requires HTTPS. `ATTACHMENTS_PATH` must be absolute and readable/writable by Maildock.

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

Open `http://localhost:3000/setup` for first-run owner creation. After setup, sign in at `/login`; `/` is protected. The owner username is immutable in the Phase 0 foundation.

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

The development override binds the app and PostgreSQL only to localhost. The production-oriented base file contains exactly `app` and `postgres`, does not publish PostgreSQL, and only exposes the app port to its private Compose network for an external reverse proxy.

The app entrypoint waits for Compose's PostgreSQL health check, runs migrations, then starts the web and worker composition roots. The same image can later run only one role by setting `MAILDOCK_ROLE=web` or `MAILDOCK_ROLE=worker`.

Health endpoints:

- `GET /api/health/live` checks only that the HTTP process is alive.
- `GET /api/health/ready` checks the database, migration foundation, and writable attachment storage without contacting mail providers or exposing internal errors.

Stop the stack with `docker compose -f docker-compose.yml -f docker-compose.dev.yml down`. Named PostgreSQL and attachment volumes are retained unless explicitly removed.

## Current data model

The only application migration contains the singleton instance state, Better Auth infrastructure tables, and login-throttling state. pg-boss manages its own schema. There are no mail-domain tables and no mail-domain `user_id` ownership columns.
