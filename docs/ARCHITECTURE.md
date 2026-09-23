# Maildock Architecture

Status: **V1 architecture baseline**

Audience: contributors and coding agents implementing Maildock

Decision authority: this document is the source of truth for V1 unless an explicit architecture decision record (ADR) changes it

## 1. Product goal

Maildock is a single-user, self-hosted web mail application that aggregates any number of email accounts into one browser-based interface. One Maildock installation has one owner and unlimited configured mail accounts. It synchronizes mail into a local database so normal browsing and search do not depend on live IMAP requests.

Maildock is not a multi-user SaaS product. It has no organizations, tenants, roles, RBAC, public registration, or per-user mail ownership. Authentication protects access to the whole instance and is separate from ownership in the mail domain.

```text
Maildock instance
├── MailAccount
│   ├── Mailbox
│   └── ...
├── MailAccount
└── MailAccount
```

V1 is a modular monolith written in TypeScript and running on Node.js 24 LTS. The web stack is Next.js with React and pnpm manages the single dependency graph, as recorded in ADR 0002. Deployment is Docker-first: one Maildock application image/container plus one PostgreSQL container managed by Docker Compose. PostgreSQL is the only required infrastructure dependency.

## 2. V1 scope and non-goals

### In scope

- Add, configure, disable, and remove multiple IMAP/SMTP accounts.
- Unified inbox across enabled accounts.
- Per-account and per-folder message views.
- Message list and message detail views.
- Read/unread state.
- Move, archive, delete, and restore where the remote provider supports the operation.
- Compose, reply, reply-all, and forward through SMTP.
- Upload, download, and display attachments safely.
- Incremental background IMAP synchronization into PostgreSQL.
- Search over locally synchronized message metadata and body text.
- Operational visibility sufficient to diagnose account and synchronization failures.

### Explicitly out of scope for the MVP

- Gmail API integration.
- Microsoft Graph integration.
- POP3.
- AI features.
- Contacts/address-book management.
- Calendar features.
- Mandatory Redis, external message brokers, Elasticsearch, or object storage.
- Splitting the application into independently deployed services.
- Multiple Maildock users, organizations, tenants, roles, or RBAC.
- Public user registration.
- TOTP two-factor authentication (the authentication design retains an extension point for it).

These exclusions are boundaries, not placeholders to implement speculatively.

## 3. Architectural principles

1. **Domain code does not depend on protocols or frameworks.** IMAP, SMTP, Next.js, PostgreSQL, the job runner, and file storage are adapters around application use cases.
2. **Local data powers the UI.** Reads for mailbox views, message details, counters, and search come from PostgreSQL. Live provider calls happen in synchronization and command workflows, not during ordinary page rendering.
3. **Remote state remains authoritative for mail.** The local database is a durable synchronized model plus local operational state. Conflicts are reconciled explicitly during sync.
4. **Account boundaries are mandatory.** Every remote mailbox, message, attachment, cursor, and command is associated with an account. Remote identifiers are never treated as globally unique.
5. **Background work is durable and idempotent.** Jobs reside in PostgreSQL and may run more than once. Handlers must safely retry.
6. **Security is a design constraint.** Credentials and OAuth tokens are encrypted at rest; mail HTML and attachments are untrusted input.
7. **Extraction seams exist from day one.** Queue, worker execution, providers, and attachment storage use explicit ports so they can later move to separate processes or services without redesigning the domain.
8. **Module boundaries are important; ceremony is not a goal.** Use ports and adapters where they protect meaningful boundaries such as mail providers, storage, jobs, encryption, and external infrastructure. Do not require a `Command`/`CommandHandler`/`DTO`/`RepositoryPort`/`RepositoryAdapter` chain for every trivial database operation or add layers that only forward arguments. Prefer the simplest implementation that preserves useful application/domain/infrastructure separation.

## 4. System context and deployment

Production topology:

