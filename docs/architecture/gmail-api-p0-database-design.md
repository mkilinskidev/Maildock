# P0 — proposed fresh-install database model

Date: 2026-10-09. Status: proposed; **no schema or SQL file is changed by P0**. Governed by [the P0 architecture](gmail-api-p0-fresh-install.md) and [ADR 0013](../adr/0013-gmail-message-identity-and-label-membership.md).

## Model and invariants

Reuse `mail_accounts`, `mailboxes`, `messages`, `mailbox_messages`, `message_contents`, `message_attachments`, `blobs`, `message_commands`, `notification_events`, drafts and outgoing tables. Add only two native synchronization tables. There is no Gmail-specific message/content/blob store, identity bridge, alias or migration journal.

Use account `provider_type` values `imap_smtp` and `gmail_smtp`, mapping to child `receive_transport` values `imap` and `gmail`. Retain explicit child discriminators where PostgreSQL must enforce conditional identity constraints: CHECK cannot inspect a parent row. Enforce parent transport/account agreement with composite FKs, not application checks alone. Proposed shared account field `receive_transport` is derived/generated from `provider_type`, not an independently editable selector. This small duplicate discriminator supports ordinary FKs without a new authority trigger.

For each composite FK, create the referenced UNIQUE key, even when the UUID alone is already a PK. Cross-account membership must be impossible. PostgreSQL CHECK expressions must use explicit `IS NULL`/`IS NOT NULL`, because an expression evaluating to NULL passes a CHECK. Opaque ID nonempty checks are separate from equality/ownership checks.

## Changes to existing tables

| Table                                                                                       | Proposed final columns and constraints                                                                                                                                                                                                                                                                                                                                                                             | Behavior retained                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `mail_accounts`                                                                             | Extend provider check to `imap_smtp`/`gmail_smtp`; generated `receive_transport TEXT`; UNIQUE `(id,receive_transport)`; `work_revision BIGINT NOT NULL DEFAULT 1` with positive check. `gmail_smtp` requires `auth_method='oauth2'`, provider Google and existing valid encrypted Google cache/subject rules. IMAP endpoint/username fields nullable only for Gmail, all required/valid for IMAP                   | Enabled, sorting, display/sender identity, encrypted secrets, SMTP, discovery/readiness diagnostics                 |
| `mailboxes`                                                                                 | `receive_transport TEXT NOT NULL`; composite FK `(account_id,receive_transport)` to account; UNIQUE `(account_id,id,receive_transport)`. Gmail label rows require nonempty `provider_mailbox_id`, no UID/UIDNEXT/MODSEQ; virtual All Mail has `view_kind='all_mail'`, NULL provider label ID and all IMAP locator fields NULL. Other rows use `view_kind='remote'`                                                 | Existing UUID/name/path/counters/lifecycle/roles; IMAP sync-state columns and path uniqueness                       |
| `messages`                                                                                  | `receive_transport TEXT NOT NULL`, account/transport FK; `provider_message_id TEXT` required/nonempty for Gmail; optional `provider_thread_id TEXT`, `provider_history_id TEXT` with decimal validation only for Gmail; `remote_missing_at TIMESTAMPTZ`; `inventory_generation BIGINT` for native recovery observations; UNIQUE `(account_id,id,receive_transport)` and `(id,receive_transport)` for dependent FKs | UUID, envelope/internal date/size, RFC headers, local search vector/body, timestamps                                |
| `mailbox_messages`                                                                          | Add `account_id` and `receive_transport`; composite FKs `(account_id,mailbox_id,receive_transport)` and `(account_id,message_id,receive_transport)`. UID/UIDVALIDITY nullable; IMAP requires positive values and optional positive MODSEQ, Gmail requires all three NULL                                                                                                                                           | Placement UUID, flags, action-hidden projection, synchronization timestamps                                         |
| `message_attachments`                                                                       | `account_id`, `receive_transport`; FK `(account_id,message_id,receive_transport)` to message; nullable IMAP UID fields; `gmail_attachment_id TEXT` nullable for inline payload parts. Existing `part_id` stores native Gmail part ID or IMAP section according to transport                                                                                                                                        | Attachment UUID, `(message_id,part_id)` uniqueness, display/CID/filename metadata, blob/status/error, incoming pins |
| `message_commands`                                                                          | `receive_transport`, `account_revision` and `intent_sequence BIGINT`; Gmail native target derived from referenced message, not source path/UID. Nullable source path/UID/epoch for Gmail, required source path/UID/epoch for IMAP. Account/message/mailbox composite FKs; index pending work by `(account_id,message_id,intent_sequence)`                                                                          | Six actions, statuses, optimistic fields, error/attempt/completion timestamps and durable intents                   |
| `notification_events`                                                                       | `receive_transport`; nullable UID/epoch with conditional branches and composite account/message/mailbox ownership. Gmail uniqueness `(account_id,message_id)` under transport predicate; IMAP current placement uniqueness becomes IMAP-only                                                                                                                                                                       | Sequence/cursor, sender/subject payload, preferences and live-arrival delivery                                      |
| `outgoing_messages`                                                                         | No new send transport: SMTP only. Keep immutable payload and separate delivery/copy states. Existing IMAP Sent receipt fields stay nullable; optional `sent_copy_message_id UUID` identifies confirmed native Gmail message via `(account_id,message_id)` ownership FK                                                                                                                                             | Pending/sending/sent/failed/uncertain delivery and no automatic uncertain resend; copy policy/status                |
| `message_contents`, drafts, staged/outgoing attachments, blobs, signatures/preferences/auth | No transport-specific copy of these tables; source adapters resolve from their current owning message/account                                                                                                                                                                                                                                                                                                      | Current cache/policy/request/attempt fences, local autosave/revisions/pins, encryption/security                     |

