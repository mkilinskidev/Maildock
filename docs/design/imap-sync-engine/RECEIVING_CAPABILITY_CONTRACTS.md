# R01 — Receiving capability and compatibility contracts

2026-10-14. Design only, inspected at `3ad3ae68d9dd3a65267f45292ba0a524b6169110`
on `feature/imap-sync-stage-4c-worker`. The user-approved order is R01–R16
before the initial Docker/UI milestone, R17 secondary-folder parity, R18 cleanup
and full validation. This document supplies implementation contracts for B1–B13;
it neither activates the engine nor authorizes R02 execution in this task.

Baseline: [revised plan](REVISED_IMPLEMENTATION_PLAN.md),
[Stage 4C counterexamples](../../implementation/imap-sync-engine/STAGE_4C_RESULTS.md),
[decisions](DECISIONS.md), accepted Stage 1–4B components. Historical OPEN or
RECOMMENDED labels do not reopen accepted behavior. Required tests below are
future acceptance gates, not tests added or run by R01.

## Shared authority vocabulary

Existing boundaries are [`0035`](../../../db/migrations/0035_receiving_authority.sql),
[`0036`](../../../db/migrations/0036_receiving_demand.sql),
[`0037`](../../../db/migrations/0037_receiving_election.sql),
[`ReceivingExecutor`](../../../src/shared/infrastructure/database/receiving-executor.ts),
[`receiving-authority`](../../../src/shared/infrastructure/database/receiving-authority.ts)
and [`ReceivingPersistence`](../../../src/modules/mail/application/receiving-persistence.ts).

Every publication captures an immutable operation kind, actor/term, ephemeral
turn lifetime, account/configuration/lifecycle identity, exact source identity,
expected mailbox epoch/revision/F/E/R, and existing intent ID where applicable.
Evidence is bounded, validated and copied before SQL admission. Proposed SQL
capabilities below are explicit allowlists on these boundaries, not arbitrary
callbacks or a setting that disables guards. Validate OLD and NEW identities.

Lock order: coordinator SHARE → account SHARE → mailbox UUID order UPDATE →
receiving-state UUID order UPDATE → intent/cache/placement rows in stable key
order. Takeover/renewal uses the conflicting coordinator UPDATE. Lifecycle writes
use the same order, with account UPDATE. Each affected enrolled mailbox advances
revision exactly once, including cache-only publication; F/E/R changes require
their existing evidence rules. Metadata behavior and new-install enrollment
restrictions remain intact. Mandatory deferred checks validate the complete scope,
operation allowlist, resulting identities/revisions and DB-clock lease at logical
commit point **L**. D15 Variant A remains unchanged.

Network, decoding, sanitization and blob staging happen outside SQL reservations.
Receiving transactions use the existing revocable executor, at most its current
two-second control/publication budget and remaining operation deadline. Retirement
never means backend disappearance. Unknown COMMIT is recovered under conflicting
locks before retry; an unlocked snapshot cannot establish failure. No counter
wrap/reset, reused retired client, public authority grant or superuser is added.
The ordinary schema-owner trust boundary documented in Stage 1 and enforced at
startup by [`database-authority`](../../../src/shared/infrastructure/database/database-authority.ts)
is preserved; this is not a sandbox against hostile owner DDL/GUC forgery.

## C1 — Durable business intent and optimistic projection (B1–B3)

- **Existing boundary:** `MessageCommandService.create/run/fail`,
  `MessageContentService.request/detail/run`, `AttachmentService.request/run`,
  `persistAttachmentMetadata`, their API routes, existing `message_commands`,
  `message_contents`, `message_attachments` and `ReceivingDemand`.
- **Minimal change:** narrow request functions validate and lock the active
  placement, then insert/coalesce intent and record due/generation in the same
  short application transaction; wake only after commit. Commands retain action,
  original flags and frozen source/destination; serialize on placement to permit
  only one pending/executing action. Project requested Seen/Flagged and MOVE
  hiding from that command in lists, detail and counts. Failure removes the
  projection; it never restores a saved flag array over newer canonical flags.
  Remove the `recentSyncUidValidity` prerequisite in favor of C4 identity.
