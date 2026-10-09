# Maildock — Phase P0: native Gmail API on a fresh database

Date: 2026-10-09. Status: proposed architecture for owner review; documentation only.

## Authority, scope and evidence

The owner has decided to start with an empty Maildock database when native Gmail receiving is ready. Remote mail remains on its servers; local state that cannot be reconstructed may be lost. This decision **supersedes every legacy Gmail migration and transport rollback recommendation** in [the original audit](gmail-api-architecture-audit.md), commit `c13df90f6a0bba888866824dc49ec96f2a86524c`. Keep that report as historical evidence, not an implementation backlog.

The new design contains no IMAP UID/API ID conversion, historical UUID canonicalization, aliases, migration journal, inventory of old records, shadow account, old-record compatibility, Gmail-over-IMAP fallback, transport cutover coordinator or cohort migration. Ordinary Drizzle DDL deployment history and native Gmail re-enumeration after history expiry are still necessary; neither is legacy data migration.

This branch starts at the audit commit. Local refs reviewed:

| Source                     | Pinned commit                              | Evidence used                                                                     |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Audit                      | `c13df90f6a0bba888866824dc49ec96f2a86524c` | Architecture findings and inherited `test` application                            |
| `test`                     | `234695e729144b6652b8ffa67b32537c266ed077` | Current application, merged IMAP hotfix, schema/security/recovery and composition |
| `experiment/gmail-api-poc` | `94cc3543aae94fec1e2d530ed68cf9406f2d1842` | Seven-file isolated GET-only experiment; no production persistence                |

**Verified** means inspected code at these commits or linked Google documentation. **Proposed** means a concrete P0 decision awaiting review. **Open** means future validation or owner choice. No PoC execution, application startup, database access/reset, live Gmail API request, secret inspection, OAuth change, production edit, deployment, push, merge or PR is part of P0. Future validation requirements below are plans, not completed results or authorization to create automated tests.

Supporting decisions: [ADR 0012: transport](../adr/0012-native-gmail-receive-transport.md), [ADR 0013: identity/labels](../adr/0013-gmail-message-identity-and-label-membership.md), [ADR 0014: checkpoints](../adr/0014-gmail-account-history-and-progressive-sync.md), [ADR 0015: SMTP/drafts](../adr/0015-gmail-smtp-first-and-local-drafts.md). [Database proposal](gmail-api-p0-database-design.md) specifies constraints and deployment compatibility; [roadmap and acceptance](gmail-api-p0-roadmap.md) specifies delivery gates.

## Target behavior and UI contract

Every account created through the existing Google OAuth tile uses Gmail REST for receiving, inventory, content, attachments and the existing six message actions immediately. Failure to enable the API leaves that account in an actionable error state; it never starts an IMAP receiver. Microsoft OAuth and password accounts continue through the existing IMAP/SMTP adapter. Routing depends on persisted account transport and OAuth provider identity, never the email domain or hostname. A password account pointing to Gmail remains an ordinary password/IMAP account; it is not an automatically converted Google OAuth account.

Both transports use the current PostgreSQL message, content, attachment, draft, outgoing and blob infrastructure. SMTP remains the only sending transport. No API sending, Gmail draft mirroring, new credential store, transport selector, extra Google tile or setup screen is introduced.

The visual and functional baseline is `test`, including its reader retry behavior. Keep Google Client ID/Secret in Settings, Google OAuth start/callback/reconnect, account list/switching, all inboxes, list/reader/search/conversations, reply/forward/attachments, sending, draft autosave, read/star/archive/trash, navigation, preferences, sanitizer/iframe and remote image policy. Only Gmail labels/folder presentation, Gmail API connection details replacing Google IMAP details, and Gmail synchronization diagnostics may differ.

Internal capability plumbing is required to keep existing controls working: `mail-client.tsx` currently gates actions on IMAP `MOVE`, and commands/content/attachments use UID readiness. Replace these predicates with application capabilities and discriminated locators; never manufacture `MOVE`, UIDVALIDITY, UIDs or MODSEQ. Retain the existing endpoints, UUID parameters, paging cursors, status names and consumed DTO fields. Add transport/capability data internally where necessary; specify absence for protocol-only fields rather than leaking fake IMAP details. Account connection results need a receive diagnostic adapter for the existing Google connection panel; password and Microsoft responses keep current semantics.