```text
Internet
   |
   | HTTPS :443
   v
Reverse proxy (deployment concern; for example Caddy or Traefik)
   |
   | private/internal connection
   v
Maildock application container
  - Next.js web UI and HTTP endpoints
  - application/domain modules
  - IMAP/SMTP adapters
  - PostgreSQL job workers
  - scheduled job enqueuer
   |                     |
   | private Docker      | IMAP / SMTP over TLS
   | network             |
   v                     v
PostgreSQL container     Mail providers
   |
Docker volume: database data

Maildock application container
   |
Docker volume: attachment objects
```

The V1 image starts both the web process and the background worker runtime under one application lifecycle. The code must keep HTTP handling and job execution as separate composition roots even when they run in one container. A later deployment may start the same image with `web` or `worker` roles.

Docker Compose must define exactly two required services:

- `app`: the Maildock image, with an attachment volume mounted at a stable path.
- `postgres`: a supported PostgreSQL release with a persistent data volume and a health check.

PostgreSQL must not publish a port to the public Internet. In production, the application port should not be exposed directly to the Internet either: public traffic terminates TLS at a reverse proxy, which reaches the app over a private/internal connection, and the app reaches PostgreSQL only over the private Docker network. A reverse proxy is deployment infrastructure and is not a mandatory third service in the base Maildock Compose file. Development may publish the app and database ports to localhost where useful, with clearly development-only configuration.

Startup must wait for a healthy database, run schema migrations once using an explicit migration command or guarded entrypoint step, and then start the application. Do not rely on container startup order alone. The application should expose a liveness endpoint and a readiness endpoint that verifies required dependencies without contacting mail providers.

## 5. Codebase shape

Use a single repository and a single TypeScript dependency graph. Keep module boundaries visible in directories and imports rather than creating premature packages.

```text
src/
  app/                         # Next.js routes, layouts, and React UI
  modules/
    auth/
      application/
      infrastructure/
    accounts/
      domain/
      application/
      infrastructure/
    mail/
      domain/
      application/
      infrastructure/
    sync/
      domain/
      application/
      infrastructure/
    sending/
      domain/
      application/
      infrastructure/
    attachments/
      domain/
      application/
      infrastructure/
    search/
      application/
      infrastructure/
    jobs/
      application/
      infrastructure/
    platform/
      infrastructure/
  shared/
    domain/
    application/
    infrastructure/
  composition/
    web.ts
    worker.ts
db/
  migrations/
docs/
  ARCHITECTURE.md
  adr/
```

Rules:

- `domain` contains entities, value objects, domain services, events, and port interfaces where a genuine domain boundary exists. It imports no Next.js, database client, IMAP/SMTP library, filesystem, or job library.
- `application` contains use cases, transaction boundaries, authenticated-access checks, necessary boundary DTOs, and orchestration. It depends on domain/application ports for meaningful substitutable boundaries, but does not require a repository interface for every simple module-local query.
- `infrastructure` implements ports for PostgreSQL, protocols, encryption, storage, logging, and jobs.
- UI and route handlers call application use cases. They do not query infrastructure adapters directly.
- Cross-module access goes through an exported application API or explicit port. Do not import another module's database implementation or private domain objects.
- Composition roots are the only places that instantiate concrete adapters.
- These boundaries do not mandate one class or interface per operation. Direct, module-local database access from a focused application service is acceptable when no meaningful substitution or policy boundary is lost.

## 6. Bounded modules and ownership

| Module      | Owns                                                                            | Does not own                                     |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Accounts    | Account lifecycle, provider configuration, encrypted secrets, connection status | Messages or synchronization cursors              |
| Mail        | Mailboxes, messages, message state, threads/conversation projection             | Protocol connections and job scheduling          |
| Sync        | Sync cursors, reconciliation policy, sync runs, remote change ingestion         | UI queries and credential storage implementation |
| Sending     | Draft/send commands, MIME construction, SMTP delivery status                    | Inbox synchronization                            |
| Attachments | Attachment metadata, object keys, storage port, safe streaming                  | Message rendering                                |
| Search      | PostgreSQL search documents and query semantics                                 | Remote provider search                           |
| Jobs        | Durable job records, leases, retries, schedules, dead-letter state              | Domain-specific job logic                        |

## 7. Provider abstraction

