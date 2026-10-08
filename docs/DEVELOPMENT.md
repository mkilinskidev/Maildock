# Development

## Toolchain

Maildock uses Node.js 24 LTS (`>=24.15 <25`; container pins 24.21.0), pnpm 12.7.0, TypeScript 6 and PostgreSQL 18. Docker is required for integration/security tests.

```sh
corepack enable
corepack prepare pnpm@12.7.0 --activate
pnpm install
```

## Local application

Maildock development uses the same bundled PostgreSQL service as production. External/local independently managed PostgreSQL instances are unsupported. Copy `.env.example` to `.env`, use a development origin such as `http://localhost:3000`, and start the complete stack with:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

The base Compose file remains production-mode by design. Do not try to switch it to development through `.env`; `docker-compose.dev.yml` is the supported development override.

## Commands

```sh
pnpm dev
pnpm build
pnpm start
pnpm start:worker
pnpm typecheck
pnpm lint
pnpm test
pnpm test:security
pnpm test:security:browser
pnpm db:generate
pnpm db:migrate
pnpm format:check
```

## Repository layout

```text
src/          application, UI, modules, infrastructure and composition roots
db/           forward SQL migrations and Drizzle metadata
scripts/      container and PostgreSQL operator helpers
patches/      pinned pnpm dependency patches
tests/        unit/integration/browser/security tests
docs/         current product/operator/developer documentation
docs/adr/     architecture decision records
```

Historical migrations are immutable. Add a new migration instead of editing deployed history. pg-boss owns its own schema.

Use [Architecture](ARCHITECTURE.md) and the ADRs as design authority. Preserve account/mailbox/UIDVALIDITY identity boundaries, local UI reads, retry-safe jobs, secret-safe logs, isolated email HTML and single-owner semantics.

The `tests/security` suite is permanent regression coverage even though historical finding reports are no longer part of the current docs tree.

Dependency patches are intentional production behavior. Read [Dependency patches](DEPENDENCY_PATCHES.md) before upgrading a patched package.
