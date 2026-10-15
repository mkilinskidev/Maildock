# R05 — Active identity and safe reads

2026-10-15. **PASS for R05 identity-aware public reads and retained-cache safety.**
No receiving execution or worker cutover is enabled.

Base: `35682e2bd04849f8de9986f58a7c51d1e50b306d`.
Branch: `feature/imap-sync-r05-active-reads`.

## Shared placement identity

Append-only migration `0042_receiving_active_reads.sql` reuses and corrects
`maildock_receiving_active_source`, the C1 source validator consumed by the R02
projection and R04 publication guards. It checks existing account, matching
message/mailbox ownership, selectable active mailbox, exact placement message,
mailbox, UID and epoch, UID range, current mailbox UIDVALIDITY and receiving epoch,
and equality of placement/state/account configuration bindings. No lifecycle or
credential capability from R08/R09 is assumed.

The same-message/same-UID replacement test exposed a SQL name collision in R02:
unqualified `epoch` resolved to `receiving_mailboxes.epoch`, ignoring the requested
epoch when another matching placement existed. The replacement definition uses
positional parameters throughout. The Stage 1 `receiving_current_placements` view
now delegates to this exact predicate, rather than checking the state epoch alone.

The existing `message_placement_projection` remains the public placement source.
Its optimistic Seen/Flagged and pending/executing MOVE hiding are unchanged.
Failure removes the projection against current canonical flags; it never restores
saved original flags. An account with any receiving enrollment cannot use legacy
secondary placements without their own enrollment. Entirely unenrolled fixtures
retain their applicable baseline behavior. Disabled enrolled accounts retain
valid cached reads, including All Inbox, while content/attachment requests and
message actions still require enabled accounts. Baseline All Inbox continues to
exclude disabled accounts as before.

## Public read paths and cache provenance

`maildock_receiving_visible_resource` validates the frozen original
message/mailbox/epoch/UID/configuration tuple against an active, non-hidden
projected placement. `active-identity.ts` supplies the shared Drizzle expressions.
Existing R02 content and attachment provenance columns are sufficient; no columns,
cache stores, ledgers or indexes were added.

The predicate is enforced in SQL for:

- Mailbox and unified message snippets, detail, attachment descriptor lists,
  conversation cached content, HTML reader candidates and policy reads.
- Attachment status, request, direct download and inline CID lookup. A ready blob
  cannot bypass source validation. Local staged uploads and draft/signature blob
  routes remain independent.
- New incoming draft selections, pending attachment promotion, incoming outgoing
  selections, and source message lookup for reply/forward.
- Notification-linked lookup, joined to the projection before the 50-event limit.
  This also replaces the existing per-event context queries with one joined query;
  the shared notification checkpoint and preference semantics remain intact.

Mailbox aggregation uses projected visible placements before counting. Enrolled
`messageCount`, `unseenCount` and `synchronizedMessageCount` reflect those facts,
including optimistic Seen and hidden MOVE, rather than historical server counts.
Wholly unenrolled mailbox reported-count semantics remain unchanged. An optional
`countsIncludePendingActions` mailbox response field identifies receiving counts
that already include the R02 projection. The sidebar uses those counts directly
and refreshes them after accepting an action, avoiding a second local Seen delta.
Legacy mailbox responses and client corrections retain their prior behavior.

Ready remote content is exposed only with current provenance. Non-ready content
never exposes retained plain text. A request encountering stale ready/in-flight
content returns the existing unavailable domain error instead of reporting cache
success or retargeting ready bytes. Hidden source requests are also rejected.
The physical content, search text, attachment descriptors and blobs are retained.
A future source replacement must use fenced publication; web request code gains
no ready-overwrite or in-flight-retarget authority.

## Compose and local snapshots

Preparation freezes epoch, UID and configuration in the existing source-context
JSON for enrolled accounts. The initial metadata lookup captures that identity;
the content lookup checks it again, preventing a replacement between those reads
from binding old bytes to a new reference. Supplied frozen contexts are checked
on preparation reuse, draft creation and direct outgoing source lookup. IDs alone
cannot authorize reuse of an enrolled prepared reference.

A newly created receiving-source draft derives and stores threading headers in
its existing source context after validation. Sending that durable local draft
uses its saved thread and blob snapshots independently of later source loss.
Adding new incoming resources still checks source identity. Existing local blobs
are neither deleted nor invalidated. Baseline drafts retain their prior source
validation behavior. Source-context additions are optional; route response shapes
and existing fields are preserved.

## Search and conversations