The application-facing abstraction is `MailProvider`. Provider selection belongs to the Accounts module. IMAP/SMTP is the only V1 implementation, but the contract must not expose library-specific connection objects or IMAP sequence numbers.

```ts
interface MailProvider {
  testConnection(account: ProviderAccount): Promise<ConnectionReport>;
  listMailboxes(account: ProviderAccount): Promise<RemoteMailbox[]>;
  getMailboxDelta(input: MailboxDeltaRequest): Promise<MailboxDelta>;
  fetchMessages(input: FetchMessagesRequest): Promise<RemoteMessage[]>;
  fetchAttachment(input: FetchAttachmentRequest): Promise<RemoteBinaryStream>;
  applyCommand(command: RemoteMailCommand): Promise<RemoteCommandResult>;
  sendMessage(message: OutgoingMessage): Promise<SendResult>;
}
```

The concrete `ImapSmtpMailProvider` may internally separate IMAP reads/commands and SMTP sending. Future Gmail API and Microsoft Graph adapters must implement equivalent application semantics. Capabilities are reported explicitly, for example archive support, server-side move, flags, and provider-specific delta quality. Use capability checks rather than provider-name conditionals outside the adapter.

## 8. Core data model

Use UUIDs (or another application-generated opaque identifier chosen once during implementation) for local primary keys. Store provider identifiers separately. All timestamps are UTC. Database tables use foreign keys and deliberate cascade/restrict behavior.

The schema has no `user_id`, tenant, organization, role, or per-user visibility columns. Mail records belong to configured mail accounts within the one Maildock instance. Account foreign keys preserve provider identity and data integrity; they do not represent Maildock-user ownership.

### Required aggregates and records

`instance_state` and Better Auth infrastructure tables

- singleton initialization state in `instance_state`
- the owner's unique username and Argon2id credential in Better Auth's internal user/account tables
- password algorithm/parameter metadata on the singleton state; the encoded Argon2id hash also carries its parameters
- opaque server-side sessions, idle and absolute expiry, revocation, login throttling, and verification infrastructure required by Better Auth

These records implement access to the instance and are not foreign-key owners of mail-domain rows.

`accounts`

- local `id`
- display name and email address
- provider type (`imap_smtp` in V1)
- encrypted connection/authentication payload reference or ciphertext envelope
- enabled state and lifecycle status
- last successful connection time and sanitized error summary
- created/updated timestamps

`mailboxes`

- local `id`, `account_id`
- remote mailbox identifier/path and delimiter
- display name
- normalized role when known: inbox, sent, drafts, trash, archive, junk, custom
- subscribed/selectable flags
- UIDVALIDITY, UIDNEXT, highest known MODSEQ when available
- last successful sync time
- uniqueness on `(account_id, remote_mailbox_id)`

`messages`

- local `id`, `account_id`
- stable provider message identifier when available
- RFC `Message-ID` as optional header data, never as the primary key
- subject, sender, recipients, reply-to
- sent/received/internal dates
- normalized preview and searchable plain text
- sanitized HTML or a reference to sanitized render content; raw source is never rendered
- size, attachment indicator
- created/updated timestamps

`mailbox_messages`

- `mailbox_id`, `message_id`
- remote UID scoped to the mailbox
- flags such as seen, answered, flagged, deleted, draft
- remote modification marker when available
- uniqueness on `(mailbox_id, remote_uid)`

This association is required because IMAP UIDs are mailbox-scoped and a message may appear under different provider semantics. Do not identify a message using UID alone.

`attachments`

- local `id`, `message_id`
- MIME part identifier, filename, media type, size, content ID, inline flag
- remote/MIME part reference sufficient for a later provider fetch
- optional opaque storage key and checksum once cached
- binary storage state, including `remote_not_cached`, `fetching`, `cached`, and failure/quarantine states as needed

`sync_states` / `sync_runs`

- per-account and per-mailbox cursor/checkpoint data
- recent-window and historical-backfill phase/progress data sufficient to resume work and report progress
- state: queued, running, succeeded, partial, failed
- lease/attempt data, started/finished times, sanitized diagnostics

`outbox_messages`

