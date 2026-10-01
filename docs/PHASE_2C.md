# Phase 2C — Compose and Durable Outgoing Mail

Implemented against `bbdd326dcf7b97a28d640dba053a90ea350c8ee2` (Phase 2B).

## Scope and UI

Compose opens in the existing right-hand reader pane, using the Phase 2A visual
system. From is a selector of enabled, configured Maildock accounts and defaults
to the current account when usable. To, Cc, Bcc, subject and a plain-text body are
supported. All recipients may be supplied in Cc/Bcc alone. The form retains its
React state on validation/API failure and closes after durable queueing.

The owner can compose another message while earlier sends are pending. Status
feedback polls the local API and distinguishes queued/sending ("Sending…"), sent,
failed and uncertain. Terminal feedback can be dismissed. A partial recipient
rejection after positive SMTP acceptance is shown alongside "Message sent";
Maildock does not resend to rejected recipients. There is no uncertain retry
button, permanent Outbox, or draft persistence. In-session feedback does not
survive a browser reload; the database record and its status do.

## Data model and migration

Forward-only Drizzle migration `0012_striped_luke_cage.sql` adds
`outgoing_messages`, independent of `message_commands`:

| Field                              | Purpose                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| UUID `id`, `account_id`            | Exactly one existing sending account; restrictive FK                 |
| JSONB `from`, `to`, `cc`, `bcc`    | Authoritative identity snapshot and structured addresses             |
| `subject`, `plain_text`            | Original compose content                                             |
| Unique `message_id`                | Stable RFC Message-ID                                                |
| `mime_base64`                      | Exact final MIME bytes, encoded for lossless PostgreSQL text storage |
| `status`, `attempts`, `error`      | Finite lifecycle, bounded delivery attempts, safe explanations       |
| `next_attempt_at`, `started_at`    | Durable retry eligibility and attempt start                          |
| `smtp_accepted_at`                 | Positive SMTP completion time                                        |
| `accepted_count`, `rejected_count` | Recipient outcome counts without exposing addresses                  |
| `created_at`, `updated_at`         | Creation and state update timestamps                                 |

Constraints enforce finite statuses, 0–3 attempts, 1–100 total recipients and the
MIME size bound. A PostgreSQL trigger makes account, identity, recipients, compose
content, creation date, Message-ID and MIME immutable from creation. Later updates
only change delivery state and metadata. Existing migrations and mailbox roles
are unchanged. Run the normal `pnpm db:migrate` before starting updated workers.

## Message-ID and MIME

Creation generates one cryptographically random UUID Message-ID in the form
`<UUID@maildock.invalid>`. The reserved local domain convention requires no DNS
ownership; uniqueness derives from the random local part. The database stores
the ID before any SMTP attempt, and retries never generate another ID.

The MIME boundary uses the installed Nodemailer `MailComposer`, independently of
SMTP. It builds final RFC MIME from the validated creation data inside the
transaction, with a fixed Date and Message-ID, UTF-8 names/subject, plain-text UTF-8
content, base64 transfer encoding and CRLF lines. It explicitly disables file and
URL access. The resulting bytes are persisted once. SMTP receives a decoded
Buffer of exactly that snapshot, never high-level compose fields. The boundary
can later grow to multipart messages without changing durable delivery ownership.

Bcc is **never supplied to the MIME builder**. It remains in owner-only database
compose data and contributes to the SMTP envelope, together with To and Cc.
Duplicate identical envelope addresses are collapsed. Status responses, feedback,
provider failure text and job payloads contain no recipient lists or bodies.

## Validation and API

Nodemailer's standards-aware address parser handles display names and quoted
names (including commas and Polish Unicode). Each addr-spec is validated using
Zod's email validator. A small structural guard rejects unfinished quoting,
brackets, empty list entries and trailing garbage that the parser otherwise
repairs. This phase accepts conventional Internet mailbox addresses and name-addr
forms, not address groups, comment-only syntax, address literals or international
local parts. Header control characters are rejected in all recipient fields,
display names and subjects. A body may contain normal line breaks but no NUL.

Limits: 8,000 characters per recipient input, 100 total recipients, 200 characters
per display name, 254 per addr-spec, 998 for subject, 500,000 for body, 1,000,000
bytes for final MIME, and 3,100,000 bytes for the HTTP request (bounded while
streaming, including without Content-Length). UTF-8 expansion can make a body
below its character limit exceed the final MIME limit; that is rejected safely.

