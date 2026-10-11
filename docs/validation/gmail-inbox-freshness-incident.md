# Gmail INBOX freshness incident

Branch: `codex/gmail-api-complete-provider`. Investigation: 2026-10-11.
All evidence timestamps below are UTC (Europe/Warsaw is UTC+02:00).
The running deployment was inspected only; this change was not deployed.

## Actual seven-message reconciliation

At **08:04:49.094**, a bounded, read-only Gmail comparison returned exactly seven
INBOX identities and three unread. It used one `messages.list(q=in:inbox)` and
seven `messages.get` requests: **8 Gmail requests / 145 endpoint units**. OAuth
used the existing encrypted grant and client configuration; the temporary access
token stayed in memory. PostgreSQL diagnostics used SELECTs with
`default_transaction_read_only=on`. No message bodies, subjects, tokens or full
message identities were printed or saved. No Gmail messages were modified.

| Redacted message | Remote unread | Canonical message | Local INBOX / flags              | Pending work | Failure stage     |
| ---------------- | ------------- | ----------------- | -------------------------------- | ------------ | ----------------- |
| `1a12…be2c`      | Yes           | Absent            | Absent                           | Absent       | 1: not discovered |
| `1a12…18bc`      | Yes           | Absent            | Absent                           | Absent       | 1: not discovered |
| `1a12…180b`      | Yes           | Absent            | Absent                           | Absent       | 1: not discovered |
| `1a03…9fec`      | No            | Present           | Present, Seen + Flagged, visible | None         | Correct           |
| `19b2…9673`      | No            | Present           | Present, Seen + Flagged, visible | None         | Correct           |
| `1995…f295`      | No            | Present           | Present, Seen + Flagged, visible | None         | Correct           |
| `1978…3cf1`      | No            | Present           | Present, Seen + Flagged, visible | None         | Correct           |

The three unread messages also have CATEGORY_UPDATES and INBOX remotely. The
four read messages have STARRED/YELLOW_STAR, INBOX, and CATEGORY_PERSONAL or
CATEGORY_UPDATES; the first two also have IMPORTANT. Each existing message has
its All Mail placement as well. None is remotely missing or action-hidden.
There is no evidence of a projection/API/UI omission for the three missing
identities: they do not exist in the canonical database at all.

At **08:03:58.173**, the persisted INBOX counter was **4 / 0 unread**, last sampled
at **2026-10-10 18:23:38.992**. The account held **41,277** canonical messages
(count sampled at 08:05:28). Historical inventory had already completed by the
investigation: no active inventory phase/run; the active backlog was historical
**history work**, not current P2 inventory. The reported deployment symptom must
not be confused with the account phase at inspection time.

## Confirmed cause and execution path

At 08:03:58 there were **2,256 pending history items, all P0**, and seven complete
history receipts. Oldest discovery: **07:55:06.700**. History was still paginating:
104 pages, `history_pages_complete=false`, `history_drain_due=true`, applied/start
checkpoint **12854430**, no final candidate, burst=8. At **08:05:28.371** page count
was **115**, still incomplete; latest discovery was **08:05:01.541**. Discovery
therefore progresses, but has not reached the three new identities. Completed
jobs or older projections do not establish current-INBOX freshness.

The shared SQL priority decision is used by both pg-boss admission and the
authority-holding worker. Admission freezes a class; the worker checks it again
after OAuth and the account lock and yields if it changed. No evidence of an
admission/worker class mismatch was found. Quota and `next_attempt_at` apply to
the whole account, including history discovery.

A final bounded, read-only history-page probe at **08:21:01.024** sampled the
current discovery cursor at page **196**: 100 records, 106 generic message
references, **zero generic references with labels**, and 35 typed events with
message/changed labels. There were still more pages. This confirms that the live
historical stream contains the ambiguous references handled conservatively as
P0. The probe added one history.list / 2 units: total live Gmail diagnostic
traffic was **9 requests / 147 units**, with no writes.