- local `id`, `account_id`
- immutable send payload or reference after submission
- status: draft, queued, sending, sent, retryable_failed, permanently_failed
- idempotency key, attempt count, next attempt time, sanitized error
- remote sent-message identifiers when learned

`pg-boss` internal schema

- pg-boss owns and migrates its internal job, queue, schedule, lease/retry, and retention records
- Maildock owns versioned runtime-validated payload contracts, idempotent handlers, and sanitized diagnostics
- application migrations do not duplicate pg-boss internal tables

Exact schema and ORM/query builder are implementation decisions, but the semantics and identity boundaries above are mandatory. Any deviation requires an ADR.

## 9. Local and remote identity

- Local IDs are stable and used by UI routes, domain references, and foreign keys.
- Provider identity is always stored with `account_id` and, where required, `mailbox_id`.
- IMAP UID is valid only within `(account, mailbox, UIDVALIDITY)`. A UIDVALIDITY change invalidates the old cursor and UID mapping for that mailbox and triggers controlled reconciliation.
- RFC `Message-ID` is optional, non-unique, and untrusted. It may assist threading/deduplication but cannot establish record identity alone.
- Do not merge messages across accounts merely because headers or content hashes match.
- Preserve enough remote identity to correlate command results and later sync observations.

## 10. Synchronization design

Synchronization is asynchronous. UI requests may enqueue work but do not hold an HTTP request open while synchronizing a mailbox.

### Initial account sync

1. Validate IMAP/SMTP configuration without logging secrets.
2. Discover mailboxes and normalize special-use roles.
3. Persist mailbox metadata and enqueue bounded jobs for a configurable recent usable window, newest first where supported.
4. Persist message bodies and attachment metadata in transactional batches; checkpoint only after each batch commits.
5. Make the account usable in the UI after the recent window is available; do not wait for all historical mail.
6. Continue with bounded historical-backfill jobs until the complete available mailbox history is synchronized locally.
7. Report historical-sync progress and keep partial failures retryable.

The desired final state is complete locally synchronized mail history, not a permanent rolling window. The initial usable window is configurable; its exact default (for example, 30 days) is a Phase 0/product decision. Backfill must be resumable, checkpointed, bounded, and restart-safe. It must yield capacity to higher-priority incremental synchronization, avoid monopolizing workers, and coexist with new-mail processing. Incremental sync of new mail always has higher operational priority than historical backfill.

Message synchronization always stores attachment metadata, including the remote/MIME part reference needed for later retrieval. It does not require downloading attachment binaries during initial or historical sync. Body-fetch policy may be staged as needed, but locally displayed/searchable content must converge to the complete-history goal.

### Incremental IMAP sync

- Prefer standards/extensions such as CONDSTORE/QRESYNC when the selected server and library support them.
- Otherwise use UIDNEXT plus bounded UID range fetches, flag refreshes, and periodic reconciliation.
- Treat sequence numbers as connection-local transient values; never persist them as identity.
- Detect UIDVALIDITY changes and rebuild the affected mailbox mapping without corrupting other mailboxes.
- Apply inserts, updates, flag changes, moves, and expunges in idempotent transactions.
- Use IMAP IDLE only as a wake-up hint. Correctness must come from a subsequent delta sync, with periodic polling as fallback.
- Cap concurrency per account and globally to avoid provider throttling and resource exhaustion.
- Record sync watermarks only after corresponding local changes commit.
- Prioritize new-mail and incremental work above historical-backfill jobs.

### User commands and reconciliation

Read/unread, move, archive, and delete use an explicit command workflow:

1. Validate authorization and local preconditions.
2. Write a durable command/job and, where desired, an explicitly marked optimistic local projection in one database transaction.
3. Execute the remote command idempotently as far as the provider permits.
4. Persist the confirmed remote result.
5. Run a targeted delta sync to reconcile authoritative state.
6. On permanent failure, revert or mark the optimistic projection as failed and expose a user-actionable status.

Never update only the local flags and assume the server changed.

## 11. PostgreSQL-backed jobs

