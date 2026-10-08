# Maildock architecture

Status: **V1 candidate architecture**

Maildock is a single-owner, self-hosted web mail application. One installation has one immutable owner and any number of configured mail accounts. It is a modular TypeScript monolith with separate web and worker composition roots, deployed by default as one application container plus PostgreSQL.

Architecture Decision Records in [`docs/adr`](adr/README.md) capture durable choices. This document describes the current product, not the order in which features were implemented.

## System context

```text
Browser
   |
 HTTPS
   v
operator ingress / reverse proxy
   |
   v
Maildock application
  - Next.js UI and API
  - application/domain modules
  - web composition root
  - worker composition root
  - IMAP/SMTP adapters
  - pg-boss jobs
   |             |
   |             +---- IMAP / SMTP / OAuth providers
   |
   +---- PostgreSQL
   |
   +---- persistent blob/attachment storage
```

The PostgreSQL 18 service bundled with Maildock's official Docker Compose stack is mandatory infrastructure and part of the application security boundary. External, managed, shared, or independently provisioned PostgreSQL is explicitly unsupported: Maildock owns its database roles, ownership, authority hardening, migrations, pg-boss state, and recovery invariants. Redis, Elasticsearch, external queues and object storage are not required.

## Product boundary

Maildock is not a multi-user SaaS product. There are no organizations, tenants, roles, RBAC or per-user mail ownership columns. Authentication protects the whole instance.

V1 mail transport is IMAP + SMTP. Microsoft and Google OAuth provide credentials to that same mail pipeline; Maildock does not use Microsoft Graph or Gmail API mail endpoints.

Remote mail remains authoritative. PostgreSQL is a durable synchronized read model plus local operational state.

## Identity and persistence

Local UUIDs are stable application identity. Remote identifiers are stored separately.

- IMAP UID is scoped to `(account, mailbox, UIDVALIDITY)`.
- Sequence numbers are connection-local and never persisted as identity.
- UIDVALIDITY changes trigger controlled reconciliation.
- RFC `Message-ID` is optional, non-unique and untrusted.
- Account boundaries are mandatory; cross-account heuristic merging is prohibited.

PostgreSQL stores owner/auth state, encrypted account/provider configuration, mailboxes/messages/placements/content, sync checkpoints, drafts, conversations, signatures/preferences, outgoing state, remote commands, blob metadata, search data, diagnostics and pg-boss state. Binary attachment/MIME objects live in persistent blob storage.

Database + blob storage + cryptographic keys form one recovery boundary.

## Synchronization

Ordinary UI reads use PostgreSQL, not live IMAP.

Initial synchronization discovers mailboxes, synchronizes a configurable recent metadata window, then continues bounded historical metadata backfill. Message content is fetched on demand and persisted locally. Incremental synchronization remains higher priority than backfill.

CONDSTORE/QRESYNC are used where available. IDLE is only a wake-up hint; correctness comes from delta synchronization and periodic fallback polling. Durable job payloads use local IDs and handlers reload authoritative state before remote work.

## Actions and sending

Remote message mutations use durable command state, optional optimistic local projection and later provider reconciliation.

Compose/reply/reply-all/forward share one durable sending pipeline. A complete MIME snapshot becomes immutable before queueing. SMTP delivery and Sent-folder copy have separate states because either can become uncertain independently. Maildock does not claim universal exactly-once SMTP semantics.

## Mail features

Maildock includes local drafts, optional conversation view, PostgreSQL full-text search, rich compose/signatures, attachment handling, desktop notifications and owner diagnostics.

Received HTML is sanitized and rendered in a sandboxed iframe with CSP. Remote images are blocked by default. Incoming attachment binaries are fetched on demand; outgoing/staged blobs use bounded verified storage.

## OAuth

An OAuth provider registry isolates provider-specific authorization from generic mail behavior. Microsoft and Google both resolve to OAuth2 credentials consumed by the same IMAP/SMTP adapter. Provider configuration is installation-level database state with encrypted client secrets.

## Jobs and runtime

pg-boss uses the application PostgreSQL database and owns its internal schema. Maildock owns job payload contracts, idempotent handlers and scheduling policy.

The default image runs migrations and then both web and worker roots. Advanced deployments may use `MAILDOCK_ROLE=web|worker`.

## Security boundaries

Principal boundaries are canonical HTTPS `APP_ORIGIN`, private raw app/database networking, immutable owner + mandatory MFA, Origin/CSRF mutation checks, persistent authentication admission controls, bounded inputs, encrypted provider credentials, ordinary PostgreSQL runtime authority, isolated untrusted email HTML, safe diagnostics and matched database/blob/key recovery sets.

See [Security](SECURITY.md), [Installation](INSTALLATION.md) and [Backup & recovery](BACKUP_AND_RECOVERY.md).

## Explicit V1 non-goals

- multiple Maildock users, tenants or RBAC;
- POP3;
- Microsoft Graph or Gmail API mail transport;
- contacts/address-book management;
- calendar;
- AI features;
- mandatory Redis/external broker/search service/object storage;
- microservice decomposition;
- provider-independent exactly-once remote effects.

Future work should preserve these identity/security invariants unless a new ADR explicitly changes them.