- **Authority/transactions:** web may create pending command rows, or create a
  pending content row with null payload and validated source provenance. Existing
  content/attachment rows may transition `not_fetched/failed → pending`, updating
  only status/error/request time and an explicitly validated request identity.
  It cannot overwrite a ready result, retarget an in-flight request, set
  fetching/executing/ready/succeeded, attempts, result UID, blob, body/search text,
  flags, MODSEQ, `action_hidden`, MIME metadata, epoch, coverage or revision.
  Pending-row insertion must make the search-body trigger a no-op, including
  preserving any existing derived body. `detail` becomes read-only: attachment
  descriptors are published with fenced metadata, never created on opening mail.
  Owner claims and result/failure CAS use C3. Ordinary local draft uploads remain
  local business writes, distinct from remote attachment results.
- **Failure/uncertainty:** enqueue loss/ACK does not fail or clear durable pending
  work. Duplicate requests coalesce against the same source; different stale
  sources fail validation. Only a matching attempt may settle an intent; a late
  failure cannot overwrite ready/succeeded or a newer retry. Local scheduling
  diagnostics do not assert a remote outcome. C8 governs executing mutations.
- **Negative tests:** enrolled requests survive lost wakes without canonical
  UPDATEs; simultaneous duplicate actions; forged ready/blob/body/destination;
  mixed pending-plus-payload UPDATE; stale/cross-account placement; opening detail
  produces no writes; failed projection preserves newly received flags.
- **First consumer:** R02; R10–R12 consume execution/result semantics.

## C2 — One owned admission boundary and control headroom (B5, B6, B12, B13)

- **Existing boundary:** `ElectedReceivingCoordinator.loadAccount/notify`,
  `ReceivingScheduler.select/admit`, `runOneReceivingTurn`, owned metadata
  adapter, provider client factories and legacy worker registrations.
- **Minimal change:** extend the existing selector with typed metadata/repair,
  bootstrap/LIST, STORE/MOVE, content/attachment slices, APPEND/lookup and IMAP
  diagnostic work. Selection yields a captured operation, not an autonomous
  callback/queue worker. Only committed elected ownership can admit it. Bootstrap
  uses account identity before a mailbox exists; unsaved diagnostics use C7.
- **Authority/transactions:** W is the global active-operation bound; C=1 is
  one data operation/socket per persisted account across all kinds, with W=1
  supported. An unsaved diagnostic consumes W and its own bounded ephemeral key;
  a saved or edited-saved diagnostic consumes the account's C slot. No optional
  watcher is introduced. Admission remains held through actual socket and local
  SQL retirement, even after cancellation. Validate DB ownership and configuration
  in a short scope before client creation, and check lifetime after each await.
  Provider helpers must accept the owned lifetime; they cannot create a second
  client outside it. SMTP keeps its separate existing path.
  Reserve one aggregate executor admission position for control: at most
  `min(W, 2D−1)` active data turns, each with at most one executing/queued SQL
  request, plus one coalesced control request. Control includes renewal,
  membership refresh and validation; renewal takes priority. All remain within
  D executing/D waiting. D=1 permits one data turn and one waiting control
  request; this reserves admission capacity, not a magically free running lane.
  Missed renewal deadline still terminates ownership.
- **Failure/uncertainty:** current/user work rotates at bounded unit boundaries
  while retaining the accepted startup fresh barrier and protected history
  policy. Body/attachment slices yield only after validated group completion;
  APPEND is one bounded non-preemptible unit. Slow work is cancelled under the
  existing deadline/size policy, not given another lane. Reload bounded live
  membership on wakes and periodic control opportunities; do not retain 4B's
  acquisition-only candidate list. Due settlement CAS checks captured request
  generations and remaining durable commands/content/attachments/sent-copy work.
  Account and mailbox due are settled together against their captured generations;
  newer requests remain due. ACK never clears due. `sentCopySyncPending` clears
  only after fenced targeted destination publication, not demand acceptance.
  Deferred secondary demand cannot be reported complete.
