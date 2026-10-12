# Staged IMAP receiving implementation plan

2026-10-12. Planning only. The architecture is ready for staged planning with [readiness gates](IMPLEMENTATION_READINESS.md) and [OPEN decisions](DECISIONS.md); this review does not start any stage or authorize release. Prefer one reviewable commit per coherent change and separate fault/compatibility evidence. No giant replacement commit, another prototype, new receive engine, worker fleet or Gmail REST implementation.

Stages are vertical capabilities with bounded scope, not permission to expose an incomplete engine. Until a full account route is ready, keep it disabled in production; never allow old and new authoritative receiving writers to run concurrently for the same account. Use existing stable fixtures and retained failures as test oracles. Future tests listed below are requirements, not tests created/run by this task.

## Stage 1 — A fenced durable metadata commit

**Scope:** establish the production DB executor contract and one atomic mailbox metadata/frontier transaction, with no IMAP routing changes. Settle decisions D07–D09 before writing the affected component; validate implementation details in this isolated stage. A bounded fixture batch must be queryable after an independently observed commit and replayable after a lost reply.

**Modules:** proposed receiving transaction executor under `src/shared/infrastructure/database/`; `database-worker.ts`/`worker.ts` for isolated lane configuration; extract transaction-aware persistence from `MessageService.persistBatch`; inspect `db/migrations/0017_conversations.sql::maildock_reconcile_conversation` and subsequent trigger definitions. Keep web/SMTP/auth transactions intact.

**Persistence:** proposed new-install F/E/R/revision/due/wake and singleton owner fields, active-epoch read contract, unique event/placement keys and recommended deferred authority check. Review future fresh-install DDL/permissions separately; no v1 migration. Preserve message/attachment/conversation tables. All authoritative fact paths must enlist the check and revision; no unguarded bypass.

**Tests:** original late callback rolling back replacement and prepared old DELETE; paused COMMIT after lease expiry; takeover before/after L; unknown COMMIT response; reserve/startup/TLS/lock/statement deadline; rollback on ancillary threading/event failure; independent-reader facts/frontier/notification atomicity, empty interval and UID upper bounds. Verify forced lane end cannot affect an unrelated shared-pool transaction. Test account disable and mailbox epoch conflict while commit waits.

**Acceptance:** 32/32 replacement rows survive old cleanup; rejected authority/revision leaves all facts unchanged; acknowledged commit matches independent durable state; unknown outcome resolves before retry; no shared pool retirement, no network-spanning DB session. Physical durability expiry remains disclosed. Cost of conversation merges fits bounded commit budget or names a blocker.

**Dependencies:** agreement on executor/authority/revision contract; existing stable database/security setup. **Reversion:** keep module unwired and revert commits; disposable new-install fixtures may be recreated. Do not downgrade a populated new schema into v1 automatically. A durable rollback strategy for deployed new-schema data needs its own review before enabling.

## Stage 2 — One real INBOX metadata window

**Scope:** supported ImapFlow adapter and a single complete descending INBOX SEARCH/FETCH operation into Stage 1 persistence. Exercise actual wire completion, configured resource limits and destructive abort, without turning the experiment into an imported production service.

**Modules:** extract owned-client receive functions from `imap-smtp-mail-provider.ts`; keep normalization and lifecycle guards; proposed narrow adapter in accounts infrastructure; if approved, isolate additive ESM/CJS patch from existing STORE patch. Existing tests/fixture peers provide raw responses.

**Persistence:** initialize epoch and E=B/F=B-1/R=0 atomically; advance E only after complete evidence, increment revision. Active epoch scopes UI queries; partial metadata cannot silently move frontiers. No receipt table.

**Tests:** dense/sparse/empty windows, SEARCH absent response versus complete empty, omitted/duplicate/unexpected metadata, excessive nesting/size/aggregate/ESEARCH, legal unsolicited flag-only/sequence-only FETCH, stale STATUS refreshed, hung SELECT/FETCH/DONE/trickle, late token, epoch reset, parser-byte amplification and lock release. Preserve conditional STORE tests with any patch.

**Acceptance:** first useful bounded metadata requires no full inventory/body; failed/incomplete command advances nothing; actual tagged success and settled scope release reusable connection; destructive failures retire it; aggregate and parser budgets include declared headroom. Compatibility/poison policy remains visible.

**Dependencies:** Stage 1 and approved adapter surface/metadata limits. **Reversion:** adapter remains isolated/unwired until accepted; revert extraction/patch independently, preserving original STORE patch. No provider accounts are touched by this stage's tests.

## Stage 3 — Independent fresh discovery and progressive history