V1 uses PostgreSQL for both application data and durable jobs. ADR 0004 selects pg-boss 12.33.7. Do not build a parallel custom queue framework. Maildock job contracts and pg-boss configuration preserve these semantics:

- atomic claim using row locks (`FOR UPDATE SKIP LOCKED`) or equivalent library guarantees
- leases with expiry so abandoned jobs can be recovered
- retries with exponential backoff and jitter
- maximum attempts followed by dead-letter/permanent-failure state
- idempotency/deduplication keys for sync and send workflows
- versioned payloads with runtime validation
- priority and `available_at`
- graceful shutdown that stops claiming and finishes or releases active work
- retention/cleanup policy for completed jobs

Scheduled work is represented by a database-backed schedule or by enqueueing guarded jobs from the application runtime. There is no in-memory-only source of truth. Job handlers call application use cases; they do not contain domain logic.

Expected job families include mailbox discovery, recent-window sync, historical backfill, mailbox delta sync, message body fetch, attachment fetch, remote command execution, SMTP send, targeted reconciliation, periodic account sync, and cleanup.

## 12. Attachment storage

Application code uses an `AttachmentStorage` port with operations equivalent to put, stat, open/read stream, and delete. V1 implements it with a local filesystem rooted at the configured Docker volume. Future S3 or Azure Blob implementations must not change Mail or Attachments domain models.

The default V1 synchronization policy stores attachment metadata with the message and leaves binary state as `remote_not_cached`. On the owner's authenticated request to view or download an attachment, Maildock fetches the referenced MIME part from the provider, stores it through `AttachmentStorage`, transitions the state to `cached`, and serves it from the local cache. Fetching and caching must be idempotent and safe under concurrent requests. The design must permit later configurable policies—on demand, automatically cache below a size threshold, or cache all—without requiring every policy in V1.

Rules:

- Store only opaque generated object keys; never use a sender-provided filename as a path.
- Keep original filename and media type as metadata after validation and normalization.
- Prevent path traversal by resolving keys under one configured root and rejecting escapes.
- Stream uploads/downloads; do not buffer arbitrary attachments in memory.
- Enforce configurable per-file and per-message size limits.
- Write to a temporary object and atomically finalize after successful checksum/metadata persistence.
- Make cleanup idempotent and handle orphaned database rows/files with a reconciliation job.
- Download through an authenticated application endpoint; knowing an attachment, message, or account ID is never sufficient authorization. Do not expose the volume as a public static directory.
- Set safe `Content-Disposition`, `Content-Type`, `X-Content-Type-Options`, and caching headers.
- Inline CID content follows the same authenticated fetch/cache path and is addressed only through an authorized content-ID/object lookup.

Malware scanning is not a required V1 infrastructure service, but the storage workflow must leave a separate security-status transition hook (`pending` to `available`/`quarantined`) for later scanning without conflating it with the binary cache state.

## 13. Credentials and token security

Account passwords and future OAuth refresh/access tokens are secrets.

- Never store credentials or tokens in plaintext columns, logs, job payloads, URLs, browser storage, or client-visible responses.
- Encrypt and decrypt secrets only through an encryption port using authenticated encryption (for example AES-256-GCM or a vetted envelope-encryption library).
- Supply the root/master encryption key through deployment secrets/environment, never PostgreSQL, the repository, or the Docker image.
- Ciphertext records include key version, nonce/IV, authentication tag as required, algorithm/version metadata, and timestamps to support rotation.
- Decrypt only immediately before provider use and keep plaintext lifetime minimal.
- Redact connection strings, auth headers, email credentials, and message bodies from logs and errors.
- Fail closed if the encryption key is absent or invalid.
- Design the encryption port so a later KMS/HSM-backed implementation can replace the local key implementation.

The example environment file contains placeholders only. Production documentation must recommend a secret manager or protected orchestrator secret, restricted filesystem permissions, database encryption at rest where available, and regular key rotation/backup procedures.

## 14. Instance authentication

Maildock V1 has one instance owner. Authentication gates the entire instance; it does not make the owner part of mail-domain ownership and must not introduce `user_id` columns on mail records.