## Repository findings that shape the design

| Verified seam                                                                                                    | Required targeted change                                                                |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `schema.ts`: account provider constrained to `imap_smtp`; IMAP endpoints mandatory                               | Add `gmail_smtp` and conditional endpoints, no activation modes                         |
| `messages.providerMessageId` is text, not unique; `MessageService.persistBatch` creates rows for IMAP placements | Add Gmail-only account uniqueness and direct upsert; keep IMAP ingestion semantics      |
| `mailbox_messages` already separates messages from placements but requires UID/epoch                             | Reuse as label membership with conditional locator constraints                          |
| Attachments, commands and notifications require IMAP identities                                                  | Add transport-specific locator/uniqueness branches in these existing tables             |
| `accounts/infrastructure/accounts.ts` and `composition/worker.ts` instantiate IMAP                               | Wire one shared routing policy into web scheduling/readiness and worker execution       |
| Recent/backfill/delta jobs and IDLE are mailbox-based                                                            | Route Google to account jobs and exclude it from all IMAP producers and consumers       |
| Google scopes are `https://mail.google.com/`, `openid`, `email`; encrypted token refresh is serialized           | Reuse grant, configuration and subject checks; no scope change                          |
| SMTP acceptance and Sent-copy states are separate; uncertain sends do not retry automatically                    | Keep delivery state machine; adapt Google Sent handling without APPEND                  |
| Search is local FTS; conversations use RFC headers and account-scoped SQL triggers                               | Preserve local search coverage and grouping preference; Gmail thread ID is supplemental |
| Authority maintenance enumerates tables/functions; restore verifies migration history/schema                     | Update release security/restore inventory with schema, not after deployment             |

The PoC proves useful patterns: fixed Gmail origin, redirect refusal, bounded HTTP attempt including body consumption, pagination guards, string history IDs and bounded concurrent metadata reads. It does not implement headers sufficient for the UI, MIME content, mutations, refresh, persistence, checkpoints, quotas across workers or crash recovery. Port selected patterns with review; do not merge the experiment wholesale. Its reported HTTP timings are not end-to-end provider benchmarks.

## Provider interfaces and composition

Proposed internal contracts, illustrated as documentation rather than production types:

```typescript
type ReceiveContext =
  | {
      kind: "imap";
      accountId: string;
      revision: string;
      imap: ProviderConnection;
    }
  | {
      kind: "gmail";
      accountId: string;
      revision: string;
      subject: string;
      accessToken: string;
    };

type MessageLocator =
  | {
      kind: "imap";
      accountId: string;
      mailboxId: string;
      path: string;
      uidValidity: string;
      uid: string;
    }
  | { kind: "gmail"; accountId: string; messageId: string };

type PartLocator =
  | {
      kind: "imap";
      message: Extract<MessageLocator, { kind: "imap" }>;
      section: string;
    }
  | {
      kind: "gmail";
      message: Extract<MessageLocator, { kind: "gmail" }>;
      partId: string;
      attachmentId?: string;
    };
```

`revision` is an ordinary account configuration/credential publication fence, not a transport migration generation. Increment it on disable, reconnect and relevant credential/config changes; responses must verify it before committing. Account transport is selected at creation and immutable for this release. Tokens exist only in resolved work contexts, never job payloads or logs.