`classifyGmailHistory` conservatively assigns P0 when a historical event lacks
label evidence. This is safe classification but **P0 is not synonymous with the
current INBOX**. The live all-P0 backlog demonstrates the resulting loss of
relevance. A newly arrived identity has no priority until its history page has
been reached. Alternating 12-item drains and history discovery, the 4,500 pending
high-water guard, and old-first ordering can delay that discovery further. The
existing history probe operates after page exhaustion, so it cannot bypass an
unfinished history traversal. Counter refresh at first/final history boundaries
does not independently reconcile INBOX identities during the traversal.

Inventory already yields to history between bounded pages; it was not the active
blocker in the live snapshot. P2 consuming the local budget ahead of current P0
is not established for this snapshot. The confirmed failure is **current INBOX
membership depends on reaching new history events through historical work**.

## Quota evidence and diagnostics

The live state repeatedly reported category `quota`: at 08:03:58 the retry deadline
was **08:04:03.109**; at 08:05:28 it was **08:05:32.611**. Actual limits were
4,000 user units/minute, 100,000 project units/minute, and 2,000,000 project
units/day. Background ceilings remain 70% (2,800 / 70,000 / 1,400,000).

Existing logs contain OAuth timing but no quota-source/HTTP-reason information;
there were no sync application events supplying it. At **08:11:31.930**, a newly
observed deadline was **08:12:01.737**, rolling project usage 2,096 and daily usage
36,326. At **08:13:06.764**, rolling project and Google-user ledgers were both
2,540; daily usage was 39,108, deadline 08:13:21.765. These observations alone
cannot prove which earlier refusal occurred: buckets age out, and successful
work does not clear the old category until a checkpoint. **The historical live
quota source (local refusal versus Gmail 429 versus Gmail 403) remains unknown.**
It is not presented as a confirmed local or Google limit.

Minimal diagnostics now preserve:

- `quotaSource=local_budget`, requested units, limiting budget scope, usage and ceiling;
- `quotaSource=gmail_http`, HTTP status, Google reason codes and original Retry-After;
- normalized retry duration, next eligibility and actual worker class P0/P1/P2.