- **Negative tests:** followers/expired tokens create zero sockets; concurrent
  metadata/action/test for one account; W=1/2/4 and D=1/2 saturation; cancellation
  cannot free a slot early; renewal under full publication demand fails closed;
  late requests defeat due clearing; enable/disable membership changes; no legacy
  secondary client executes after cutover.
- **First consumer:** R03; R09 and R15 finish credentials/membership/settlement.

## C3 — Operation-specific fenced SQL publication (B2, B3, B9)

- **Existing boundary:** Stage 1 claim/write/revision/deferred guards,
  `ReceivingPersistence.persist`, `persistMessageMetadata`, attachment/blob
  publication, command result transactions, conversation trigger and
  `maildock_update_search_body` in `0019_global_search.sql`.
- **Minimal change:** add the following separate capabilities to existing
  authority/persistence APIs. They share the authority rules above; none grants
  unrestricted account-wide UPDATE permission.

| Capability | Exact allowed result and scope |
| --- | --- |
| Metadata | Existing bounded fresh/history/repair/epoch evidence and writes; retain 128 records/2 MiB. MIME attachment descriptors and existing conversation/notification effects remain in the same transaction. |
| Content | One matching claimed request and active source tuple; publish complete decoded/sanitized text, policy version and search text, or matching failure. Source revision advances; F/E/R unchanged. |
| Attachment | One matching request, active source tuple and MIME part identity; publish verified finalized blob reference/size plus matching draft-attachment references atomically, or matching failure. No partial blob is ready. |
| Command | CAS pending → executing before wire mutation; matching attempt result settles command and publishes evidenced flags/MODSEQ or source removal, plus due repair. Claim/result transactions are separate from IMAP. Resultless local failure changes only intent/projection. |
| MOVE / APPEND | At most two same-account enrolled mailbox scopes: source/destination for MOVE, destination only for APPEND. Validate each expected state, selected path/epoch and attempt binding. Publish known placements and business result atomically; do not advance interval F/E from targeted results. |
| Shared derived cache | Content's source capability permits only `messages.search_body` derived from that exact validated cache row and its generated vector. Other enrolled placements of the same message do not need revision changes for this derived-only write. No envelope/MIME/account/placement mutation is permitted through this exception. |

- **Authority/transactions:** shared canonical metadata updates still require all
  affected enrolled placement scopes; reject if outside the bounded operation
  scope. For a known MOVE destination reuse the message with unchanged metadata;
  do not acquire arbitrarily many folders to refresh it. INSERT/UPDATE/DELETE
  allowlists include ancillary trigger writes and both sides of identity changes.
  Claim markers on existing intents include the attempt's term/configuration/
  source binding so same-owner late callbacks cannot settle newer attempts.
  Blob registration and ready linkage commit together; physical file staging is
  not authority and unlinked files use existing cleanup. Content/attachment ready
  evidence includes exact BODY.PEEK part/origin, encoded length or proven EOF,
  successful final command/stream completion and continuous decoding across
  slices; interruption discards partial decoded output and restarts the part.
  Attachment finalization additionally verifies complete size/digest and stored
  blob existence. Recovery reloads all
  affected revisions and intent/result rows in the same lock order.
- **Failure/uncertainty:** either all scoped results/revisions commit or none do.
  Missing destination evidence records uncertainty/repair on the existing intent,
  never fabricates a UID/placement. Unknown publication acknowledgment triggers
  locked recovery before any remote retry. Cache source replacement is a fenced
  operation, not an intent-write escape hatch.
- **Negative tests:** Stage 1 32-row late-callback oracle and L timing remain;
  expired term, ABA revision/attempt, forged kind or source, payload mutation,
  third/cross-account scope, shared search trigger changing envelope, atomic
  source/destination rollback, deterministic lock order, ready versus late failure.
- **First consumer:** R04; R11/R12/R13/R14 consume individual capabilities.

## C4 — Active identity for every public read/reference (B7, B8)

- **Existing boundary:** `receiving_current_placements`, `MessageService` lists/
  all-INBOX, `SearchService`, `ConversationService`, mailbox counts, content and
  attachment lookups, `NotificationService`, draft/compose/render services.