`POST /api/outgoing` accepts only `accountId`, `to`, `cc`, `bcc`, `subject` and
`plainText`. It applies existing owner authentication and mutation Origin checks.
From is resolved from the persisted account on the server, never from the client.
Unknown fields such as From or credentials are rejected. Account eligibility is
checked during creation and again before delivery; OAuth accounts must be
connected. Credentials are resolved by the existing account abstraction.

The endpoint returns HTTP 202 with `{ id, status: "queued" }` after persistence
and an enqueue attempt. It performs **no SMTP**. This is a receipt for queueing,
not evidence of SMTP acceptance. `GET /api/outgoing/:id` is authenticated and
returns only ID, account ID, delivery and Sent-copy states, safe errors,
acceptance time and rejection count, with `Cache-Control: no-store`.
Maildock retains its single-owner model.

## Durable queue and concurrency

1. Validate and resolve the account within a PostgreSQL transaction.
2. Persist identity, recipients, Message-ID and final MIME with `queued`.
3. Enqueue pg-boss `outgoing-message-v1` with **only** `{ outgoingMessageId }`.
4. The worker loads the record and credentials from existing boundaries.
5. Acquire a session advisory lock keyed `outgoing:<UUID>`.
6. Atomically claim `queued → sending` with an incremented attempt count, in an
   autocommit statement that completes **before** any SMTP network delivery.
7. Persist the provider's accepted, definite-failure or uncertain result.

The advisory lock covers the entire attempt. A competing job or poller that
cannot acquire it does nothing. After acquiring it, a worker that sees `sending`
recovers uncertainty instead of sending. Terminal states do nothing. The claim
also checks the status and database retry eligibility atomically.

State operations use the same reserved connection as the advisory lock, while
credential/OAuth resolution occurs before reservation. This avoids holding a pool
connection while waiting for another account-service connection. PostgreSQL's
clock determines retry eligibility and delays, rather than comparing app and
database clocks.

pg-boss transport retries are disabled (`retryLimit: 0`): application state alone
decides whether another SMTP attempt is safe. Singleton job keys reduce duplicate
queue entries; correctness relies on PostgreSQL state and locks, not singleton
deduplication. There is no Redis or second queue system. Docker services remain
`app` and `postgres`.

## SMTP provider and exact retry policy

`MailProvider.deliverMessage` receives account/provider SMTP context, an envelope
and immutable MIME bytes. `ImapSmtpMailProvider` uses the existing secure
Nodemailer configuration (TLS/required STARTTLS and existing password/OAuth
credentials). It first runs `verify()`, which submits no message, and then
`sendMail({ envelope, raw, messageId })`. The transport metadata Message-ID is
read from the immutable snapshot so Nodemailer does not generate a separate ID
for its internal raw MIME node. It never rebuilds MIME or logs content/credentials.

| Observed result                                                | Durable outcome                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| Positive completed `sendMail`, at least one accepted recipient | `sent`, acceptance timestamp and recipient counts          |
| Verification-stage structured connection/DNS/timeout code      | `queued` with bounded backoff, or `failed` after attempt 3 |
| Other verification/configuration/authentication/TLS failure    | `failed`, no automatic retry                               |
| Explicit 5xx `MAIL FROM` or `RCPT TO` failure from Nodemailer  | `failed`, no automatic retry; these occur before DATA      |
| Any other exception once `sendMail` has been entered           | `uncertain`, no automatic retry                            |
| Provider exception without a trustworthy classification        | `uncertain`, no automatic retry                            |

The verification-stage retry whitelist is `ETIMEDOUT`, `ECONNECTION`, `EDNS`,
`EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`. It does
not inspect exception prose. Unknown failures are terminal at verification.
`ESOCKET` is not whitelisted because it can also wrap TLS configuration failures.
Attempts are limited to three total, with database delays of 30 seconds after the
first safe failure and 60 seconds after the second, plus the poll interval.

Verification and submission use separate Nodemailer connections. A successful
verification does **not** prove the subsequent send succeeded. Even a subsequent
authentication/connection failure is uncertain if this boundary cannot prove it
occurred before submission. A socket error labelled `CONN` during DATA is not
treated as safe. Explicit DATA rejections also remain uncertain under this
conservative initial policy; exception text is never used to guess acceptance.

