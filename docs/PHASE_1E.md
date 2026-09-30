# Phase 1E: mailbox delta synchronization

The worker uses PostgreSQL as the mail read model. A `mailbox-delta-sync-v1` pg-boss job contains only a version, account ID, mailbox ID, and reason. The browser refreshes the current local message list every 20 seconds while visible. No browser request talks to IMAP.

## Checkpoint and recovery

`mailboxes.delta_uid_validity`, `delta_last_seen_uid`, and `delta_highest_modseq` are the durable checkpoint. Status, sanitized error, start/completion, and last-success timestamps aid diagnosis. New metadata and its UID checkpoint are committed together in a bounded database transaction. If the worker crashes, a retried batch is idempotent. The MODSEQ checkpoint advances only after all flag changes and known-UID removal checks succeed. The saved value is the MODSEQ observed at mailbox SELECT, before subsequent queries, so changes during the run remain eligible next time.

Phase 1C placements in the current UIDVALIDITY epoch bootstrap `delta_last_seen_uid` from their maximum UID. If the recent-window sync found no messages, the first delta sync repeats the recent-date search up to the UIDNEXT frontier observed at SELECT, then records that frontier. This prevents an empty recent window from importing all history. A crash during this bootstrap repeats it. UIDNEXT is used only as an exclusion frontier in this case, never as evidence that a particular UID exists. Subsequent new-message searches use UID greater than the checkpoint, allow gaps, and fetch metadata in configured batches. They do not fetch bodies or attachment data.

Each delta sync selects the mailbox read-only and checks UIDVALIDITY before using UIDs or MODSEQ. A changed epoch deletes old UID-scoped placements, resets the delta checkpoint, and schedules the Phase 1C recent-window rebuild. Message and downloaded content rows remain for future garbage collection. Recent sync also clears the delta checkpoint when it sees a changed epoch.

## Flags and removals

When CONDSTORE and a saved MODSEQ are available, `FETCH 1:*` with ImapFlow's public `changedSince` option requests only UID, FLAGS, and MODSEQ. Unknown flags are preserved. A newer placement MODSEQ wins over an older response. Without a valid MODSEQ baseline, bounded UID FETCH batches revisit all locally indexed placements. This fallback costs O(local placements) flag traffic per poll; it never downloads bodies. Known local UIDs are also checked in bounded UID SEARCH batches. Only locally indexed UIDs confirmed absent are removed. Old remote UIDs outside the recent window are never imported for reconciliation. Sequence-only EXPUNGE events are wake-ups, not deletion evidence.

ImapFlow 2.0.6 exposes `changedSince` and expunge events, but its public `mailboxOpen` API does not accept a durable QRESYNC UID set or MODSEQ checkpoint. Phase 1E therefore does not enable QRESYNC. Explicit UID reconciliation supplies correctness on servers with or without QRESYNC and OBJECTID.

## Wake-ups and concurrency

The worker polls eligible initialized mailboxes every `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS` (default 300, allowed 30–3600). pg-boss singleton keys collapse pending jobs by mailbox. A session-level PostgreSQL advisory lock serializes recent and delta jobs for the same mailbox across workers; the reserved connection releases it in `finally`. IMAP network work runs outside a database transaction. A busy lock causes the job to retry under pg-boss backoff.

One IDLE connection is kept per enabled, initialized INBOX when the server advertises IDLE. Other folders use polling. ImapFlow's supported automatic IDLE and `maxIdleTime` handle protocol renewal. `exists`, `flags`, `expunge`, and mailbox close only enqueue a delta job. The watcher reconnects with bounded exponential backoff and jitter, and enqueues a delta after reconnect. It does not mutate mail tables. Disabling an account closes its watcher on the next manager refresh; worker shutdown closes all watcher connections. Polling is the correctness path after missed events, disconnections, or restart.

The manual Sync action schedules a delta for initialized mailboxes and recent sync for uninitialized mailboxes. Discovery follows the same rule. The existing authenticated, Origin-checked mutation route remains in use.
