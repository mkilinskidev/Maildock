# Maildock — Gmail REST architecture audit and implementation plan

Audit date: 2026-10-09. Status: proposal; no provider implementation authorized by this report.

> **Superseded for the fresh-install Gmail design by [Phase P0](gmail-api-p0-fresh-install.md), dated 2026-10-09.** The owner will replace the local database when the native provider is ready. All legacy identity bridging/deduplication, UUID aliases, migration journals/inventories, shadow synchronization, IMAP rollback, old Gmail record compatibility and cohort cutover recommendations below are historical and must not be implemented. The original repository findings and generic IMAP hotfix analysis remain evidence. The P0 documents govern the new schema, provider, synchronization, SMTP policy, acceptance gates and release procedure. Neither document authorizes a database deletion or implementation before P0 review.

Evidence vocabulary: **VERIFIED** means inspected repository code or explicitly cited primary documentation; **RECOMMENDED** means a proposed design; **OPEN** means validation is still required. Protocol documentation establishes feasibility, not the contents of a particular installation's database or its Cloud configuration.

Repository baseline (local refs, matching the displayed remote tracking refs where present):

| Ref | Commit | Relationship |
| --- | --- | --- |
| `main` | `ba074880768645473af070ecc846e420ced990d5` | Production baseline |
| `test` | `234695e729144b6652b8ffa67b32537c266ed077` | Starting checkout; includes merged IMAP hotfix |
| `experiment/gmail-api-poc` | `94cc3543aae94fec1e2d530ed68cf9406f2d1842` | Descendant of this exact `test`; seven added/changed files |

The checkout was clean at audit start. Branches were inspected with `git show`, `git diff main..test`, and `git diff test...experiment/gmail-api-poc`, without switching the existing branches or executing the PoC. The only repository change is this report, on `codex/gmail-api-architecture-audit`, based on `test`. No application, dependency, migration, credential, remote mailbox, or pg-boss state was changed. No live Gmail requests, application startup, tests, deployment, merge, push, or PR were performed.

Code references below use repository-relative `path:line` anchors at the pinned commits, principally `test`. PoC references explicitly refer to its branch. Existing tests were read for coverage; test execution and new test code are outside this audit. No local database, stored secret, or environment file was opened.

## 1. Executive summary and recommendation

**RECOMMENDED:** Introduce a native Gmail receiving provider with one account-wide history checkpoint, stable account-scoped Gmail message IDs, and label memberships projected into the existing mailbox UI. Keep the IMAP provider and the complete `test` hotfix. Preserve existing Google credentials, OAuth routes, tile, local drafts, MIME pipeline, content security, and UI-facing URLs. Begin with Gmail receiving plus existing SMTP (Option A); evaluate API sending separately after receiving and rollback are proven. Remote draft mirroring is a later optional decision, because current drafts are local.

This is more than adding an HTTP adapter. **VERIFIED:** the database has messages and placements, but current ingestion allocates a message for each new IMAP placement. Content, attachment, action, notification, account readiness, scheduling, and some UI enablement still assume IMAP identity. A Gmail provider cannot safely implement the current `MailProvider` by manufacturing UIDs, UIDVALIDITY, MODSEQ, or `MOVE` capabilities.

**Highest migration risk:** several cached UUIDs can represent one Gmail message, with different cached bodies, attachment UUIDs, draft references, and conversation membership. A destructive merge can lose data or break references. Use proven identity bridges, reversible aliases, a migration journal, and transport generation fencing before switching authority. Stop automatic cutover for ambiguous identity groups; do not resolve them by RFC Message-ID alone.

**OPEN:** the supplied timings (179 ms empty delta, 207 ms history with 10 records/4 messages, approximately 82 ms GET median, approximately 2.1× concurrent sample speedup, previously 28–40 s IMAP per folder) are user-reported measurements. No captured benchmark artifacts are committed in the reviewed PoC. They justify development, not a verified end-to-end speedup or full-import ETA.

Approval decisions are enumerated in §15. Implementation must wait for approval of schema/identity reconciliation, rollout policy, label semantics, and sending/draft scope. There is no request to approve code in this audit.

## 2. Current architecture — verified findings

| Area | VERIFIED finding and evidence | Consequence |
| --- | --- | --- |
| Runtime | Next.js web plus separate worker composition, PostgreSQL/Drizzle and pg-boss. `src/composition/worker.ts:49`; `src/modules/jobs/infrastructure/job-runtime.ts:8`; `docs/ARCHITECTURE.md` | Reuse runtime, security and operational boundaries |
| Provider wiring | Worker creates one `ImapSmtpMailProvider` and injects it into mail services (`worker.ts:54`). Web service assembly also instantiates it in `src/modules/accounts/infrastructure/accounts.ts:57` | Both roots need transport-aware routing; changing `web.ts` alone is insufficient |
| OAuth registry | `src/modules/accounts/infrastructure/oauth-composition.ts:8` registers Google/Microsoft authorization; it is not a mail transport registry | Keep auth provider identity separate from receive/send transport |
| Account constraints | `src/shared/infrastructure/database/schema.ts:546` permits only `providerType = imap_smtp`; IMAP/SMTP endpoints are mandatory. Public password account input uses a literal type (`src/modules/accounts/domain/account.ts:42`) | Google OAuth account construction and internal schema must change without adding a manual transport selector |
| Account work | `AccountsService.getProviderImapAccountForWork` returns endpoint plus refreshed credentials (`accounts-service.ts:452`); SMTP work resolves the same OAuth infrastructure (`:469`, `:563`) | Add Gmail work context; do not refresh once for every parallel HTTP request |
| Provider interface | `src/modules/accounts/domain/mail-provider.ts:1` embeds IMAP/SMTP endpoints. Recent/backfill/delta are per mailbox; body/mutations/attachment requests contain UID/epoch/path | Split synchronization and remote locators instead of pretending the interface is neutral |
| Progressive storage | Recent metadata ingestion and historical backfill are separate from lazy content (`message-service.ts:221`, `:367`; `backfill-sync-service.ts`; ADR 0011) | Keep progressive visibility and lazy content; full enumeration need not download bodies |
| Identity | `messages` holds local UUID/account/providerMessageId, no unique provider-ID constraint (`schema.ts:852`). `mailbox_messages` uniquely identifies mailbox+UIDVALIDITY+UID (`:977`) | Relational foundation supports memberships; ingestion does not provide logical Gmail deduplication |
| Actual ingestion | `persistBatch` finds an existing placement, otherwise always allocates `randomUUID()` and inserts a new message (`message-service.ts:367`, new-message branch in that method) | Same provider ID in multiple folders can produce multiple message records |
| Content | One content row per message with request generation and fetch attempt (`schema.ts:1047`); placement/epoch checks before IMAP fetch (`message-content-service.ts:114`, `:308`) | Preserve generation fencing, sanitization and cache policy; replace locator resolution |
| Attachments | Source mailbox/UID/UIDVALIDITY are frozen, mandatory; unique message+part ID (`schema.ts:144`; `attachment-metadata.ts:12`); worker verifies original placement (`attachment-service.ts:316`) | Cannot simply relabel an IMAP part as a Gmail part; cached attachment UUIDs need bridging |
| Reader security | `email-rendering-service.ts`, `sanitize-email-html.ts`, `render-email-document.ts`, `rich-email-body.tsx` implement sanitizer, remote-content policy and iframe isolation | REST body retrieval must feed this same path |
| Mail UI reads | `MessageService.list` reads PostgreSQL, keyset cursor date/UUID, flags from placement (`message-service.ts:612`). All inboxes matches `upper(remote_path) = INBOX` (`:685`) | Preserve IDs, paging order and INBOX projection |
| Search | PostgreSQL FTS; one deterministic lateral placement per *message record*, not per remote provider ID (`search-service.ts:19`, `:40`) | Canonical aliases must prevent duplicate logical hits; retain local search and its coverage |
| Counts | Mailbox response combines locally stored placement counts with remotely reported unseen totals (`mailbox-service.ts:144`); client adjusts unread display (`mail-client.tsx:1317`) | Do not replace whole-mailbox unread totals with recent-cache counts |
| Conversations | Optional preference; header-based grouping and account-scoped triggers (`conversation-service.ts:19`; `db/migrations/0017_conversations.sql:43`, `:147`) | Store Gmail thread ID as supplemental identity; do not silently replace grouping rules |
| Commands | Six actions only: read/unread, flag/unflag, archive/trash (`schema.ts:1080`). Durable optimistic projection and reconciliation (`message-command-service.ts:34`, `:222`) | Current general move, restore, spam action and permanent delete are not exposed command features |
| Jobs | Mailbox locks are PostgreSQL session advisory locks (`mailbox-lock.ts:5`); delta jobs keyed by mailbox (`delta-sync-jobs.ts:31`); producers coalesce transactionally (`coalesced-sync-job.ts:4`) | Gmail requires account execution lock and routing in every producer/consumer |
| Wakeups | Delta poller enumerates eligible mailboxes; `idle-watchers.ts:29` maintains IMAP clients | Exclude Gmail-active accounts from all IMAP background work |
| Drafts | Local UUID, revision check and attachment pins (`draft-service.ts:28`, `:239`, `:291`); composer autosave/local browser recovery (`mail-composer.tsx:109`, `:174`, `:219`, `:287`) | Gmail DRAFT-labelled incoming records are not Maildock editable drafts |
| Sending | Immutable MIME blob before queue; separate delivery and Sent-copy states; uncertain sends never auto-resubmitted (`outgoing-message-service.ts:397`, `:463`; `schema.ts:23`) | Keep durability and uncertainty semantics for either transport |
| Diagnostics | Allowlisted application events and stage telemetry (`application-event.ts`; `performance.ts:92`) | Extend fixed metrics; never log token, MIME, headers, query, provider response bodies |

