# Maildock

Lost owner password or MFA material? A host administrator can run `docker compose exec app maildock owner-recovery`. It preserves the owner and mail data, revokes existing authentication, and requires new MFA. See [operator recovery](docs/INSTALLATION.md#break-glass-owner-recovery).

Maildock is a single-owner, self-hosted web mail client for managing multiple email accounts from one browser interface.

It keeps a local PostgreSQL read model for fast browsing and search while IMAP/SMTP providers remain authoritative for mail. Maildock supports standard IMAP/SMTP accounts plus OAuth for Microsoft and Google accounts, durable background synchronization and sending, attachments, local drafts, conversations, rich HTML mail, signatures, search, notifications, and account diagnostics.

> **Release status:** the V1 feature set is frozen and the first security-remediation pass is complete. Final release validation is still in progress; do not treat the current branch as a published stable release yet.

## Quick start for local evaluation

You need Docker with Docker Compose.

1. Clone the repository and create your local environment file:

   ```sh
   cp .env.example .env
   ```

2. In `.env`, set:

   ```dotenv
   APP_ORIGIN=http://localhost:3000
   POSTGRES_PASSWORD=<strong-random-password>
   AUTH_SECRET=<base64-random-secret>
   CREDENTIALS_ENCRYPTION_KEY=<base64-32-byte-key>
   ```

   Generate each of the two base64 secrets independently:

   ```sh
   openssl rand -base64 32
   ```

3. Build and start the local stack:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
   ```

4. Open the app container logs and copy the generated **Setup secret**:

   ```sh
   docker compose logs app
   ```

5. Open `http://localhost:3000/setup`, enter that secret, and create the owner. Sign in, complete mandatory TOTP enrollment using the same setup secret, and save the recovery codes outside Maildock. Keep the temporary setup secret until MFA enrollment is complete; it is permanently disabled then.

6. Sign in at `http://localhost:3000/login` and add an account from **Settings → Accounts**.

Stop the local stack with:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

The named PostgreSQL and attachment volumes are retained. **Do not add `-v` unless you intentionally want to destroy all Maildock data.**

For a real server, do not use the development override. Read [Installation & deployment](docs/INSTALLATION.md) first.

## Documentation

- [Installation & deployment](docs/INSTALLATION.md) — fresh Docker deployment, first-run setup, HTTPS/ingress, updates, health checks.
- [Configuration](docs/CONFIGURATION.md) — environment variables, secrets, limits, tuning.
- [OAuth providers](docs/OAUTH.md) — Microsoft and Google application setup.
- [Backup & recovery](docs/BACKUP_AND_RECOVERY.md) — the supported matched backup set, restore procedure, post-restore security maintenance.
- [Security model](docs/SECURITY.md) — owner authentication, mandatory MFA, credential protection, network and content boundaries.
- [Architecture](docs/ARCHITECTURE.md) — current V1 system design and data/identity rules.
- [Development](docs/DEVELOPMENT.md) — local toolchain, commands, tests and repository structure.
- [Dependency patches](docs/DEPENDENCY_PATCHES.md) — why Maildock carries pinned package patches.
- [Architecture Decision Records](docs/adr/README.md) — durable design decisions.

Security-development reports and phase-by-phase implementation notes were intentionally removed from the current documentation surface. Their history remains available in Git; the files above describe the product as it exists now.

## Production shape

The supported base deployment has exactly two required services:

```text
Internet
   |
 HTTPS
   v
operator-managed reverse proxy / ingress
   |
   v
Maildock app  ---> IMAP / SMTP providers
   |
   +---- PostgreSQL
   |
   +---- attachment volume
```

The base `docker-compose.yml` publishes neither the app nor PostgreSQL on the host. Production requires HTTPS at the canonical `APP_ORIGIN` and a private path from ingress to the app. PostgreSQL must not be Internet-accessible.

The application image starts migrations, the web process, and the background worker. The same image can run only `web` or `worker` with `MAILDOCK_ROLE` in custom deployments, but the base V1 stack runs both together.

## Core characteristics

- One immutable Maildock owner per installation; no registration, tenants, roles or RBAC.
- Mandatory TOTP MFA with recovery codes.
- Multiple IMAP/SMTP accounts with encrypted passwords/tokens.
- Microsoft 365 / Outlook.com and Gmail / Google Workspace OAuth through the same IMAP/SMTP mail pipeline.
- Progressive synchronization: recent mail first, historical metadata backfill afterwards, incremental synchronization prioritized over backfill.
- PostgreSQL-backed durable jobs through pg-boss.
- Local full-text search across synchronized mail.
- Durable message actions and outgoing mail with explicit uncertainty handling.
- Persistent attachment/blob storage separate from PostgreSQL.
- Rich received HTML isolated in a sandboxed iframe; remote images are blocked by default.
- Rich compose, signatures, local drafts, conversation view, desktop notifications and diagnostics.
- Structured operational logs with secret-safe diagnostic boundaries.

## Health endpoints

- `GET /api/health/live` — HTTP process liveness.
- `GET /api/health/ready` — database, migration foundation and writable attachment storage readiness.

Readiness intentionally does not contact remote mail providers.

## Technology

Maildock currently pins Node.js 24.21.0 in the container and pnpm 12.7.0. The application uses TypeScript, Next.js, React, PostgreSQL 18, Drizzle ORM, pg-boss, Better Auth, ImapFlow, Nodemailer and MailParser.

For direct development use Node.js 24 LTS (`>=24.15 <25`), pnpm 12.7.0, PostgreSQL 18 and Docker for integration/security tests.

## License

No open-source license is currently declared. Until a license is added, normal copyright rules apply.
