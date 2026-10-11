# Sync Engine v2 — Contract Review and V1 Static Audit

Date: 2026-10-11
Status: **Design input / static audit, not a verified runtime root-cause report**
Tracking: [Issue #5](https://github.com/mkilinskidev/Maildock/issues/5)
Branch inspected: `sync-engine-v2` (derived from `archive/sync-engine-v1-final`)
Product authority: [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md) Draft 0.6

## Executive findings

The v2 product contract is a viable direction and does not require another implementation-level priority taxonomy. The key invariant is *Inbox First, History With Leftovers* across actual capacity, not merely job priority. Current v1 has multiple interacting admission, fairness, transport and recovery mechanisms; preserving all of them would defeat the explicit simplification objective. This audit identifies concrete code seams but **does not claim to reproduce or diagnose** the reported fresh-database startup in which P2 work ran before INBOX.

No code, migrations, production data, accounts, or deployment were changed. No live-provider traffic or runtime tests were executed.

## 1. Product contract review

| ID | Finding / ambiguity | Disposition |
| --- | --- | --- |
| PC-01 | Initial Inbox Window is 30 days / at most 200 / fill to 50 if fewer qualify. A provider-native `date` or `internalDate` can differ from user-visible received date; a stable bootstrap boundary and deterministic tie-breaking remain unspecified. | **Open architecture and acceptance detail**; do not guess date semantics. |
| PC-02 | Initial INBOX bootstrap is a gate for *that account's* history, yet newly arriving messages during bootstrap must be serviced without shifting its frozen window. | **Compatible** if eligibility for current INBOX remains independent of fixed initial-window progress; specify race test. |
| PC-03 | 'All INBOX first' and 'history eventually progresses' are compatible only if work is bounded and there is a fair residual-capacity policy. An endlessly busy INBOX may legitimately consume all provider capacity. | **Clarify** that history liveness is conditional on actual spare capacity, not an unconditional guarantee. |
| PC-04 | Manual actions (read/archive/trash) may be more urgent than history yet compete with INBOX under account/provider limits. The contract must avoid starvation of accepted interactive commands while protecting freshness. | **Open** priority/fairness policy for interactive mutations and on-demand content, no unreviewed rigid ordering. |
| PC-05 | 'INBOX READY' is a milestone, not proof of 100% remote freshness. If changes occur continuously, readiness must not wait for an impossible globally quiet instant. | **Compatible**, define bounded cut-over reference and continue normal deltas. |
| PC-06 | Optimistic UI promises immediate projection only *after* durable intent acceptance; client-only optimism before persistence needs rollback on failed admission. | **Clarify UI acknowledgement sequence** and reject stale command response overwrites. |
| PC-07 | Local stable UUIDs during provider history replay are achievable for native Gmail IDs; IMAP MOVE has no universal portable stable identity across UID changes. | **Provider-specific exception**; avoid promising universal identity preservation; validate actual supported IMAP capabilities. |
| PC-08 | Resource unit is provider-specific; 'budget per session' would be misleading for Gmail's time-window quotas and IMAP's connection constraints. | **Resolved conceptually** in Draft 0.4; architecture must implement correct resource accounting. |
| PC-09 | Freshness goals (IMAP 5s, Gmail 30s) are provisional rather than approved SLAs. Internal queue-wait latency and end-to-end delivery latency need separate measurement. | **Open release gates** based on live-provider measurements with and without backlog. |
| PC-10 | Existing Gmail design documentation assumed a fresh database, while v2 issue freezes a production baseline and no longer authorizes data removal. | **Important migration conflict**: do not import legacy Gmail P0 reset strategy into v2 migration. |

No direct logical contradiction forces rejection of the contract, but PC-03/04/07/10 are significant design gates.

## 2. Code seams inspected and evidence

| Code path | Observed fact | Consequence / recommendation |
| --- | --- | --- |
| `src/modules/mail/infrastructure/sync-admission.ts` | Intercepts `pg-boss` `executeSql`; checks SQL fragments and pins `pg-boss` **12.33.7**; uses advisory transaction lock and SQL candidate selection. | **High coupling** to dependency internals. Treat as candidate for replacement, not as a default v2 foundation. |
| `src/modules/mail/infrastructure/gmail-priority-decision.ts` | Decision SQL computes `p0/p1/p2`, burst threshold >=8, lower-due age >=60 seconds, and phase/action transitions. | Priority semantics span SQL admission and Gmail service. Simplify to product work eligibility + resource budget; preserve only necessary fairness. |
| `src/modules/mail/infrastructure/gmail-sync-jobs.ts` | Gmail account job, priority mapping and per-second poller; jobs wake account service, while durable state tracks eligibility. | Durable wake repair is worth preserving; queue scheduling is not authoritative progress. Account work does not directly correspond to a single INBOX task. |
| `src/modules/mail/application/gmail-sync-service.ts` | Executes bounded slices with state, phase decisions, account lock, account revision and sync work. | Preserve checkpoint/idempotence concepts. Explicitly separate current-INBOX work from history under the new product contract. |
| `src/modules/mail/infrastructure/gmail-quota.ts` | Weighted quota budgets and transactions exist; `interactive` calls may access higher fraction, while receive history and INBOX appear to share background quota allocation. | **Critical design check**: current implementation does not directly prove a reserved current-INBOX budget; require a specific capacity test. |
| `src/modules/mail/infrastructure/idle-watchers.ts` | IMAP IDLE watchers filter eligible active INBOX, react to exists/flags/expunge, enqueue delta and reconnect. | Retain IMAP hints/fallback concept. A watcher only becomes eligible after mailbox recent sync success: check bootstrap sequencing under live conditions. |
| `src/modules/mail/infrastructure/recent-sync-jobs.ts` | Dedicated IMAP recent jobs and continuation. | Preserve initial-window behavior, not necessarily queue layout. |
| `src/modules/mail/infrastructure/delta-sync-jobs.ts` | Dedicated IMAP delta queue, coalescing and lock. | Current-work eligibility must be unified at resource-admission layer across providers. |
| `src/modules/mail/infrastructure/backfill-sync-jobs.ts` | Dedicated IMAP backfill jobs, queue checks against recent/delta, continuation frontier. | Checking *queued* recent/delta is not a standalone capacity guarantee; avoid relying on priority alone. |
| `src/modules/mail/infrastructure/coalesced-sync-job.ts` | Enqueue-time advisory transaction lock plus singleton job lookup. | Keep semantics of deduplication, but critically review whether this remains necessary in v2; enqueue authority must not become the source of progress. |
| `src/modules/mail/domain/synchronization-policy.ts` | P0/P1/P2 classification and separate count provenance semantics. | Distinguish explanatory work classes from actual budget guarantees; preserve truthful counts. |
| `src/modules/accounts/infrastructure/receive-transport.ts` (referenced by jobs) | Account transport/revision are checked in receive job policy. | Work generation/revision fencing is necessary across IMAP and Gmail; preserve semantics. |

Evidence scope: inspected paths on `sync-engine-v2` via repository fetch; this is a selected static audit, **not** complete transitive call-graph verification. Detailed root cause requires instrumented fresh-install reproduction and provider-backed tests.

## 3. Risks ranked

1. **P0 — Bootstrap correctness:** Reproduce new DB startup under instrumentation; assert no historical provider work begins for a new account before first INBOX window is complete. Verify Gmail and IMAP separately.
2. **P0 — Resource isolation:** Prove fresh INBOX can start despite backfill, 15,000 remote deletions, quota pressure and competing accounts. Instrument actual capacity admission, not only queued priorities.
3. **P0 — Data safety and migration:** Existing stored account/provider identity, local UUIDs, content/attachments, pending mutations and checkpoint schemas must survive planned upgrade or have an explicitly approved conversion. No implicit fresh DB.
4. **P0 — Durable consistency:** Verify checkpoint cannot overtake its covered committed state; restart/duplicate worker/stale response tests; prevent data removal after partial inventory.
5. **P1 — Dependency coupling:** Avoid patching private queue-library SQL as a core correctness dependency unless justified by a written decision, supported tests and controlled upgrade strategy.
6. **P1 — Observability:** Distinguish actual first INBOX provider request, first materialization, last confirmed delta, pending backlog, admission wait and effective provider quota/backoff.

## 4. Keep / redesign / leave untouched

**Keep conceptual guarantees:** PostgreSQL as durable source of sync progress; bounded batches, safe provider checkpoints, idempotent message projection; account revision fencing; reliable IMAP wakeups and fallback; provider-aware identity; Gmail weighted quota accounting; durable optimistic commands; truthful counters; security and diagnostics constraints.

**Redesign receive orchestration:** eligibility and accounting for current INBOX vs history; fair distribution across accounts; bootstrap gate; quota and worker admission; late/lost wake repair; a unified minimal observable state contract across IMAP and Gmail. Do not copy `sync-admission.ts` SQL interception, P0/P1/P2 logic and old retry/poller layers wholesale.

**Preserve unrelated functionality:** frontend and UI routes/DTO compatibility, OAuth, SMTP/sending, drafts, attachments, stored MIME and blob security, search, conversations, diagnostics, authentication, deployment and recovery boundaries unless a specific interface adaptation is proved necessary.

## 5. Proposed next design artifacts and gates

1. **Provider behavior/capability matrix**: IMAP vs Gmail REST for initial-window query, delta detection, stable IDs, renames, deletions, quotas and cursor expiry. Mark tested vs proposed.
2. **Minimum sync state model**: account current-INBOX eligibility, provider checkpoint, bootstrap state, historic frontier, durable retries and failure reason. Distinguish scheduling from state.
3. **Resource admission design**: protect current-INBOX capacity, handle interactive commands, fairness, and leftover history. Compare simplest designs; no premature multi-worker architecture.
4. **Migration compatibility design**: existing v1 data and migrations, account transport wiring, dual-work prevention, rollback/no-destruction rules.
5. **Measurable acceptance and replay tests**: clean-install reproduction, injected failures and real-provider scenarios; establish benchmark thresholds before release.

**Architecture gate:** document these designs and measure the v1 baseline before implementing v2. No rewrite, database reset, migration, branch cleanup, deployment or main merge is authorized by this audit.
