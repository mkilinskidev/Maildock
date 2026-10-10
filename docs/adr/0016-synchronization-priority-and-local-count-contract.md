# ADR 0016: Synchronization priority and local count contract

- Status: accepted — product contract approved; phased implementation
- Date: 2026-10-10
- Supersedes: remote unread badge authority and counter-first acceptance in the Gmail latency proposal
- Superseded by: none

## Context

The [cross-provider architecture analysis](../validation/sync-priority-architecture-analysis.md) confirms that Gmail REST and IMAP have no shared INBOX precedence or bounded fairness. Independent queues cannot enforce global precedence. Whole IMAP mailbox operations occupy consumers; Gmail drains account history before taking another page. Counter observations can precede message projection, and independent browser requests can combine new counters with old rows. The [Gmail latency diagnosis](../validation/gmail-read-status-latency-diagnosis.md) reproduces long sweeps, stale remote counters and backoff; it does not establish the cause of the reported live incident or a universal latency bound.

Related records: [ADR 0004](0004-postgresql-background-jobs-with-pg-boss.md), [ADR 0008](0008-initial-sync-and-mail-storage-policy.md), [ADR 0011](0011-progressive-mail-storage-without-retained-incoming-raw-mime.md), [ADR 0012](0012-native-gmail-receive-transport.md), [ADR 0013](0013-gmail-message-identity-and-label-membership.md) and [ADR 0014](0014-gmail-account-history-and-progressive-sync.md). This record does not change the proposed status or outstanding review gates of the Gmail ADRs. Priority classes below are unrelated to roadmap phase names.

## Approved decisions

### Priority and correctness

P0 covers current INBOX arrivals, read/unread flags, archive/delete/move, membership, metadata and corresponding counters. A current change to an old message, including removal from INBOX, is P0. P1 covers current changes elsewhere. P2 covers historical backfill and non-urgent reconciliation. Classify using the affected scope, including previous membership; unknown Gmail identities require classification, not automatic assignment to P1.

P0 receives the next safe scheduling opportunity. Finish active remote operations and commit each consumed batch together with durable progress before yielding and releasing authority. Do not interrupt FETCH, discard receipts, or advance progress over unfinished work. Retry/backoff deadlines override urgency. Admission must be fair between eligible accounts across worker processes, with lower-priority service and P0 headroom.

Gmail retains unfiltered account-wide history checkpoints, durable receipts, run/revision fences, pagination/digest guards, quotas and backoff. INBOX-only work must never advance the account checkpoint past unfinished work. IMAP retains UIDVALIDITY, MODSEQ and UID cursor correctness, mailbox locks, retries, presence confirmation and IDLE recovery. Microsoft OAuth2 is IMAP authentication, not a separate engine. Credentials are acquired outside execution authority where currently required.

### Local unread counts and coverage

The visible INBOX unread badge represents all locally materialized unread messages available in Maildock, including messages beyond the loaded page. This applies to every transport and All Inboxes. It is a message count, not page length or conversation count. Count distinct local message identities within each mailbox, exclude command-hidden placements, and avoid duplicate label/placement counting. All Inboxes must share the enabled, active, selectable INBOX scope of its rows and deduplicate account/message identities.

Store and expose remote Gmail/IMAP observations separately; never silently substitute them for the local count. Preserve optimistic command overlays and eventual reconciliation. Partial import requires separate coverage/freshness information. Equal remote and local totals do not prove coverage or freshness; import completion does not prove current-INBOX coherence. A remote observation can itself be stale.

### Coherent publication

Publish related metadata/flags, membership, local counters and coverage/freshness coherently to selected mailbox, All Inboxes and reader. A new badge must not be combined with stale corresponding rows. A generation timestamp alone cannot guarantee this while intermediate batches remain visible.

Prefer a short coherent database snapshot/API envelope with local aggregates from that same snapshot, then coordinated browser application and request-order guards. All Inboxes requires an account vector, and ready-reader flags and loaded tail rows need refresh/invalidation. These are implementation proposals for Phase 4; larger staged/versioned projections require evidence that the minimal contract is insufficient. No provider-atomic remote snapshot is implied.

## Provisional tuning and performance budgets