| Interface/component                        | Responsibilities                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `MailProvider` / IMAP adapter     | Keep current mailbox-oriented synchronization, epoch guards, UID content/mutations, SMTP and generic Sent APPEND                            |
| `GmailAccountSource`                       | Profile/readiness, label catalog/counters, message ID pages, UI metadata, unfiltered history pages; returns bounded data, not DB writes     |
| `GmailSyncService`                         | Account baseline, pagination/work persistence, message upserts, label memberships, completion/checkpoint transactions                       |
| `MessageContentSource`, `AttachmentSource` | Resolve discriminated locators into current semantic display parts/byte consumption; preserve limits, cache and fencing                     |
| `MessageMutationTransport`                 | Execute six existing actions; Gmail uses message-scoped label operations/trash, IMAP keeps conditional STORE/MOVE                           |
| `SmtpSender`                               | Existing immutable MIME, SMTP envelope including Bcc, acceptance and uncertain outcome semantics                                            |
| `SentCopyCoordinator`                      | Generic IMAP APPEND unchanged; Google observes native SENT and optionally labels that same message                                          |
| `MailTransportRouter`                      | Server-only account routing, capabilities and readiness; rejects inconsistent provider/auth combinations                                    |
| Shared message projector                   | Reuse envelope/date/search/conversation/content values; Gmail repository handles native identity/membership, not a second storage subsystem |

Web assembly in `accounts.ts` schedules provider-aware discovery/refresh/content/commands and resolves connection checks. Worker assembly wires the same router, Gmail HTTP/token sources, shared storage/services and account jobs. `web.ts` reaches the existing account assembly; editing only `web.ts` is insufficient. Consumers reload account transport, enabled/OAuth state and revision rather than trusting payloads. Google OAuth account completion schedules Gmail bootstrap; manual Refresh in any Gmail label coalesces to an account wakeup. Generic queue names and IMAP logic remain intact.

## Message identity and labels

One `messages` row per `(accountId, gmailMessageId)`, enforced by a Gmail-only unique index. Generate local UUID once at the first upsert, including conflict-safe concurrent inserts; it remains stable through label changes, history replay, expiry recovery and restarts within that installation. IDs in another account are separate identities. A fresh reset creates new UUIDs; old links are intentionally not supported.

Store Gmail message, thread, label and history IDs as strings. Use native Gmail ID exactly as returned, without UID conversion or numeric parsing. Validate history decimal text and compare using precision-safe BigInt only when needed; never increment history IDs. RFC Message-ID is conversation/search/Sent-observation evidence, not message uniqueness.

Reuse `mailboxes` for label catalog and `mailbox_messages` for membership. Stable label ID, not display name, determines mailbox identity; rename preserves UUID. Project global read/star flags into every Gmail membership atomically to keep current DTOs consistent. A label removal deletes that membership only, not the message/body/blob. Unknown labels trigger catalog refresh without dropping valid membership data.

| Gmail state             | Existing application projection                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `INBOX`                 | Inbox role and path `INBOX`, preserving all-inboxes query semantics                                                       |
| `SENT`, `TRASH`, `SPAM` | Native system label mailboxes; Trash uses `messages.trash`, never permanent delete                                        |
| User labels             | Mailbox rows keyed by provider label ID; `/` hierarchy is presentation only                                               |
| `UNREAD`, `STARRED`     | Read/star flags, not extra copies or independent per-label flags                                                          |
| All Mail                | Synthetic mailbox view derived from non-TRASH/non-SPAM mail; no invented Gmail `ALL_MAIL` label or remote mutation target |
| `DRAFT`                 | Remote mail records remain separate from editable Maildock drafts; no adoption, autosave or cloud write                   |

Recommend excluding remote DRAFT records from ordinary list/search/All Mail projections for Phase 1, while accounting for their IDs during complete inventory/history so they cannot hold checkpoints open. A later DRAFT removal re-fetches and publishes the now ordinary message. Local Drafts remains unchanged. Review this label-presentation choice explicitly in P0; do not silently reinterpret remote drafts as immutable cached sent mail.

Native archive removes `INBOX` and retains user labels. Recommend auto archive role = virtual All Mail, native trash role = TRASH and native sent role = SENT. For an explicitly mapped user archive label, add that label and remove INBOX in the same modification; never remove unrelated labels. A custom trash mapping cannot replace Gmail trash semantics: reject unsupported mappings using the existing folder-settings error surface. Confirm allowed mapping options in P0, within the permitted Gmail folder presentation change.