- **Minimal change:** one shared SQL predicate, applied before joins, pagination,
  ranking, counts and conversation member aggregation. For requested
  `(account A, mailbox M, message X, epoch E, UID U)` it requires:

  ```text
  account exists; mailbox.account_id = message.account_id = A;
  placement.mailbox_id = M; placement.message_id = X;
  mailbox selectable AND lifecycle_status = active;
  1 <= placement.uid = U <= 4294967295;
  placement.uid_validity = E = mailbox.uid_validity = receiving_mailboxes.epoch;
  placement.configuration_binding = receiving_mailboxes.configuration_binding
    = account.configuration_version.
  ```

  E/U are resolved from the active placement when the API supplies only IDs;
  message ID alone is never authority. Missing enrollment in a receiving account
  means topology-only secondary metadata, with zero usable placements, not legacy
  receiving fallback. A wholly unenrolled account may retain the legacy predicate
  only before cutover/inside baseline fixtures; this does not authorize dual routing.
- **Authority/transactions:** account enabled is additionally required for remote
  requests/actions, not for reading otherwise valid cached mail on a disabled
  account. Pending MOVE hides the source through C1 projection. Shared-message
  visibility requires at least one qualifying visible placement. Content and
  attachments additionally require ready data whose frozen source tuple and
  configuration binding still satisfy this predicate; same message ID or MIME
  part number does not prove cross-epoch byte identity. Add source mailbox/epoch/
  UID/configuration provenance to existing content rows; extend existing attachment
  provenance with configuration binding. Do not retarget ready bytes on request.
  If the source disappears but another placement remains, fetch from a newly
  validated source rather than exposing unproven old cache bytes. Existing local
  draft/outgoing blob snapshots remain usable independently of remote placement.
- **Failure/uncertainty:** stale rows remain physically present but cannot yield
  detail, body-only search hits/snippets/rank, conversation dates/counts, downloads,
  inline CID resources or new reply/forward references. Search must build the
  effective vector from header metadata and only eligible body text; filtering
  placements alone leaves stale `messages.search_body` searchable. New compose
  preparation freezes source epoch/UID/configuration on the existing source
  context; validate it on reuse. A copied local draft remains editable/sendable
  after source loss, but cannot re-read stale remote resources.
- **Negative tests:** epoch/configuration replacement with old rows retained;
  body-only stale search hit; stale conversation newest member/count; direct
  attachment/CID URL; compose-source ABA; disabled cached read versus rejected
  fetch; legitimate local draft blob survives remote invalidation.
- **First consumer:** R05; R02 uses the predicate for request validation.

## C5 — Complete bounded LIST, bootstrap and identity replacement (B4, B5, B8)

- **Existing boundary:** `listMailboxes`, `MailboxDiscoveryService.run`,
  `MailboxService.reconcile`, `MailboxRoleService`, selected metadata evidence,
  `ReceivingPersistence.initialize/persist(kind: 'epoch')` and elected candidates.
- **Minimal change:** bootstrap an enabled account with no mailbox via owned
  SELECT INBOX; complete correlated tagged OK plus explicit valid UIDVALIDITY/
  UIDNEXT creates canonical INBOX and enrollment atomically in a fenced account
  bootstrap transaction. Empty INBOX is valid. Failed SELECT creates no identity.
  A completed epoch mismatch publishes replacement before any new-epoch FETCH;
  reset F=UIDNEXT−1, E=UIDNEXT, R=0 and increment revision. Configuration rebinding
  in C6 uses the same empty-coverage replacement even if numeric UIDVALIDITY repeats.
