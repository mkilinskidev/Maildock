# ADR 0011: Progressive mail storage without retained incoming raw MIME

- Status: accepted
- Date: 2026-10-07
- Supersedes: ADR 0008 raw-MIME retention decision
- Superseded by: none

## Context

Implementation proved that keeping every incoming RFC822 source is unnecessary for the chosen V1 read model and would materially increase storage. Maildock can synchronize metadata first, fetch selected display parts on demand and store sanitized/local content while attachment binaries remain on demand.

## Decision

Keep ADR 0008's 30-day configurable initial window, complete historical metadata backfill, incremental-work priority, account-scoped threading evidence and on-demand attachment binaries.

Do not retain the complete incoming RFC822 source as a general V1 storage requirement. Recent/backfill metadata synchronization does not download it. On-demand content fetch selects bounded display text/HTML parts, validates/decodes them, sanitizes HTML and stores the local display/search representation. Attachment metadata preserves the provider reference required for later binary retrieval.

Outgoing mail is different: a complete immutable MIME snapshot is deliberately persisted before queueing so SMTP delivery and optional Sent-copy use identical bytes and uncertain retries do not rebuild content.

## Consequences

Storage planning includes PostgreSQL content/search state and persistent blob objects, but not a mandatory raw source copy of every received message. Re-sanitizing historical content is limited to the source material Maildock actually retained or can safely refetch from the provider.