- On first startup, an uninitialized instance exposes a narrowly scoped setup flow that creates the single owner's username and Argon2id password hash.
- Owner creation and initialization must be atomic. After successful initialization, the setup capability is permanently closed during normal operation and cannot create another owner. There is no public `/register` equivalent.
- Every application endpoint is denied by default until an authenticated instance session is established, except the minimum setup, login, and liveness/readiness endpoints. This includes reads, search, attachment/CID access, and all mutations. Possession of a local identifier is not authorization.
- Use a secure server-side session model with an opaque identifier in an `HttpOnly` cookie. Set `Secure` in production and an appropriate `SameSite` policy; define bounded idle and absolute lifetimes and server-side revocation.
- Rotate the session identifier after authentication and any future privilege/authenticator change. Do not place secrets or sensitive mail data in the cookie.
- Protect state-changing requests against CSRF as appropriate to the session design and strictly validate `Origin` against the configured canonical application origin.
- Rate-limit login attempts and apply progressive backoff/brute-force protection without creating an easy permanent denial-of-service condition.
- Keep authentication deliberately small: username/password for V1, without organizations, roles, RBAC, or a general IAM subsystem.
- Keep a clean extension point for optional TOTP two-factor authentication later; TOTP is not required in the first MVP.

ADR 0006 selects Better Auth with its username plugin and Drizzle adapter, custom Argon2id hashing, database sessions, database-backed rate limiting, and bounded progressive login backoff. Sessions use a 12-hour sliding idle expiry and a separately enforced 30-day absolute expiry. Password recovery is intentionally unavailable until an operator-safe recovery procedure is designed and documented. ADR 0001 remains the governing single-owner decision.

## 15. Safe email rendering

Email bodies, HTML, headers, filenames, and URLs are attacker-controlled.

- Parse MIME with a maintained, bounded parser and explicit size/depth limits.
- Sanitize HTML on the server with an allowlist suitable for email. Remove scripts, forms, frames, embedded active content, event handlers, dangerous URL schemes, CSS capable of data exfiltration or UI escape, and unsafe SVG.
- Render sanitized HTML in a sandboxed iframe or equivalently isolated document. Do not inject raw mail HTML into the application DOM.
- Use a restrictive Content Security Policy for both the application and message frame.
- Block remote images and other remote resources by default to prevent tracking. Loading them requires an explicit user action and must not leak Maildock credentials or referrer data.
- Rewrite `cid:` resources to authenticated local endpoints after verifying that the resource belongs to the requested local message and account.
- Render a safe plain-text alternative when HTML is absent or rejected. Escape plain text before display and linkify only validated schemes.
- Never execute attachments inline. Preview only explicitly supported safe types through constrained viewers; otherwise download.
- Sanitize subject/header text and prevent header injection when composing or sending.

ADR 0007 selects DOMPurify with current jsdom, a versioned sanitizer policy, a capability-free sandboxed iframe, a frame CSP starting from `default-src 'none'`, and remote-resource blocking by default. Sanitized output must be invalidated and regenerated when the sanitizer policy/version changes. ADR 0008 retains raw MIME as private untrusted object data behind the same authorization boundary so content can be reparsed and sanitized again.

## 16. Search

V1 search uses PostgreSQL only. Build a weighted full-text document from normalized subject, sender/recipients, and extracted plain body text. Maintain it transactionally or through idempotent indexing jobs. Every search endpoint requires an authenticated instance session; account and mailbox filters narrow results but are not per-user visibility controls.

The minimum searchable fields are subject, addresses/display names, and plain-text body. Filters should support account, mailbox/folder, read state, attachment presence, and date range. Search never contacts IMAP in the request path. A future external index must implement a search port without changing mail use cases.

## 17. Web and API boundaries

- The browser communicates only with Maildock HTTP endpoints/server actions; it never receives provider credentials or connects directly to IMAP/SMTP/PostgreSQL.
- Route handlers are thin adapters: validate input, require an authenticated instance session, invoke focused application behavior, and map the result.
- Use runtime schema validation at every external boundary, including HTTP input, environment configuration, job payloads, provider responses where practical, and persisted JSON.
- Mutation endpoints require CSRF protection appropriate to the chosen session strategy and strict origin checks.
- Authentication and setup follow Section 14 and ADR 0001. Specific session-library selection remains a Phase 0 implementation decision. The schema and endpoint guards must never assume that possession of a local account, message, or attachment ID grants access.
- Paginate message lists with stable cursor-based pagination. Do not return full bodies or attachment bytes in list endpoints.
- Use idempotency keys for send submission and other retry-prone mutations.