Important nuance: `providerMessageId` is populated from `RemoteMessageMetadata.providerEmailId` (`message-service.ts:80`) but is not used to reuse message rows across placements. Existing command/notification matching sometimes uses it; that is not deduplication.

## 3. `main` versus `test` hotfix analysis

**VERIFIED:** `main..test` changes 26 files, including schema/migration 0035, provider/delta/content/OAuth/worker code, a reader retry message, diagnostics and tests. The large generated schema snapshot accounts for much of the 7,097 insertions. `test` includes merge `234695e`, hotfix tip `837bd7a`, correctness fixes `42105e2` and `4eb4c81`, and earlier performance investigations. Documentation-only investigation commits in the history do not imply a committed production data dump in this tree.

| Classification | Actual change | Required disposition |
| --- | --- | --- |
| Generic, permanent | Content request/attempt UUID fencing (`schema.ts:1054`; `message-content-service.ts:242`, `:340`, `:458`), repairing missing enqueue, retry state tied to durable job metadata (`content-jobs.ts:32`, `:129`; `worker-process.ts:49`) | Retain for both transports, including migration generation checks |
| Generic, permanent | Safe refresh of stale/unknown HTML policy, preserving valid cache and reader retry presentation (`message-content-service.ts:163`, `:217`; `message-reader.tsx:188`) | Freeze `test` behavior as UI baseline; never restore older error behavior |
| Generic, permanent | Correlated stage telemetry, queue eligibility/original age, safe timeout/disconnect/cancellation categories (`performance.ts:1`; provider `sanitizeError` at `imap-smtp-mail-provider.ts:249`) | Extend for Gmail; keep fixed allowlists and best-effort logging |
| IMAP-specific, permanent | Presence queries separately bounded to 1,000 UIDs/8,000 characters (`uid-presence.ts:2`); validate UID response; independently FETCH-confirm absence; postpone removals until valid STATUS (`imap-smtp-mail-provider.ts:1297`) | Needed for non-Gmail and rollback; do not substitute Gmail history logic into this code |
| IMAP-specific, permanent | Capture SELECT epoch/MODSEQ before ImapFlow mutations; valid STATUS mandatory; epoch-fenced deletions/completion (`imap-smtp-mail-provider.ts:1138`, `:1339`; `delta-sync-service.ts:259`) | Preserve correctness fixes; no count-only fast-path assumption |
| IMAP-specific, permanent | Iterator result/error preservation and connection-health handling (`imap-client-lifecycle.ts:53`); content MIME/charset safety retained with instrumentation (`imap-smtp-mail-provider.ts:1504`) | Continue testing non-Google adapters |
| Google-specific OAuth, permanent | Reconnect serialized with refresh; validate Google subject; rotated refresh token retained; revocation committed while holding row lock (`google-oauth.ts:296`, `:382`) | Shared by Gmail REST and SMTP; retain without copying token storage |
| Gmail IMAP work eventually bypassed | Per-folder connections, presence/flags reconciliation, STATUS and IMAP body downloads when the account is Gmail-active | This is work performed by generic adapter paths, not a disposable Gmail-only hotfix module |
| Investigation required | Account row locks encompass OAuth HTTP; each acquisition refreshes; content worker concurrency is 1; mailbox-scoped content job keys despite shared content rows | Measure pool pressure/fairness; adapt deliberately. Do not loosen correctness fences to improve metrics |

Migration 0035 remains present and unchanged. `patches/imapflow@2.0.6.patch` fixes conditional STORE and predates this diff; retain it with the remaining dependency patches. No hotfix deletion, simplification, or revert is proposed, including after Gmail becomes default.

## 4. Gmail API PoC review

**VERIFIED:** PoC adds `experiments/gmail-api-poc/{README.md,client.ts,experiment.ts,cli.ts,main.ts}`, a package script and `tests/gmail-api-poc.test.ts`. Its merge base is exactly the reviewed `test` commit. It neither imports application roots nor handles production persistence.

| PoC evidence (PoC branch) | What it establishes | Production gap |
| --- | --- | --- |
| `README.md:1`, `client.ts:172` | Fixed Gmail origin, GET only, redirect refusal, injected transport, bounded attempt including body consumption | No write operations, account credential lifecycle or DB durability |
| `client.ts:5`, `experiment.ts:28` | String history IDs; BigInt range comparisons without unsafe Number conversion; pagination/cycle guards | History counts do not persist resulting mailbox state |
| `client.ts:271`, `:281`; `experiment.ts:167` | Profile before listing; restricted partial metadata fields | Excludes headers, snippet and MIME; cannot drive complete list/reader/attachment behavior |
| `experiment.ts:95`, `:136` | Bounded concurrent metadata pool; drains in-flight work; sequential then concurrent comparison | Order/warmup bias; same small sample; no DB/content/sanitization/queue timings |
| `client.ts:238` | 429/5xx backoff, respects Retry-After including excessive deadline refusal | No jitter, 403-reason classification, refresh after 401, durable retry scheduling, account/project quota controller |
| `experiment.ts:28` | Counts distinct event tuples and affected IDs, leaves resulting checkpoint null on incomplete history | Does not fetch/reconcile affected messages; retains sets/attempt arrays for bounded sample only |
| `tests/gmail-api-poc.test.ts:1` | Mock coverage of pagination, ID precision, repeated events, expiration, failure, timeout, concurrency, CLI and sanitized output | No real-account mutation/recovery/migration/UI coverage; tests were inspected, not run |

**RECOMMENDED:** Reuse timeout, fixed-origin, validation, partial-field, bounded-concurrency and safe-reporting patterns. Do not import this experimental client wholesale into application composition. Its static access token and accumulating diagnostic arrays are unsuitable for a long-lived worker. Benchmark repeated warm/cold orders, realistic headers/MIME structure and full persistence before comparing transports.

## 5. Proposed target architecture

**RECOMMENDED:** Keep domain/application services and UI routes, introduce a transport router and a dedicated Gmail sync orchestrator:

```text
Existing UI / Next API (local account, mailbox, message, draft UUIDs)
     -> existing application reads, rendering, compose, durable intents
     -> transport router (persisted account mode + generation)
          -> IMAP synchronizer / locator / mutations + SMTP sender
          -> Gmail account synchronizer / locator / label mutations
               -> Gmail REST client + existing Google token resolver
     -> shared metadata/content/attachment projection + PostgreSQL + blobs
     -> existing pg-boss runtime, provider-aware schedulers and repair pollers
```

Account receive mode is persisted and server-controlled: `imap`, `gmail_shadow`, `gmail_active`, `rollback_pending`; send mode initially remains `smtp`. Google OAuth identity, not an email-domain suffix or configured hostname, makes an account eligible. Password Gmail accounts remain IMAP until explicitly linked to the existing Google authorization flow; do not silently replace their credentials. Microsoft and other providers stay IMAP/SMTP.

New Google OAuth accounts use the same tile, routes and consent. During rollout, default remains IMAP until approved deployment policy enables Gmail for eligible new accounts; then readiness checks precede Gmail activation. Existing accounts stay IMAP until reconciliation succeeds. A Google account with disabled API remains operational on the current mode with an actionable error; never oscillate between providers after a transient 429/5xx.

For Gmail, synchronization is account-wide even when Refresh is clicked in one folder. Routing maps that local request to one account job; no folder creates its own history checkpoint. Retain global configuration such as recent import window, poll cadence and backfill priority. Expose compatible progress projections to current screens; account diagnostics are the allowed place for history metrics.

