# Native Gmail staging qualification

Use a separate fresh staging installation and an explicitly authorized disposable
Google mailbox. Do not use the owner's production Gmail account, database, blob
namespace or credentials. Deployment/merge is outside the implementation task.

1. Review the implementation commit and run the normal database-authority checks.
   Apply additive migrations through 0037 on the fresh staging database. Confirm
   the PostgreSQL role/authority contract and recovery-manifest verification.
2. Configure the existing Google OAuth Client ID/Secret and exact staging callback
   using the existing settings. Enable Gmail API for that same Cloud project.
   Inspect its actual per-user/per-project allocations in Cloud Console and set
   the three `MAILDOCK_GMAIL_*` budgets conservatively. Retain the existing scopes.
3. Authorize the staging mailbox through the existing Google tile. Verify OAuth
   readiness and Gmail API connection diagnostics; receiving must create no IMAP
   session. Revoke/reconnect once and test a disabled API/access-denied condition.
4. Seed identifiable recent/old mail, Spam, Trash, custom labels and remote drafts.
   Verify recent-ready before full coverage; label rename keeps local UUIDs; one
   message with several labels produces one search/conversation result. Remote
   drafts must not appear as editable local drafts. Confirm folder counters settle
   after synchronization. Compare complete native ID/label coverage after import.
5. Open plain, HTML, nested alternative/mixed/related and non-UTF8 messages. Verify
   sanitizer, iframe isolation, blocked remote images/sender allowlist, inline CID
   images, downloads, attachment size rejection and content retry feedback. Bodies
   should not be fetched by initial metadata import; local search should find body
   text only after fetching. Check light/dark themes and keyboard navigation.
6. Read/unread, star/unstar, archive from Inbox and a custom label, native move via
   the existing action endpoint, and Trash. Verify global flags and preservation
   of unrelated labels in Gmail and Maildock. Interleave changes in another Gmail
   client; retry after network interruption and confirm no stale intent reversal.
7. Compose, reply and forward with To/Cc/Bcc and attachments. Exercise local draft
   autosave/restore. Verify SMTP accepted/failed/uncertain handling, no automatic
   uncertain resend, server-managed SENT correlation and absence of IMAP APPEND.
   Check explicit custom Sent-copy error feedback.
8. During backfill, read/download/send and execute actions with pool size one.
   Restart the worker before and after a page publication. Trigger manual Refresh,
   disable/reconnect an account, and confirm durable work resumes with revision
   fencing. Simulate lost queue wakeup; the poller must restore eligible work.
9. Create new Inbox mail and concurrent label changes during history replay.
   Verify one notification per eligible arrival and no historical notification
   flood. Exercise expired-history reconciliation with injected/staging-only API
   fixtures; partial inventory must preserve UUIDs/cache and never infer absence.
10. Lower quotas to observe background pause and interactive reserve. Exercise
    Retry-After/429 and transient failures without a checkpoint jump. Confirm logs
    and queue payloads contain no tokens, message bodies or personal headers.
11. Repeat representative password IMAP and Microsoft OAuth IMAP receiving, reader,
    commands, SMTP, drafts, search, conversations and UIDVALIDITY recovery. Perform
    the existing security browser suite on the isolated staging origin.

Record commit, image/runtime versions, actual Cloud allocations, mailbox size,
recent/full times, quota usage, retries, UUID/membership comparisons and every
failure. Live performance must be reported separately from the synthetic report.
Release remains blocked until these live OAuth/MIME/SMTP/Cloud-budget and browser
checks pass and the owner approves deployment.
