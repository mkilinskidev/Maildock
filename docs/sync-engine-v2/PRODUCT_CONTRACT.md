# Sync Engine v2 — Product Contract

Status: **Draft 0.2 — Initial Inbox Window decisions approved; other sections pending review**
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
3. Inbox Freshness targets, polling/wakeup strategy, measurement points and realistic SLA by provider.
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