**Scope:** one owner/account executor and shared selector choose one window at a time; fresh work is eligible from first SELECT. Implement bounded opportunity history protection, per-account current alternation, account/folder rotation and overload admission in the same selector. Start with C=1; optional watcher comes later. This is the smallest no-browser receive milestone, tested in disposable integration configuration.

**Modules:** receiving coordinator/selector composed by `worker.ts`; extracts from `MessageService`, `DeltaSyncService`, `BackfillSyncService`; replace compatibility scheduler targets behind `requestSync`; no changes to SMTP delivery. No old consumer may execute the same account.

**Persistence:** atomic F/E progress and due/wake generation; history candidate derives from E>1. Aging/count remains ephemeral; no durable scheduling phase.

**Tests:** 50k+10 arrivals at barriers, old dates, current alternation, C=1/W=1 history under continuously replenished bounded demand, account fairness, age threshold/count boundary, resource-gate suppression, no back-to-back protected history, hard overload/recovery, sparse overflow/shrink, no-browser cold start. Run the new M2 policy, not Phase 3's old zero-history assertion.

**Acceptance:** deterministic repeated safe history commits while current demand remains nonempty; configured fresh/user wait envelopes hold in reference profile; hard overload has recorded reason and resumes at a safe boundary; every unit releases account/W allocation. Preserve existing 5 s user and watcher-free 20 s fresh laboratory hypotheses, report p95 and maxima separately. Numerical history parameters must be approved from evidence before enabling.

**Dependencies:** Stages 1–2 and D10 admission settings. **Reversion:** disable integrated route and stop/settle it before restoring stable account routing in a schema-compatible environment; never run two engines for comparison against the same account. Keep isolated DB fixtures reproducible.

## Stage 4 — Real durable wakes, takeover and restart

**Scope:** compose pg-boss account wake handlers, due repair and elected coordinator into always-on worker startup/pause/shutdown. Integrate existing command/content producers as durable eligibility signals, with execution routing enabled only as Stage 6 completes. Add optional IDLE when C/P permit; polling remains correctness fallback.

**Modules:** `worker-process.ts`, `JobRuntime`, recent/delta/backfill/discovery schedulers, `coalesced-sync-job.ts`, `IdleWatcherManager`, compatibility facades in `web.ts`, and pending-intent scanners. Retire old orchestration registration only at cutover.

**Persistence:** durable due before best-effort wake; repair paginates accounts/folders/intents; coordinator lease generation/expiry. Use existing pending rows for commands/content/attachments/sent-copy, no second intent ledger.

**Tests:** actual pg-boss ACK/redelivery/stately/coalescing patch; crash after due commit/before send, after metadata commit/before ACK and continuation loss; two processes contest lease; stale resumed owner; remote-cap rejection; watcher loss/hung DONE; MFA readiness pause/resume and graceful shutdown during start; current-first restart with withheld final arrivals reproducing the old 179 s failure. Test follower delivery and lost in-process signals.

**Acceptance:** only elected owner opens receiving sockets; missed wake repaired within bounded sweep; duplicate ACK/redelivery never duplicates work facts/events; startup current opportunities precede history protection; sockets/DB settle before lease release. Remote abandoned sockets/backoff limitations remain explicit. No browser prerequisite.

**Dependencies:** Stage 3 and Stage 1 retirement proof. **Reversion:** stop new consumers/coordinator, settle resources and disable route before switching producer/consumer facades together. Preserve pg-boss jobs/intents; do not purge queues or treat ACK as completed business work.

## Stage 5 — Bounded repair and folder lifecycle

**Scope:** exact known-UID membership/FLAGS pages independent of fresh; recent-known and bulk due work; per-folder rotation, LIST topology, role preservation, epoch switches and bounded cleanup. Secondary arrivals remain independent of secondary history.

**Modules:** extracts from `synchronizeDeltaMailbox`/`DeltaSyncService`; `MailboxDiscoveryService`, `MailboxService`, `MailboxRoleService`; all active-epoch list/search/conversation/content read paths; bounded cleanup. Review topology finalization before code: complete LIST limits and bounded DB publication cannot be hand-waved.

**Persistence:** R/revision atomic with confirmed absence/flags; separate per-folder epochs/due; lifecycle/missing state retained; old epoch instantly invisible, cleanup in bounded transactions preserving referenced blobs/drafts/outgoing. Last-pass time optional diagnostics. Full FLAGS fallback first; CHANGEDSINCE optimization can follow separately.

**Tests:** 15k deletions+10 arrivals; equal-count churn; old/new flag races and NOMODSEQ; cursor wrap ABA; omitted flags recheck; INBOX-before-secondary-LIST/bootstrap; secondary-folder finite revisit under busy INBOX; folder rename/delete/recreate/disable during FETCH; ambiguous/missing/manual role mapping; old epoch cleanup including cascade/threading cost.