Future configurable defaults: fair admission among eligible accounts; at most one outstanding P0 execution slice per account; reserved P0 capacity; a lower-priority opportunity after eight productive P0 slices or 60 seconds of eligible waiting, whichever occurs first, retaining P0 headroom. Rotate P1 and P2 accounts. Yield at safe batch boundaries. Enforce account/global ceilings for workers, DB resources, IMAP connections including IDLE, and Gmail background quota within existing interactive reserves. Numerical connection/worker ceilings remain workload-dependent and must be measured before configuration is chosen.

Target healthy visible-tab INBOX freshness around 10–30 seconds, with proposed p95 ≤30 seconds under a declared reference workload: three enabled accounts, one external change per account/cycle, sub-second provider responses, metadata-only synchronization and ongoing historical import. Record backlog, local INBOX size, pool/worker capacity, IDLE availability and API costs. This is a future measured SLO, not a guarantee. Backoff, quota, offline providers, hidden tabs, unavailable capacity and large sweeps can exceed it. No tuning value above changes runtime behavior in Phase 1.

## Rollout and Phase 1 implementation

1. Contract and foundations: this ADR, provider-neutral classification vocabulary, additive mailbox counter observations and bounded structured debug diagnostics. Existing mailbox fields and writers remain intact. API mailbox fields and aggregate counts are read in one SQL statement; the sample time dates that DB read, not provider freshness or coherent publication. Local counts exclude hidden placements and deduplicate message IDs. Remote observation time remains null because generic updatedAt/delta completion cannot truthfully date every writer. Coverage records remote_sample_exceeds_local when a remote sample exceeds a local total/unread value, otherwise unknown. This is an observed count gap, not proof of partial import: remote samples can be stale and commands can hide placements. Existing recent/backfill and account inventory progress remain the import-state authority; this foundation never claims complete or fresh current-scope coverage. Existing IMAP last successful delta time is exposed with its precise meaning; Gmail has no equivalent truthful timestamp.
2. Admission/fairness: use the policy vocabulary and delivery measurements to implement fair resource admission, preserve retry deadlines, reserve P0 capacity and prevent starvation. Validate cross-process behavior and declare budgets. No prerequisite on speculative database columns.
3. Provider work: resumable IMAP slices and Gmail durable classification/intake, without weakening epoch or checkpoint correctness.
4. Coherent publication/UI: snapshot envelope and coordinated refresh, local badge/All Inboxes cutover, optimistic overlay reconciliation, reader and tail invalidation, truthful current-scope freshness/coverage. **Badge cutover is intentionally deferred:** current independent mailbox/message requests and remote-observation-based overlay acknowledgements cannot safely consume the new local samples. Replacing only the number would preserve misleading publication and risk double-counting commands. The approved local-count decision remains final.
5. Measure and tune freshness within an explicit workload/resource envelope; optional bounded Gmail INBOX reconciliation only if measured backlog warrants it.

Diagnostics reuse Pino at debug level: one delivery event per job with account/transport/mailbox IDs, phase, known delta trigger (otherwise unknown), eligibility wait excluding retry delay, execution duration, retry count and typed lock contention. Returned deliveries are not called successful relevant synchronization: they may skip, defer, or absorb provider errors. Gmail adds bounded phase/deadline and quota/retry/pending-command diagnostics. Counter provenance/coverage and IMAP last-success time are available through the mailbox observation API. Enable LOG_LEVEL=debug for a targeted capture; identifiers are log fields, never metric labels. No credentials, message content, arbitrary errors or folder names are logged. Queue wait measures the current delivery's eligibility age, not the original external event or coalesced trigger age.

## Non-goals and consequences

Phase 1 does not change pg-boss priorities, worker counts/dispatch, remote algorithms, history intake/checkpoints, polling intervals, frontend coordination or migration behavior. No new database columns, publication generations, falsely populated timestamps, generic orchestrator, resumable IMAP implementation, reset, release or Gmail Push/Pub/Sub. The additive API observation is a foundation for Phase 4, not a coherent message-list envelope. Existing legacy remote badge fields and optimistic behavior persist until that dependency is implemented.

Local aggregates cost a mailbox placement scan using the existing mailbox index; collect query timings under the reference workload before denormalizing. API observations are optional in the TypeScript DTO for older consumers/fixtures, but populated by listForAccount. Tests cover local/remote separation, count-gap/unknown coverage, duplicate/hidden/seen placements, truthful timestamps, neutral classification, safe diagnostics and preservation of optimistic overlays. No live mailbox or end-to-end validation is required in this phase.