- **Authority/transactions:** LIST evidence must include account/configuration,
  request coverage for the entire namespace (not subscribed-only), correlated
  successful final command completion, unique paths/unambiguous stable IDs,
  bounded parsed bytes and all entries. Initial topology publication bound is
  128 affected mailbox identities (union of existing and observed), 2 MiB
  normalized evidence, with existing adapter raw/parser and operation budgets.
  These are conservative component limits, not provider/SLA claims. Topology is
  an explicit account capability, distinct from the two-mailbox data capability:
  lock the bounded entire affected set in UUID order, compare captured topology
  identities/manual mappings, and atomically publish metadata/missing transitions,
  autodetected roles and one revision increment for each affected enrolled scope.
  Its deferred lifecycle check explicitly permits evidenced missing/nonselectable
  results; it cannot publish message/cache data or delete receiving state.
  Manual mappings win; concurrent manual change rejects stale role publication.
  LIST STATUS values are observations, not authorization to replace an enrolled
  epoch; SELECT establishes usable identity. Enroll a selected empty operation
  destination before MOVE/APPEND without starting its ordinary inventory/history.
- **Failure/uncertainty:** reject the whole LIST on partial/failed/over-budget/
  conflicting evidence or scope overflow; no partial additions, role remap or
  missing transition. Keep prior topology and due work with bounded diagnostic/
  backoff. Rename preserves UUID only with unambiguous provider stable identity;
  otherwise old path becomes missing and new path receives new identity. Never
  infer rename from counts or transfer UID/coverage. Replacement preserves old
  physical placements but C4 hides them; no populated legacy enrollment/conversion.
- **Negative tests:** absent/trickled SELECT, UIDNEXT=1, delayed old FETCH;
  subscribed-only or interrupted LIST, duplicate path/stable ID, bounds overflow;
  rename/delete/recreate, manual role change during wire wait, selected destination
  mismatch, missing enrolled INBOX, atomic topology failure without false absence.
- **First consumer:** R06 bootstrap/epoch; R07 topology and destinations.

## C6 — Configuration, disable and physical deletion (B10, B13)

- **Existing boundary:** `AccountsService.update/setEnabled/delete`, OAuth
  reconnect, `mail_accounts`, cascades/RESTRICT dependencies in `schema.ts`,
  account SHARE locking and undeletable `receiving_mailboxes` in Stage 1.
- **Minimal change:** additive monotonic `configuration_version` on the account
  and matching binding on existing receiving state/placements/intents/cache
  provenance. Change it on IMAP endpoint/security/login/password, auth method/
  provider/principal or explicit reconnect/grant replacement. Display/sender/SMTP
  edits, due hints and routine access-token/cache rotation do not change it.
  A separate account lifecycle version changes on enable/disable; this is needed
  to reject disable→re-enable ABA without invalidating retained cached mail.
  Captured work compares both versions; facts bind configuration only. Counters
  cannot be `updatedAt` or wake generation. Identity additions are on existing
  rows, necessary because the same server epoch/UID can recur after account edits.
- **Authority/transactions:** lifecycle updates serialize with publication using
  account UPDATE and commit demand atomically. Disable cancels membership/new
  admission; pending read intents remain dormant, and executing mutations use C8
  recovery on re-enable. Configuration change makes old bindings unusable until
  owned SELECT/replacement; no frontier/revision is reset in place.
  DELETE retains the existing physical-removal contract and existing RESTRICT
  refusal for drafts/outgoing rows; do not silently delete those records or hide
  a retained account as success. A terminal account-removal function locks
  coordinator SHARE then account UPDATE and all mailbox/state rows in order,
  verifies dependencies, and deletes receiving state plus existing cascade rows
  and account in one bounded transaction. This narrowly permits state DELETE
  only when the entire account identity is removed at commit, including deferred
  terminal validation; ordinary state DELETE/reset remains forbidden. It needs
  authenticated application lifecycle authority, not a live receiving owner, so
  removal also works with workers stopped. No source UUID may be reused.
- **Failure/uncertainty:** lock timeout/oversized deletion leaves the whole account
  unchanged and reports retryable failure. Do not disable in a separately committed
  preparatory transaction. If an old publication acquired account SHARE first,
  its valid L may complete before deletion; deletion waits. If lifecycle wins,
  the blocked old transaction rechecks missing/disabled/changed identity and fails.
  A still-live remote socket may have an uncertain effect but cannot recreate DB
  identity after deletion. Unreferenced physical blobs use existing cleanup;
  shared draft/outgoing/signature blobs are retained. Old jobs become no-ops.
