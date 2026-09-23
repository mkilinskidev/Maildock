# ADR 0004: PostgreSQL background jobs with pg-boss

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

Maildock needs durable, retryable background work without Redis or another broker. The selected library must support current Node.js and PostgreSQL, concurrency, retries/backoff, crash recovery, scheduling, deduplication, transaction integration, and graceful lifecycle management.

pg-boss 12.33.7 requires Node.js 22.12+ and PostgreSQL 13+, is actively maintained, uses PostgreSQL `SKIP LOCKED`, supports retries with exponential backoff and jitter, priorities, singleton/deduplicated jobs, scheduling, dead-letter behavior, heartbeats/expiry, and insertion through application transactions.

## Decision

Use pg-boss 12.33.7 with the application PostgreSQL database. pg-boss owns and migrates its internal schema; Maildock migrations must not duplicate it. Keep job payloads versioned and runtime-validated and handlers idempotent because retryable processing can occur more than once.

The web and worker runtimes have separate composition roots. The V1 container may run both, while `MAILDOCK_ROLE` deployment configuration supports later separation without changing application modules. Worker startup probes queue metadata after `start()` and shutdown uses pg-boss graceful stop.

## Alternatives considered

- BullMQ/Redis or RabbitMQ: rejected because they add mandatory infrastructure.
- A custom PostgreSQL queue: rejected because pg-boss satisfies the required semantics.
- In-memory jobs: rejected because they are not durable or crash-safe.

## Consequences

- PostgreSQL is the only required infrastructure service.
- Queue schema changes follow pg-boss lifecycle management.
- Operators must monitor PostgreSQL load and queue retention as mail job volume grows.
