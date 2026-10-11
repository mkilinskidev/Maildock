# Reusable patterns and their limits

Pinned Thunderbird: **5ac95865d39e426e66122ef4f54907ffa474a579**, inspected **2026-10-11**. [Source map](01_SOURCE_MAP.md) supplies the pinned paths/symbols/ranges for evidence IDs below. All Maildock adaptations are proposals; none approves implementation.

## 1. Make message visibility independent of full content

**Problem:** downloading MIME bodies and attachments before listing messages makes first use depend on the largest messages.

**Thunderbird solution/evidence:** `ProcessMailboxUpdate` reconciles identities and fetches headers; `NormalMessageEndDownload` transfers header groups; `AddNewImapHeaderToDB` publishes additions. `HeaderFetchCompleted` subsequently hands body candidates to AutoSync or explicit body retrieval. `StreamMessage` checks local availability before remote access (T07, T10–T11, T15, T21).

**Benefit:** metadata can become useful while content is missing. **Limit:** full flag discovery can still delay first headers; filters requiring bodies can couple processing to content. Thunderbird's automatic offline copies are optional product behavior, not a necessity for Maildock.

**Maildock adaptation:** retain lazy display parts and attachment streaming; make metadata durability and publication the normal ingestion result. PostgreSQL metadata, text content and blob storage need distinct availability states, but do not need duplicate synchronization engines. A failed attachment fetch should not make metadata disappear. Existing v1 already has this useful separation ([comparison](04_MAILDOCK_COMPARISON.md)).

## 2. Use remote identity, not message dates, to determine membership

**Problem:** old/future/missing Date headers and sparse UID values can break date-defined completeness.

**Thunderbird solution/evidence:** discovery compares server UID/flag state with local UIDs; only missing identities are fetched. Reduced fields include Received, and header parsing records the UID independently from parsed dates. `AllocateImapUidString` compresses actual known UIDs, including gaps that full flag state proves empty (T08–T11). `test_missingDateUsesReceived` verifies metadata fallback, not a date-filtered sync frontier.

**Benefit:** discovery is independent of presentation order; no record per unused UID is required. **Limit:** full flags and missing-UID arrays can be large. UID order indicates allocation within an epoch, not the sender's Date or a guarantee of inbox relevance.

**Maildock adaptation:** a recent display window can be a UX optimization, but an old-dated new UID still needs ingestion. Keep account/folder/UIDVALIDITY/UID placement identity; do not equate RFC Message-ID with placement uniqueness. For sparse history, benchmark work proportional to returned identities rather than blindly traversing every numeric gap.

## 3. Separate complete evidence from partial change evidence

**Problem:** a delta response omits unchanged messages; treating absence as deletion destroys valid local state.

**Thunderbird solution/evidence:** `FindUidsToDelete` distinguishes full and partial flag state. Complete state allows removal of missing local UIDs; partial state mainly permits returned Deleted flags. `ProcessMailboxUpdate` falls back to a full flag fetch after count sanity suggests external expunges (T07–T08).

**Benefit:** inexpensive updates coexist with eventual repair. **Limit:** count sanity does not constitute a complete proof against every simultaneous arrival/deletion pattern. Full fallback can be expensive; no QRESYNC vanished-UID path was found (T14).

**Maildock adaptation:** keep explicit provider semantics for complete membership, returned flag changes and confirmed absence. v1 already uses successful SEARCH over known local UIDs to establish deletion evidence; preserve it until a measured alternative is correct. A repair pass can be low priority and resumable, but must finish its evidence unit before deleting anything. Do not copy Thunderbird's count heuristic as a universal server correctness guarantee.

## 4. Rebuild transient queues from durable message availability

**Problem:** persisting every scheduling decision creates many recovery states.

**Thunderbird solution/evidence:** AutoSync keeps queues, sets, offsets and retries in memory; it scans existing headers and skips `HasMsgOffline` bodies. A first STATUS response can force update if cached counts look unchanged but the summary DB has no headers (T17). Finished messages are distinguished from aborted partial writes (T19).

**Benefit:** the local facts are the source of repair work. **Limit:** rebuilding means additional scans; desktop processes have a different ownership model. Highest header UID/MODSEQ writes are not an atomic receipt frontier (T08, T11, T20).

**Maildock adaptation:** prefer durable facts — placements, content availability and provider-specific progress — over durable scheduler phases. Queue insertion can be repaired by a periodic scan if commits are idempotent. Keep transactional batch-plus-progress writes already present in v1. An always-on worker still needs durable due work and ownership across processes: purely in-memory desktop scheduling is insufficient.

## 5. Reconsider priority at real execution boundaries

**Problem:** a low-priority operation already holding a connection or lock ignores the priority of later work.

**Thunderbird solution/evidence:** AutoSync's completion callback can select a newly higher-priority sibling after a body group, and re-sorts pending message keys when new candidates arrive. Defaults group by bytes, not simply count; one oversized message is allowed (T16–T18).

