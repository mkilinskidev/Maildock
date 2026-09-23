# ADR 0003: PostgreSQL persistence with Drizzle

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

Maildock needs transactional relational storage, explicit SQL capabilities, reproducible migrations, and a TypeScript query layer without hiding PostgreSQL semantics. PostgreSQL 18.6 is the current supported minor release of the current major line. Drizzle ORM 0.45.3 and Drizzle Kit 0.31.11 support PostgreSQL and the selected Better Auth adapter.

## Decision

Use PostgreSQL 18.6, Drizzle ORM 0.45.3, Drizzle Kit 0.31.11, and postgres.js 3.4.9. Commit generated SQL migrations and apply them explicitly before process startup.

PostgreSQL-specific features are allowed where they improve correctness or performance, including transactions, `ON CONFLICT`, full-text search, GIN indexes, row/advisory locking, `SKIP LOCKED`, and cursor pagination. Do not put a generic repository abstraction in front of PostgreSQL merely to conceal the selected database.

## Alternatives considered

- A database-neutral repository layer: rejected because it would obscure capabilities the architecture intentionally relies on.
- Prisma: not selected because direct SQL visibility and PostgreSQL-specific operations are central requirements.
- Handwritten migrations only: rejected as the default because Drizzle Kit provides schema-derived, reviewable SQL; deliberate SQL amendments remain allowed.

## Consequences

- PostgreSQL is a product dependency, not an interchangeable implementation detail.
- Migrations remain reviewable and reproducible.
- Foundation migrations contain authentication/initialization tables only. Mail-domain schema is deferred.