Search retains the generated `messages.search_vector` and its GIN index as a
candidate superset. Before ranking or LIMIT, it chooses the original vector only
when body provenance is eligible; otherwise it builds a header-only vector with
the existing `maildock_search_vector` function. Matching, ranking and snippets
therefore consume the same eligible body. Ineligible body-only candidates cannot
consume result slots or affect `hasMore`. Header-only search remains available
through another qualifying placement of a shared message. Original body text and
generated vectors remain stored, and R04's guarded derived-cache trigger is
unchanged.

Conversation lists/window counts/newest members and cross-folder member counts
already use the R02 projection, and now benefit from the corrected shared source
predicate. Conversation open joins content only through current frozen provenance.
Tests verify that a newer retained member cannot displace an older current member
or inflate either count. Baseline conversation behavior remains covered.

## PostgreSQL evidence and negative controls

`receiving-active-reads.integration.test.ts` uses disposable PostgreSQL 17.6,
actual migrations, an ordinary non-superuser schema owner, real application APIs,
the existing ReceivingPersistence/ReceivingPublication capabilities, immutable
local storage, and an independent postgres.js reader. R05 adds **21 cases**:

- Active lists/detail/search/conversations, counts, R04 body/blob publication and
  preparation; disabled cached reads versus rejected remote requests.
- Retained old epochs across lists, unified view, detail, search, conversations,
  counts, reader, download, CID and compose; independent SQL proves retained rows,
  ready status, blob linkage and indexed body remain present.
- Optimistic Seen counts and pending MOVE exclusion; original R02 regressions
  additionally verify failed projections preserve newly published canonical flags.
- A valid shared secondary placement preserving headers while old-source body,
  snippets and ready cache disappear; stale requests preserve the original row.
- Configuration invalidation, frozen compose reuse and the same message ID/UID
  with both old and replacement epoch placements retained.
- Copied local draft and immutable outgoing attachment use after source loss.
- Unenrolled secondary bypass, missing/nonselectable mailbox, invalid UID, and
  notification active/epoch/MOVE controls with notifications actually enabled.
- A valid ready PNG CID before replacement, rejection afterward, and restored
  access only under an explicit test-only removed-predicate control.
- Stale body ranking versus a newer equal-header message: the unsafe stored vector
  ranks the old message first, while the real endpoint correctly ranks the newer
  header hit first and generates header-only snippets.
- Fifty-five additional newer stale candidates followed by two older valid
  messages: search returns exactly two without `hasMore`, mailbox cursors return
  both, counts are two, while independent SQL sees all 58 retained placements.

Database-owner fault injection temporarily replaces the shared active-source and
resource predicates with `SELECT true`, then calls the same list/search/download
APIs. Retained messages and bytes become visible, demonstrating that the positive
safety assertions would fail without these predicates. Definitions are restored
in `finally`, and rejection is verified again. The CID control independently
removes just the resource predicate. Fixture-only DDL for shared/replacement facts
and notifications restores all guards atomically; it is not application authority
and does not implement later-stage synchronization.

## Resource efficiency

No new index, service, worker, persistent ledger or cache is introduced. Existing
mailbox/message/remote-identity indexes and the search GIN index are reused.
The existing 30,000-message search fixture verifies the actual endpoint plan uses
`messages_search_gin_idx`. The final selected read run observed about 15 ms for
rare search plus EXPLAIN and 431 ms for the common-query case; these are local
fixture observations, not a production latency guarantee.

Lists/search retain bounded application result pages; conversation members remain
one existing SQL query. Filtering and aggregation happen in PostgreSQL, without
loading a mailbox or search candidate set into application memory. Search
materializes enrollment once per account inside its query and reuses the generated
vector for eligible bodies, avoiding unnecessary vector reconstruction. The
account CTE consumes memory proportional to configured accounts; PostgreSQL still
sorts/ranks matching candidates using its ordinary query memory/spill behavior.
Common terms and many retained matching candidates can add server-side provenance
checks; no broader performance redesign is claimed.

Resource/list queries introduce no extra per-message database round trips. Compose enriches its existing
metadata query and checks the captured identity in its existing detail query. A
new source-bound draft adds one UPDATE to persist server-derived thread context.
Mailbox counts remain their existing aggregate query. Notification context lookup
falls from up to 50 separate queries to one joined batch query. The sidebar adds
one mailbox endpoint refresh after an accepted action for projected counts; this
uses the existing mailbox listing/aggregate queries and avoids retaining local
count adjustments until the retired delta engine runs.

## Validation

The final joint run passed **353/353 tests across 12 files**:

