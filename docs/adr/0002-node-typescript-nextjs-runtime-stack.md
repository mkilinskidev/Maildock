# ADR 0002: Node.js, TypeScript, Next.js, React, and pnpm runtime stack

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

Maildock needs one supported TypeScript application stack for its modular monolith. Versions were verified against current package metadata and official documentation on 2026-09-23. Current jsdom requires Node.js 24.15 or newer within the Node 24 line. TypeScript 7 and ESLint 10 are current releases, but the current Next.js lint dependency graph does not yet accept those peer ranges.

## Decision

Use Node.js 24.21.0 LTS, TypeScript 6.0.3, Next.js 16.3.6, React and React DOM 19.3.0, and pnpm 12.6.0. Require Node.js `>=24.15.0 <25` and pin the container to 24.21.0. Use the Next.js App Router and a single TypeScript dependency graph.

Use ESLint 9.39.5 until the current Next.js lint plugins support ESLint 10. Package versions are exact in `package.json` and the resolved graph is committed in `pnpm-lock.yaml`.

## Alternatives considered

- TypeScript 7 and ESLint 10: deferred because their peer ranges conflict with the current Next.js lint toolchain.
- Node.js 22: rejected because Node.js 24 is the selected LTS baseline and current jsdom targets newer supported runtimes.
- Separate frontend and backend packages: rejected because they add deployment and dependency ceremony without helping the V1 modular monolith.

## Consequences

- Local and container builds use the same pinned Node.js and pnpm lines.
- Version upgrades require compatibility checks, especially for Next.js, TypeScript, ESLint, jsdom, native Argon2 bindings, and Better Auth.
- The application image can run the web and worker composition roots together or separately.
