# Sync Engine v2 — Product Contract

Status: **Draft 0.8 — Fresh-install-only scope and fast, bounded Initial Inbox Window selection approved; provider algorithms pending**
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

### INBOX USABLE, INBOX READY and history semantics

**Approved (2026-10-11):** `INBOX USABLE` and `INBOX READY` are separate milestones. Neither requires full mailbox history, a globally exact newest-200 sort, full MIME nor a moment when the remote mailbox stops changing.

- **USABLE** means some valid selected INBOX data has been durably published and can be browsed. It may occur before initial selection completes; show incomplete coverage honestly.
- **READY** means the finite, provider-appropriate initial selection has reached its defined completion rule, selected messages have been reconciled to the permitted terminal outcomes, a **fixed logical cut-over boundary T1** has been safely resolved, and ongoing current-INBOX synchronization is durably arranged. T1 can be a provider cursor/snapshot boundary rather than a wall-clock timestamp.
- All changes up to the fixed T1 relevant to the initial selection must be applied or conclusively accounted for. Changes after T1 are owned by continuous synchronization and **must not move the READY gate**. Do not wait for a quiet INBOX.
- A selected message deleted or removed from INBOX before fetch must not be resurrected merely to satisfy selection. Permitted terminal outcomes are: the current remote state was durably projected, or remote absence/membership removal was reliably confirmed. An unresolved transient fetch/error **blocks READY** and remains visible/retryable; merely recording a recovery path is not sufficient to declare READY.
- Initial-window exact membership and the finite provider selection stopping rule are transport-specific design gates. Provisional first-screen content can be USABLE but cannot be presented as definitively READY until those conditions are met.
- **History may begin after the finite initial INBOX selection is completed and safely materialized**, even if the T1 reconciliation needed for READY is still underway, but *only* with leftover capacity and without delaying current INBOX or the remaining READY work. History is not gated on the READY label. Other accounts continue independently.
- Current-INBOX messages arriving during bootstrap are eligible for priority service independently of the frozen selection. A normal current change after T1 does not revoke a legitimately reached READY milestone. Freshness health and history coverage are tracked separately from bootstrap completion.
- A provider outage, quota backoff, or unreconciled selected item cannot be reported as successful READY. Display incomplete/degraded state truthfully.

`INBOX READY` is **a completed bootstrap milestone**, not an always-current status assertion. Display bootstrap progress, current Inbox Freshness (including last confirmed reconciliation/backoff), and History Coverage independently. Proposed phase labels remain implementation details.

### IIW acceptance scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| IIW-01 | New account / empty database | Initial INBOX work begins before historical ingestion. History may start once the bounded initial selection is completed and safely materialized, even before READY, using only leftover capacity. |
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

The initial bootstrap gate remains in force: for a newly configured account, its bounded initial INBOX selection must complete and be safely materialized before that account begins historical import; INBOX READY is not required; freshness signals during bootstrap remain eligible for priority service. Other existing accounts continue to receive their normal INBOX opportunities.

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

## Approved: Reconciliation & Consistency (RC)

Decision (2026-10-11): **Use immediate optimistic UI updates, backed by durable user intents and later remote confirmation.** Remote provider state is authoritative for received mail, except that explicitly pending user intents control what the UI temporarily presents. This decision must preserve existing Maildock behavior and must not imply that a queued action has already succeeded remotely.

### Product requirements

