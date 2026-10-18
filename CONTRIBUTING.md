# Contributing

Before proposing changes, read [Architecture](docs/ARCHITECTURE.md), [Development](docs/DEVELOPMENT.md), the security documentation and [ADRs](docs/adr/README.md).

Preserve the single-owner architecture, account/IMAP identity boundaries, local-read-model design and established security boundaries unless a change deliberately introduces and documents a new architecture decision.

## Contribution process

1. Work on a dedicated branch.
2. Keep changes focused on one purpose.
3. Run the relevant local validation (below).
4. Open a pull request against `main`.
5. Review the CI results and fix failures.
6. Merge after appropriate review and passing validation.

## Local validation

Run focused tests for the area you changed, plus:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm test` needs Docker. Unset `DATABASE_URL` and `TEST_DATABASE_URL` first so tests use disposable containers and never an existing database; see [Development](docs/DEVELOPMENT.md#tests-and-database-isolation). Security-sensitive changes should also be covered by tests in `tests/security`, and changes to the Dockerfile, owner recovery or backup tooling should run the production-image scripts described in [Development](docs/DEVELOPMENT.md#additional-security-checks).

## Continuous integration

GitHub Actions runs three jobs on pull requests to `main`:

- `Static checks`: type checking, linting and repository-wide formatting.
- `Tests`: the full Vitest suite, including security tests, against disposable PostgreSQL containers.
- `Build`: the production build.

CI only validates; it does not deploy or publish anything. See [Development](docs/DEVELOPMENT.md#continuous-integration) for details and for interpreting failures.

## What not to commit

Do not commit `.env`, credentials, OAuth tokens, mail data, backup archives or private diagnostic artifacts. Dependency patches are intentional; read [Dependency patches](docs/DEPENDENCY_PATCHES.md) before upgrading a patched package.
