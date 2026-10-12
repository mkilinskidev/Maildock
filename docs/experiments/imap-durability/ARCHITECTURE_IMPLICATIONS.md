# Architecture implications of Phase 3

The approved documents are unchanged. This report records experimental findings
and proposed clarifications requiring a separate architecture review. Nothing here
authorizes production synchronization code.

## Assumptions supported

Real PostgreSQL transactions can couple bounded metadata and coverage atomically.
SIGKILL during insertion/frontier work leaves the old visible state; killing after
commit leaves a usable new boundary. Reloading durable facts resolves a lost COMMIT
response and makes remaining history discoverable without a continuation ledger.
PostgreSQL placement uniqueness and a small set of coverage facts suffice for the
tested replay cases. No staging table, searched-UID queue or receipt set was needed.

Monotonic receiving-owner generation plus transactional fencing rejects an expired
worker's buffered FETCH, including after its database backend is lost and it
reconnects. A single authoritative data operation per account avoids competing
normal writers; different accounts still share workers and small database pools.
Active epoch visibility and revision fencing prevent stale resurrection following
confirmed deletion and UIDVALIDITY replacement.

Complete membership SEARCH remains separate from FETCH/flag evidence. An omitted
metadata result is unresolved, never an expunge. Conservative replay rechecks the
range on a fresh selected connection. Counts do not prove membership, including
equal-count delete/arrival. Partial CHANGEDSINCE remains an optional optimization,
not an absence mechanism; this coordinator uses the full bounded metadata/flags
fallback rather than a global MODSEQ checkpoint.

The network trials support the original 10 s total-turn hypothesis for the measured
healthy/limited profiles. No deadline was raised to hide a failure. A 100 ms requested
relay profile measured approximately 124 ms NOOP median; fresh availability remained
below 1.4 s in that small single-account test. This is not a provider SLA. A hung
command occupied about 10.02 s before destruction/replay. Kernel netem packet loss
was confirmed from actual drop counters, not assumed from requested settings.

## Minimal clarifications required

1. **Authority at commit.** Define the fencing linearization point inside the DB
   commit path, not solely before returning from an application callback. This
   experiment uses a deferred constraint trigger to reject delayed COMMIT after
   expiry. A production alternative must supply equivalent evidence and account
   for locking/transaction timing. It need not copy this trigger mechanically.
2. **Same-owner obsolete results.** Make the turn token/revision rule explicit.
   The experiment stores one mailbox revision to prevent ABA across cursor wrap,
   confirmed deletion and old callbacks. An equally proven ephemeral-token design
   can avoid that field; owner generation alone cannot replace the requirement.
3. **Database timeout settlement.** Socket inactivity and per-statement timeouts
   do not settle a suppressed COMMIT acknowledgment. A total DB budget must include
   admission/startup/BEGIN/commit, abort actual I/O and resolve durable uncertainty
   before releasing the account. A late-callback reproduction found that native
   close alone is insufficient: postgres.js callback cleanup rolled back a newer
   transaction on its reused connection. The repaired experiment explicitly owns
   transaction commands and invalidates guarded SQL creation/execution on retirement.
   The post-fix callback and prepared-query cases pass; earlier performance is
   labeled pre-fix. A supported production boundary remains to be selected. Before backend
   PID identification, the experimental watchdog conservatively retires its pool's
   sockets; after identification it retires only the affected connection. This
   collateral reconnect tradeoff needs review, not an unsupported precision claim.
4. **Shutdown/recovery selection.** Quiescence does not clear already-persisted
   current demand. An early load harness completed all history before its last
   fresh check, withholding two arrivals for about 179 s. It was corrected to
   flush current demand first and rotate historical work across accounts. The
   original measurement is retained. Recovery must use the same admission rules
   as normal operation rather than a mailbox-draining shortcut.
5. **Measurement definitions.** Separate selector admission, actual wire command
   admission, operation completion, and independently observed availability. An
   early selector-sampling integral severely understated utilization; final load
   instrumentation sums actual admitted operation occupancy. Requested 20/100 ms
   network settings are not measured RTT values.

## Resource interpretation

History is permitted to make no progress while all accounts have eligible current
demand. The saturation runner asserts unchanged historical frontiers during that
phase and bounded ready/user/running sets. Once current demand stops, it first
commits the final arrivals and rotates real history operations, then performs repair
and independent comparison. W=1 has no physical headroom; W>=2 leaves a current
opportunity while history uses at most W-1 slots. Database admission is bounded and
prioritizes short ownership/due control ahead of history; no normal transaction is
held across IMAP I/O.

Optional watchers, arbitrary socket-count scaling, pg-boss producer/delivery and
full application business persistence are deliberately absent. Actor sessions are
independent test clients and are included when interpreting server session counts.
A remote account's ten-session rejection during takeover establishes the practical
recovery delay; a PostgreSQL lease cannot promise instantaneous remote revocation.

## Remaining obligations

Persistence-backed permanent poison UID recovery, billion-sized real UID gaps,
provider/OAuth compatibility, production notifications/conversations, user mutation
uncertainty, full MIME cache publication and bounded obsolete-epoch cleanup remain
unproven. Some are outside Phase 3; none may be implied by passing small read tests.
Retained scripted unsafe reproductions still show why K=128 is a work size rather
than a parser-token ceiling, and why private transport hooks need separate review.

The quantitative load/convergence findings belong in [PERFORMANCE_RESULTS.md](PERFORMANCE_RESULTS.md).
The recommendation is an architecture-review input, not a production approval.