- **RC-001 — Authority:** The remote provider is the source of truth for message presence, membership and remote flags. Local cached data is a potentially delayed projection; local drafts and outgoing state retain their distinct existing authority.
- **RC-002 — Durable optimistic intents:** Before reporting an accepted user mutation, persist its intended outcome durably. UI may immediately project that intent as pending; crash/reload must not silently lose it. On rejection before persistence, do not show it as accepted.
- **RC-003 — Protection from stale reads:** In-flight or replayed provider snapshots must not silently overwrite outstanding local intent. Use guards reflecting message/property, run and source version semantics as appropriate; simple arrival-time last-write-wins is insufficient.
- **RC-004 — Observable lifecycle:** Each accepted command has an actionable state such as pending, confirmed, failed or uncertain/reconciling. The UI must not silently treat an unconfirmed remote operation as completed. Failures must have an understandable resolution/retry path.
- **RC-005 — Idempotent projection and execution:** Replayed sync pages and retries do not multiply logical messages or duplicate memberships. Mutations must use provider-appropriate desired-state/idempotency checks when safe; uncertain results must be observed before any potentially non-idempotent retry.
- **RC-006 — Correct remote conflicts:** When local and another client change the same property concurrently, do not blindly assert that local or remote "wins." Preserve pending local intent until resolved and reconcile to the subsequently confirmed remote state; identify irreconcilable or unobservable outcomes rather than inventing an ordering guarantee.
- **RC-007 — Correct deletion semantics:** Removing INBOX or a Gmail label is not equivalent to permanent message deletion. A partial listing or interrupted inventory cannot authorize deletion. Confirm true remote absence in a provider-appropriate way; do not resurrect remote-deleted messages through stale work.
- **RC-008 — Identity and content preservation:** Remote moves, Gmail label changes and IMAP UID changes must not spuriously duplicate logical messages or discard valid local MIME/attachments. Gmail account-scoped message identity and IMAP mailbox/UIDVALIDITY identity require distinct provider-aware handling; do not assume universally stable identity across IMAP moves.
- **RC-009 — Sequential intents:** Multiple accepted actions on the same message/property must resolve deterministically in user-intent order or be safely coalesced where semantics permit. An earlier remote response cannot override a newer accepted intent. Independent properties should not be blocked needlessly.
- **RC-010 — Bulk work does not starve freshness:** Large-scale changes (e.g. 15,000 deletions, moves or read/unread updates) must be bounded, resumable, and scheduled below ongoing INBOX detection/materialization as defined by Inbox First, History With Leftovers; an individual interactive action must not act as unlimited interactive-priority work.
- **RC-011 — Honest counters and search:** Partially synchronized folders must distinguish server-reported totals from local covered/known counts where available. Search and conversations must not duplicate messages because of Gmail labels or replay. Incomplete local search coverage must not masquerade as full remote coverage.
- **RC-012 — Recovery and UI convergence:** After restart, disconnect or an uncertain remote outcome, reconstruct the visible pending state from durable data, re-observe provider state when needed, and eventually show the authoritative remote outcome or a visible unresolved state. Never indefinitely retain a falsely confirmed optimistic state.

### Examples and expected results

| ID | Situation | Expected behavior |
| --- | --- | --- |
| RC-T01 | Mark read in Maildock, delayed older unread snapshot arrives | UI retains accepted pending read intent; snapshot cannot silently revert it. |
| RC-T02 | Mark read, then unread before first command confirms | Final projection reflects newest intent; old confirmation cannot overwrite newer intent, and remote changes are handled safely. |
| RC-T03 | Maildock and another client set opposing read states | Observe/resolve the remote result after local command processing; do not claim cross-client total ordering. |
| RC-T04 | Archive in Gmail | Remove INBOX membership but preserve message identity, content and unrelated labels. |
| RC-T05 | Move message between IMAP folders | Track provider-specific identity change where provably possible; avoid manufacturing identity equivalence; preserve valid local cached content. |
| RC-T06 | Message deleted remotely while a local action is pending | Do not recreate it; surface a resolved missing/failed outcome and reconcile local projection. |
| RC-T07 | Repeated remote history/page, duplicate jobs or repeated command | No duplicate canonical Gmail message or placement; safe idempotent execution and projection. |
| RC-T08 | Incomplete inventory or network failure during deletion scan | No mass tombstoning/removal from partial evidence. |
| RC-T09 | 15,000 remote deletes/flag changes during concurrent INBOX arrivals | Progresses in bounded batches without starving fresh messages. |
| RC-T10 | Restart after optimistic action accepted but before provider reply | Pending intent reappears correctly, provider outcome is rechecked before unsafe retry. |
| RC-T11 | Provider confirms action then a newer local action is pending | Earlier confirmation cannot clear or overwrite newer intent. |
| RC-T12 | Provider applies action but acknowledgement is lost | Report uncertainty/reconcile; do not claim failure or blindly replay a non-idempotent operation. |