- **Negative tests:** host/principal edit with repeated epoch/UID; password edit,
  normal OAuth refresh without invalidation; disable/re-enable during FETCH/SQL;
  DELETE blocked behind valid old L and lifecycle-first rejection; RESTRICT
  dependency refusal; deletion timeout rollback; forged standalone state DELETE;
  callback/job after account removal cannot republish.
- **First consumer:** R08; R04 provides the terminal SQL capability.

## C7 — Credentials and diagnostic connections (B11, B12)

- **Existing boundary:** `AccountsService.getProviderImapAccountForWork`,
  `testUnsaved/testExisting`, Google `accessToken/complete/requestToken`, Microsoft
  `accessToken/complete`, provider `testConnection`, 4B DB-only account loader.
- **Minimal change:** loader returns bounded encrypted credential/configuration
  snapshot only. Resolve/refresh outside all database transactions/reservations
  with operation cancellation and an absolute deadline passed through HTTP/MSAL
  transport. Then short CAS persists refreshed encrypted cache only if captured
  configuration/grant still matches; reconnect commits new configuration and due.
  Coalesce refresh per account across IMAP/SMTP callers in the process without
  holding a DB lock. Cross-process refresh uses compare-and-set cache identity,
  never overwrites a newer grant; unknown token rotation requires reconnect rather
  than blind refresh replay. OAuth reconnect's fallback refresh also leaves SQL.
- **Authority/transactions:** check elected ownership, enabled/lifecycle and
  configuration after refresh, immediately before owned IMAP construction.
  Cancellation revokes late refresh/cache publication; a transport that cannot
  actually abort must retain its bounded allocation through settlement and cannot
  resurrect work. SMTP credential resolution remains separate and must work with
  app-pool size one. Saved diagnostics join account admission; edited-saved input
  is ephemeral and cannot mark persisted configuration verified. Only an exact
  saved configuration may CAS diagnostic status/capabilities, with owner validation;
  diagnostic success confers no mailbox/epoch/frontier authority.
- **Failure/uncertainty:** unsaved tests require authenticated, bounded, ephemeral
  delivery from web to the elected selector (choice U1 below), no account creation,
  persistent ledger, credentials in wake jobs or direct web IMAP fallback. Capture
  deadline/request ID and caller disconnect cancellation; request/response loss,
  follower or unavailable owner returns unavailable/retryable diagnostic failure.
  No automatic replay after timeout. Secrets are excluded from logs/results and
  discarded at settlement; SMTP test behavior remains independent.
- **Negative tests:** stalled refresh abort and late completion; expired/revoked
  grant, refresh/reconnect race, lost owner before client creation, pool-size-one
  SMTP; stale saved diagnostic status write; unauthenticated/oversized/follower
  ephemeral request; disconnect/takeover produces no late socket or persisted secret.
- **First consumer:** R09; R03 consumes the diagnostic envelope/admission contract.

## C8 — STORE, MOVE and APPEND uncertainty without duplicate effects (B6, B9)

- **Existing boundary:** conditional `mutateMessage` STORE/MOVE, command
  pending/executing/succeeded/failed and attempts, `SentCopyService` saving/saved/
  uncertain state, frozen attempted destination, `appendMessage/findSentCopy`,
  existing outgoing Message-ID/MIME snapshot and both sent-copy policies.
- **Minimal change:** freeze configuration, selected source/destination identity
  and attempt before remote mutation in the existing intent/outgoing rows. Persist
  the owner claim before sending. Restarted executing/saving is evidence of an
  attempted operation, not permission to resend. No new receipt/remote ledger.
