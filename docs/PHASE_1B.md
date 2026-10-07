# Phase 1B mailbox discovery

Phase 1B discovers IMAP mailbox metadata in durable background jobs. It does not
select every mailbox, issue message `FETCH` commands, or synchronize messages.

## Identity and reconciliation

Every mailbox has an application-generated UUID. That local ID is independent
of its account-scoped remote path, UIDVALIDITY, and any provider OBJECTID.

Reconciliation first matches `(account_id, provider_mailbox_id)` when the
provider supplies a stable mailbox/object ID, including a historical `missing`
row. An active path-matched row without an ID may be upgraded when that ID first
appears. Otherwise the exact `(account_id, remote_path)` fallback applies only
to a currently `active` row. Accounts are never crossed.

A `missing` row without a matching stable provider ID never wins path fallback.
If the same path appears later, Maildock creates a new local UUID and retains
the historical row. Equal UIDVALIDITY is not proof that two observations are
the same mailbox; different UIDVALIDITY proves that UID-scoped state cannot be
reused, but UIDVALIDITY is never general mailbox identity or a rename detector.
Consequently, without a stable provider ID both rename and path reuse are
represented conservatively as an old `missing` mailbox plus a new local
mailbox.

Mailboxes absent from a successful listing are marked `missing`, not deleted.
Their first/last discovery timestamps and prior observations remain. Only a
matching stable provider ID can reactivate a historical row; path alone cannot.
Rows already missing and still absent are left unchanged. A failed listing does
not reconcile at all, so it cannot mark previously known mailboxes missing.

## Remote observations

The table retains the exact remote path and server delimiter. Presentation
hierarchy is derived from those values; `/` is never assumed. `\Noselect` and
`\NonExistent` entries are retained as non-selectable hierarchy containers.

Server LIST attributes are retained, including unknown extension attributes.
Known RFC 6154 flags (`\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`,
`\Sent`, and `\Trash`) are also exposed as special-use values. INBOX is derived
only from the protocol-defined case-insensitive `INBOX` path. ImapFlow's
localized-name heuristics are not accepted as SPECIAL-USE evidence, roles are
not unique, and no English-name heuristic is applied.

UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, message count, and unseen count are
optional observations obtained through LIST + STATUS. They are PostgreSQL
`bigint` values and cross TypeScript/API boundaries as decimal strings. A
reported UIDVALIDITY change updates the observation and increments
`uid_validity_change_count` with `uid_validity_changed_at`. This is the seam for
future invalidation of UID-scoped state; Phase 1B has no messages or cursors to
clean up.

The relevant authenticated capability set is stored on the account:
IMAP4rev2, IDLE, CONDSTORE, QRESYNC, MOVE, UIDPLUS, SPECIAL-USE,
LIST-EXTENDED, LIST-STATUS, and OBJECTID. Future synchronization must make
capability-driven decisions and must not select behavior from provider names.
An OBJECTID is persisted when an adapter can report it. ImapFlow 2.0.6 exposes
mailbox IDs for CREATE/SELECT but not through its LIST/STATUS result, so the V1
IMAP discovery adapter normally leaves this field absent rather than opening
every mailbox or inventing identity.

ImapFlow reports `subscribed: true` as a fallback when neither LIST subscription
metadata nor LSUB produced authoritative state. Because that fallback cannot be
distinguished in the public result, the adapter persists an explicit `false`
when reported and otherwise leaves subscription state unknown.

## Execution and diagnostics

Account creation commits independently, then schedules `mailbox-discovery-v1`
through pg-boss. The same action supports rediscovery. A keyed `stately` queue
prevents queued/active duplicates for one account, while an account-scoped
PostgreSQL advisory transaction lock protects reconciliation. Jobs use bounded
retries with exponential backoff. Disabled accounts fail closed before provider
work.

The account UI reports pending/running/success/failure, last success, active
mailbox count, hierarchy, counts, and a development diagnostics disclosure for
paths, delimiters, attributes, special use, UID observations, and capabilities.
Credentials, authentication exchanges, and protocol transcripts are never
included; ImapFlow logging remains disabled.

## Manual verification

1. Start the web and worker processes (or the Docker Compose stack) and log in.
2. Add an enabled real IMAP/SMTP account; saving must succeed independently of
   discovery.
3. Wait for `Discovering mailboxes…` to become success, or use **Refresh
   mailboxes**.
4. Compare the hierarchy, container folders, counts, and special-use flags with
   an established client.
5. Expand diagnostics and compare delimiter, UID values, and capabilities.
6. Temporarily make IMAP unavailable, retry, and confirm the previous hierarchy
   remains visible; restore connectivity and confirm a later retry succeeds.

Real servers should especially be checked for subscription reporting,
non-`/` delimiters, incomplete SPECIAL-USE metadata, LIST-STATUS fallback
behavior, very large MODSEQ values, and whether OBJECTID metadata is exposed by
a future ImapFlow release.