| Suite                                                | Passing cases |
| ---------------------------------------------------- | ------------: |
| R05 active reads                                     |            21 |
| R02 business intents / boundary                      |            26 |
| R04-B cache publication                              |            36 |
| R04-C bounded publication                            |            64 |
| Stage 1 safety / retirement                          |            26 |
| Global search (including actual 30,000-row GIN plan) |             8 |
| Conversations                                        |            27 |
| Attachments / MIME / draft / reader                  |            66 |
| Outgoing messages                                    |            47 |
| Message commands                                     |            16 |
| Reader API                                           |             5 |
| Compose preparation API                              |            10 |

After the sidebar compatibility adjustment, the affected R05/R02 files passed
**47/47** again, and four UI regression files passed **67/67**, including the
baseline and server-projected unread-count paths. Thus the selected 353-case run
plus UI cases covers **420 distinct passing cases** (the 47-case rerun overlaps).

The focused existing asynchronous/offline display-content regression additionally
passed **1/1**, with 15 unrelated foundation cases skipped. Application/worker
typecheck, repository lint, changed-supported-file Prettier, and working/staged
whitespace checks passed. No deadlines were increased; no Dovecot benchmark or
unrelated E2E suite ran.

Commands (all test runs use `--maxWorkers=1 --no-file-parallelism`):

```text
pnpm exec vitest run tests/receiving-active-reads.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-cache-publication.integration.test.ts tests/receiving-bounded-publication.integration.test.ts tests/receiving-safety.integration.test.ts tests/global-search.integration.test.ts tests/conversations.integration.test.ts tests/attachments.integration.test.ts tests/outgoing-messages.integration.test.ts tests/message-commands.integration.test.ts tests/email-rendering-api.test.ts tests/compose-preparation-api.test.ts --reporter=default --reporter=json --outputFile.json=<TEMP>/maildock-r05-final.json
pnpm exec vitest run tests/mail-client-unread-count.test.tsx tests/mail-interactions.test.tsx tests/mail-shell.test.tsx tests/desktop-notifications.test.tsx
pnpm exec vitest run tests/core-platform.integration.test.ts -t 'fetches display content asynchronously'
pnpm exec vitest run tests/incremental-sync.integration.test.ts
node node_modules/vitest/vitest.mjs run tests/incremental-sync.integration.test.ts -t 'resets UIDVALIDITY|polls only enabled' # accepted base archive only
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

Disposable tests used process-local Docker settings:
`DOCKER_HOST=npipe:////.\pipe\dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
Final logs and structured case results are in TEMP:
`maildock-r05-final.log`, `maildock-r05-final.json`,
`maildock-r05-baseline-content.log`, `maildock-r05-final-authority.log`,
`maildock-r05-incremental-baseline.log`, `maildock-r05-typecheck.log`,
`maildock-r05-lint.log`, `maildock-r05-ui.log`,
`maildock-r05-final-affected.log` and `maildock-r05-format.log`. The selected search
fixture also writes the actual plans to ignored `.search-results/performance.json`.
The baseline archive is retained at TEMP/
`maildock-r05-baseline-a8796acf3c2d41aa92249ca7403a2823`, with existing dependencies
linked in place; no packages were installed or modified for the comparison.

Two historical incremental-sync regression failures also reproduced once on the
accepted base archive, using the same installed dependencies:

- `resets UIDVALIDITY, removes old placements, and requests a recent rebuild`:
  expected `recentSyncStatus='pending'`, received `not_started`.
- `polls only enabled, initialized, selectable, active mailboxes`: its boss test
  double lacks `getDb().executeSql`, now used by receiving wake production.

The full incremental file passed its other 23 cases, including notification
preferences/checkpoint/deduplication. The bounded base comparison failed the same
two selected cases, with 23 skipped. These are documented baseline exceptions,
not fixed or declared passing by R05.

Development runs exposed the R02 epoch-argument bug, an outgoing `FOR SHARE`
against the nullable side of the projection (fixed by locking the message table),
and baseline disabled-account/draft compatibility differences (preserved).
New fixtures also initially used incorrect trigger names and passed a UI-only
prefill field to strict draft input; those fixtures were corrected without
weakening assertions, write guards, or deadlines.

## Remaining dependencies

R06 must own bootstrap/epoch replacement; R07 must own topology and secondary
synchronization prerequisites. R08/R09 retain full account lifecycle,
configuration rebinding/removal and credential/diagnostic admission. R11/R12 must
perform actual cache retrieval and any necessary fenced source replacement;
a stale ready row is deliberately unavailable until that authority is used.
R10/R13/R14 and worker cutover remain outside this change. No new worker
registrations or IMAP operations were added. No push, merge or PR was performed.

**Stopped after R05.**