SMTP acceptance is not proof of inbox delivery, nor of a Sent mailbox copy.
Partial recipient rejection does not trigger retransmission to the whole set.
Transport response strings are not persisted because they can contain addresses;
only counts and safe static descriptions cross the application boundary.

## Uncertainty and crash recovery

At startup and every 30 seconds, the outgoing poller:

- re-enqueues due `queued` rows, including creation-time enqueue failures;
- acquires the outgoing lock before recovering abandoned `sending` as `uncertain`;
- leaves `sent`, `failed` and `uncertain` untouched.

The lock prevents repair from changing a live worker's state. There is no lease
expiry that grants another worker permission to send. If a process dies before
claiming, `queued` remains eligible. If it dies after the durable `sending` commit,
even before contacting SMTP, recovery must assume delivery could have happened.
If SMTP accepted and the process died or the database failed before recording
`sent`, the surviving row is recovered as uncertain without resubmission.

**A recovered `sending` message is not automatically resent because avoiding
duplicate delivery is more important than pretending an ambiguous SMTP outcome
is definitely failed.** Its safe feedback is "Maildock could not confirm whether
this message was sent." The stable Message-ID helps identify a message but is not
an SMTP idempotency key; remote servers are not assumed to deduplicate it.

## Phase 2C fix — explicit Sent-copy policy

Some SMTP services automatically store sent mail, while others require the client
to append a copy through IMAP. A Sent mailbox alone cannot establish which
behavior applies. Maildock never infers this policy from provider names, email
domains, mailbox paths, localization or SPECIAL-USE flags.

Forward-only migration `0013_fuzzy_vanisher.sql` adds `sent_copy_policy` to each
account and snapshots it on each outgoing message at creation. Both existing and
new accounts default to `server`; historical outgoing mail becomes
`server` / `not_required`. Updating policy affects future compose submissions,
including deterministically preserving the policy of already queued messages.
There is no historical backfill. The immutable-snapshot trigger also protects
the outgoing policy snapshot.

- `server`: the owner expects the mail service to save sent mail. Maildock does
  not APPEND; copy state remains `not_required`.
- `maildock`: positive SMTP acceptance atomically persists delivery `sent` and
  copy state `pending`. Maildock then saves the exact persisted MIME via IMAP.

The account settings use the existing authenticated, Origin-protected account
PUT API. Password and OAuth accounts can update policy without submitting
credentials. When `maildock` is selected, the UI displays the existing semantic
`sent` role destination and Auto/Manual source, or an incomplete-configuration
warning. Change the destination in **System folders → Sent**; there is no second
folder selector. A temporarily missing mapping does not reset account policy.

### Separate delivery and copy state

SMTP `sent` is final positive recipient-delivery acceptance. No Sent-copy result
can reverse it, retry SMTP, or report that the message could not be sent.
Copy state has its own finite database-constrained lifecycle:

```
SMTP not positively accepted: not_required (no copy work)
server + SMTP sent:          not_required
maildock + SMTP sent:        pending → saving → saved / failed / uncertain
recovered saving:            read-only reconciliation → saved / uncertain
```

The outgoing table also stores a safe copy error, attempt/saved timestamps,
destination mailbox ID and path, optional UIDVALIDITY/UID, and a durable
`sent_copy_sync_pending` marker. Copy work is restricted by database constraints
to positively sent messages with a snapshotted `maildock` policy. No normal
message/placement records are fabricated.

### Durable jobs, exact MIME and destination

The separate pg-boss queue `sent-copy-v1` contains **only**
`{ outgoingMessageId }`, with queue-managed retries disabled. SMTP completion
attempts enqueue after persisting `pending`; failure leaves recoverable work.
At startup and every 30 seconds a poller enqueues pending work, abandoned
`saving` recovery and saved copies still awaiting sync enqueue.

Workers acquire the existing `outgoing:<UUID>` session advisory lock, reload the
database row and resolve credentials through the account abstraction. Duplicate
jobs cannot APPEND concurrently. Before network APPEND, an autocommit conditional
`pending → saving` update persists the selected same-account mailbox ID/path.
This destination remains the recovery target even if the owner later changes
the semantic role mapping.