**Benefit:** a clear continuation boundary permits reprioritization without cancelling every operation. **Limit:** this policy applies to bodies. Header transfer every ten messages is a DB/UI publication boundary, not a transport scheduling boundary. Header dump loops can finish all remaining IDs inside one URL (T09–T10). Bytes are not a wall-clock bound either.

**Maildock adaptation:** require metadata/history/repair execution units to release their execution lock and transport allocation before continuation. One worker framework can choose among operation kinds; the kind/priority need not imply separate implementations. Timeouts, returned-item limits and provider costs all matter; concrete limits must come from measurements, not historical 30/200/50 defaults.

## 6. Budget connections per account and admit that one connection changes the design

**Problem:** jobs that are independently concurrent still compete for a remote server limit.

**Thunderbird solution/evidence:** incoming-server connection cache matches selected folders and protects INBOX from arbitrary reuse; local fallback maximum is five. A busy same-folder match queues the proposed URL rather than opening another one (T04–T05).

**Benefit:** reuse reduces repeated authentication/selection and limits local connection creation. **Limit:** same-folder affinity can serialize urgent work behind history. Queue-head dispatch can delay later queued work; the cap is locally configured, not an adaptive proof of server capacity.

**Maildock adaptation:** own the complete account connection budget, including watchers, history, commands and on-demand content. Consider reserving a slot for urgent work only when capacity actually permits it. At capacity one, watcher use and background work must yield the same transport; fairness requires bounded operations, not an extra impossible connection. Do not copy same-folder busy affinity as the desired freshness policy.

## 7. Notifications request reconciliation; they are not the authoritative record

**Problem:** push signals can be coalesced, delayed or lost across disconnection.

**Thunderbird solution/evidence:** IDLE EXISTS routes through the ordinary folder update path, while timer biff and later selection provide other triggers. Parser count updates alone do not publish new messages. AutoSync's periodic status check similarly delegates to regular update (T02, T12–T13, T17).

**Benefit:** one reconciliation implementation can accept several wakeup sources. **Limit:** idle handling does not prove reliable same-folder preemption or an arrival latency bound. A wakeup during a running update may be suppressed by the folder-running guard (T01).

**Maildock adaptation:** express notifications as a need to check provider state and retain a pending need across active work. A polling repair trigger must work with no browser. Coalescing should preserve a later run rather than silently treating a wakeup as completed by unrelated active work. This is a requirement, not an approved checkpoint/enqueue design.

## 8. Keep protocol capabilities behind provider-specific reconciliation

**Problem:** one generic integer cursor makes unrelated protocols appear interchangeable.

**Thunderbird solution/evidence:** IMAP chooses full flags, high-water UID or optional CHANGEDSINCE according to selection state and capability/preferences. UIDVALIDITY resets identities. MOVE and UIDPLUS change command behavior (T07–T08, T14, T21).

**Benefit:** correctness uses the evidence each protocol actually provides. **Limit:** preference-gated optimizations are not universal guarantees; fallback code remains necessary.

**Maildock adaptation:** common job execution and persistence can share batch/result concepts, but IMAP epochs/UIDs and Gmail account history must remain opaque provider state. Capability negotiation is an adapter responsibility. Gmail label membership is not IMAP folder UID identity.

## Gmail REST: transferable principles, different mechanisms

The inspected stable Maildock baseline has Google OAuth targeting Gmail IMAP/SMTP, not a native REST history implementation. Gmail REST remains a product requirement for the redesign, not an observed v1 path (see comparison evidence M12).

Official [Gmail synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync) separates listing/retrieval from incremental history and requires full synchronization when an old history cursor returns HTTP 404. This supports provider-specific repair, not replacing UIDVALIDITY with `historyId`. The [history.list reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) describes non-contiguous history IDs, pagination and change types; arithmetic UID-range progress cannot be applied to them.

Official [push guidance](https://developers.google.com/workspace/gmail/api/guides/push) uses watch/Pub/Sub notifications to trigger history retrieval; watches expire and notifications can be delayed or dropped. Common wakeup/coalescing and eventual repair principles transfer. A history cursor, a list page token and an IMAP UID represent different things; this research does not prescribe their final commit boundaries or pagination algorithm.

Additional REST-specific issues requiring design evidence are request quotas/rate errors, account-wide versus label-scoped processing, message/label identity, and convergence during historical pagination. Lazy bodies still apply, but metadata projection and attachment retrieval use REST resources. Do not assume Gmail IMAP's `X-GM-*` fields are a native REST synchronization path (T09).

## Patterns to reject or restrict

Reject a direct port of desktop app-idle gating, Mork/mbox formats, same-folder serialization, unbounded metadata URL work, or count-only completeness. Restrict newest/smallest scheduling to the domain it actually covers. A rebuilt transient body queue is useful evidence against redundant durable scheduler state, but cannot justify eliminating Maildock's transactional progress, retry ownership or explicit failure handling.