### Explicitly deferred to architecture

Transport-specific command semantics (including whether an operation is safe to retry), persistence layout, conflict guards/versions, execution serialization and coalescing, reconciler algorithms, precise identity across IMAP moves, counter coverage and UI state terminology must be designed and validated separately. Provider checkpoints and failure recovery must satisfy CR-001–CR-006. Existing sending/draft semantics must not be rewritten as a side effect.

This section is an approved product contract only: no code, schema, deployment or migration changes are authorized.

## Approved: Installation baseline and migration scope (MI)

Decision (2026-10-11): **Sync Engine v2 is intended exclusively for new Maildock installations, initialized with a fresh PostgreSQL database.** No existing installation is an authorized in-place data-migration source for the v2 launch. This resolves independent review C-04's product scope; it does not by itself resolve schema, bootstrap or deployment design.

- **MI-001 — New installation only:** v2 bootstraps into a newly initialized, empty Maildock database, using a coherent versioned schema and corresponding application binaries.
- **MI-002 — No v1 data upgrade:** Migration/conversion from stable `main` v1.0.0, experimental native Gmail v1-final, or other existing Maildock databases is out of scope. Do not build legacy UID/label identity conversion or preserve v1 local UUIDs across a separate new installation.
- **MI-003 — No implied data preservation by reinstall:** Remote mail can be re-synchronized if still present on the provider. Local-only drafts, outgoing state, command state, cache, local UUID links and other installation-bound data are **not** automatically transferable. Never represent a fresh install as a lossless migration.
- **MI-004 — Preserve product functionality, not legacy data:** The new receiving engine must preserve supported Maildock UI, authentication/OAuth, local drafts, SMTP sending, content and attachments, user commands, search, conversations and existing security controls as working capabilities in the new installation.
- **MI-005 — Forward upgrades within v2:** From the first released v2 installation onward, ordinary updates require supported non-destructive schema/data evolution and recovery compatibility. Fresh-only launch scope is not permission to reset an already initialized v2 database for each release.
- **MI-006 — Safe coexistence and release boundaries:** v2 must not silently take over or overwrite an existing v1 database or blob directory. Existing guard/compatibility checks remain protective until a reviewed v2-specific initialization/version check exists. Do not bypass a guard merely to boot v2 against an incompatible database.
- **MI-007 — No automatic conversion/rollback claim:** Rolling back the application binary must be compatible with the exact schema and persistent state. Do not promise downgrade between v1 and v2 or automatic restoration of old local data; document restore prerequisites for supported v2 releases.

### Installation acceptance cases

| ID | Situation | Required result |
| --- | --- | --- |
| MI-T01 | New v2 deployment with empty database and clean storage | Initializes supported v2 schema and begins account onboarding without legacy conversion steps. |
| MI-T02 | v2 binary is pointed at pre-existing v1 database | Fails safely with actionable incompatibility explanation; does not rewrite, wipe or opportunistically migrate it. |
| MI-T03 | New account connects to an existing remote mailbox | Pulls remote messages according to IIW/backfill; does not claim to restore old local-only application state. |
| MI-T04 | A subsequent supported v2 application release upgrades a populated v2 database | Preserves supported data and runs reviewed forward migrations safely. |
| MI-T05 | Administrator requests downgrade to v1 | No automatic binary/schema downgrade is promised; supply clear incompatibility/restore guidance. |

**Deferred:** exact version markers, migration filenames, schema initialization procedure, bootstrap release checks, backup/restore runbook and v2-to-v2 compatibility matrix. This decision authorizes documentation only, not reset operations or deployment changes.

## Approved: Initial Inbox Window selection objective (IS)

