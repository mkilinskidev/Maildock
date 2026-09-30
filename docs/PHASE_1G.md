# Phase 1G: progressive historical metadata backfill

After recent sync succeeds, the worker schedules `mailbox-backfill-sync-v1`. Each invocation opens the mailbox read-only, verifies UIDVALIDITY, and examines at most `MAILDOCK_BACKFILL_CHUNK_SIZE` UIDs (default 500) below the durable frontier. It uses `UID SEARCH` within that bounded numeric range, then fetches only envelope, flags, MIME structure, size, INTERNALDATE, MODSEQ, and EMAILID metadata for returned UIDs. Bodies, raw messages, and attachment binaries are never requested. A `SEARCH` hit omitted by `FETCH` is searched again. If it still exists, the job retries the range; if it disappeared, the range can safely advance.

The mailbox stores `backfill_uid_validity`, `backfill_frontier_uid`, `backfill_status`, `backfill_error`, and `backfill_completed_at`. The initial frontier is SELECT's `UIDNEXT - 1`. Each chunk uses the Phase 1C `(mailbox, UIDVALIDITY, UID)` placement upsert and commits the next descending frontier in the same transaction. A crash before that transaction leaves the previous frontier for retry. Frontier zero means the entire older UID space for that epoch has been traversed, including gaps and an empty mailbox. INTERNALDATE only supports display ordering; it is not a checkpoint. A UIDVALIDITY mismatch resets backfill state and requests the existing recent rebuild; delta's epoch recovery also resets it.

Recent and delta jobs use pg-boss priority 10; backfill uses -10, one local worker slot, and a five-second continuation delay. Backfill yields when that mailbox has queued recent or delta work. All three workers share the `mailbox-sync:<mailboxId>` advisory lock. A periodic backfill poll repairs a crash between a committed chunk and continuation enqueue, and skips disabled accounts, missing mailboxes, and completed mailboxes. The account mailbox diagnostics show status and the next UID frontier.

## Manual verification with an older message

1. Apply migration `0009`, set `MAILDOCK_BACKFILL_CHUNK_SIZE` if the default 500 UID span is unsuitable, and restart web and worker processes.
2. Use the existing mailbox with a known message older than 30 days. Trigger recent sync or reconnect the account and allow discovery/recent initialization. Confirm recent messages are usable immediately.
3. In account discovery diagnostics, watch history move from pending/running to complete and the frontier decrease toward zero. The old message should appear in its mailbox list before or by completion. Refresh the list if already open.
4. While history imports, send or receive a new message and refresh; confirm recent/delta sync still shows it. Restart the worker mid-backfill and confirm the frontier resumes without duplicate placements. Do not rely on the old message's date as a progress cursor.

The full automated suite covers provider UID traversal, sparse ranges, omitted FETCH responses, transactional progress, retries, UIDVALIDITY recovery, scheduling priority, shared lock, empty and disabled/missing mailboxes, and prior phases.