## 6. Interface and component changes

**RECOMMENDED:** Interface names below are proposed contracts, not existing types.

| Existing seam | Decision | Concrete responsibility |
| --- | --- | --- |
| OAuth registry / `OAuthMailProvider` | Remain stable for begin/complete/configuration; additive optional token-lease seam | Same client ID/secret, subject, encrypted refresh token and routes; reuse a lease within one sync operation |
| `ProviderAccount`, `ProviderImapAccount` | Keep for IMAP; add discriminated Gmail work context | `{ accountId, receiveTransport, generation, oauthSubject, tokenLease }`, no fake hosts/UIDs |
| Current `MailProvider` | Retain as IMAP contract, split new capability contracts | `ImapSynchronization`, `GmailAccountSynchronization`, `MessageContentSource`, `AttachmentSource`, `MessageMutationTransport`, `OutgoingTransport`; no generic UID frontier for Gmail |
| Remote metadata | Separate message fields from remote identity/membership | Stable `{ transport, accountId, remoteId }`, envelope/date/size, supplemental thread ID, labels, observed version; UID/epoch only on IMAP locator |
| `RemoteMimePart` / body selectors | Reuse semantic body/attachment classification with provider part locators | IMAP numeric part validation stays IMAP-only. Gmail locators include partId/attachmentId; UI part UUID remains stable |
| `MessageService.persistBatch` | Retain IMAP method; extract shared message-value projection; add Gmail canonical upsert | Uniqueness by Gmail ID; atomic memberships/flags and checkpoint boundary; no implicit RFC-ID merging |
| `DeltaSyncService`, backfill/recent services | Remain IMAP-specific; add Gmail orchestrator | Account baseline, durable pending IDs, initial inventory and history replay |
| Content/attachment services | Preserve UI API/results and hotfix fences; extend locator resolution | Source chooses Gmail message ID or validated IMAP placement; recheck mode/generation before publish |
| `MessageCommandService` | Preserve command API/status/optimistic behavior; split readiness and transport execution | Gmail action checks capabilities without UID or IMAP MOVE; serialize intents per canonical message across labels |
| Outgoing/Sent copy | Preserve SMTP initially; add explicit send transport later | Transport snapshot on outgoing row; REST response remote ID; independent legacy APPEND preserved |
| Schedulers/pollers/watchers | Route every producer and recheck every consumer | Existing jobs reload mode; Gmail uses account keys; old payloads remain parseable and are skipped/rerouted safely |
| `MailboxView`, `MailAccountView` | Preserve consumed fields; extend explicit application capabilities and Gmail diagnostics | `canArchive`, `canTrash`, receive transport info. Never set `imapCapabilities=['MOVE']` to satisfy UI |
| UI routes and result shapes | Remain stable where consumed; additive fields only | No new credentials page/tile, paging scheme, compose workflow or visual restyling |

Likely new files: `accounts/domain/mail-transport.ts`, `accounts/infrastructure/mail-transport-router.ts`, `accounts/infrastructure/gmail-rest-client.ts`, `mail/application/gmail-sync-service.ts`, `gmail-message-repository.ts`, `gmail-migration-service.ts`, `mail/infrastructure/gmail-sync-jobs.ts`, `gmail-account-lock.ts`, and `accounts/infrastructure/gmail-mail-provider.ts`.

Existing modules requiring targeted edits: schema, account service/domain views, Google OAuth account construction, web assembly `accounts.ts`, worker composition/process, discovery/recent/backfill/delta jobs, idle watchers, content/attachment services and selectors, commands, counts/notifications, search/conversations alias resolution. UI internals `mail-client.tsx:419` currently gate archive/trash on IMAP MOVE: replace the predicate with application capabilities, keeping identical controls and styling. This behavioral plumbing is necessary even though visible UI changes are limited to the three allowed areas.

## 7. Database and message identity strategy

### 7.1 Smallest safe extension after inspecting the model

**RECOMMENDED:** Retain `messages`, `mailboxes`, `mailbox_messages`, `message_contents`, attachment/blob/draft tables. Do not introduce a second Gmail message store or synthetic IMAP IDs. Use additive migrations, followed by narrow conditional constraints:

| Proposed schema change | Purpose / integrity |
| --- | --- |
| Account receive/send mode and `transportGeneration` | Server-controlled routing/fencing; current endpoint fields retained for rollback. Existing rows default IMAP/SMTP |
| `account_gmail_sync_state` (PK/FK account ID) | `historyId TEXT`, baseline, status, run ID, generation, next attempt/error/timestamps; decimal validation, no JS Number or PostgreSQL signed-bigint dependency |
| `gmail_message_identities` | Unique `(accountId, gmailMessageId)` -> canonical local message UUID; optional Gmail thread/history strings. Composite account+message FK; Gmail identity is namespaced independently of legacy providerMessageId |
| Placement transport discriminator | Gmail memberships have NULL UID/UIDVALIDITY; IMAP memberships require both. Retain IMAP unique identity, add partial unique `(mailboxId,messageId)` for Gmail; enforce account ownership in persistence/composite relations |
| Label locator | Preserve mailbox UUID; provider label ID is canonical, path/name is presentation. Scope uniqueness to transport if legacy provider mailbox IDs coexist |
| Remote locators for attachments/commands | Nullable legacy UID fields only under Gmail discriminator; Gmail message/part/attachment IDs with conditional checks; never use Gmail part IDs in IMAP downloads |
| Notification identity | Retain legacy uniqueness, add Gmail uniqueness per account/message arrival; nullable IMAP fields conditional by transport; migration/backfill never publishes arrivals |
| Migration runs, alias map and journal | Unique old UUID -> canonical UUID within account; recorded mapping proof, before-images/reference changes, per-group completion and generation; retained copies until rollback window ends |
| Durable inventory/history work | Tables keyed by account/run/message ID and phase, plus label inventory generation; page/work progress survive crashes; bound in-memory buffers |

Do not set a global unique constraint on `messages.providerMessageId`: existing Gmail values can repeat across placements and non-Gmail OBJECTID is a different namespace. Prefer the dedicated identity table until old data and identifier provenance are established. User preferences, auth rows, signatures and blob objects remain intact.

Future SQL must include migration journal/snapshots, security grants/authority verification and backup/restore handling, not only Drizzle declarations. Check `scripts/postgres/99-maildock-authority.sql`, recovery compatibility files, and migrations 0017/0019/0032 for functions and triggers when adding tables or changing identity projections. No migration is created in this task.

### 7.2 Verified IMAP/API identity bridge

**VERIFIED (Google):** `X-GM-MSGID` is an unsigned 64-bit decimal identifier equivalent to the hexadecimal Gmail API message ID; UIDs are unrelated. It can be FETCHed and SEARCHed. [Google IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions).