Decision (2026-10-11): **A promptly usable INBOX takes precedence over globally perfect chronological top-200 ordering if achieving the latter requires expensive unbounded discovery.** This supplements, and does not silently erase, the existing 30-day / 200 / fallback-to-50 IIW rule.

- **IS-001 — Speed and bounded cost first:** On a newly connected account, select an initial useful INBOX population with bounded provider discovery and metadata cost. Do not require scanning an arbitrarily large mailbox merely to prove absolute top-200 order.
- **IS-002 — Provider-aware recency:** Select recent messages using provider-supported, documented ordering/date and pagination. IMAP UID ordering must not be represented as equivalent to INTERNALDATE order; Gmail listing order/pagination must not be claimed to provide a stable global snapshot without evidence.
- **IS-003 — Retain the product window:** Aim to materialize up to 200 eligible recent INBOX messages from the last 30 days, and if fewer than 50 qualify, supplement with older INBOX messages up to 50 total where available. The window is an *initial materialization objective*, not permission to perform unbounded scans before showing useful mail.
- **IS-004 — Partial selection honesty:** If bounded discovery cannot yet establish the exact newest set or minimum fallback count, do not falsely declare the selection complete. Record outstanding selection/fallback work and keep progressing safely; UI must not misrepresent provisional coverage or freshness.
- **IS-005 — Fixed bootstrap reference and continued arrivals:** Hold a stable initial selection horizon so live arrivals do not endlessly shift bootstrap. Service newly arriving INBOX messages independently and preferentially, including while selection continues.
- **IS-006 — Eventually complete coverage:** All skipped or deferred older INBOX and other-folder mail remains eligible for historical backfill, including imported/backdated mail and messages outside the initial approximation. History must not replace current INBOX work priority.

### Important unresolved design trade-off

The bootstrap policy now distinguishes USABLE from READY and fixes a finite logical cut-over T1; READY does not require mailbox quietness or historical completion. **Still open:** exact provider-specific finite initial selection stopping rules and T1 construction/reconciliation for Gmail REST and IMAP. Do not equate first visible messages with READY, assume UID recency equals date recency, or silently weaken the 50-message fallback.

### Acceptance cases to design

| ID | Scenario | Required outcome |
| --- | --- | --- |
| IS-T01 | 50,000-message INBOX with old imports/backdated dates | User sees useful recent mail without waiting for global exact chronological ranking; selection limitations are visible/recorded. |
| IS-T02 | Gmail or IMAP pages are inconsistent or change during bootstrap | Stable initial horizon, replay-safe projection, no arbitrary total-order claim. |
| IS-T03 | Fewer than 50 recent messages | Older-message fallback progresses toward up to 50 without an unbounded pre-display scan. |
| IS-T04 | New INBOX message during selection | Prioritized independently without restarting the fixed bootstrap window. |

No provider-specific query, scan ceiling, SLA, schema, queue or algorithm is approved by this statement.

## Approved: Finite bootstrap cut-over acceptance additions (BR)

| ID | Situation | Expected result |
| --- | --- | --- |
| BR-T01 | 50,000 messages in INBOX; first small batch persisted | USABLE can be shown without READY or complete history. |
| BR-T02 | Continuous arrivals while initial work completes | Freeze finite provider-aware T1; bootstrap reaches READY without awaiting a quiet mailbox; later arrivals remain active freshness work. |
| BR-T03 | Selected message removed from INBOX or deleted during bootstrap | Confirm absence/membership change; do not resurrect it or block READY forever on a no-longer-existing item. |
| BR-T04 | Selected message cannot be resolved because of transient errors | Keep READY withheld and degraded/retry status visible until resolved. |
| BR-T05 | Initial selection safely materialized, T1 reconciliation still underway | History may use remaining capacity without blocking INBOX freshness or READY completion. |
| BR-T06 | Full history still has tens of thousands of messages after T1 | READY is possible; history coverage remains separately incomplete. |

No scheduler algorithm, quota split, batch size, exact T1 provider method, code change or schema change is approved by this clarification.