Use `labels.list` for inventory and bounded `labels.get` for remote message/unseen counters; refresh on cadence and after mutations/deltas, not per message. Counters describe the full remote label, while loaded-list counts describe the local cache. Do not sum labels for account totals or present partial import as complete. Virtual All Mail requires its own local coverage-aware count; do not relabel profile total as All Mail count. Deleting a label retires its mailbox and memberships, not the message. Existing deterministic search placement and local header-based conversations continue; All Mail should be a fallback placement, not an extra search hit.

## Progressive synchronization and checkpoint protocol

Only one committed Gmail `historyId` per account. Use the two operational tables in [the database proposal](gmail-api-p0-database-design.md): account sync state and bounded durable work. These serve native synchronization, not migration tracking.

### Initial import and historical backfill

1. Resolve the existing Google grant and readiness. Acquire account execution authority; persist profile H0 **before** enumeration as baseline, not completed checkpoint. Inventory labels.
2. Enumerate the configured recent window first, using an explicit date query supported by the current broad scope, `includeSpamTrash=true` and bounded ID pages. API list ordering is not an assumed guarantee: time windows and local `internalDate` sorting establish recent-first availability. Headers/label/date metadata make rows immediately usable without body downloads.
3. Persist each discovered page's IDs into durable work with its successor token in the same transaction. Fetch metadata with bounded concurrency; each successful transaction atomically upserts native identity, full memberships, flags, envelope, supplemental thread/history, conversation/search effects and work completion. Never advance a page cursor across unstaged IDs.
4. Mark recent-ready only after recent pages/work are complete. Replay history from H0 before declaring the initial delta checkpoint valid; do not use a later profile head to skip changes. Backfill older date windows/ID pages at lower priority. The complete account inventory must cover all IDs, including Spam/Trash and ignored remote drafts; recent query results alone do not establish completeness.
5. Service completed history sweeps between short backfill slices. Do not wait for the entire historical import before renewing a valid checkpoint. Bound page rows/in-flight requests/transaction size; persist date-window boundaries and page token to resume.
6. Once full inventory and subsequent history replay are complete, record coverage. Page traversal is not an atomic server snapshot: repeat targeted checks for scan drift and confirm each candidate local absence by exact GET before retiring it. Partial traversal, estimated totals and quota failure prove no absence.

Initial recent/backfill never emits historical desktop notifications. During initialization, suppress replay notifications until the recent baseline is established; afterward notify only live Inbox arrivals according to existing preferences, once per native identity. Accept a startup notification observation gap rather than flooding the UI with old mail. Notification policy is separate from mail completeness.

### Account-wide history replay

1. Read committed H under execution authority; start a durable sweep with fixed start H, run UUID and account revision. No label or history-type filter. Use all typed event collections and general `messages` as supplemental affected-ID evidence; repeated IDs coalesce within each pending batch.
2. Stage a page's affected IDs and successor token transactionally; keep committed H unchanged. Fetch **current full label state**, not unordered event patches. Existing known messages may use a smaller label/history response; new messages require list headers/date metadata. This makes added/removed/read/star events idempotent even when GET observes newer state.
3. Resolve every item to a committed projection or confirmed exact-message absence. Label removal is not deletion. 401/403, parse/network errors and quota failure are not absence. A validated exact-message 404 marks remote absence, removes active projections and keeps the local UUID/cache/references pending existing retention policy. No remote deletion is issued.
4. Continue all pages and work. On final page retain returned H1 as **candidate**, not checkpoint. Atomically CAS expected H/run/revision and set committed H=H1 only when no pending work remains and the page sequence has ended. Empty history obeys this same completion rule. Never advance from a profile call, notification or per-message observation.
5. Crash before completion resumes staged work or restarts from committed H; crash after commit but before queue ACK reloads the committed value. Upserts/memberships/notification uniqueness prevent duplicate effects. Invalid/repeated page tokens restart the sweep from H rather than guessing progress. Bound persisted work and release the account lock between job slices, while retaining sweep identity.