## 18. Transactions, consistency, and events

- A use case defines the transaction boundary for its local state changes.
- Database writes and job/outbox insertion that must succeed together occur in the same PostgreSQL transaction.
- External IMAP/SMTP/storage calls do not run inside long-held database transactions.
- Domain/application events that trigger reliable follow-up work are persisted through a transactional outbox or equivalent job insertion, not an in-memory event emitter alone.
- Consumers are idempotent and record enough correlation data to diagnose retries.
- Optimistic concurrency or row locking is used where simultaneous sync and user commands could overwrite state.

## 19. Observability and operations

Use structured logs with a request/job correlation ID and stable event names. Include account/message identifiers only as opaque local IDs unless a diagnostic explicitly requires more. Never log credentials, tokens, raw bodies, attachment content, or full protocol transcripts in production.

Required operational signals:

- HTTP request latency/error counts.
- Job queue depth, age of oldest available job, retries, dead letters, and execution duration by job type.
- Per-account last successful sync, current sync state, failure category, and next retry.
- IMAP/SMTP connection and throttling failures with sanitized categories.
- Database and attachment-volume readiness/capacity indicators.

Health endpoints:

- Liveness: process event loop is responsive; no external checks.
- Readiness: database reachable, migrations compatible, attachment root readable/writable; no provider checks.

Support graceful shutdown, bounded job execution, database backups, and attachment-volume backups. Database and attachment backups form one logical recovery set; document recovery and consistency expectations before production release.

## 20. Configuration

All deployment-specific configuration comes from validated environment variables or mounted secrets. Centralize parsing in one configuration module and terminate startup with a clear sanitized error on invalid values.

The Phase 0 configuration foundation validates environment, canonical application origin, database URL/pool size, a base64 authentication secret of at least 32 bytes, a base64 32-byte credential-encryption root key, absolute attachment root, worker concurrency, and log level. Later phases add bounded sync, storage, and protocol settings before using them. Do not scatter direct environment reads through modules.

## 21. Evolution seams

The following future changes must be possible without changing domain semantics:

- **Separate workers:** start the worker composition root in another container/process while the web process only enqueues jobs.
- **External queue:** replace the Jobs infrastructure adapter while keeping versioned job commands and handlers.
- **Object storage:** replace local `AttachmentStorage` with S3/Azure Blob.
- **Gmail API or Graph:** add `MailProvider` adapters and capability mappings; do not add them to V1.
- **External search:** replace the Search infrastructure adapter and rebuild the index from PostgreSQL.

This does not require implementing unused adapters now. It requires stable ports, provider-neutral application types, and no protocol-specific leakage into the domain.

## 22. Implementation phases

No phase should add Gmail API, Graph, POP3, AI, contacts, or calendars unless this architecture document is explicitly revised.

### Phase 0 — repository and decisions

Status: bootstrap implemented. ADRs 0002 through 0008 resolve the Phase 0 technology and policy choices. The Phase 0 skeleton also includes the minimum configuration, authentication, health, migration, worker-lifecycle, and Docker behavior needed to prove those decisions.