**VERIFIED (pinned dependency):** inspected the published `imapflow@2.0.6` tarball from the [npm version metadata](https://registry.npmjs.org/imapflow/2.0.6), extracted outside the repo and matched its SHA-512 to published integrity. `dist/cjs/commands/fetch.js:79–85` automatically requests EMAILID for OBJECTID, otherwise X-GM-MSGID for X-GM-EXT-1. `dist/cjs/tools.js:725–733` maps Gmail decimal text to `emailId` without numeric conversion. `dist/cjs/search-compiler.js:239–246` supports EMAILID or Gmail X-GM-MSGID search. Repository adapter maps `message.emailId` to `providerEmailId` (`imap-smtp-mail-provider.ts:516`); persistence maps that into `messages.providerMessageId` (`message-service.ts:80`). The local patch changes STORE, not these paths.

Therefore cached *proven Gmail X-GM* IDs can be converted using `BigInt(decimal).toString(16)` without UID derivation or body downloads. Validate positive unsigned 64-bit range and provenance; never convert arbitrary OBJECTID text or blindly classify a hexadecimal all-digit ID as decimal. Store original and normalized identifiers separately.

**OPEN:** actual installations' identifier coverage, capability provenance and old library versions are unknown. A future authorized read-only inventory must measure missing IDs, duplicates, conflicts, orphaned placements, attachment UUIDs/blobs, and cached HTML policy. It must not expose mail contents in diagnostics.

Reconciliation order:

1. Match validated X-GM-MSGID from known Google IMAP ingestion; optionally verify metadata against the API ID in staging.
2. If absent, bounded IMAP UID FETCH of X-GM-MSGID with current UIDVALIDITY checked; no body download. If OBJECTID takes priority, validate whether the returned EMAILID has a documented bridge; otherwise obtain explicit Gmail identifier evidence through a supported adapter path before conversion.
3. API `rfc822msgid:` query may generate candidate matches, but duplicate/missing/untrusted RFC IDs preclude automatic identity proof. Corroborate with remote X-GM identity; treat header/date/size resemblance as review evidence only.
4. If remote placement has disappeared, keep cached record and references as unresolved local history. Do not drop it or attach it to a guessed message. Existing-account automatic cutover blocks for unresolved live identities; an explicitly approved local-history exception may preserve inaccessible legacy rows.

### 7.3 Canonicalization without losing caches

Choose a deterministic canonical UUID (prefer a valid cached body and referenced record, then stable tie-break). Preserve each former UUID through an account-scoped alias; reader/compose/attachment/search/conversation resolution checks alias and ownership. Migrate placements to one canonical Gmail membership per label, recording before-images, without deleting old message/content/attachment rows during rollout. Live queries must exclude aliased legacy duplicates.

For content, retain every previous valid cache; select a usable current-policy body for canonical reads. Do not invalidate because transport changed. For attachments, keep public UUIDs/blobs and draft references; map provider parts only with structural proof (type/disposition/content ID/size and, where available, hash). MIME section `1.2` and Gmail part `0.1` are not equivalent. If mapping is ambiguous, cached bytes remain usable; fetch fresh structure lazily before remote download. Do not overwrite a cached part/blob from a speculative match.

Conversation membership/reference triggers require alias-aware reconciliation and reversible journal updates; user preference does not change. Search body may reuse only verified cached plain/sanitized content and existing local search conversion. Do not fetch the entire mailbox body to improve search coverage.

### 7.4 Labels and folder projection

**VERIFIED (Google):** labels attach to messages; thread label unions are not all-message membership, and thread mutations affect all existing members. [Label semantics](https://developers.google.com/workspace/gmail/api/guides/labels).

**RECOMMENDED mapping:**

| Gmail concept | Maildock projection / operation |
| --- | --- |
| `INBOX` | Existing Inbox mailbox UUID where proven; presentation path remains `INBOX`; all-inboxes query continues working |
| User labels | One mailbox row per stable label ID; hierarchy from label names for display only; rename preserves UUID and memberships |
| `UNREAD` | Absence of `\\Seen`; removing/adding UNREAD marks read/unread on all projected memberships of the message |
| `STARRED` | `\\Flagged` on every membership; optionally existing Starred label projection |
| `SENT`, `DRAFT`, `SPAM`, `TRASH` | Sent, remote Drafts, Junk, Trash system role projection. Remote DRAFT is not local composer draft |
| All Mail / archive role | Derived view for non-SPAM/non-TRASH messages consistent with verified Gmail All Mail inclusion; no invented `ALL`/`ARCHIVE` API label. Validate draft inclusion against staging IMAP baseline |
| `IMPORTANT`, categories | Label projection if already shown/required; respect label visibility settings, no new navigation categories |
| Archive | Remove INBOX only, retain custom labels; do not MOVE to another label. Manual archive-role overrides on legacy Google accounts require compatibility decision |
| Trash | `messages.trash`; apply complete authoritative labels to every membership, not only source folder |
| Spam / restore | Future provider operations use label changes / `messages.untrash`; precise destination reconciliation from returned labels |
| Remove custom label | Remove just that membership; keep message/body/other memberships |
| Permanent delete | `messages.delete`, separately authorized destructive action; never use it as label removal or ordinary Trash |

Counts: project message memberships once; flags are global per Gmail message but duplicated in placement flags for current APIs. Remote label counters preserve full-mailbox unseen totals; refresh counters after deltas/commands, with existing client optimistic adjustment reconciled once. An account total must not sum all labels. Labels newly discovered/removed need their own periodic label inventory: history alone must not be treated as a complete label catalog change feed.

## 8. OAuth and account lifecycle

**VERIFIED:** `google-oauth.ts:23` requests `https://mail.google.com/`, `openid`, `email`. Token response scope, when returned, is checked for that mail scope (`:169`). State is session/provider-bound, hashed, single-use and PKCE-backed (`:195`, `:240`). Cache contains version/subject/refresh token under account encryption context (`:29`, `:109`, `:126`). No persisted access-token cache: every `accessToken()` refreshes while locking the account (`:382`). Reconnect validates the same subject, preserves old refresh token when omitted and validates it (`:296`). Revocation sets `reconnect_required` in that locked transaction.

**VERIFIED (Google):** the currently requested mail scope covers reading, modifications, sending, drafts and permanent deletion. No additional Gmail scope is necessary for a token actually granted it. Restricted-scope requirements already apply; changing transport does not remove them. [Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes). Applicable verification/security-assessment requirements depend on distribution and data handling; personal/testing/internal exceptions must be evaluated for the actual project. [Verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**RECOMMENDED:**

- Reuse `OAuthProviderConfigs` (`oauth-provider-configs.ts:25`, `:69`, `:99`), existing encrypted client secret and account refresh-token context. Keep the same settings controls (`oauth-provider-settings.tsx:202`) and Google tile (`settings-shell.tsx:355`). No separate REST credentials, redirect or consent page.
- Before activation, check Gmail API enablement on the same Cloud project via an authorized readiness operation. Enablement is an operator Cloud action, not a new Maildock credential. Do not assume IMAP success proves API enabled.
- Classify disabled-service 403 using validated Google error reason/status metadata; expose fixed English text through existing error area: “Gmail API is disabled for the configured Google Cloud project. Enable Gmail API in that project and retry.” Do not mark revoked consent on this error. Avoid raw Google response dumps.
- Preserve current scope set. A scope reduction is a separate approval/ADR, especially while SMTP/IMAP rollback uses the broad scope. No forced reconsent solely because REST is introduced.
- Acquire one token per account operation and share within the request pool; optionally add short-lived in-memory token lease/single-flight refresh with expiry margin. Never write tokens to jobs/logs. Adding a lease requires extending current token resolver to expose expiry, not inventing expiry from its string result.
- After 401, invalidate the lease and refresh once; repeated 401 stops work. Invalid grant/revocation retains existing reconnection UI; config/service/permission errors remain distinguishable. Rotate refresh tokens atomically through the existing lock.
- Disable/delete/reconnect/config change increments transport generation. Recheck enabled/status/mode before requests and before publication; reconnect clears token leases. Subject change is still rejected.

**OPEN:** enablement, granted token scope, Workspace admin policy, quota generation and verification status of the user's project require future authorized validation; none were accessed here.

## 9. Initial and incremental synchronization algorithms

### 9.1 State, execution and transactions

**RECOMMENDED:** `account_gmail_sync_state.historyId` is the committed account checkpoint, nullable until a baseline is safely established. It is an opaque decimal string; never a JS Number, never incremented, never cast into a UID/MODSEQ field. Equality/string persistence suffice; precision-safe BigInt comparison may validate monotonic observations without interpreting gaps.

Use account-level session advisory lock `gmail-sync:<accountId>` on a reserved connection, analogous to `mailbox-lock.ts:5`. It serializes initial/backfill/history/reconciliation and migration cutover. Commands lock canonical message and coordinate with this account projection boundary. Define lock order: account transport/session boundary, then message, then attachment/outgoing if needed; acquire token before reserving scarce connections where safe and recheck generation afterward. Test pool size 1 explicitly. Do not hold long data transactions across enumeration/HTTP.

Queue `gmail-account-sync-v1` uses `{version,accountId,generation,reason}` and account singleton key. History is not sourced from job payload: reload it under lock. Coalescing/pg-boss retries prevent waste but cannot guarantee unique execution; row generation/run identity and CAS govern correctness. A durable work/status row plus repair poller closes enqueue-after-commit gaps. Queue completion is an acknowledgement *after* DB commits, never the checkpoint authority. Do not directly edit pg-boss internal tables.

All batch commits check account enabled, connected, receive mode, generation and sync run; lock state row and verify expected checkpoint/run ID. Metadata, canonical identity, label memberships, flags, search/conversation effects and notification suppression/events commit together. Short transactions and bounded work tables allow retries without an account-sized DB transaction. If transport changes during remote I/O, discard its response before persistence.

### 9.2 Initial synchronization / reconciliation

1. Resolve credentials/readiness, acquire account boundary, reload authority. Start durable run with generation and phase. Fetch profile history **H0 before enumeration**, persist it as baseline (not a completed sync checkpoint), inventory labels.
2. Enumerate messages account-wide, including Spam/Trash, with bounded pages; deduplicate IDs durably. Use the existing recent cutoff for first visible metadata, then lower-priority older inventory/backfill. A query window is not a complete account inventory. If using `q`, current broad production scope permits it; PoC metadata-only scope cannot. `messages.list` returns IDs/thread IDs, maximum 500 per page. [List contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).
3. Fetch UI-required headers and metadata for in-scope IDs with bounded pool. Upsert each complete authoritative message state and memberships; reuse existing mappings/caches. List results alone cannot establish sender, subject, flags and attachment availability. Do not persist missing fields as empty values over good cached metadata.
4. Persist page progress only after its discovered IDs are durably recorded and fetch work completed or remains explicitly pending. Network/DB failures preserve the last completed frontier; durable pending IDs are retried. Opaque page token expiry restarts enumeration with idempotent upserts; page limits schedule continuation, never falsely report completion.
5. Replay **unfiltered account history from H0** after recent enumeration, and repeatedly between backfill chunks so a long import does not outlive history retention. New arrivals/changed existing messages are reconciled; older newly labelled records may need metadata despite being outside the recent window. Keep inventory completeness and delta readiness as separate states.
6. For complete reconciliation, finish all inventory pages, replay intervening history, resolve pending IDs and refresh label inventory. Only then compare previously present IDs/memberships against the complete generation. Confirm uncertain absences by exact message GET/history; never remove data after a truncated/failed scan. Page traversal is not a transactional snapshot: concurrent mailbox changes need replay and targeted/repeated inventory checks before declaring absence.
7. Mark recent-ready/full-inventory-complete separately, committing the final history cursor only via the delta completion rule below. Preserve cache even for remotely deleted messages; hide remote memberships/tombstone identity, defer local GC. If H0 expires mid-import, restart reconciliation against a fresh baseline and reuse all completed mappings/caches.

The progressive policy does not claim full local search/body coverage; history processing is still account-wide. One H0 need not survive the entire 41k import if completed deltas are safely committed between bounded backfill chunks. Backfill response writes obey the same account boundary/version checks to avoid overwriting a newer delta.

### 9.3 Incremental history

1. Load committed H under account lock. Call `history.list(startHistoryId=H)` without label/type filters so removed labels, trash and deletions remain visible. Persist run and discovered affected IDs in bounded work tables. Validate IDs and page tokens; deduplicate repeated records/events.
2. Consider all four specific event collections (`messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`). Generic `history.messages` is supplemental affected-ID evidence, not an additional event count. Multiple changes to one ID coalesce to final-state reconciliation, never an unordered sequence of destructive mutations.
3. Fetch current message metadata/labels once per distinct affected ID per reconciliation batch. For an existing identity, refresh complete label set and read/star projection across all memberships. Label removal alone never deletes the logical message. GET may observe a state newer than returned history; later replay is idempotent and must not revert it with an older event patch.
4. A confirmed exact-message 404 under valid account authority represents remote absence; retry/validate ambiguous failures, never treat 401/403/network/parse errors as missing. MessageDeleted history plus exact lookup is strong deletion evidence. A newly added then deleted message need not create a visible row. Tombstone old identity/memberships while retaining cached bytes/references.
5. Persist projections in short transactions with run/generation guards. History pages can be staged/applied before completion, but **committed H stays unchanged** until every page and affected ID is successfully persisted/resolved. Do not advance to a page's mailbox head while `nextPageToken` exists.
6. On final page, retain returned historyId H1; after durable work completion, transaction locks account sync row, verifies expected H/run/generation, and atomically writes H1, completion status/counters and clears pending work marker. Never substitute a later `getProfile.historyId` for H1, which could skip unprocessed events. Empty history also advances by this rule.
7. Crash before checkpoint commit: replay from old H, upserts/notifications are idempotent. Crash after commit but before pg-boss acknowledgement: duplicate handler reloads new H; it does not replay the stale payload cursor. If a crash occurred after remote command success, reconcile command intent rather than resubmitting an uncertain send.

**VERIFIED (Google):** history can expire, IDs have gaps, and only a completed page sequence supplies a usable advanced head; 404 requires full synchronization. [History contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list). **RECOMMENDED:** checkpoint 404 changes status to `reconciliation_required`, retains old cache/identity, and starts §9.2. Targeted recent reconciliation may restore responsiveness but is not sufficient to prove all cached memberships current. Full ID/label reconciliation is needed; full body redownload is unnecessary.

### 9.4 Scheduling and failures

Maintain existing poll interval initially, once per account, with jitter/fairness and low-priority backfill. Manual refresh and post-command wakeups coalesce. IMAP pollers/discovery/recent/backfill/IDLE must filter by active transport; stale jobs recheck generation before network work. Disabled/reconnect-required accounts pause. Retryable HTTP/network/DB failures keep the checkpoint, with bounded exponential jitter and Retry-After; long delays persist `nextAttemptAt` rather than sleeping while holding worker/DB locks.

Rate-limit errors can be 403 reason codes or 429, not just the latter. Classify disabled service, permission/scope, revoked authorization, expired history, missing message, invalid response, rate limit and transient transport distinctly. Mutations and sends do not inherit GET's blind retry policy. [Google error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

## 10. Sending, drafts and attachments

### 10.1 Option comparison and staged choice

| | Option A: Gmail receive + SMTP | Option B: Gmail receive/send/drafts |
| --- | --- | --- |
| Behavior preserved | Current SMTP envelope, uncertainty and partial-recipient model; local autosave | Existing composer can remain; delivery/draft backend semantics require additional work |
| Sent | Gmail normally supplies server Sent; existing user-selected `maildock` APPEND can create another copy | REST send supplies SENT; no APPEND/import after successful send |
| Credentials | Existing Google refresh flow shared | Same credentials/scopes, no second grant |
| Identity | Discover Sent through Gmail delta; correlate known outgoing Message-ID conservatively | Persist API response message/thread ID directly |
| Risks | Temporary Gmail IMAP dependency for deliberate legacy APPEND; server-side Sent behavior must be validated | Ambiguous POST retry, Bcc, alias sender, immutable MIME adaptation, draft races |
| Recommendation | First production stage | Separate later stages; remote draft mirror optional |

**VERIFIED:** Sent-copy policy is snapshotted in outgoing row and has separate failure/uncertain state (`outgoing-message-service.ts` insertion before `:397`; `sent-copy-service.ts:22`, `:69`). Sent APPEND must not be silently deleted or its policy changed during this audit/rollout. With Option A, initially preserve a selected `maildock` policy via explicit legacy Sent-copy path and validate duplicate risk; do not enable a cohort that requires an incompatible forced policy change. A later policy translation to “provider manages Sent” requires approval and must keep the visible settings flow compatible. Never save both via API insert and IMAP APPEND as a fallback.

**RECOMMENDED Option B:** immutable outgoing row includes transport generation/send mode and expected Gmail thread identity. `messages.send` receives base64url MIME; persist returned ID and schedule account delta. Lost response after POST remains `uncertain`; fixed Message-ID lookup is evidence, not proof of non-delivery and not a reason for blind resend. Queued SMTP rows retain their original transport through cutover. Sending via API does not need to create a remote draft first.

**Critical verified compatibility gap:** `outgoing-mime.ts:7` accepts To/Cc but no Bcc; SMTP separately uses all recipients in its envelope (`outgoing-message-service.ts`, delivery call after `:463`). Gmail sends to MIME To/Cc/Bcc headers, so simply base64url-encoding current SMTP MIME would omit Bcc recipients. Add transport-aware send MIME/envelope construction before freezing bytes, and test Bcc receipt/privacy, recipient deduplication, aliases, unicode headers and rejected/invalid-recipient errors. [Send contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send). Existing SMTP MIME must not change incidentally.

Keep reply/reply-all/forward preparation in `compose-preparation-service.ts`, `reply-forward.ts` and outgoing snapshot. Optional API threadId is supplemental; Gmail requires threading headers and matching subject for insertion into a thread. Do not thread solely by Gmail ID or change Maildock conversation preference. [Gmail thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads).

### 10.2 Local drafts first; remote drafts later

Preserve local revision conflict checks, browser recovery, autosave delay, attachment pinning, consumed state and local Draft list. Remote Gmail DRAFT-labelled messages remain readable mailbox records, as current remote IMAP drafts do. They do not automatically become editable composer records.

If remote draft synchronization is approved later, add a separate `gmail_draft_links` table: local draft ID, stable Gmail draft ID, changing remote message ID, last mirrored local revision, content hash, generation and uncertain-operation state. Serialize updates per draft; only mirror committed revisions, coalesce superseded autosaves, retain local state on rate limit. Creating a draft after lost POST response cannot be retried without reconciliation; external Gmail edits need conflict policy, not last-write-wins overwrite. Prevent echo import/mirror loops. Coordinate send/discard with in-flight mirror, preserving local draft until outcome is known. Gmail draft updates replace contained message identity; draft deletion/send cannot be equated with local row removal. [Draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts).

### 10.3 Bodies and attachments

Metadata GET retrieves headers required for sender/recipient/subject/date/reply/threading; full-format field masks may retrieve MIME structure without body data if supported and validated. **OPEN:** select a proven metadata/structure request shape that preserves attachment indicators before enabling users; metadata-only payload is not an IMAP BODYSTRUCTURE substitute. On demand, full MIME payload yields selected body bytes; raw MIME fallback may use current parser patterns, bounded in memory and never retained as incoming raw source (ADR 0011). [Message formats](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

Gmail body data is base64url, not automatically UTF-8; decode charset deliberately, preserve existing fatal validation/part-size policy and select multipart alternative/mixed/related safely. Keep sanitized HTML, CID mapping and remote-image isolation. Some text/body parts themselves require attachment-ID retrieval. Incoming binary attachments use Gmail message ID plus attachmentId, or inline body data; enforce decoded and encoded limits before materializing JSON, type/integrity checks and blob bounds. REST base64 JSON is not a streaming IMAP binary download: chunk a bounded decoded buffer into the existing consumer contract, and include JSON/base64 peak memory in limits. Keep outgoing/staged attachment UUIDs and immutable MIME blobs.

## 11. UI compatibility assessment

The visual/functional baseline is the current `test` checkout, including retry messaging. **RECOMMENDED:** no redesign, navigation change, new account tile, new credential fields, transport dropdown or provider-specific composer.

| Surface | Compatibility requirement / necessary internal adaptation |
| --- | --- |
| Settings Google OAuth | Same `oauth-provider-settings.tsx`, fields, persistence, secret encryption and redirect URI |
| Add/reconnect | Same registry definition, `settings-shell.tsx:355` tile and `/api/oauth/google/{start,callback}`; same account identity/security checks and redirects |
| Accounts/order/enable/delete | Same UUIDs, ordering, fields and operations; pause authority internally while migration remains restartable |
| Message lists/paging/all inboxes | Same local API routes, page size, keyset cursor and row visuals; no duplicates per label; INBOX remains discoverable |
| Reader/images/auto-read | Same content API/state, iframe/CSP, blocked remote content, trusted-sender policy and auto-read timing |
| Search | Same local FTS/UI; no Gmail `q` substitution; alias-aware single logical hit with deterministic placement |
| Read/star/archive/trash | Same buttons, keyboard/selection behavior and pending feedback; capabilities replace MOVE checks; Gmail global flags update all label views |
| Reply/all/forward/send | Same preparation, composer, signatures, Bcc/attachment flows and outcome display |
| Draft/autosave | Local revision/browse recovery unchanged; no forced cloud-draft ownership |
| Conversations | Same opt-in/off behavior and header-based group semantics; message alias resolution preserves stable links |
| Background/notifications | Same user-facing cadence and notification policy; no migration/backfill/label-only notification flood |
| Allowed differences | Folder/label presentation, Google account IMAP detail area, synchronization diagnostics only; use existing classes/components |

**VERIFIED feature gap:** current command schema and toolbar do not expose general move, restore, permanent deletion or spam mutation. Ordinary Delete is Trash. Preserve existing behavior; document these native provider capabilities for future use, but do not introduce controls to “satisfy” an audit checklist. If the user expects these to be existing features, clarify scope before adding them.

Manual system-folder mappings and Sent-copy choice are existing preferences. Their compatibility with Gmail-native archive/SENT semantics needs a decision (§15), not a silent reset. Internal capability additions to `mail-client.tsx` are allowed plumbing, with zero visual difference outside the three permitted areas.

## 12. Migration and rollback strategy

**RECOMMENDED state machine:** `eligible -> inventory -> mapping -> shadow_validated -> cutover_pending -> gmail_active`, with `blocked`, `retry_pending`, `rollback_pending`, `imap_active` recovery states. Each run records account/generation, phase, progress counts, identity proof and completion receipt; credentials never appear in the journal.

1. Ship additive schema and routing with IMAP defaults. Existing accounts/credentials/content/preferences remain usable. Deploy hotfix-compatible binary before schema allows Gmail locators; older IMAP-only binaries are not an assumed rollback target.
2. Read-only inventory of account-scoped legacy rows in authorized staging. Build ID mapping using §7.2. Journal ambiguous groups, do not guess. Bounded mapping can run alongside existing IMAP projection with generation checks; shadow API data writes to migration staging, never overwrites live flags or memberships. Shadow work has its own history checkpoint and emits no notifications or remote commands.
3. Validate label counts, duplicate identities, body/attachment hashes and all FK/draft/conversation/search references. Establish H0/replay in shadow. Preflight native semantics for manual roles and Sent-copy preferences; unresolved requirements block cutover.
4. Enter short account cutover barrier. Fence generation; stop/reroute IMAP producers, close IDLE clients and wait for old in-flight publishers. Drain pending commands/Sent copies and retain outgoing transport snapshots; uncertain mutations reconcile before activation. Block new remote intent execution briefly through existing pending states; keep local reads/draft autosave available. No queued command may change meaning by switching transport underneath it.
5. Recheck final legacy drift under barrier; atomically activate mappings/aliases/label projection, mode/generation and validated Gmail state, record receipt. All Gmail live writes thereafter use account sync boundary. If the transaction fails, live authority remains IMAP; durable staging supports restart.
6. Retain legacy rows, locator ledger, before-images, all cached bytes and IMAP credentials throughout the rollback window. Repair poller discovers incomplete phases on restart. Repeated migration invocation resumes the same account/run or detects completed receipt; it never creates a second logical Gmail identity.

### Interruption recovery

| Failure boundary | Recovery |
| --- | --- |
| Before inventory/mapping batch commit | Replay batch; no live projection changed |
| After staging commit, before job acknowledgement | Read durable frontier; reprocessing is idempotent |
| During history replay | Old committed H retained; complete pending IDs/replay; expiration starts new inventory baseline |
| During canonical group activation | Group transaction/journal is all-or-nothing; prior UUIDs/caches preserved |
| Before atomic cutover receipt | Remain IMAP; resume reconciliation, repair fenced publishers if barrier had started |
| After receipt, before enqueue/ack | Mode/state row proves Gmail authority; repair scheduler queues account sync |
| During rollback | `rollback_pending`/generation fence persists; resume IMAP identity hydration and reconciliation before releasing writer authority |

### Rollback is a transport operation, not a blind database rewind

Fence Gmail generation, drain commands/requests, stop Gmail scheduling. Reconcile pending/uncertain outcomes against server, then enumerate IMAP and validate current UIDVALIDITY. API-imported messages have no known IMAP UID: bridge Gmail hex IDs to decimal X-GM-MSGID, obtain current placements via supported UID search/fetch and reuse canonical identities/caches. Preserve the ledger across epochs. Extend IMAP persistence for *migrated Google accounts only* to reuse proven Gmail identity; untouched non-Google ingestion remains as inspected. This avoids duplicating API-era messages on rollback.

Restore/reproject legacy placements, aliases and reference changes from the journal only after merging API-era live identities and remote state. Do not restore stale flags/membership before-images over newer server changes. An alias rollback plan must preserve API-era draft/attachment references and old links; it cannot simply delete canonical rows. Keep aliases that are necessary for stable links, with mode-aware query resolution. Test toggling IMAP→Gmail→IMAP→Gmail repeatedly.

Rollback to the new compatible binary with Gmail disabled is supported; downgrade to old `main` cannot read Gmail-null UID rows or canonical projections safely. Disaster recovery uses a matched DB/blobs/keys backup and accounts for mail/drafts created since backup. A full backup restore is not routine rollback and can lose local post-backup work. Report the supported rollback version and retention window before activation.

**OPEN:** Gmail labels hidden from IMAP or IMAP-disabled Workspace policies can make fallback incomplete. Preflight that the rollback cohort's remote IMAP access and visibility cover required data; exclude accounts lacking a tested fallback until approved. No promise that API→IMAP label restoration is universally possible.

## 13. Performance and quota considerations

**VERIFIED (current Google documentation):** quotas changed on 2026-05-01; qualifying older projects retain previous limits. Published new limits are 1,200,000 units/project/minute and 6,000/user/project/minute. Relevant costs: profile/labels.list 1, history.list 2, messages.list 5, messages.get/attachments.get/trash 20, modify/untrash 5, send/drafts.send 100, draft create/update 10/15. Project-specific effective limits need validation. [Quota reference](https://developers.google.com/workspace/gmail/api/reference/quota).

**RECOMMENDED arithmetic, not ETA:** 41,000 IDs at 500/page need about 82 list requests (410 units), plus 41,000 metadata GETs (820,000 units at current published cost). At 6,000 units/minute, quota alone implies approximately 137 minutes for those GETs under ideal scheduling; reserves, retries and other traffic increase it. This is a quota throughput illustration, not predicted wall time or a promise about older projects. Metadata/full field masks reduce bytes, not per-method cost. Measure actual project capacity before choosing import pacing.

**RECOMMENDED engineering:**

- Account/project unit budgets shared by history, body, attachment, mutation and import workers. Reserve at least 30% initially for interactive/delta work; adjust from measured evidence. Begin concurrency 4, benchmark 1/2/4/8 with configured quota pacing; do not turn the PoC's ceiling 16 into a production default.
- Use recent-window visibility first and bounded older metadata backfill. Reuse verified cache and mapped metadata; still reconcile current labels/flags. Bounded GET work queues and page batches (start 100–500 IDs, DB writes 50–100) prevent whole-mailbox arrays/transactions.
- Measure cold process/OAuth/DNS/TLS separately from warm HTTP, JSON/base64, DB upsert/index/trigger time, queue delay, sanitizer and blob I/O. Use pooled HTTP keep-alive and bounded body parsing. Count actual retries/bytes/decoded size; never retain all attempts indefinitely.
- Prioritize delta over backfill, body over historical metadata; enforce cross-account fairness and cancellation. Database bulk upserts must preserve identity/CAS/notification atomicity. Conversation triggers and existing per-row inserts may dominate import; optimize only after measurement.
- Empty poll typically needs history call plus token acquisition (current resolver refreshes every acquisition), and occasional label counters/catalog calls. The PoC's one-request result omits those production stages.
- Future watch/Pub/Sub is optional infrastructure, not required for first release. It is a wakeup hint: authenticated delivery/dedup, renewal, missed-event fallback and polling remain necessary. Do not replace committed checkpoint from a notification history ID. [Push guidance](https://developers.google.com/workspace/gmail/api/guides/push).

### Proposed benchmark gates (approval targets, not observed results)

Use seeded approximately 41k-message staging accounts, one and several label memberships, varied MIME/attachments, 1/4 concurrent accounts, constrained DB pools and a fixed VPS/network specification. Record ≥100 warm delta/body samples for percentile claims; repeat ≥3 cold runs and rotate sequential/concurrent ordering.

| Benchmark | Explicit proposed acceptance |
| --- | --- |
| Empty delta | Warm end-to-end p95 ≤2 s excluding poll interval, ≤1 history page; token/DB/queue metrics included; no mailbox-wide scans |
| 4 changed messages / label/read changes | Warm worker-start-to-commit p95 ≤3 s under quota headroom; exact final state, no skipped checkpoint, requests scale with changed IDs/pages |
| Initial 41k import | 100% unique remote IDs and required memberships for completed inventory, no bodies downloaded unless explicitly opened; no elapsed-time claim until measured; benchmark and approve deployment budget before default rollout |
| Existing migration | Zero valid cached body/blob redownload solely for transport change; zero lost references; every identity group mapped or explicitly blocked |
| Reader/interactive commands during import | p95 ≤20% worse than measured no-import Gmail baseline; no starvation; uncertain sends not resubmitted |
| Memory/DB | Peak worker RSS ≤configured deployment budget (initial proposed 512 MiB for measured workload); no growth proportional to entire mailbox/history; data transaction p95 ≤500 ms at proposed batch size |
| Quota/error stress | Sustained allocated quotas respected, Retry-After honored, bounded in-flight requests; other accounts continue; cursor never advances over failed work |
| Rollback | Complete bounded sample rollback with identical surviving local UUID resolution and cache hashes; full 41k recovery timed/reported before rollout approval |

Targets may be revised by explicit approval after baseline measurement; correctness gates cannot be relaxed to reach latency targets.

## 14. Regression test strategy

This is a planned matrix only. No automatic/unit tests are created or modified by this audit. Existing repository tests anchor future regression work; mocks prove deterministic failure paths, real Gmail test accounts prove protocol semantics. Use dedicated grants/mailboxes and backups, never production credentials.

| Area / existing coverage anchors | Mock or isolated PostgreSQL cases to design | Real account / manual visual cases |
| --- | --- | --- |
| UI compatibility (`mail-shell`, `mail-interactions`, `settings-shell`, `email-rendering-ui`) | Stable DTOs/routes, capabilities, pagination, selection; screenshot baseline plan | Compare all screens/light-dark/empty/loading/error/keyboard states; differences only allowed areas |
| OAuth (`google-oauth`, `google-oauth-routes`, `account-provider-flow`) | Same fields/tile/URLs, scope constant, rotation, revocation races, subject mismatch, token single-flight | Same connect/reconnect consent; disabled API, Workspace policy, actual granted scope |
| Non-Google IMAP (`incremental-sync-provider`, `imap-hotfix`, `imap-client-lifecycle`) | Hotfix presence/STATUS/epoch guards, IMAP queues unaffected | Password IMAP plus Microsoft OAuth smoke/regression with same binary |
| Gmail initial/history | Empty, >1 page, repeated tokens, huge string IDs, failures at each page/work commit, crash/duplicate queue | Create/change/delete during enumeration; Spam/Trash inclusion; recent plus full backfill |
| Identity and migration | Duplicate X-GM groups, missing/invalid IDs, RFC-ID collision, cross-account IDs, journal retry | Compare verified decimal↔hex IDs; multi-label mailbox, UID epoch reset, unresolved mappings |
| Labels/counts/commands (`message-commands`, `mailbox-roles`, `mail-client-unread-count`) | Remove-label≠delete, all-membership flags, canonical command serial ordering, optimistic/history races | Inbox/custom label/All Mail/Sent/Trash/Spam behavior, manual roles, rename/visibility/counts |
| Sending/Sent (`outgoing-*`, `sent-copy-*`) | Queued transport snapshot, uncertain POST, Bcc MIME, no API APPEND; SMTP uncertainty retained | SMTP server Sent; legacy manual policy; API To/Cc/Bcc, aliases, reply threading, exactly one expected Sent representation |
| Drafts (`draft-api`, `mail-composer`) | Revision conflict, local recovery, pins, interrupted send; optional mirror revision/identity replacement | Two tabs, reopen/restart, local drafts unchanged; external Gmail draft only if optional phase approved |
| Attachments/body (`attachment-*`, `display-parts`, `imapflow-download-charset`) | Part bridge ambiguity, CID, multipart charset/base64 malformed/oversize, stale generations, blob hash/reference retention | Varied actual MIME, inline/large attachments, forward and cached download after migration/rollback |
| Search/conversations (`global-search-*`, `conversations`) | Canonical hit once, deterministic mailbox, aliases and triggers, retained body index/preference | Compare saved searches/local coverage and conversation on/off before/after |
| History expiry/rate/errors | Explicit 404 history vs 404 message, 403 reasons, 429 Retry-After, 5xx, JSON truncation, failed DB commit | Staging long-gap recovery plus constrained quota/controlled error injection; do not abuse live quota to force errors |
| Concurrent accounts/jobs (`runtime-jobs`, `recent-sync-jobs`, `backfill-sync-jobs`) | Pool=1, duplicate workers, account generation/lock failure, outage repair, disconnect/reconnect/delete | Concurrent accounts with cold worker restart, import plus reads/commands/notifications |
| Rollback and security (`security/*`, `worker-logging-boundaries`) | API-era identities/drafts survive rollback, no old writer publishes; new tables/authority/restore verification | Repeated transport toggles, backup/restore drill, IMAP visibility preflight; inspect sanitized logs |

Every crash scenario should be tested before and after durable commit/queue acknowledgement. Mock assertions must inspect resulting DB projections/checkpoint, not merely HTTP call counts. Real-account manual checks remain mandatory for label semantics, identity conversion, API enablement, Gmail Sent behavior, MIME and threads.

## 15. Risks, unresolved questions and trade-offs

| Priority | OPEN / decision | Required resolution before relevant implementation |
| --- | --- | --- |
| Highest | Coverage/provenance of existing providerMessageId and duplicate cached UUIDs | Authorized inventory; approve reversible alias/journal strategy and policy for unresolved live/history records |
| Highest | Supported rollback version/IMAP visibility and API-era state | Approve compatible-binary rollback, retention window and tested X-GM placement hydration; no blind old-main downgrade |
| High | Manual archive/system-folder/Sent-copy preferences versus Gmail semantics | Approve native archive removal of INBOX, All Mail view, and handling of custom role mappings/manual Sent policy without silent reset |
| High | New nullable locator columns/constraints/security functions | Approve additive schema design and restore/security work; review migration rehearsal before cutover |
| High | API sending drops Bcc if reusing current MIME blindly | Resolve transport-aware MIME before Option B; preserve SMTP regression baseline |
| High | Gmail REST MIME/part mapping and size memory | Validate request shape/charset/limits and cached part bridge in staging |
| High | Concurrent old jobs and optimistic flags | Account generation, publication fences and canonical command serialization; approved cutover maintenance behavior |
| Medium | Current token refresh locks/pool overhead | Measure before introducing expiry leases; no duplicate credential store |
| Medium | Effective quotas and Cloud enablement | Operator verifies project; published 2026 defaults cannot be assumed for existing project |
| Medium | Optional Gmail threads/draft mirror | Recommend unchanged local conversations/drafts; approve extra semantics separately |
| Medium | User-reported unsupported move/restore/permanent delete | Confirm whether any additional functionality is expected; do not broaden this integration's UI scope |

**RECOMMENDED ADRs:** native account-wide Gmail transport and capabilities; account-scoped identity and reversible legacy aliases; history/persistence/job consistency; rollout/rollback authority; Google grant reuse and future scope minimization; native label projection and manual-folder compatibility; SMTP-first with optional API sending and local-first drafts. Amend ADRs 0005/0008/0011 by follow-up decisions rather than silently replacing their invariants.

The current task authorizes the report only. Before implementation, obtain approval for these concrete choices: additive schema plus aliases/journal; eligible OAuth-only staged rollout and automatic default policy; native archive/label and manual role/Sent policy handling; Option A first, separate Option B and optional cloud drafts; rollback window/version, unresolved identity policy and benchmark deployment budget. No scope expansion or broad UI refactor is recommended.

## 16. Phased implementation plan

All paths below are repository-relative. Migration names are responsibilities, not reserved sequence numbers. Each phase should be one or a few small reviewable changes. Test work is prospective and subject to the implementation authorization; this audit does not execute it.

| Phase / dependency | Deliverable and likely files | Expected DB changes | Validation / rollback |
| --- | --- | --- | --- |
| P0 — approved design | ADRs, authorized inventory tool/report, fixed UI baselines; `docs/adr/`, account/identity inventory specification | None | Resolve §15 decisions, measure mapping coverage and project quota; IMAP unchanged |
| P1a — P0 | Transport contexts/router/capabilities, both roots (`accounts/domain/mail-provider.ts`, new `mail-transport.ts`, `accounts.ts`, `worker.ts`); default IMAP | Account mode/generation defaults only | Existing adapter/API behavior identical; disable new router path |
| P1b — P1a | Additive identity/sync/work/journal/locator schema; `schema.ts`, new migration, authority/restore scripts | Tables/partial uniqueness/conditional UID constraints from §7 | Empty/populated DB upgrade/restart/backup drill; keep Gmail flag off; forward-compatible binary rollback |
| P2 — P1 | Bounded production REST GET client/readiness/token lease; `gmail-rest-client.ts`, Google resolver additive seam and connection diagnostics | Optional readiness error/timestamps in sync state | Mock timeout/reasons/rate/401/logging checks; authorized real staging profile/labels/metadata only; no live cutover |
| P3a — P2 | Metadata/header/MIME mapper, canonical upsert and label projection; `gmail-message-repository.ts`, mailbox roles/counts | Identity/member data only in isolated/staging cohorts | New account dedup/multi-label/count fixture; off flag restores IMAP defaults |
| P3b — P3a | Initial/progressive/history orchestrator and account jobs; `gmail-sync-service.ts`, `gmail-sync-jobs.ts`, lock; route existing producers/watchers | Sync baseline/checkpoint/inventory/work state | Failure/expiration/duplicate/crash matrix, 41k metadata benchmark; keep existing accounts IMAP |
| P4a — P3 | Gmail content/attachment source; `message-content-service.ts`, `attachment-service.ts`, `display-parts.ts`, MIME locator adapter | Locator metadata where required | HTML/CID/charset/size/cache generations; shadow new accounts only; retain IMAP sources |
| P4b — P4a | Gmail durable six-action execution and UI internal capabilities; commands/service/job/schema views, `mail-client.tsx`; diagnostics in allowed panel | Gmail command targets + notification identity, if not in P1b | All-label read/star, archive/trash, optimistic race/notification matrix; flag off requires command drain |
| P5a — P4 | Migration planner and reversible canonical groups; `gmail-migration-service.ts`, alias resolution in read/search/conversations/compose/attachments | Mapping/alias/journal rows; no destructive cache cleanup | Rehearse interrupted groups, hashes/FKs, unknown identities block; shadow staging only |
| P5b — P5a | Atomic cutover and rollback coordinator; all job consumers, account service and compatible IMAP identity reuse | Activation receipt/generation; preserve legacy locators | Existing-account cohort end-to-end plus repeated rollback; compatible binary + mode switch |
| P6 — P5b | Controlled receiving rollout with Option A; diagnostics/runbook/OAuth enablement instructions | No new model; rollout mode rows | All required UI/non-Google/SMTP regression, measured SLO/quota; pause activation or roll back cohort |
| P7a — separate approval, P6 | Option B API sending, transport-aware Bcc MIME, response identity, Sent semantics; `outgoing-message-service.ts`, `outgoing-mime.ts`, Gmail sender, `sent-copy-service.ts` | Send transport snapshot, Gmail sent identity/thread ID; version existing queued payloads safely | Real To/Cc/Bcc/alias/thread/Sent/uncertain checks; queued rows retain transport, stop new API sends on rollback |
| P7b — optional separate approval, P7a | Remote draft mirror/adoption policy; `draft-service.ts` remains local authority, new mirror service/jobs | `gmail_draft_links` and durable mirror attempts/revisions | Lost response/external edit/send-discard races; disable mirroring, retain local drafts and remote known identities |

No phase removes the IMAP hotfix. Potential cleanup of retained legacy copies after an approved rollback retention window is a separate, explicitly approved data-retention project, not part of provider activation.

## 17. Explicit acceptance criteria for each phase

| Phase | Completion gate (all required) |
| --- | --- |
| P0 | Decisions signed off; verified inventory method/provenance; unresolved counts reported; UI baseline/feature scope and benchmark hardware/effective quota established |
| P1a | IMAP defaults preserved for all existing accounts; both roots route identically; explicit capabilities with no fake IMAP identifiers; API contracts stable |
| P1b | Schema upgrade idempotent/restart-safe; existing valid rows preserved; cross-account mappings rejected; security authority/backup/restore verified; compatible rollback binary documented |
| P2 | Same Google configuration/tile/flow/scope; no token in logs/jobs; disabled API actionable; rotation/reconnect/401 and bounded rate behavior demonstrated |
| P3a | One canonical Gmail identity per account; distinct memberships without duplicate rows; label rename preserves IDs; metadata fields/count semantics accurate |
| P3b | Baseline-before-enumeration, all pages/pending IDs accounted for; history head commits only after successful projection; restart/duplicates/404 work; measured 41k run meets correctness/memory/quota gates |
| P4a | Current reader isolation/images/charset and size safeguards unchanged; cached UUID/blob bytes retained; attachments/body source failures cannot publish across generations |
| P4b | Six existing actions keep UI/feedback; Gmail flags apply across labels; archive retains custom labels, Trash never permanent deletion; notifications once per logical arrival; concurrent intents/history deterministic |
| P5a | Every existing live identity proven or blocked; cached body/blob/reference preservation verified; alias/draft/conversation/search links work; journal resumes without duplicate effects |
| P5b | Cutover receipt atomic; old writers fenced; pending/uncertain intents resolved; API-era messages/drafts/cache survive tested rollback; repeated toggles do not duplicate messages |
| P6 | No visual/functional differences outside allowed areas; non-Google and SMTP pass established regressions; all cohort migrations reversible; benchmark results published; default enablement approved only after these gates |
| P7a | Bcc recipients/privacy correct; immutable MIME/uncertain outcome preserved; known API remote ID persisted; no duplicate APPEND/Sent; legacy SMTP jobs/policy behave as approved |
| P7b | Local autosave/recovery unchanged; remote revisions/identity replacements tracked; external conflict policy proven; lost create/update/send/discard responses recover without duplicate drafts or loss |

Release must stop on any identity ambiguity, lost cache/reference, unsafe checkpoint advance, stale publisher, unapproved preference reset, unintended UI change, or failed rollback. Latency improvement alone is never an activation gate.
