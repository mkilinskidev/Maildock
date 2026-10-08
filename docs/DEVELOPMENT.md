# Development

## Supported development environment

Maildock's supported complete development environment runs through Docker Compose. This is the canonical way to run the application locally.

The Docker development stack provides the components and configuration required by the application, including the bundled PostgreSQL service, database migrations, the Next.js web application, background workers and job processing, and persistent application storage.

External, locally installed, managed, or independently provisioned PostgreSQL instances are not supported. Development uses the same Maildock-managed PostgreSQL service as production because database roles, ownership, authority hardening, migrations, pg-boss state, and recovery invariants are part of the application architecture.

Do not bootstrap a fresh Maildock development environment with `pnpm db:migrate` and `pnpm dev`. `pnpm dev` starts only Next.js and does not provide the complete application runtime. Likewise, `pnpm start:worker` starts the compiled worker and is not a fresh-checkout development bootstrap command.

## Toolchain

Maildock uses Node.js 24 LTS (`>=24.15 <25`; container pins 24.21.0), pnpm 12.7.0, TypeScript 6 and PostgreSQL 18.

Docker with Docker Compose is required for both the supported development environment and the supported test environment.

For repository tooling and commands executed directly on the host:

```sh
corepack enable
corepack prepare pnpm@12.7.0 --activate
pnpm install
```

## Start Maildock locally

Copy `.env.example` to `.env` and configure the required values for the Docker development stack. Use a development origin such as `http://localhost:3000`.

Then start the complete environment:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

The base Compose file remains production-mode by design. Do not try to switch it to development through `.env`; `docker-compose.dev.yml` is the supported development override.

Use Docker Compose to inspect or stop the stack:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

The development Compose override is intended for local development only. Production deployment requirements are documented separately in [Installation](INSTALLATION.md) and [Configuration](CONFIGURATION.md).

## Testing

Docker with Docker Compose is required for the supported Maildock test environment.

The test suites run in isolated Docker containers so that contributors and CI use the same controlled runtime and service dependencies. A local PostgreSQL installation or manually configured application database is not required for the supported test workflow.

Run the standard test suite with:

```sh
pnpm test
```

Run the security test suites with:

```sh
pnpm test:security
pnpm test:security:browser
```

Owner recovery also requires verification in the final production image, including a real Docker PTY, hidden password input, safe refusal paths, process restart and fresh MFA login:

```sh
docker build -t maildock-owner-recovery:local .
node tests/security/production-runtime-dependencies.mjs maildock-owner-recovery:local
node tests/security/production-image-regression.mjs maildock-owner-recovery:local
node tests/security/owner-recovery-production-regression.mjs maildock-owner-recovery:local
MAILDOCK_RECOVERY_TEST_IMAGE=maildock-owner-recovery:local node tests/security/recovery-production-regression.mjs
```

These drills create disposable containers and synthetic data. The restore drill builds the hardened PostgreSQL image once and reuses it across its isolated Compose projects.

Docker must be installed and the Docker daemon must be running before executing the test suites.

Do not treat a locally installed PostgreSQL instance or manually started Maildock processes as the canonical test environment.

## Repository commands

Commands that can be useful directly on the host include:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm db:generate
```

`pnpm db:migrate`, `pnpm start`, and `pnpm start:worker` are runtime/operational commands used by the application and deployment workflows. They are not the supported way to assemble a fresh local development environment manually.

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