- Verify compatibility and establish tooling around the preferred candidates: Node.js 24 LTS, TypeScript, Next.js, React, and pnpm. Do not blindly pin versions without verification.
- Use PostgreSQL. Prefer Drizzle ORM and its compatible migration tooling because Maildock needs accessible SQL and PostgreSQL-specific transactions, `ON CONFLICT`, cursor pagination, full-text search, GIN indexes, locking, and potentially `SKIP LOCKED`; verify the choice before implementation.
- Verify the current candidates: Zod for runtime validation, ImapFlow for IMAP, Nodemailer for SMTP, `mailparser` for MIME parsing, Pino for structured logging, and Argon2id for password hashing.
- Research and select a maintained Node.js/PostgreSQL job queue based on maintenance/activity, supported PostgreSQL versions, retries/backoff, concurrency, scheduling, crash recovery, job deduplication/idempotency support, graceful shutdown, and TypeScript support. Do not select it merely because it is popular.
- Research and explicitly choose the server-side HTML sanitizer, sanitization policy, iframe/sandbox strategy, CSP strategy, remote-resource blocking strategy, and sanitizer policy versioning. Do not improvise these choices while implementing message UI.
- Select the session implementation consistent with ADR 0001, including atomic first-run setup, cookie/session lifecycle, CSRF and Origin enforcement, login throttling/backoff, reset/recovery policy, and a future TOTP extension seam.
- Decide the configurable initial usable-history-window default and how historical progress is measured and reported.
- Record choices that constrain architecture as ADRs.
- Add Dockerfile and Compose definitions with app/PostgreSQL health checks.

### Phase 1 — account and storage foundation

- Extend the Phase 0 configuration, migrations, composition roots, logging, and operational checks as account and storage behavior requires.
- Accounts module and encrypted credential storage.
- AttachmentStorage filesystem adapter and domain job enqueueing/handler integrations over pg-boss.

### Phase 2 — synchronization and read model

- IMAP mailbox discovery, bounded recent-window sync, and resumable progressive full-history backfill.
- Incremental sync/checkpoints and message/attachment metadata persistence.
- On-demand authorized attachment-binary fetch and local caching.
- Mailbox/message queries and unified inbox UI.

### Phase 3 — mail actions and sending

- Durable read/unread, move, archive, and delete workflows.
- Compose/reply/forward, MIME generation, SMTP outbox, attachment upload.
- Targeted reconciliation and clear failure states.

### Phase 4 — search and hardening

- PostgreSQL full-text search and filters.
- HTML rendering isolation, remote-image controls, security headers, and non-login rate/size limits.
- Backup/restore documentation, metrics, operational screens, and failure recovery.

## 23. Definition of done for each feature

A feature is not complete unless:

- It respects module boundaries and uses ports at meaningful external or replaceable boundaries without requiring pass-through abstraction layers.
- Inputs and persisted JSON payloads are runtime-validated.
- Every protected endpoint requires an authenticated instance session; local IDs never act as authorization. Mail-account scoping is preserved for provider identity and integrity, not per-user visibility.
- External calls have timeouts and sanitized error mapping.
- Retried jobs/commands are idempotent or safely reconciled.
- Local and remote identifiers are stored at their correct scope.
- Secrets and untrusted mail content never reach logs or unsafe rendering paths.
- Database migrations are forward-applicable and operational behavior is documented.
- Relevant manual verification and acceptance criteria are recorded for the implementing phase.
- New sync behavior does not starve higher-priority incremental mail processing, and long-running backfill is bounded, checkpointed, and restart-safe where applicable.
- Attachment behavior stores metadata during message sync and does not require eager binary download unless a configured policy explicitly requests it.

## 24. Decisions intentionally deferred

Phase 0 decisions are recorded in ADRs 0002 through 0008. The following implementation details remain deliberately deferred until their owning phase:

- the exact `email-html-v1` sanitizer allowlist and CSS transformation rules, within ADR 0007's fixed isolation boundary
- raw-MIME pruning controls and production capacity guidance; retention by default is fixed by ADR 0008
- detailed sync-progress UI when a provider cannot report a stable total
- optional attachment auto-cache policies beyond the V1 on-demand default
- conversation presentation and heuristics beyond ADR 0008's identity and threading constraints
- a reviewed administrative password-recovery procedure and optional TOTP implementation

Implementers must record a new ADR before changing any accepted boundary.

## 25. Architecture change process

Create a short ADR under `docs/adr/` for any change that affects deployment topology, required infrastructure, module ownership, identity rules, security boundaries, persistence semantics, provider contracts, or an intentionally deferred choice. An ADR records context, decision, alternatives, and consequences. Update this document when the accepted decision changes the V1 source of truth.
