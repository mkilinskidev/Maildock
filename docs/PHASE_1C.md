# Phase 1C: recent message index

Phase 1C stores a bounded, recent metadata index. It deliberately does not synchronize message content.

## Storage and identity

`messages` stores account-scoped envelope metadata, IMAP `INTERNALDATE`, declared RFC822 size, optional provider email ID, and normalized MIME structure. RFC Message-ID is optional, untrusted metadata and is neither unique nor a deduplication key.

`mailbox_messages` stores the remote placement. Its unique remote identity is `(mailbox_id, uid_validity, uid)`. IMAP sequence numbers never cross the provider boundary. An unseen placement creates a new local message unless a future phase introduces a provider identity rule with proven semantics. Consequently, duplicates across mailboxes are acceptable; false cross-account or heuristic merging is not.

## Recent-window synchronization

`MAILDOCK_INITIAL_SYNC_DAYS` defaults to 30. The worker subtracts that many UTC calendar days, rounds the cutoff down to UTC midnight, opens the mailbox read-only, and performs UID SEARCH with IMAP `SINCE`. `SINCE` compares IMAP `INTERNALDATE` by calendar date, not timestamp, so the cutoff day is intentionally included. This overlap is preferable to missing messages.

Search results are split into `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE` batches (default 150). Each UID batch is streamed with explicit fetch fields: UID, FLAGS, MODSEQ when the server supplies it, INTERNALDATE, RFC822.SIZE, ENVELOPE, BODYSTRUCTURE, and emailId when the server supplies OBJECTID. The fetch iterator is fully consumed before its bounded buffer is persisted. No source, headers, bodyParts, download, or downloadMany operation is requested.

Absence from this recent search never deletes an existing placement. It is not a complete mailbox snapshot and does not implement expunge reconciliation.

## UIDVALIDITY

The UIDVALIDITY returned by read-only mailbox selection is authoritative and is stored separately as `recent_sync_uid_validity` from the discovery STATUS observation. A previously absent value is recorded before batches are associated. A changed value transactionally deletes that mailbox's old UID-scoped placements, records the new epoch and change diagnostics, and then rebuilds the recent index. Unreferenced historical `messages` may remain. A UID from a new epoch can never alias an old placement, even if mailbox discovery observed the new epoch before message synchronization selected it.

## MIME and attachments

BODYSTRUCTURE is converted into provider-neutral JSON containing part identifier, lowercase content type and disposition, filename (disposition filename or content-type name), transfer encoding, decimal declared size, content ID, content/disposition parameters, and child hierarchy. `has_attachments` is true for an explicit `attachment` disposition or filename/name metadata. An inline or non-text part without a filename is not automatically presented as an attachment. No MIME-part bytes are stored.

## Jobs, state, and failure behavior

`mailbox-recent-sync-v1` is a durable pg-boss queue with an IDs-only versioned payload. A mailbox singleton key prevents concurrent jobs for the same mailbox; worker concurrency defaults to 2. Mailbox discovery schedules active selectable mailboxes after its database work commits, and an enqueue failure does not roll back successful discovery.

Mailbox state is `not_started`, `pending`, `running`, `success`, or `failed`, with requested/started/completed timestamps, sanitized error, cutoff, result count, and last-success timestamp. Batches commit independently. A later failure retains earlier batches, and retries re-search safely because the remote placement unique key makes persistence idempotent. Existing flags and MODSEQ are refreshed.

The authenticated list API uses PostgreSQL only, orders by `(internal_date, message_id)` descending, and uses a stable keyset cursor with a maximum page size of 100. The refresh mutation only enqueues work and applies the existing Origin/CSRF check. The UI renders local sender, subject, INTERNALDATE, read/flagged state, and the conservative attachment indicator.

## Deferred

Phase 1C does not include historical backfill, full reconciliation, message bodies, arbitrary headers, raw RFC822 source, attachment files, content rendering, IDLE, CONDSTORE/QRESYNC incremental fetch, threading, search, sending, or message mutations. Those remain Phase 1D or later work.