The destination comes exclusively from the existing resolved `mailbox_roles`
`sent` mapping and existing role-resolution rules. It must belong to the sending
account, be active and selectable. No fallback folder is guessed. Missing or
unavailable roles fail the copy while SMTP remains `sent`.

`MailProvider.appendMessage` receives IMAP context, the destination, `\Seen`,
the SMTP acceptance time as IMAP internal date, and the decoded persisted MIME
Buffer. The adapter uses ImapFlow APPEND with those exact bytes. It does not
rebuild MIME, change Message-ID/Date, or add Bcc. The SMTP snapshot, including
its original Bcc-header omission, remains authoritative.

Positive APPEND completion sets `saved`. Returned APPENDUID identity is persisted
when available; UIDPLUS is optional and no UID is invented. If the library
returns an actual discovered destination UID, that identity may also be retained.
Cleanup failures cannot revoke positive acceptance. Failures before entering
APPEND are terminal `failed`; every unproven failure after entry is conservatively
`uncertain`. This fix has no automatic APPEND retry, including preflight failures,
and no manual append-again control.

### APPEND ambiguity and Message-ID reconciliation

The server may store an APPEND before the process dies or the database records
`saved`. A worker encountering `saving` **never APPENDs again**. It verifies that
the snapshotted destination remains available in the same account, then performs
read-only IMAP HEADER Message-ID search. Because HEADER search uses substrings,
each candidate's fetched envelope Message-ID must match the exact generated,
persisted Maildock ID. A positive exact match yields `saved`, with actual UID and
selected UIDVALIDITY; unrelated substring hits do not count.

Unavailable credentials/destination, search failure, excessive candidates
(over 100), or no exact match yields `uncertain`. Even an empty search does not
authorize another APPEND: eventual visibility and ambiguous remote outcomes
must not create duplicate Sent copies. Terminal uncertainty is not automatically
retried. Message-ID is only correlation for this particular Maildock-generated
operation; global message identity and deduplication rules remain unchanged.

### Targeted synchronization and feedback

After positive APPEND or recovery confirmation, Maildock persists `saved` and
`sent_copy_sync_pending`, then requests existing targeted mailbox delta sync.
If initial synchronization has not completed, it requests the existing recent
sync instead. Queue failure retains the marker for poller repair; repair only
requests sync and never repeats APPEND. Remote IMAP state remains authoritative.

Normal success remains **Message sent**. Pending copy feedback adds that a copy
is being saved. Copy failure says **Message sent, but the copy could not be saved
to Sent.** Copy uncertainty says **Message sent, but Maildock could not confirm
whether the Sent copy was saved.** These warnings remain dismissible; ordinary
completed success disappears after five seconds. MIME, credentials and Bcc
recipients are absent from jobs and status feedback.

Remaining limitations: no copy retry UI, no historical copy backfill, no automatic
inference of provider behavior, and no repair that risks duplicate APPEND.

Deferred: attachments, HTML/rich text, drafts/autosave and Drafts sync, replies,
reply-all, forwarding, arbitrary From/aliases, signatures, undo, scheduled/bulk
sending and a permanent Outbox. Existing
reader HTML isolation, account abstractions, sync/command queues and mailbox role
semantics are preserved.

## Verification coverage

New tests cover address/UTF-8 MIME validation, immutable persistence and stable
Message-ID, Bcc envelope privacy, owner/Origin API checks and size limits,
ID-only jobs, enqueue repair, acceptance, bounded safe retries, terminal failures,
account isolation, disabled accounts, compose state/account selection and status
feedback. PostgreSQL integration tests cover competing workers and active repair.
The mandatory crash test injects a database failure at the final `sent` write
after the provider has positively accepted, then constructs a restarted service
and verifies recovery as uncertain with exactly one SMTP invocation.

Sent-copy tests additionally cover migration of real pre-fix rows, conservative
defaults, policy snapshots, manual/automatic semantic roles, unavailable and
cross-account destinations, exact bytes/Seen/internal date, APPENDUID and its
absence, separate delivery success, ID-only jobs, enqueue/sync repair, initial
and delta sync requests, concurrent workers, and read-only exact Message-ID
verification. Critical crash tests inject failure after APPEND acceptance but
before the saved write, restart recovery, and assert exactly one APPEND and one
SMTP invocation for found, absent and unavailable search outcomes. UI tests
cover policy selection and copy states without exposing Bcc.