Per-message observed history guards prevent an older GET from overwriting newer metadata/flags. All Gmail projection writers, including command confirmation and enumeration, coordinate through account execution authority; UI optimistic intents are stored separately and re-applied over confirmed state. No transaction spans an HTTP call. [Google's history contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) specifies gaps in history IDs and expiry; the native recovery design does not infer contiguity.

### Expired history recovery

History-list 404 enters `reconcile_required`; it is distinct from a single message GET 404. Retain local rows/UUIDs, bodies and blobs, capture a fresh H0 and perform complete native ID/label inventory with recent availability first. Increment an inventory generation and mark observed rows. Reuse metadata/content where safe, refresh labels/version, replay changes from the new baseline, and exact-GET unseen old IDs before hiding absent memberships. Do not clear the database or redownload all bodies. Recent repair can restore responsiveness but cannot claim all old memberships reconciled. If a recovery baseline expires again, restart safely and keep serving completed projections with incomplete diagnostics. [Google synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync).

### Locks, crashes and concurrent commands

Use PostgreSQL session advisory account lock `gmail-account:<uuid>` on a reserved connection as the execution boundary for bounded Gmail sync slices and remote mutations. Always use that same reserved connection for guarded projection transactions; loss of its lock session must cancel/discard remote work and cannot permit publication on another pool connection. Durable state CAS provides a second guard. This avoids a split-brain writer and the existing lock-plus-second-pool-checkout deadlock pattern.

Resolve OAuth before reserving the execution connection and recheck revision/subject/enabled/OAuth state afterward. Never call the current DB-backed token refresher while holding the sole connection in a pool of one. Release authority to refresh an expired token, then reacquire and revalidate the run. Avoid nested mailbox locks on Gmail work. Content/attachment fetches use their existing message/request/attempt or attachment fences, validate account revision and locator, and need not monopolize the sync lock; any publication changing shared label metadata goes through the account boundary.

Commands are durably accepted in the existing table/API, ordered per logical message across labels. Account execution lock serializes remote command effects with sync slices; choose bounded slices so a 41k import cannot block an interactive action for minutes. Read/star operations set the requested state, archive removes Inbox, trash moves to Trash. On lost response, observe current remote state before retrying an idempotent intent; do not treat job delivery as proof of application. Keep failed/optimistic feedback and original behavior for generic IMAP. A history projection cannot cancel a newer pending user intent. SMTP sending uses the existing outgoing lock and uncertainty logic, not the Gmail sync lock.

Jobs carry only version/account/revision/reason, with account singleton key; handlers reload durable progress. Producers coalesce wakeups transactionally using existing queue patterns. Persist needs-work/next-attempt markers before enqueue; repair pollers recover enqueue failure, worker death, duplicate delivery and queue acknowledgement gaps. Queue state is not checkpoint authority. Disconnect/deletion invalidates runs and responses. Reconnect keeps subject validation and starts catch-up or expiry recovery, not a different receiver.

## Quotas, OAuth and lazy content

Keep current Google Client ID/Secret, encrypted account refresh token, refresh rotation/reconnect subject checks and existing routes/scopes. Resolve one token for a bounded operation and share it across its HTTP pool. An expiry-aware in-memory lease/single-flight is optional only after the resolver exposes real expiry; do not infer expiry from today's token-string API. Refresh once after 401, then stop/reconnect as appropriate. API disabled or Workspace policy errors use current connection/sync diagnostic surfaces and never trigger IMAP or repeated consent.

Gmail API must be enabled in the **same** Google Cloud project by its owner before the future receiving release; no new Maildock setup page. Actual enablement, grant, Workspace policy and effective project quotas were not accessed in P0. The existing broad grant covers the documented methods; keep scopes unchanged. [Messages GET scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

Propose a shared account/project quota scheduler used by history, import, content, attachments, commands and web connection checks across processes. Reserve each method's units in a short PostgreSQL transaction before HTTP, serialized with a project-keyed transaction advisory lock; keep bounded current/previous minute counters in the existing native sync-state rows and sum them for the configured Google project's accounts. The sum of both whole-minute buckets conservatively bounds rolling-minute use and survives process death without a third operational table. Do not refund abandoned attempts. External clients sharing that Cloud project are not visible to Maildock: configure headroom and obey server throttling. Start concurrency 4, benchmark 1/2/4/8; reserve 30% of configured budget for interactive/delta work, with fair account scheduling. Carry durable next-attempt deadlines for long waits; release connections/locks rather than sleeping through Retry-After. Retry 429/5xx and validated rate-limit 403 with bounded exponential jitter; classify service/permission/revocation errors separately. Do not log provider response bodies, tokens, URLs with IDs, MIME or headers. Fixed-origin HTTP, redirect refusal, bounded parsing and cancellation apply to reads and mutations. [Error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

Published new limits are 6,000 units/user/project/minute and 1,200,000/project/minute; qualifying older projects retain prior quotas. Current costs include metadata GET 20, list 5, history 2 and attachment GET 20. At the new rate, 41k metadata GETs alone use 820k units, a quota-only lower bound of about 137 minutes before reserves/retries. This is planning arithmetic, not a measured import ETA. Partial fields reduce bytes, not method cost; validate effective quota before an import-time commitment. [Google quota reference](https://developers.google.com/workspace/gmail/api/reference/quota).

Metadata requests retain list headers, envelope/date/size/labels; attachment/body structure can be obtained lazily. `hasAttachments` is derived accurately from a bounded structure-only GET when needed for the list paperclip, excluding body data with a field mask; benchmark the additional request cost rather than guessing from filename/snippet. On opening, map Gmail MIME structure/body fields to existing display-part classification, decode bounded base64url and charset, sanitize through the current pipeline, and persist the same content/search representation. Incoming raw MIME is not retained. Parts with external `attachmentId` use attachment GET; inline data uses message payload. Preserve CID resolution, filename handling, blob hashes/limits and forwarded incoming attachment pins. Never run Gmail part IDs through IMAP section-number validation. Large base64 JSON can expand memory even if only one attachment is fetched; enforce encoded/decoded ceilings and streaming/bounded consumption before writing blobs. [Message and part schema](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).

## SMTP, Sent and local drafts

Recommend Google server-managed Sent with no IMAP APPEND, `messages.insert`, `messages.import`, synthetic local Sent message or API send. Gmail automatically stores mail submitted through SMTP, according to [Gmail's client guidance](https://support.google.com/mail/answer/78892). Ingest that message through normal Gmail identity/history; do not mint a second received message from an outgoing row. Preserve immutable outgoing MIME, envelope/Bcc, queue, acceptance/rejection and uncertain-send behavior; observing Sent must never cause an uncertain SMTP send to be resubmitted.

Default `server` policy remains server-managed. For the existing `maildock` preference, propose observing the native SENT message and, only if the selected Sent folder is a custom user label, adding that label to **the same native message**. Native SENT cannot be manually applied, so never attempt to repair a missing server copy by setting SENT. Never upload MIME as a fallback. Match the Maildock-generated RFC Message-ID, account, sender and bounded send time only to observe outgoing completion; multiple candidates stay unresolved and never merge received identities. Delayed/unconfirmed Sent does not downgrade accepted SMTP delivery or initiate retry. [System label restrictions](https://developers.google.com/workspace/gmail/api/guides/labels).

**Open P0 policy conflict:** the current UI promises “Maildock saves a copy in Sent.” The proposed observation/custom-label policy avoids duplicates but changes that option's implementation and may be misleading when confirmation fails. Owner review must approve its meaning for Google, or approve a narrow adjustment within Gmail folder/API details. Do not disable/change the settings UI or silently normalize a chosen preference without that review. Generic `maildock` APPEND remains exactly as today. The existing outgoing copy states can track pending/saving/saved/failed/uncertain observation, with nullable IMAP receipt fields; `server` remains `not_required`.

Local drafts, revisions, browser recovery, autosave, attachment pins and consumed-draft/send transitions remain unchanged. They are local database state, not Gmail drafts; a fresh installation does not reconstruct them. Remote DRAFT records never become editable local drafts. API sending/cloud drafts require a later separate request.

## Fresh-install release and restore strategy

The release initializes the reviewed schema in an empty database via the existing append-only Drizzle chain plus new DDL. Keep shipped SQL/journal/snapshot hashes; do not squash historical migrations to avoid legacy mail mapping. This creates the final clean model without importing old mail data. Schema application is not an existing-account migration plan.

For the future reset, prefer a **new empty database volume and new blob namespace** over deleting the existing volume in place. Stop ingress/web/worker first, ensure accepted/pending/uncertain outgoing work is reviewed, retain a matched offline backup if desired, and provision new scoped DB ownership through supported procedures. Reset startup must be an explicit operator action after P0 review and implementation release approval; no automatic reset command or startup drop is proposed or executed here.

Run normal owner setup/MFA and configure Settings again, reusing the same external Google Cloud Client ID/Secret and existing OAuth flow; re-add/re-authorize accounts. Reuse of credential code/configuration design does not mean transplanting encrypted rows into a new instance: account UUID/AAD, keys and owner binding must match. No partial extraction/import tool for old refresh tokens or settings is proposed. Decide operator key retention separately, keeping backup keys with their original recovery set.

Document lost local drafts, signatures/preferences, outgoing history/uncertain state, cached mail/body/blob state and local URLs before the future reset. Ensure another service/process cannot keep using the previous account connections or job tables. Preserve remote mail. Import metadata and retrieve bodies lazily from the servers into new identities. No database or attachment directory is deleted by P0.

Restore is **whole-installation recovery**, not an old Gmail record compatibility promise. A pre-native backup is restored only into its matched pre-native binary/schema/keys/blob set as a separate old installation. Never feed that backup to the new native receiver or convert its Gmail identities. A native-install backup restores with its matched new schema and security/keys/blob set, then resumes Gmail history or native expiry recovery. Old pg-boss jobs cannot enter the fresh DB. Returning to an offline old installation, if the operator chooses it, is a whole-release recovery decision with outgoing-send review; no IMAP-to-Gmail per-account rollback is designed. See the [database release checklist](gmail-api-p0-database-design.md#ddl-authority-and-restore-compatibility).

## Retained hotfix and unresolved review gates

Retain migration 0035 and the entire `test` hotfix: UID presence chunking/response validation/FETCH confirmation, mandatory STATUS and SELECT epoch/MODSEQ fencing, iterator/lifecycle error handling, content request/attempt generations and enqueue repair, cache/security retry behavior, telemetry allowlists, serialized Google refresh/reconnect and token rotation. Gmail bypasses mailbox IMAP execution; Microsoft/password accounts continue using every generic fix and existing dependency patches. No cleanup/revert is justified by the fresh DB decision.

| Priority                  | Open item                                                               | Resolution required                                                                                        |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P0 review                 | Google `maildock` Sent preference meaning                               | Approve observation/custom-label policy while preserving current UI, or specify permitted wording/behavior |
| P0 review                 | Gmail manual role mappings and remote DRAFT presentation                | Approve native archive/trash/Sent rules, user-label archive and remote DRAFT exclusion                     |
| Before provider readiness | Same-project API enablement/grant/admin policy                          | Operator validation in a dedicated authorized stage; no scope change                                       |
| Before release            | Effective quotas, deployment hardware/import budget                     | Measured quota-aware benchmark; PoC timings are insufficient                                               |
| Before release            | MIME structure/charset/attachment correctness and memory                | Representative manual fixtures, bounded content fetching through existing security pipeline                |
| Before release            | Lock-session loss, pool=1, command/history/intent races                 | Demonstrate durable progress and no stale publisher or blocked interactive work                            |
| Before release            | Fresh schema/authority/whole-backup compatibility                       | Review all DDL/security inventory/restore paths together                                                   |
| Future reset              | Reset timing, backup retention/key strategy and uncertain outgoing work | Separate explicit operator release action; never delete/reset during P0                                    |

These are focused architecture/validation choices. There is no remaining blocker concerning legacy identity coverage, migration cohorts, UUID aliasing or Gmail IMAP rollback. Proceed to implementation only after P0 is reviewed.
