# Thunderbird-first research principles — Sync Engine v2

Status: **Approved research and design process**, 2026-10-11. No implementation authorization.

## Principle

Before inventing a synchronization mechanism for Maildock v2, investigate how Thunderbird solves the analogous problem in its **current, actually executed code**. Extract the rationale, invariants and trade-offs, not C++ source code, API structures or Thunderbird-specific architecture.

**Research first, design second.** The approved Maildock [Product Contract](PRODUCT_CONTRACT.md) remains authoritative for product requirements; Thunderbird is a reference implementation, not a new product specification.

## Investigation protocol

1. Trace the full Thunderbird path for the question (IMAP server observation → local headers/state → offline fetch where relevant → scheduling → restart/recovery). Clearly separate header/flag/expunge reconciliation from background offline body download: `nsAutoSyncManager` alone is **not** the full receive-sync implementation.
2. Cite current repository paths, symbols, relevant line ranges/commits, and tests where available. Determine whether code is invoked today, optional, legacy, or behind configuration/capability flags.
3. Record exact invariants, prioritization boundaries, batching/preemption granularity, server assumptions, error handling and observed limitations. Distinguish code evidence from inference.
4. Compare with Maildock v1 observed implementation and v2 contract. Explicitly call out desktop vs always-on server, single-client vs multi-account constraints, IMAP vs Gmail REST, PostgreSQL durability, lazy bodies and provider quotas.
5. Recommend the **simplest** Maildock-specific design that preserves approved guarantees. Explain deviations from Thunderbird. Do not copy code or claim Thunderbird proves a property it does not implement.
6. Where evidence conflicts with an approved product requirement, document an open decision instead of editing the Product Contract or silently weakening it.

## First research package, before further architecture approval

- Initial folder discovery, large INBOX and how new arrivals bypass backlog.
- Flag/read state, deletes/expunge/move, UIDVALIDITY and reconnect/recovery.
- IMAP IDLE, connection allocation and contention between background sync and user actions.
- Offline/body fetch scheduling vs metadata synchronization, priority queues and bounded execution.
- Persistence/commit safety and what Thunderbird does **not** guarantee (no invented transactional checkpoint model).
- Implications for proposed Maildock IMAP I-A/I-B, Gmail G-A/G-B, finite READY/T1 and checkpoint architecture.
- A Thunderbird → Maildock v1 → proposed v2 comparison with evidence, transferable patterns, nontransferable assumptions and simplifications.

Output suggested: `docs/sync-engine-v2/THUNDERBIRD_ARCHITECTURE_REVIEW.md` on a separate research branch, no app code changes, no product contract amendments, no implementation or migrations.
