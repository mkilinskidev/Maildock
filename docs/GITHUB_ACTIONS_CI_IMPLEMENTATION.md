# GitHub Actions CI — implementation (v1.1.0, stage 1)

## Workflow

Single file: `.github/workflows/ci.yml` (workflow name `CI`).

Triggers: `pull_request` targeting `main`, `push` to `main`, `workflow_dispatch`.
No `pull_request_target`.

Concurrency group `ci-<workflow>-<PR number | ref>`; in-progress runs are
cancelled only for pull requests (a new push to the same PR supersedes the old
run). Runs on `main` and other PRs are never cancelled.

## Jobs

All jobs run directly on `ubuntu-latest` (no job container), independently of
each other. Job names are stable so they can be required status checks:

| Check name      | Timeout | Commands                                                                              |
| --------------- | ------- | ------------------------------------------------------------------------------------- |
| `Static checks` | 15 min  | `pnpm typecheck`, `pnpm lint`, `prettier --check .github`                             |
| `Tests`         | 45 min  | `env -u DATABASE_URL -u TEST_DATABASE_URL pnpm test` (all `tests/**`, incl. security) |
| `Build`         | 20 min  | `pnpm build` (Next.js standalone + worker)                                            |

Each job: `actions/checkout@v7` (`persist-credentials: false`) →
`pnpm/action-setup@v6` (version from `packageManager`: `pnpm@12.7.0`) →
`actions/setup-node@v7` (Node 24) → `pnpm install --frozen-lockfile`.
The frozen install applies `patchedDependencies` from `pnpm-workspace.yaml`
(imapflow, next, pg-boss patches) exactly as locally and in the Dockerfile. No
packages are upgraded.

`Tests` additionally runs `playwright install --with-deps --only-shell chromium`:
`tests/setup-form.test.ts`, `tests/security/mfa-ui.test.ts` and
`tests/security/mfa-management-ui.test.ts` launch headless Chromium. The
browser version is fixed by the locked `playwright@1.63.0`.

`Build` sets the same placeholders as the Dockerfile build stage
(`APP_ORIGIN=https://build.invalid`, `POSTGRES_PASSWORD=build-only-placeholder`,
`ATTACHMENTS_PATH`, production `NODE_ENV`/`MAILDOCK_ENV`) and generates
throwaway random `AUTH_SECRET` / `CREDENTIALS_ENCRYPTION_KEY` inside the step.
Without them `next build` fails during page-data collection on configuration
validation (verified locally).

## Docker / Testcontainers

- Docker Engine and Compose v2 on the hosted runner are checked first
  (`docker version`, `docker compose version`, `docker info`).
- `postgres:18.6-bookworm` (the only Testcontainers image used) is pulled
  before tests so registry latency does not consume the 120 s hook timeouts.
- Testcontainers uses the runner's default Docker socket; Ryuk and cleanup are
  left enabled. No `TESTCONTAINERS_*` overrides.
- Several integration tests reuse `TEST_DATABASE_URL` when it is set. The test
  command removes `DATABASE_URL` and `TEST_DATABASE_URL` explicitly via
  `env -u`, so every integration test gets a disposable container.
- A guard step fails if a `.env` file exists in the workspace. The repository
  ignores `.env`; no test loads `.env` files (no `dotenv`/`loadEnvFile` usage).
- `tests/security/ingress-compose.test.ts` runs `docker compose config` only
  (resolves the Compose model, starts nothing). The production stack is never
  started.
- OAuth tests stub `fetch`; no test contacts Gmail, Microsoft or any real mail
  provider. No secrets are referenced by the workflow.

No test is excluded. The production-image scripts in `tests/security/*.mjs`
are not `*.test.ts` files, are not collected by Vitest, and are not run here;
they belong to later release validation.

## Caching

`actions/setup-node` with `cache: pnpm` caches the pnpm store, keyed on the
hash of the committed `pnpm-lock.yaml`. `node_modules` is not cached; installs
are always `--frozen-lockfile`. Playwright browsers and Docker images are not
cached (simplicity over a few saved seconds).

## Security

- `permissions: contents: read` at workflow level; no job widens it.
- No secrets, deployment, publishing, tags or releases; no artifacts uploaded.
- Checkout does not persist the token in the workspace.
- Actions are official (`actions/*`) or from the pnpm organisation, pinned to
  major versions (`checkout@v7`, `setup-node@v7`, `action-setup@v6`). The
  repository had no prior pinning convention; switching to commit SHAs is a
  possible later hardening.

## Formatting

A repository-wide `pnpm format:check` gate is **not** added: it would fail
permanently on `SYNC_ENGINE_V1_AUDIT.md` and `SYNC_ENGINE_V1_PRIORITY_DESIGN.md`,
which this stage must not modify. CI checks `.github/` only. Add
`pnpm format:check` to `Static checks` after the documentation cleanup stage.

## Local validation (Windows host, Node 24.21.0, pnpm 12.7.0)

Performed in a clean detached worktree of the base commit (no `.env`):

| Check                                                          | Result                                        |
| -------------------------------------------------------------- | --------------------------------------------- |
| `pnpm install --frozen-lockfile` (patches applied)             | pass                                          |
| `pnpm typecheck`                                               | pass                                          |
| `pnpm lint`                                                    | pass                                          |
| `pnpm build` without placeholders                              | fails (expected; config validation)           |
| `pnpm build` with the workflow's placeholders                  | pass                                          |
| `prettier --check .github`                                     | pass                                          |
| YAML parse + structural script (triggers, permissions, inputs) | pass; all action inputs exist in `action.yml` |
| `bash -n` on every `run` block                                 | pass                                          |
| `git diff --check`                                             | clean                                         |

**Not run locally:** the Vitest suite. Docker Desktop was not running on the
host, and it was not started to avoid touching the live Maildock installation.
The last full local run on the base commit was 1380/1380 (see
`docs/COOPERATIVE_BACKFILL_IMPLEMENTATION.md`). `actionlint` was not available.

## Still to verify in GitHub Actions

GitHub Actions has **not** run yet. On the first run confirm:

1. All three jobs start for the PR and finish green.
2. Testcontainers starts PostgreSQL and Ryuk on the hosted runner; Playwright
   Chromium launches.
3. `Tests` duration on a 4-vCPU runner (local: 151 s on 22 cores) fits the
   45 min timeout; adjust if needed.
4. Runner timezone/locale (UTC, `en_US`) does not affect date-sensitive tests.
5. The pnpm store cache is saved on the first run and restored on the next.

Then mark `Static checks`, `Tests` and `Build` as required checks for `main`.

## First PR without merging 1.1.0 into `main`

This branch sits on `codex/v1-cooperative-backfill`, which is 9 commits ahead of
`main` (all Sync Engine v1 work), so a PR from this branch to `main` contains
the whole unfinished 1.1.0 work. That is acceptable for validation as long as
the PR is **opened as a draft and not merged** until 1.1.0 is ready. The
`pull_request` trigger runs the workflow from the PR head, so CI is validated
against the full 1.1.0 code without touching `main`. When 1.1.0 is ready, this
same PR (or the release PR that contains it) is merged; the `push` to `main`
then runs CI once more on `main`.

## Branch and commit

- Branch: `codex/v1-github-actions-ci`
- Base: `d61bbb2b5ae140a4dd7cf786d5ef43826b175d28`
- Implementation commit: `fca6b7713538b91af41d5ac6b27f1884dc933e69`
