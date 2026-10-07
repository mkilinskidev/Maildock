# Contributing

Maildock is approaching its first stable release. Before proposing changes, read [Architecture](docs/ARCHITECTURE.md), [Development](docs/DEVELOPMENT.md), the security documentation and [ADRs](docs/adr/README.md).

Keep changes focused. Preserve the single-owner architecture, account/IMAP identity boundaries, local-read-model design and established security boundaries unless a change deliberately introduces and documents a new architecture decision.

For code changes run relevant focused tests plus:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Security-sensitive changes should also run `pnpm test:security`. Integration/security tests may require Docker.

Do not commit `.env`, credentials, OAuth tokens, mail data, backup archives or private diagnostic artifacts. Dependency patches are intentional; read [Dependency patches](docs/DEPENDENCY_PATCHES.md) before upgrading a patched package.