Attachment IMAP source mailbox currently uses `ON DELETE SET NULL`; retain that behavior for cached/orphaned content. IMAP UID/epoch remain required even if its source mailbox was deleted, but such an uncached locator cannot fetch. Add a nullable `source_account_id` alongside the existing nullable mailbox pointer for a composite source mailbox FK, set these two pointer fields NULL together on mailbox deletion, and CHECK that both pointer fields are NULL or both non-NULL with `source_account_id=account_id`. The composite source FK includes transport; owning account/message/transport FK remains mandatory. Gmail has NULL source mailbox/account/UID/epoch: its message FK plus `part_id`/optional attachment ID is the locator. Do not require attachment ID for inline parts or reject the documented empty root `partId`; validate uniqueness and payload kind instead. Parent message accounts remain authoritative for cached-byte access.

Commands store the message UUID as authoritative Gmail identity, with no fabricated UID or duplicated API ID. Source mailbox records UI context; command execution does not require that membership to survive an archive. A nullable placement reference may disappear without losing the target. Capture account revision and a monotonic sequence under a message row lock when accepting each intent. The Gmail path reconciles overlays in sequence across all labels; original flags may be retained for current UI feedback but are not proof of remote state.

For Google account creation, store NULL IMAP endpoints/username/password, empty IMAP capabilities, explicit SMTP username=email, and resolve SMTP OAuth credential through the existing Google account grant. Do not let SMTP username fallback reference a NULL `imap_username`. `smtp_uses_imap_credentials` remains for generic IMAP and is false for Gmail; OAuth credential resolution must be independent of that password-sharing flag. Receive diagnostic naming is an internal DTO/column adaptation in the existing connection panel, not a new setup flow.

## Conditional uniqueness

The following SQL illustrates **proposed constraints only**. It is not a runnable migration and is not to be executed in P0.

```sql
-- One native message per account; IMAP OBJECTID ingestion is unaffected.
CREATE UNIQUE INDEX messages_gmail_identity_unique
  ON messages (account_id, provider_message_id)
  WHERE receive_transport = 'gmail';

-- Preserve the real IMAP remote placement identity.
CREATE UNIQUE INDEX mailbox_messages_imap_identity_unique
  ON mailbox_messages (mailbox_id, uid_validity, uid)
  WHERE receive_transport = 'imap';

-- Includes virtual All Mail materialized membership when used for existing DTOs.
CREATE UNIQUE INDEX mailbox_messages_gmail_membership_unique
  ON mailbox_messages (mailbox_id, message_id)
  WHERE receive_transport = 'gmail';

CHECK (
  (receive_transport = 'imap' AND uid IS NOT NULL AND uid > 0
   AND uid_validity IS NOT NULL AND uid_validity > 0
   AND (modseq IS NULL OR modseq > 0))
  OR
  (receive_transport = 'gmail' AND uid IS NULL
   AND uid_validity IS NULL AND modseq IS NULL)
);
```

Gmail label uniqueness is `(account_id,provider_mailbox_id)` for Gmail remote views; virtual mailbox uniqueness is `(account_id,view_kind)` where `view_kind='all_mail'`. Keep current active-path uniqueness for IMAP. A virtual path uses a reserved internal namespace distinct from user label names; `view_kind` and UUID drive behavior. Inbox path remains `INBOX`. A custom label with a display name matching “All Mail” is a different mailbox. Gmail role/view metadata never pretends a virtual folder has a provider ID.

Use PostgreSQL TEXT for Gmail native IDs and decimal history. No conversion from existing provider IDs and no global provider-ID uniqueness for IMAP. An upsert returns the existing UUID on conflict; metadata, memberships and work completion commit together. Preserve tombstoned identity rows and dependent caches during native expiry recovery; ordinary later cache retention is separate and must respect pins. A deleted message may have zero memberships, so search/conversation read projections exclude `remote_missing_at` and use active eligible placements without deleting cache rows.

Use indexes on native work due time, message missing/inventory generation and Gmail command order only where corresponding queries require them. Avoid large JSON account inventories or accumulating all history in RAM. Gmail `provider_history_id` is the last observation used for stale-response protection, never an account checkpoint.

## Native operational tables

### `gmail_account_sync_state`

One row per account, PK/FK `account_id`, constant Gmail discriminator and composite account/transport FK. Proposed fields:

