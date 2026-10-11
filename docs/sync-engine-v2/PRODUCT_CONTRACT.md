# Sync Engine v2 — Product Contract

Status: **Draft 0.5 — Initial Inbox Window, continuous freshness, resource allocation, and checkpoint/recovery principles approved; implementation design pending**
Date: 2026-10-11
Tracking: [Issue #5](https://github.com/mkilinskidev/Maildock/issues/5)
Working branch: `sync-engine-v2`
Baseline reference: `archive/sync-engine-v1-final`

## Scope and boundaries

This is a **product behavior contract**, not an implementation design. Sync Engine v1 feature development is frozen. Sync Engine v2 will replace the receiving synchronization layer, while preserving the working Maildock UI, account setup and OAuth, sending, drafts, message actions, content and attachments, security, and existing user-visible features. Runtime remains TypeScript/Node.js. No scheduler workarounds, code changes, provider rewrites, database deletion, or migration is authorized by this document.

Remote mail remains authoritative. Requirements apply to both IMAP and native Gmail REST receiving, while protocol-specific implementation and measurable freshness SLAs will be designed and validated separately.

## Approved: Initial Inbox Window (IIW)

### Eligibility and bounds

On initial account synchronization, prioritize the current INBOX before historical work.

- Reference age window: **30 days**.
- Preferred upper bound: **200 newest INBOX messages within the last 30 days**.
- Minimum sample target: **up to 50 newest INBOX messages regardless of age**, when fewer than 50 qualify within the 30-day window.
- If INBOX has fewer than 50 messages in total, ingest all available messages.
- If 50–200 messages qualify in the time window, ingest those messages, without adding older ones.
- If more than 200 qualify, ingest the newest 200 and defer the remainder.
- The window determines initial **metadata, flags and mailbox membership** ingestion; it does **not** require eager full MIME bodies or attachment downloads.
- No older messages are discarded by this selection. Deferred INBOX and other-mailbox messages are eligible for progressive historical backfill.
- The initial population must be bounded and repeatable across failures. New arrivals must not endlessly shift the bootstrap boundary.

Examples:

| INBOX contents | Initial selection |
| --- | --- |
| 10 messages total | All 10 |
| 20 within 30 days, 100 older | Newest 50 total |
| 120 within 30 days | Those 120 |
| 5,000 within 30 days | Newest 200 within window |
| 10,000 all older than one year | Newest 50 total |

### Priority invariant — applies even before INBOX READY

**Newly arriving INBOX mail must receive priority over historical backfill throughout account bootstrap and subsequent operation.** A large import, reconciliation or mass removal (including 15,000 old messages) must not indefinitely block detection and materialization of newly arriving INBOX messages.

- Prioritization must apply to actual execution resources (provider access, concurrency, rate-limit budget and database work), not merely queue labels.
- Work that has already started need not be interrupted, but high-priority work must have a bounded opportunity to execute under resources controlled by Maildock.
- During bootstrap, new arrivals are tracked and reconciled without repeatedly resetting the fixed initial window.
- History may progress using available capacity; it must not permanently starve, and it must not exhaust all Maildock-controlled provider capacity needed to service current INBOX.
- External provider outages/quotas mean no unconditional wall-clock delivery guarantee is promised.
- Detecting changes and fully materializing them are distinct stages; both need observability.

### INBOX READY semantics

`INBOX READY` may be published only when:
1. The initial selection has been determined with provider-appropriate, documented ordering and a stable bootstrap reference.
2. Required metadata, flags and INBOX memberships for selected messages are durably stored.
3. No selected message remains unresolved without a controlled recovery path.
4. Changes observed since the bootstrap reference have undergone the required reconciliation.
5. Continued current-INBOX synchronization is durably arranged.
6. Deferred history remains eligible and resumable.

`INBOX READY` **does not mean** the entire INBOX/history, MIME bodies or attachments have been downloaded, nor that the remote mailbox cannot have changed a moment later.

Track **bootstrap phase**, **Inbox Freshness** (last successfully confirmed reconciliation and lag/error), and **History Coverage** separately. Display incomplete history honestly rather than implying an empty remote INBOX.

Candidate bootstrap phases: `PENDING`, `DISCOVERING`, `MATERIALIZING`, `RECONCILING`, `INBOX_READY`; transient recovery and actionable failures must be represented. These phase names are provisional and do not dictate database schema.

### IIW acceptance scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| IIW-01 | New account / empty database | Initial INBOX work begins before historical ingestion. Historical work does not start before initial materialization and readiness. |
| IIW-02 | 20,000 messages in INBOX | Initial selection respects the hybrid 30-day / 200 / 50 bounds. |
| IIW-03 | New arrivals while bootstrapping | New messages are detected and processed with priority and are not lost or delayed behind history. |
| IIW-04 | Worker restart mid-bootstrap | Durable completed work is preserved, unfinished work resumes safely. |
| IIW-05 | Replayed provider pages/retries | No duplicate logical messages from replay. |
| IIW-06 | Remote flag or deletion changes mid-bootstrap | Reconciliation preserves the correct authoritative state. |
| IIW-07 | Provider disconnect/quota rejection | No false `INBOX READY`; safe bounded retry/visible error. |
| IIW-08 | Messages outside initial window | Deferred work remains recoverable through history backfill. |
| IIW-09 | Continuous arrivals | Bootstrap can reach readiness without an endlessly moving initial selection; arrivals still get priority. |
| IIW-10 | 15,000 historical deletions during ongoing sync | New INBOX messages continue to receive bounded execution opportunities. |

Test both IMAP and native Gmail REST, using realistic provider-backed and fault-injected cases, not unit test counts alone.

## Open decisions — do not silently assume

1. Exact provider-appropriate ordering and meaning of the 30-day window (internal timestamp versus received date), and tie-breaking.
2. Bootstrap reference, consistent paging semantics, and how to detect changes during enumeration.
3. Inbox Freshness measurement thresholds, polling/wakeup strategy and realistic SLA by provider (continuous server sync policy approved).
4. Capacity reservation/fairness under provider limits, multiple accounts and recovery.
5. Exact meaning and UI representation of history coverage, retry and status.
6. Migration and compatibility strategy; preserve existing data, stable identifiers and other product features unless explicitly approved otherwise.

## Subsequent design stages

1. Finalize complete product contract, especially ongoing Inbox Freshness and message mutations.
2. Audit provider/runtime seams and learn from v1 failure modes.
3. Document architecture, state/checkpoint/idempotency and resource isolation, with alternatives reviewed.
4. Specify safe migration and rollback.
5. Specify end-to-end/live-provider release gates.
6. Implement only after review and approval.

Documentation-only change; no implementation authorized.

## Approved: Continuous Inbox Freshness (IF)

Decision (2026-10-11): **Synchronization runs continuously on the server regardless of whether a browser is open or a user is active.** Browser activity, tab visibility and UI sessions MUST NOT gate or determine baseline receive synchronization. The browser displays locally materialized data; browser-side refresh/notifications are a separate presentation concern. The system is not allowed to wait for a web request to start routine incoming-mail work.

### Product invariants

- **IF-001 — Independence:** Current INBOX synchronization is autonomous and continuous per enabled, connected account, including during initial bootstrap and historical backfill.
- **IF-002 — Bounded service opportunity:** No Maildock-controlled historical import, mass reconciliation, batch deletion, job backlog, DB transaction or provider-request concurrency may monopolize the resources required by current INBOX work indefinitely. Priority must be effective at execution/resource admission, not only in queue names. This is a fairness requirement, not preemption of every in-flight provider request.
- **IF-003 — Durable wake and recovery:** Events, IDLE, timers and eventual push notifications are wake-up hints, not authoritative checkpoints. Lost wakeups, worker restarts and transient disconnects are repaired by persisted eligible work plus periodic reconciliation.
- **IF-004 — Safe state:** A checkpoint may advance only after covered changes are durably applied. Retries or overlapping runs must not resurrect deleted mail, override newer authoritative flags or duplicate logical messages. Remote provider remains authoritative except for explicitly pending local commands.
- **IF-005 — Account isolation:** An unavailable or heavily backfilling account must not indefinitely block healthy accounts; shared provider-level quotas, DB pool pressure and global worker resources also require fairness and limits.
- **IF-006 — Resource-aware providers:** Respect provider backoff/Retry-After, IMAP connection limits, and Gmail REST weighted user/project quota. Reserve appropriate Maildock-controlled capacity for freshness and commands while preventing history from starving permanently. Provider-wide external throttling/outages cannot be overridden or hidden.
- **IF-007 — Observability:** Record separately last attempted check, last confirmed successful reconciliation, detected-change time, durable materialization time, pending-work age, effective provider backoff, bootstrap and history status. Stale/error states must remain visible; do not present a success timestamp based solely on enqueue or failed polling.
- **IF-008 — UI independence:** Once a message is committed to PostgreSQL, an active UI must make it visible without requiring full page reload, subject to a separately tested UI propagation target. Offline browser does not stop server sync; reopening shows persisted latest known state.
- **IF-009 — Manual refresh:** Owner-initiated refresh requests high-priority reconciliation, coalesces redundant requests, and reports pending/throttled/errors transparently. It must not bypass external provider rate limits, displace already pending user mutations unsafely, or spawn unbounded duplicate jobs.
- **IF-010 — Progress during continuous arrivals:** New messages continue to be processed during bootstrap. A fixed initial window can reach INBOX READY despite continuing arrivals; the ongoing freshness stream does not require a quiet mailbox to complete.
- **IF-011 — No false guarantee:** Account status distinguishes healthy, degraded, retry/backoff, reconnect/authentication required and stale; the status may not imply zero lag simply because a watcher is connected.

### Semantics and measurement

Measure separately (1) **detection latency** from the provider-observable change to Maildock detection, (2) **materialization latency** to durable database commit and (3) **UI propagation latency** from DB commit to visibility in an active client. End-to-end time from actual remote delivery is a useful live-test measure where a trustworthy injection/delivery timestamp exists, but cannot always be inferred from provider message headers. Monitor both typical and tail latency during idle and large backfill.

An IMAP IDLE notification is not proof of reconciliation and Gmail history polling is not a push subscription. Where supported, low-latency provider hints should wake work; fallback polling/reconciliation is required regardless.

Provisional **targets to validate, not approved SLAs** under healthy providers and configured budgets:
- IMAP with a functioning IDLE signal: typically up to 5 seconds from provider-observable change to local materialization.
- Gmail REST without push: typically up to 30 seconds, depending on configured polling interval and provider limits.
- Manual refresh: begin eligible work within 2 seconds of acceptance **when internal capacity is available**; completion is a separate metric.
- A loaded active browser should update promptly after database commit; precise target remains open.

These values require instrumented provider-backed measurement and load tests before they can become release gates. Never claim unconditional sub-second or fixed delivery under outage, provider quota exhaustion, network failure or unavailable workers.

### Provider and browser policy

- IMAP: use IDLE where supported as a change hint, accompanied by delta reconciliation and polling fallback. Do not treat the IMAP connection as a durable event log.
- Native Gmail REST: use history checkpoints and bounded periodic checks. Google Pub/Sub push is **not a required dependency** of the self-hosted app; any future optional push must preserve the same correctness and recovery contract.
- Continuous server synchronization policy is fixed across browser-open, browser-closed, foreground and background states. UI activity may initiate an explicit manual refresh but does not silently tune baseline polling.

### Acceptance scenarios (proposed, testable; time thresholds pending benchmarks)

| ID | Scenario | Pass condition |
| --- | --- | --- |
| IF-A01 | Close all browser tabs for an extended interval | Server continues reconciling enabled accounts and persists received messages. |
| IF-A02 | Backfill tens of thousands of historical messages | New INBOX changes are serviced within the same measured freshness envelope as without backfill, within an agreed tolerance. |
| IF-A03 | One account fails auth or is offline while another is healthy | Healthy account continues receiving; failing account shows actionable status and controlled retry. |
| IF-A04 | Restart worker just before or after receiving a signal | Periodic durable recovery eventually schedules reconciliation; no lost eligible work or false success checkpoint. |
| IF-A05 | Gmail quota 429/403 or IMAP disconnect | Respect provider retry constraints, avoid retry storms, preserve checkpoint and surface stale/backoff status. |
| IF-A06 | 15,000 historical deletions or flag changes | Reconciliation is chunked/fair and does not starve fresh INBOX work. |
| IF-A07 | Repeat or overlap wakeups | No unbounded duplicate provider activity or duplicate logical messages. |
| IF-A08 | New message arrives while initial window materializes | It receives priority without moving the frozen window indefinitely. |
| IF-A09 | Active UI, new message persisted | UI eventually displays it without reload and within separately defined propagation target. |
| IF-A10 | Manual refresh during quota backoff | Respect backoff, give truthful feedback, do not bypass remote limits. |

### Open for next review

- Quantitative p50/p95/p99 or worst-case service-opportunity targets, measured with and without backfill.
- Provider-specific polling cadence, jitter and backoff strategy; live-connection scaling for IMAP.
- Concrete shared-budget reservation and cross-account fairness mechanisms; quantitative history-progress targets (the Inbox-first policy is approved).
- UI propagation contract and diagnostic vocabulary (last successful reconciliation versus newest known message).
- Provider-specific deltas, cursor expiry and reconciliation boundaries under deletions and changed flags.

This section is product scope and acceptance criteria, not permission to implement a scheduler or change runtime.

## Approved: Resource allocation — Inbox First, History With Leftovers

Decision (2026-10-11): **Within the capacity controlled by Maildock, serve current INBOX synchronization across all enabled accounts first. Allocate capacity remaining after that demand to other folders, maintenance, and historical backfill.** This policy applies during bootstrap as well as steady state, and does not depend on browser activity.

- **RI-001 — Current-INBOX first:** Admit eligible current-INBOX detection and materialization work ahead of historical and bulk maintenance work. Treat its required provider, worker and database capacity as protected, not merely its queue label.
- **RI-002 — Fairness among accounts:** All healthy enabled accounts must have bounded opportunities to synchronize their current INBOX. A busy account must not monopolize shared capacity or indefinitely starve another.
- **RI-003 — Leftover capacity:** When current-INBOX demand is satisfied or waiting for the next provider check, other work can consume available capacity. Do not reserve idle capacity unnecessarily. History must progress when usable resources remain.
- **RI-004 — Work already in progress:** Existing bounded operations need not be forcibly cancelled. History must run in bounded units and yield at admission boundaries so fresh INBOX work can start promptly.
- **RI-005 — Provider-specific budgets:** Gmail REST quota units and time windows, IMAP connection/concurrency limits, worker slots, database contention, and any shared quotas all constrain actual available work. Never invent a single universal 'units per session' measure or bypass external backoff and limits.
- **RI-006 — Failure isolation and recovery:** 403/429, IMAP disconnects, unavailable accounts, restarts or duplicate wakeups must not create unbounded retries, exhaust shared capacity, or lose committed progress.
- **RI-007 — Truthful degraded behavior:** If the provider or shared resource cap makes it impossible to fully satisfy every INBOX immediately, allocate fairly, show staleness/backoff and recover automatically when capacity returns. Priority is not an unconditional latency guarantee.

The initial bootstrap gate remains in force: for a newly configured account, its first INBOX window must materialize before that account begins historical import; freshness signals during bootstrap remain eligible for priority service. Other existing accounts continue to receive their normal INBOX opportunities.

**Design deferred:** concrete scheduler structure, logical/physical execution pools, reservation percentages, poll cadence, fairness algorithm, per-provider resource accounting, and quantitative latency bounds. Do not implement complexity solely to realize a priority label; assess the simplest mechanism that satisfies the invariants.

### Resource-isolation acceptance cases

| ID | Situation | Required result |
| --- | --- | --- |
| RI-T01 | Account A imports 80,000 older messages and reconciles 15,000 historical deletions; account B receives 10 new messages | Account B's INBOX receives timely access to resources; history need not finish first. |
| RI-T02 | Two or more accounts receive new INBOX messages simultaneously | Each account gets a bounded service opportunity; no single account monopolizes a shared budget. |
| RI-T03 | No INBOX work is currently eligible | History can consume available capacity subject to provider and worker limits. |
| RI-T04 | New INBOX work arrives during history | At the next bounded scheduling/admission point, capacity is preferentially assigned to INBOX. |
| RI-T05 | One account is throttled/offline | Its retries are controlled and other healthy accounts continue. |
| RI-T06 | Global/provider shared quota is exhausted | Do not violate restrictions or claim freshness; surface backoff and resume fairly. |

This is an approved product-level resource policy, not an approval of a particular implementation.

## Approved: Checkpoints and Crash Recovery (CR)

Decision (2026-10-11): **Persist completed synchronization work in bounded batches, with a separate safe provider checkpoint.** This section defines observable correctness and recovery requirements, not a queue implementation, database schema, or batch size.

- **CR-001 — Safe checkpoint:** Advance the authoritative provider change checkpoint only after *all changes it covers* are durably applied or safely and durably represented as unresolved work with a protocol-valid replay guarantee. Prefer advancing only after complete resolution; never skip partially processed changes.
- **CR-002 — Idempotency:** Worker restart, duplicate job delivery, page replay or network retry must not create duplicate logical messages or corrupt mailbox memberships.
- **CR-003 — Efficient resumption:** Resume from the latest safe durable progress. Avoid reimporting completed history when the provider supports this; limited replay of in-flight batches is acceptable and must be safe.
- **CR-004 — Expired/invalid provider checkpoint:** Perform controlled provider-specific reconciliation rather than resetting the database, discarding good cached content or declaring missing messages deleted based on partial scans.
- **CR-005 — Stale worker fencing:** Responses from obsolete work generations, workers or account revisions must not overwrite newer state. Concurrent remote user actions and provider changes require guarded publication.
- **CR-006 — Inbox-first after restart:** Recovery work and historic backlog remain below current INBOX synchronization priority under the approved Inbox First, History With Leftovers resource policy.

### Approved progress model

1. Split long-running ingestion, reconciliation and historical import into **bounded work batches**.
2. Persist each safely completed batch and its progress marker durably, with idempotent replay for interrupted batches.
3. Maintain **separate concepts** for (a) ingestion/backfill batch progress and (b) the provider's authoritative change checkpoint.
4. Only advance the authoritative provider checkpoint when its entire covered change set meets CR-001; batch progress does not imply a safe provider checkpoint.
5. Queue acknowledgement or an in-memory cursor alone is never proof of committed progress. Durable unfinished work must be rediscoverable after crash, including a crash between database commit and queue acknowledgement.
6. After recovery, continue current INBOX service promptly and resume other outstanding work from the latest safe state; do not reset the fixed Initial Inbox Window needlessly.
7. Treat a provider's explicit message-not-found, a missing placement, a transient network failure and an expired change cursor as different conditions. Never infer mass deletion from an incomplete inventory.
8. Local UUIDs, cached MIME/attachments, pending commands and other product state must be preserved across recovery where still valid. A full provider reconciliation may have to re-enumerate remote metadata; this is not permission to redownload all content.

### Provider-specific considerations (not implementation decisions)

- **Gmail REST:** Account-wide change history and its checkpoint differ from historical message enumeration. History can expire; then carry out full controlled inventory/reconciliation with a new baseline while retaining verified local data.
- **IMAP:** UIDs are scoped to mailbox and UIDVALIDITY. UIDVALIDITY changes require safe mailbox-specific reconciliation; IMAP sequence numbers are not persistent message identities. CONDSTORE/QRESYNC may optimize but do not substitute for correctness.
- Failure/backoff waits must not hold scarce database/provider execution resources indefinitely.

### Acceptance scenarios

| ID | Failure case | Required result |
| --- | --- | --- |
| CR-T01 | Restart after some batches are committed | Continue from safe durable progress without losing or duplicating messages. |
| CR-T02 | Crash after provider read but before database commit | Uncommitted work is replayable; provider checkpoint cannot skip it. |
| CR-T03 | Crash after database commit but before queue acknowledgement | Recovery is idempotent and does not lose completed state. |
| CR-T04 | Two workers process duplicate or outdated work | Only authorized/current work publishes; no stale overwrite. |
| CR-T05 | Gmail history checkpoint expires | Controlled reconciliation preserves valid local UUIDs, bodies, attachments and other state. |
| CR-T06 | IMAP UIDVALIDITY changes | Reconcile affected mailbox without treating old UIDs as valid for the new epoch. |
| CR-T07 | A provider error occurs mid-batch | Do not commit a false provider checkpoint; safely retry incomplete work. |
| CR-T08 | A crash occurs during extensive historical recovery | INBOX freshness is still prioritized once service resumes. |
| CR-T09 | Partial remote inventory omits previously known messages | Never infer deletion solely from the partial inventory. |

### Still open for architecture/validation

Batch sizing, persisted work model, transaction/CAS or fencing mechanism, per-provider cursor semantics, cadence of repair scans, measured replay overhead, and quantitative recovery objectives are deliberately **not yet selected**.

This section is approved as a product contract only. No implementation, migration, scheduler rewrite or provider changes are authorized.