- **Authority/transactions:** C2 owns mutation and reconciliation; C3 publishes
  only exact evidence. STORE is desired add/remove of one flag, not replay of the
  original whole flag set. After unknown STORE, re-SELECT same identity and fetch
  current flags/MODSEQ; if desired state is present, settle from evidence. Otherwise
  use fresh conditional STORE when supported, retaining existing conflict and
  bounded-attempt behavior. Without MODSEQ support, desired single-flag STORE is
  idempotent but provides no stronger concurrent-client guarantee. Never resend
  across epoch/configuration change.
  MOVE executes once. Complete MOVE/source absence may settle removal; a target
  placement additionally requires selected destination epoch and valid COPYUID
  mapping or independently verified exact destination evidence. Missing mapping
  requires source/destination repair, not a fabricated target UID. An uncertain
  MOVE becomes existing failed-with-uncertainty diagnostic plus durable repair;
  remove optimistic hiding, do not claim remote rollback or blindly resend.
  APPEND freezes Sent mailbox/path/configuration/selected epoch, immutable MIME
  and Message-ID on `outgoing_messages` before saving. Valid APPENDUID or bounded
  unambiguous lookup in that same destination can settle saved; verify metadata
  before publishing a placement. Missing/ambiguous match remains uncertain,
  including a completed lookup with no match; never auto-APPEND again or follow
  a newly mapped role. Server sent-copy policy never triggers Maildock APPEND.
- **Failure/uncertainty:** socket cancellation does not retract a sent mutation.
  Unknown SQL claim acknowledgment must be recovered before wire execution;
  unknown SQL result acknowledgment must be recovered before remote retry.
  Re-enable/takeover resumes reconciliation of executing/saving rows. Keep SMTP
  sent success distinct from Sent-copy failed/uncertain state. APPEND uses existing
  MIME limits and bounded turn deadline; oversized/slow upload produces explicit
  failed-before-attempt or uncertain-after-attempt state, not increased deadlines.
- **Negative tests:** lost STORE reply with concurrent flag change; conditional
  conflict; lost MOVE reply with source absent and missing/ambiguous destination;
  lost APPEND reply/COMMIT, duplicate Message-ID matches, empty lookup, role/config
  change, disable/restart; exactly one remote MOVE/APPEND attempt and no duplicate
  placement/events; SMTP stays sent despite uncertain copy.
- **First consumer:** R10 STORE; R13 APPEND; R14 MOVE.

## Remaining choice requiring approval

**U1 — Ephemeral unsaved/edited connection-test transport.** There is no existing
web→elected-owner request/reply transport; account wakes carry only account IDs.
The contract above is fixed, but choosing a new secret-bearing interprocess
transport changes deployment requirements and needs approval.

- **Recommended:** a small authenticated internal worker HTTP RPC, reachable
  through owner-aware routing, with TLS (or an equivalently protected local
  channel), bounded request/response and in-memory request cancellation. Route
  by a term-bound endpoint address advertised on the existing coordinator row;
  revalidate actor/term at the receiver, and clear advertisement only by matching
  term. The address carries no credentials and has no authority after expiry.
  Followers refuse execution; endpoint exposure/authentication must be explicit
  in R03/R09. This preserves testing credentials before saving an account without
  introducing durable secret-bearing jobs or rows.
- **Alternative:** encrypted transient PostgreSQL notification request/reply,
  using existing application encryption, dedicated bounded listener lifetimes,
  payload limits and explicit cancel/expiry messages. No queue row is written.
- **Behavioral difference:** RPC permits normal bounded credential envelopes and
  caller-disconnect cancellation but requires a private reachable worker endpoint;
  notifications reuse DB reachability but impose PostgreSQL payload limits,
  listener connections and lossy cancellation/delivery. Either returns retryable
  unavailable on owner loss; neither may use direct web IMAP as fallback.
- **Blocked:** complete diagnostic admission acceptance in R03 and unsaved/edited
  diagnostics in R09; therefore eventual R16. R02 and other independent R03 work
  are not blocked. A durable diagnostic table or exclusion from W is rejected.

DELETE is resolved by existing physical-delete/RESTRICT behavior (C6). APPEND is
resolved by existing conservative uncertain-copy behavior (C8). Topology bounds,
SQL capabilities and provenance are implementation contracts, not OPEN merely
because code/tests are pending. Broader D10/D16 product/SLA choices are outside
B1–B13; this task changes none of their existing policies.

**R02 can begin as the next separately authorized task:** its request/projection
contracts have no unresolved approval dependency. R01 stops here; U1 must be
approved before the affected diagnostic implementation is finalized.