**Acceptance:** exact quiet membership/flags convergence, no count-only/partial deletion, no full known-list command in fresh turn, no stale resurrection or cross-epoch content, topology loss only after complete evidence; bounded folder/account fairness and cleanup resource use.

**Dependencies:** Stages 1–4, approved conservative rename/LIST contract. **Reversion:** disable repair/discovery stage in isolated deployment and revert module commits; retain active epoch fences and current frontiers. Do not reveal old epoch records or reverse confirmed deletes to simulate rollback.

## Stage 6 — User actions and lazy content through the same owner

Split this milestone into independently reviewable commits: **6a flags/MOVE**, **6b content/attachments**, **6c sent-copy APPEND**. Gate complete account cutover on all three so no direct unbudgeted client remains.

**Scope:** preserve durable optimistic command intent/status/uncertainty, local drafts, cached search/rendering, attachment/forward safety and SMTP acceptance. Owner admits individual current work and complete content slices, alternating with fresh. APPEND is one indivisible bounded upload; degraded timeout compatibility requires approval.

**Modules:** `MessageCommandService`/jobs and provider `mutateMessage`; `MessageContentService`/content jobs; `AttachmentService`/attachment jobs/locks and local storage; `SentCopyService`/jobs/receiving part of outgoing lock; provider content/attachment/append/lookup functions. Preserve `DraftService`, outgoing SMTP and UI contracts.

**Persistence:** reuse original intent/cache/outgoing rows and transitions; short fenced outcome transactions and source/destination revisions; incomplete decoding/storage stays unavailable. No durable decoder cursor: discard/restart part on interrupted lifetime. Keep local draft revision semantics distinct from mailbox revision.

**Tests:** optimistic flags rollback, conditional conflicts/protocol errors, move role/epoch/source disappearance/unknown success without replay, destination notifications, APPENDUID missing/lost ACK/captured path/exact lookup, SMTP sent despite copy failure, content BODY.PEEK origin/length/finality and digest, Base64/QP/charset/zero-length/malformed parts, CID/security/limits, epoch switch during finalization, concurrent duplicate requests, blob orphan/reference safety, draft/forward/reply and UI status regressions. C=1 slow content/APPEND runs alongside arrivals/actions.

**Acceptance:** all receiving clients pass through C/P/W; no network-spanning attachment/sent-copy DB lock; user wire admission remains inside agreed reference envelope; no blind MOVE/APPEND retry, duplicate SMTP resend or partial ready cache. Existing MIME bytes, search text, sanitized rendering, notification exclusions and local draft behavior preserved.

**Dependencies:** Stages 1–5; content/adapter and uncertain-upload decisions. **Reversion:** each commit can revert while integration is disabled. During enabled-account rollback, settle unknown operations and reload durable intent before changing routing; never replay ambiguous mutations just to restore old service behavior.

## Stage 7 — Compatibility release gate and retirement

**Scope:** provider/MIME/multi-folder/security/business regression matrix and measured production-path resource/fairness acceptance. Retire unused recent/delta/backfill lifecycle fields/modules and old receive lock only when no caller remains. No unrelated features.

**Modules:** affected worker/web/provider/service/UI query paths, test suites, new-install schema/config/docs; preserve SMTP/OAuth/search/drafts/attachments/notifications/commands. Keep dependency patch upgrade checks.

**Persistence:** remove redundant old synchronization fields in fresh-install schema after verified reader cleanup; retain necessary business/due/revision state. No existing-v1 database migration.

**Tests:** all validation scenario gates, repeated deterministic/seeded reference workloads with new history opportunities, actual queue/business persistence, authorized Gmail/Microsoft/generic compatibility fixtures, OAuth refresh/revocation, restrictive caps, LIST/MIME large input, unknown COMMIT and original failing callback in actual production executor, readiness/security checks and end-to-end UI behavior. Verify dependency pin/update regressions.

**Acceptance:** every mandatory readiness risk is resolved or explicitly excludes an unsupported provider/input with approved visible behavior; no correctness blocker waived as optimization. Per-account tails, hard-overload reasons, release/settlement and memory plateau documented. No claimed provider SLA extrapolated from Dovecot. Obtain separate release authorization only after reviewable evidence.

**Dependencies:** all preceding milestones accepted and product OPEN settings resolved. **Reversion:** stop receive admission, settle/record uncertainty, preserve durable data and revert to last compatible new-engine build; use backups/recreation for disposable fresh-install trials. Schema rollback across incompatible versions is not automatic. Keep prior branches/docs/results for comparison; do not delete history.