- `status`: `not_started`, `initializing`, `ready`, `reconcile_required`, `reconciling`, `blocked`; `recent_ready`, `inventory_complete` as separate coverage flags.
- `history_id TEXT NULL`: committed account checkpoint; `baseline_history_id TEXT NULL`: pre-enumeration/recovery baseline. Both decimal validated; no signed-bigint storage assumption.
- `account_revision BIGINT`, `inventory_generation BIGINT`, `inventory_run_id UUID`; inventory phase, explicit recent/historical date boundaries and `inventory_next_page_token TEXT NULL`.
- `history_run_id UUID NULL`, `history_start_id TEXT NULL`, `history_next_page_token TEXT NULL`, `history_candidate_id TEXT NULL`, `history_pages_complete BOOLEAN`. Separate inventory/history cursors allow history between backfill slices.
- `inventory_pages_complete BOOLEAN`, `needs_work BOOLEAN`, `next_attempt_at TIMESTAMPTZ NULL`, fixed error category and bounded counters/timestamps for progress/diagnostics.
- Conservative distributed quota reservations: `quota_minute BIGINT`, `quota_current_units BIGINT`, `quota_previous_units BIGINT`, nonnegative checks. Under a short project-keyed transaction advisory lock, normalize each account's current/previous minute and sum both buckets for account/project admission. Charging before HTTP, with no refund for abandoned attempts, remains conservative through worker crashes. Current plus previous whole-minute totals upper-bound any rolling 60-second consumption; this deliberately trades throughput for a simple safe limiter. Initial readiness also creates a sync-state row before its first Gmail request.

Nullable checkpoint does not mean “no work”: bootstrap begins from baseline H0, and the first fully processed history sweep commits H1. Recovery keeps the expired checkpoint for diagnostics but uses the new baseline as sweep start. Validate legal run/candidate/page-completion combinations with CHECKs; the final CAS predicates include revision/run/expected checkpoint and zero pending work. Queue payload does not contain any of these checkpoint values.

### `gmail_sync_work`

Proposed key `(account_id,run_id,purpose,gmail_message_id)` with purpose `inventory` or `history`; TEXT native ID, account revision, due/attempt/error and bounded processing state. Page ingestion inserts/upserts pending IDs and changes its matching cursor in the same transaction. Retrying a page cannot erase a previously completed observation. Repeated events may requeue an ID in a later page; reconcile current state idempotently. Do not suppress all later occurrences for an entire long sweep, because the remote message may change again.

Work rows represent only staged pending/retry work and bounded completion receipts needed for the active page/run; retire completed rows once cursor/projection commit makes them redundant. Pending IDs are bounded by configured page intake; finish/drain a page before staging many more. Inventory generation on message rows supports unseen-ID reconciliation, so no separate full identity inventory table is needed. Ignore abandoned run work by run/revision, then clean it in bounded batches after safe state transitions. No generic `migration_runs` or before-image retention is added.

## DDL, authority and restore compatibility

Future implementation must deliver these items together:

1. Final Drizzle `schema.ts` definitions, relations/composite keys and conditional constraints; generated new SQL migration, snapshot and `_journal.json`, with all shipped 0000–0035 hashes unchanged. Do not choose/reserve a sequence number until the implementation branch is based on its actual release head. No data-copy/reconciliation SQL or upgrade tool for old Gmail rows.
2. Fresh provision through the existing migration runner: complete historical DDL chain plus new final-model DDL, ordinary scoped owner and separate pgboss state. Existing `migrate.ts` bootstrapping/local-search initialization must still succeed on empty data; do not rewrite authentication foundation.
3. An explicit startup/release guard refusing a populated legacy mail installation as a native release target **before** account/provider work or DDL that assumes native identity. The recommended deployment target is a new database, not making old Gmail records pass new checks. Exact supported empty-schema/provisioning detection is an implementation review item, not a migration inventory tool.
4. Update reviewed object inventory in `scripts/postgres/99-maildock-authority.sql` for the two new tables and any actual reviewed function changes. Retain `database-authority.ts` scope, ownership and privilege checks; no superuser/bypass/security-definer shortcut for the adapter.
5. Preserve/review immutable outgoing/blob snapshot functions, conversation reconciliation/triggers from 0017, generated search vector/functions from 0019/0032, content-to-search triggers and account ownership. Canonical Gmail rows must not create duplicate conversation members. No new SQL function is needed solely to convert Gmail identity.
6. Update restore preflight/compatibility and `restore-verification.ts`/migration-history rules for the new release, checking tables, nullable types, composite/partial uniqueness and relevant trigger/function definitions. Current search function matching depends on complete hash-verified history; do not replace it with last-migration-only logic.
7. Publish a backup/binary/schema compatibility matrix: old backup with matched old binary only; native backup with matched native schema/binary/keys/blobs. Verify a native restore with expired history runs native reconciliation and preserves local UUIDs. Do not whitelist old Gmail records or translate old queued jobs into the fresh database.

Shipping history remains immutable even though the target installation is empty. A release guard and the operator's new-volume workflow prevent accidental in-place activation; they do not implement a migration. No database commands, migrations, restore utilities or schema changes are executed or authored during P0.