Deferred-error diagnostics use warning level when available, so default info-level
production logging retains them. They never include response bodies, tokens,
message contents or identities. Regression tests distinguish local refusal,
HTTP 429 and HTTP 403 rate limits from authentication, access and other failures.
No quota settings were increased. Google's documentation describes the separate
[HTTP status and JSON reason fields](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

## Changes and safety

Add a dedicated **INBOX observation**, selected as P0 by the same admission/worker
decision. After recent initialization it is due on first use and 60 seconds
after successful completion, matching the existing normal history interval.
It precedes historical drain/discovery, including P2 inventory backlogs. Existing
quota and retry deadlines still gate execution; there is no new polling timer.

Each slice lists at most 12 remote INBOX identities, obtains their current
metadata and uses the existing idempotent projector. Durable fields record
observation start, page token, page exhaustion and last successful completion.
The token advances only after all page identities have been projected. A failed
GET/crash replays the page safely. A rejected INBOX page token restarts only this
observation, without touching history. Account revision changes invalidate the
observation fields alongside the existing run reset.

After listing, up to 12 old local INBOX placements per slice receive exact GETs.
Only current remote metadata/404 can remove membership; absence from a paginated
listing never deletes a message. Completion publishes the remote INBOX counter.
Account locks, revision fences, canonical uniqueness, history run IDs,
checkpoints and durable history receipts are preserved. No full resync, Push,
OAuth reconnect or production configuration change is involved.
The Gmail API supports bounded pages and requires GETs for details, as documented
in [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

Schema migration `0043_gmail_inbox_freshness` only adds four columns; no existing
sync data is rewritten. It has been exercised on disposable databases, not the
live database. Deployment must run the migration before the new application.

The account settings distinguish **Synchronizing**, **Waiting to retry**, and
**Sync needs attention**. Quota backoff clears the permanent IMAP error marker;
OAuth, access/API-disabled, checkpoint/reconciliation and other errors remain
visible. A successful INBOX observation clears the transient quota category.

## Acceptance and regression measurements

The fixture uses the real sync service, quota reservations, account lock,
projector and PostgreSQL migrations, with synthetic Gmail responses. It contains
20,000 historical identities, 20,000 durable P2 entries plus 5,000 ambiguous P0
entries, seven current INBOX messages (three unread), and four initially local
read INBOX messages. It injects HTTP 429 while historical work remains pending.

Before the independent path is enabled, 12 productive historical slices leave
INBOX at four messages: the three current arrivals remain undiscovered. The
reported live incident had exceeded ten minutes without convergence; that is
user-reported elapsed time, not a measured synthetic baseline.

After enabling the path, the first list encounters quota backoff. A delivery
inside the retry deadline makes **zero Gmail calls**. After retry eligibility,
one slice projects all seven identities; the next publishes the 7/3 counter and
completes the observation while **over 20,000 work entries remain pending**.
The observation uses **10 requests / 151 units**, including the rejected list:
two lists (10), seven metadata GETs (140), one label GET (1).
At a modeled two-second delivery cadence plus the actual 30-second error delay,
membership and counter converge within **32 seconds from the failed first
delivery**. The retry deadline is advanced only in the disposable test to avoid
sleeping: this is a scheduling model, not a 32-second wall-clock/live measurement.

Additional regression exercises 15 INBOX identities over multiple pages, a
partial page GET failure/replay, and an archived local INBOX message with no
history event. It verifies no duplicate memberships and preservation of the
canonical archived message. Existing priority regressions retain coverage for
admission/worker agreement, deadlines, fairness, revision fencing, receipts and
checkpoint failure handling.

Recorded single-test wall-clock measurement (synthetic HTTP and disposable DB):

| Path                                                        | Wall time | Gmail calls | Endpoint units | Result                                         |
| ----------------------------------------------------------- | --------- | ----------- | -------------- | ---------------------------------------------- |
| Previous path, 12 historical slices                         | 5,084 ms  | 144         | 2,880          | Still 4 INBOX / 0 unread                       |
| Independent observation, retry deadline advanced by fixture | 562 ms    | 10          | 151            | 7 INBOX / 3 unread; 24,856 items still pending |

The 562 ms excludes the modeled backoff wait and production queue cadence. It
must not be reported as real Gmail convergence latency. MailboxService, used by
the mailbox API, also returns synchronized count 7 and local/remote unread 3.

Validation completed:

- Broad focused suite: **127 passed, 1 optional benchmark skipped**, five files
  (`gmail-provider.integration`, `gmail-priority-review.integration`,
  `gmail-client`, `gmail-history-priority`, `gmail-foundation`), 231.65 seconds.
- After retry-diagnostic changes: **19 passed** focused acceptance, quota and
  HTTP classification cases.
- Additional admission regression confirms due INBOX is admitted/executed as
  P0 despite a historical P2 fairness selection. Persistent history errors keep
  their own retry path instead of being cleared by an unrelated INBOX success.
- The final acceptance replay includes initially stale 4/0 remote counters and
  validates the mailbox API service's resulting 7/3 counts.
- After the persistent-error guard, **3 final acceptance/admission/replay cases
  passed**; typecheck and lint were rerun successfully on that final source.
- Typecheck (web and worker), repository lint, changed-file Prettier checks and
  `git diff --check` pass. Generated Drizzle snapshots use the repository's
  existing formatting exclusion; SQL is checked for whitespace and exercised
  through real migrations.

## Remaining limitations

This change does not guarantee freshness while Gmail denies requests, OAuth is
revoked, an interactive command holds precedence, or the worker is unavailable.
A large INBOX needs multiple bounded slices and more quota; it is not assigned
an unconditional time bound. Remote pages are not an atomic Gmail snapshot.
Concurrent changes converge through the next observation/history pass. Old
history still needs draining; this patch gives current INBOX an independent
opportunity rather than changing conservative history classifications.

Production after-change convergence and the precise historical quota source
require a separately approved deployment and observation. Neither was fabricated
or tested by mutating the live account. The UI's existing refresh cadence adds
display latency after database convergence.
