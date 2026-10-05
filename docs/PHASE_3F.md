# Phase 3F — Diagnostics & Observability

## Two distinct diagnostic channels

**Operational logs: Pino → structured JSON → stdout/Docker.** Pino remains the operational logger, with its existing redaction configuration unchanged. There is no pretty-print transport, second logging framework, or database sink for Pino. Operational logs retain their technical fields, IDs, reasons, durations, UID checkpoints and counters. Delta completion/failure and IDLE connection/disconnection events now include `accountName`, `accountEmail` and `mailboxPath`. Context is selected in existing account/watcher queries once, then passed into the log calls; there are no cosmetic queries inside message loops and no additional routine operational events.

**Application Events: selective → PostgreSQL → Settings UI.** `ApplicationEventService` explicitly records a small set of meaningful lifecycle outcomes and problems. These records are diagnostic history for the owner/support person, not an audit log, activity feed, incoming-message feed, or mirror of Pino.

## Event policy

Event identifiers, levels, areas and messages are defined in a typed catalog. Messages are fixed human-readable templates, never exception text. Levels are `info`, `warning`, `error`; areas are `system`, `account`, `sync`, `imap`, `smtp`, `jobs`. Only areas used by the selected boundaries currently have producers.

| Event                        | Level / area    | Recording boundary                                                                                                   |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `account.connected`          | info / account  | A saved account connection test verifies both protocols.                                                             |
| `account.connection_failed`  | error / account | A saved account connection test fails; retains an existing provider category.                                        |
| `mail.recent_sync_completed` | info / sync     | Initial/recent mailbox synchronization commits its successful state.                                                 |
| `mail.recent_sync_failed`    | error / sync    | Initial/recent synchronization fails; retains an existing provider category or `internal_error`.                     |
| `mail.sync_failed`           | error / sync    | Delta mailbox synchronization fails.                                                                                 |
| `mail.epoch_reset`           | warning / imap  | Delta observes changed UIDVALIDITY, clears old placements/checkpoints and requests a recent rebuild.                 |
| `mail.sent`                  | info / smtp     | SMTP acceptance and the outgoing `sent` state are persisted. No subject or recipients are copied.                    |
| `mail.send_failed`           | error / smtp    | Delivery becomes permanently failed, including unavailable account credentials or unreadable immutable MIME storage. |
| `mail.send_uncertain`        | warning / smtp  | A delivery attempt records an uncertain outcome. It must not be automatically resubmitted.                           |

Repeated identical delta failures are coalesced while the mailbox remains failed; a changed failure or failure after recovery records again. Retries that remain queued are not persisted. Routine successful delta polls (including zero-message polls), flag synchronization, IDLE wakeups/reconnects, job execution, pg-boss lifecycle operations, incoming messages, read/unread/archive/delete actions, notification delivery, HTTP requests and UI navigation are explicitly **not** Application Events. Historical backfill progress and Sent-copy operations remain outside this deliberately small event integration. Crash recovery of an already-`sending` outgoing row retains the existing uncertain state behavior without adding a separate event producer.

## Storage, safety and failure behavior

Migration `0025_overconfident_tyrannus.sql` adds `application_events`: UUID ID, millisecond timestamp, level, area, typed event identifier, nullable account/mailbox references, template message and optional JSONB details. Level/area constraints and recent/account indexes support bounded querying. Account/mailbox removal sets diagnostic references to null rather than preventing deletion. Account display names and live mailbox paths are joined when reading; recorded paths can provide context after mailbox deletion.

Details have a runtime allowlist at **both write and read** boundaries: existing provider error category, mailbox path (maximum 512 characters), numeric UIDVALIDITY (maximum 20 digits). Unknown fields are stripped; invalid details are discarded. Only known mailbox paths are supplied by the instrumented sync services. Exceptions, stacks, protocol responses, credentials, credential envelopes, OAuth tokens, headers/cookies, raw MIME, bodies, snippets, attachments, subjects and senders are never copied into these records. API messages are derived again from the catalog rather than arbitrary stored text. SQL/database exception objects are not logged when diagnostic persistence fails, because their query parameters could contain private data.

Recording and cleanup are best-effort and report failures through safe Pino warnings. A failed diagnostic insert cannot change a successful mail outcome or replace the original synchronization error. Diagnostic sending events are written **after releasing the outgoing advisory-lock connection**, so a one-connection pool does not deadlock. Diagnostic history is not transactionally guaranteed: a process crash between a mail-state commit and event insertion can leave no event; this is intentional for a non-audit diagnostic facility.

## Retention

Keep approximately **30 days**, with an additional target ceiling of **10,000 most recent events**. Cleanup runs on worker startup and hourly, and at most hourly per writer during event recording. The count ceiling is applied at cleanup, not on every insert; a burst can temporarily exceed it. Cleanup failures produce safe operational warnings and do not fail startup or mail work. A stopped worker performs no scheduled cleanup; active web-side account event recording also triggers cleanup. No retention job or diagnostic mutation API is introduced.

## Owner UI and API

Settings adds **Diagnostics → Application logs** in the existing rail. The viewer uses a chronological list, with timestamp, textual/color-coded severity, account name, mailbox path, area and primary message. Authentication rejection gets a safe explanation. Native expandable **Technical details** show the event, account/mailbox IDs and allowlisted metadata. It has level, account and area filters, a refresh action, an explicit empty state and loading/error states; no charts, counters or admin-column table.

`GET /api/application-events` uses the existing owner access guard before querying. Responses (including validation/server failures) use `Cache-Control: no-store`. Parameters are validated: controlled level/area, UUID account ID, bounded cursor, and a 1–100 limit (default/UI size 50). Newest-first keyset pagination uses `(created_at, id)`, so equal timestamps do not skip or duplicate rows. Only fields required by the viewer are selected and details are sanitized again. There is no mutating diagnostic endpoint, so no new Origin/CSRF exception is introduced.

Account Diagnostics retains provider/enabled/connection state, connection/discovery outcomes, last successful synchronization, mailbox recent/delta/history status and errors, capabilities, UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ and historical frontier. Message inspection and its `MessageList` are removed completely. **View related application logs** navigates to `/accounts?section=application-logs&account=<id>`; the link loads the requested Settings section and filter, including when the user previously changed sections without changing the current URL. The Settings shell also remounts for route selection changes.

## Validation and deployment

Focused coverage exercises operational context on delta completion/failure and IDLE, unchanged secret redaction, selective persistence, absence of successful polling/IDLE writes, recent synchronization outcomes, send success/permanent failure, epoch resets, best-effort failures, age/count retention, filtering, newest-first bounded pagination, safe serialization, owner authorization with real sessions, UI empty state/details/filtering and diagnostic navigation/preview removal. The existing one-connection send test also includes diagnostic recording.

Final validation: 66 test files / 730 tests pass; the separate security suite passes 37 tests; the browser security harness passes; typecheck and lint pass (one existing warning in an ignored generated `.security-results` preview script). Both Next.js and worker builds pass. Browser/build verification uses the required Node 24 runtime; production build verification supplies an HTTPS `APP_ORIGIN` because the local development HTTP origin is correctly rejected in production. No security or browser checks were weakened.

Apply the migration using the normal `pnpm db:migrate` workflow before running the updated application and worker. No existing data is migrated or discarded except diagnostic retention of the new table.
