# Synchronization priority Phase 1 validation

Date: 2026-10-10. Branch: codex/gmail-api-complete-provider.

## Result and scope

[ADR 0016](../adr/0016-synchronization-priority-and-local-count-contract.md) records the approved cross-provider contract and separates future tuning from implemented foundations. Phase 1 adds local/remote counter observations to the mailbox API and bounded debug diagnostics. It does not implement priority admission or coherent browser publication.

## Changed files and purpose

Paths are relative to the repository root.

| Files                                                                                                              | Purpose                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs/adr/0016-synchronization-priority-and-local-count-contract.md; docs/adr/README.md                             | Accepted decision and ADR index.                                                                                                                                                                                                  |
| docs/validation/gmail-read-status-latency-diagnosis.md; docs/validation/sync-priority-architecture-analysis.md     | Existing, initially untracked source reports included so ADR references resolve after push; diagnosis formatting normalized, findings retained.                                                                                   |
| docs/validation/sync-priority-phase-1.md                                                                           | Scope, file inventory, validation evidence and remaining dependencies.                                                                                                                                                            |
| src/modules/mail/domain/synchronization-policy.ts                                                                  | Shared P0/P1/P2 classification and precise local/remote observation DTO. Classification is available for Phase 2, not connected to scheduling.                                                                                    |
| src/modules/mail/application/mailbox-service.ts                                                                    | One SQL snapshot for mailbox rows and materialized aggregates; additive counterObservation API field, distinct message counts, hidden-placement exclusion and precise DB sample time. Existing visible counters remain unchanged. |
| src/modules/mail/infrastructure/sync-diagnostics.ts                                                                | Best-effort Pino delivery diagnostics, eligibility/execution timing and typed lock contention.                                                                                                                                    |
| src/modules/mail/infrastructure/gmail-sync-jobs.ts; delta-sync-jobs.ts; recent-sync-jobs.ts; backfill-sync-jobs.ts | Enable job metadata for measurement and wrap existing delivery work with diagnostics. Queue priorities, concurrency, retry/dispatch and continuation behavior unchanged.                                                          |
| src/modules/mail/infrastructure/gmail-account-lock.ts; mailbox-lock.ts                                             | Identify lock conflicts by error type without parsing free-text errors; acquisition/release unchanged.                                                                                                                            |
| src/modules/mail/application/gmail-sync-service.ts                                                                 | Debug phase, persisted deadline and quota/retry/pending-command observations; no synchronization algorithm change.                                                                                                                |
| src/composition/worker.ts; worker-process.ts                                                                       | Pass the configured logger to operational instrumentation.                                                                                                                                                                        |
| tests/synchronization-policy.test.ts; sync-diagnostics.test.ts                                                     | Provider-neutral contract, unknown coverage/freshness, decimal precision, retry wait, payload exclusion and logging failure tests.                                                                                                |
| tests/incremental-sync.integration.test.ts; gmail-provider.integration.test.ts                                     | Synthetic IMAP/Gmail checks of partial-import separation, aggregates beyond a UI page, duplicate/hidden/seen placements and truthful timestamps.                                                                                  |
| tests/unread-counters.test.ts                                                                                      | Ensure the new local sample timestamp cannot acknowledge existing optimistic command overlays.                                                                                                                                    |

## Operational versus documented foundations

Operational: mailbox API returns local_materialized counts separately from remote_observation values; all locally available distinct messages are counted independently of pagination/conversations. A single SQL statement pairs these values with mailbox state. sampledAt means DB read time. remote.observedAt remains null. remote_sample_exceeds_local means only an observed count gap; otherwise coverage is unknown. Existing import-progress state remains authoritative for import completion. IMAP lastSuccessfulDeltaSyncAt retains its existing phase-specific semantics, and Gmail returns null for this field.

Operational: LOG_LEVEL=debug enables bounded delivery events across both engines, current-delivery eligibility wait excluding retry delay, execution duration, retry count, known delta reason and typed lock contention; Gmail supplies state/deadline and quota/retry/command deferral observations. A returned job is not declared a successful relevant synchronization. Unknown scheduling reasons and unavailable freshness are left unknown. No per-message production logging or credentials/content are added.

Documentation/next-phase vocabulary: priority contract, admission/fairness, eight-slice/60-second provisional allowance, reserved capacity, cross-process resource ceilings, future measured p95 objective, safe yielding and coherent publication proposal.

## Intentional deferrals

No database columns or migrations: existing writers cannot yet truthfully maintain a remote observation timestamp for every counter write, a current-INBOX success marker or coherent publication generation. No new scheduler, worker counts, priorities, intervals, history intake/checkpoints, provider algorithms, frontend refresh coordinator, IMAP resumability or Gmail push.

The approved local badge decision is final. Badge and All Inboxes cutover waits for Phase 4: independent mailbox/message/detail requests and current remote-based overlay acknowledgements cannot safely apply a new local sample together with related rows. The additive mailbox snapshot does not resolve that browser/API dependency. Current-scope freshness/coverage, ready-reader metadata and loaded tail invalidation remain required.

## Validation

- Targeted run: 9 test files, 107 tests passed, including synthetic provider integration on disposable PostgreSQL with no configured live database URL.
- After refining observed-gap semantics and duplicate-placement coverage: 7 unit/UI/job test files, 40 tests passed; 2 focused synthetic provider integration tests passed (65 unrelated tests skipped in this rerun).
- pnpm typecheck: passed for application and worker.
- pnpm lint: passed.
- Prettier check on every changed/included file: passed.
- Full pnpm format:check: existing docs/architecture/gmail-api-architecture-audit.md has formatting issues; this unrelated file is unchanged. The initially unformatted source diagnosis was normalized before inclusion.
- git diff --check: passed.
- No full end-to-end suite, live mailbox, database reset or destructive migration was used. Test fixtures use disposable databases.

## Phase 2 readiness

Phase 2 has an accepted priority/fairness contract, reusable classification vocabulary and operational delivery timing. Its remaining work is actual fair account admission across processes, reserved capacity, starvation prevention, aggregate resource ceilings and retry-safe lock handling. Define measurable resource budgets and admission/recovery fixtures before claiming fairness or freshness. Provider safe slicing remains Phase 3; coordinated visible local-count publication remains Phase 4. No Phase 1 field claims either guarantee.
