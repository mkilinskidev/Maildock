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

## Validation

### Local commands

Run these from the repository root with the toolchain from [Toolchain](#toolchain). Only the tests need Docker.

| Check            | Command             | Notes                                                                                 |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------- |
| Type checking    | `pnpm typecheck`    | Application and worker TypeScript projects (`tsc --noEmit`).                          |
| Linting          | `pnpm lint`         | ESLint over the repository.                                                           |
| Formatting       | `pnpm format:check` | Prettier check of the whole repository. Fix with `pnpm exec prettier --write <path>`. |
| Tests            | `pnpm test`         | Full Vitest suite, including `tests/security`. Requires Docker.                       |
| Production build | `pnpm build`        | Next.js build plus the worker. Needs a valid build-time environment (see below).      |

`pnpm build` validates configuration, so it needs a valid environment. Use placeholder values in a throwaway shell, never your real `.env` values:

```sh
# Bash
export NODE_ENV=production MAILDOCK_ENV=production APP_ORIGIN=https://build.invalid \
  POSTGRES_PASSWORD=build-only-placeholder ATTACHMENTS_PATH=/tmp/maildock-attachments
export AUTH_SECRET="$(openssl rand -base64 32)" CREDENTIALS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
env -u DATABASE_URL -u TEST_DATABASE_URL pnpm build
```

```powershell
# PowerShell
$env:NODE_ENV = "production"; $env:MAILDOCK_ENV = "production"
$env:APP_ORIGIN = "https://build.invalid"; $env:POSTGRES_PASSWORD = "build-only-placeholder"
$env:ATTACHMENTS_PATH = Join-Path $env:TEMP "maildock-attachments"
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes); $env:AUTH_SECRET = [Convert]::ToBase64String($bytes)
$rng.GetBytes($bytes); $env:CREDENTIALS_ENCRYPTION_KEY = [Convert]::ToBase64String($bytes)
Remove-Item Env:DATABASE_URL, Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
pnpm build
```

`ATTACHMENTS_PATH` must be an absolute path.

### Tests and database isolation

Docker must be installed and the daemon running. Integration tests start disposable PostgreSQL containers (`postgres:18.6-bookworm`) through Testcontainers, so no local PostgreSQL installation is needed.

Some integration tests reuse an existing database when `TEST_DATABASE_URL` is set, and the configuration loader accepts `DATABASE_URL` in test mode. **If you maintain a live local Maildock installation, make sure neither variable points at it.** Unset both before running the suite so every test creates its own container and never connects to an existing database:

```sh
# Bash
env -u DATABASE_URL -u TEST_DATABASE_URL pnpm test
```

```powershell
# PowerShell (affects the current session only)
Remove-Item Env:DATABASE_URL, Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
pnpm test
```

While iterating, run a single file, for example `pnpm exec vitest run tests/cooperative-backfill.integration.test.ts`, with the same variables unset. Container startup makes the full suite slow; hooks and tests have a 120 s timeout.

### Additional security checks

`pnpm test:security` runs only the `tests/security` Vitest files, which `pnpm test` already includes. `pnpm test:security:browser` is a standalone harness that uses local fixture servers and Playwright Chromium (`pnpm exec playwright install chromium`); it does not connect to a Maildock deployment.

Owner recovery and the production image are verified by separate scripts that need a Docker image built from this checkout. They are not part of `pnpm test`, and GitHub Actions does not run them:

```sh
docker build -t maildock-owner-recovery:local .
node tests/security/production-runtime-dependencies.mjs maildock-owner-recovery:local
node tests/security/production-image-regression.mjs maildock-owner-recovery:local
node tests/security/owner-recovery-production-regression.mjs maildock-owner-recovery:local
MAILDOCK_RECOVERY_TEST_IMAGE=maildock-owner-recovery:local node tests/security/recovery-production-regression.mjs
```

These drills create disposable containers and synthetic data. Run them for changes to the Dockerfile, runtime dependencies, owner recovery or backup/restore tooling.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests targeting `main`, on pushes to `main`, and manually (`workflow_dispatch`). A newer run for the same pull request supersedes an older one. The workflow has read-only repository permissions and uses no secrets. It only validates: it does not deploy, publish images or create releases.

Every job uses Node.js 24 and the pnpm version from `packageManager` in `package.json`, and installs with `pnpm install --frozen-lockfile`. The install therefore fails if `pnpm-lock.yaml` does not match `package.json`.

| Job             | What it validates                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Static checks` | `pnpm typecheck`, `pnpm lint` and `pnpm format:check`.                                                                                                                                                                                                                                 |
| `Tests`         | The full `pnpm test` suite, including `tests/security`. The job installs Playwright Chromium, verifies Docker, pre-pulls the PostgreSQL image, fails if a `.env` file exists, and removes `DATABASE_URL` and `TEST_DATABASE_URL` so only disposable Testcontainers PostgreSQL is used. |
| `Build`         | `pnpm build` in production mode with non-secret placeholder configuration and throwaway random keys, mirroring the Dockerfile build stage.                                                                                                                                             |

To interpret a failed check, open the failed job and read the first failing step:

- **Static checks.** Run the matching local command. For formatting, run `pnpm format:check`, then `pnpm exec prettier --write` on the files it lists.
- **Tests.** Find the failing test file in the Vitest output and rerun it locally with the variables unset. Failures while pulling an image or starting a container indicate a Docker or registry problem rather than a code problem; rerun the job once before investigating further.
- **Build.** Reproduce with the build commands above. Install failures usually mean the lockfile is out of date.

## Repository commands

Validation commands are described under [Validation](#validation). `pnpm db:generate` creates a migration after a schema change.

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

The `tests/security` suite is permanent regression coverage for the boundaries described in [Security](SECURITY.md).

Dependency patches are intentional production behavior. Read [Dependency patches](DEPENDENCY_PATCHES.md) before upgrading a patched package.
