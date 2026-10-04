# Phase 2G — Conversation model and optional view

Conversation relationships are always maintained. **Conversation view defaults
to Off**, preserving the classic message list, sorting, pagination and reader.
The single-owner setting can be changed with the Conversation view checkbox on the Accounts settings page. It is
stored in `instance_state.conversation_view`; changing it never rethreads mail.
No new users, tenants, queues or infrastructure services are introduced.

## Identity and evidence

Conversation IDs are local UUIDs. Membership belongs to a Maildock account, not
to an IMAP mailbox or UID. Message content remains in the existing `messages`
and `message_contents` tables, and mailbox placement remains in
`mailbox_messages`. One membership row is permitted per local message.

Matching uses case-preserving bracketed Message-ID tokens from Message-ID,
In-Reply-To and References. Tokens require an `@`, contain no whitespace, and
are limited to 254 bytes; normalization examines at most 65,536 header characters.
Malformed/missing IDs safely leave standalone messages unless other valid
threading evidence exists. IDs are compared exactly; ambiguous duplicate
Message-IDs do not identify or deduplicate a message. Two messages with only
the same Message-ID remain separate. A reference resolves an existing parent
only when its ID identifies exactly one local message in that account.

An explicit reference to a known parent connects its conversation. Shared
reference chains also connect messages before their ancestors have synchronized.
Subject equality, Re:/Fwd: prefixes, participants, time proximity and provider
thread IDs are never used. Composite foreign keys enforce account ownership of
memberships, conversations and redirects in addition to account-scoped queries.

## Migration and incremental reconciliation

Forward migration `0017_conversations.sql` adds `conversations`,
`conversation_members`, `conversation_references`, indexes, the setting, and
PostgreSQL reconciliation functions and a message trigger. Existing headers are
seeded before existing messages are reconciled, including messages stored before
Phase 2G. No historical migration is rewritten or remote resync required. The
generated Drizzle snapshot describes the new schema; the custom SQL functions
and trigger live in the migration.

The trigger runs transactionally for message insertion and actual changes to
threading headers. Consequently the shared persistence path covers recent sync,
delta sync and historical backfill, irrespective of the view setting. Flags,
body downloads and mailbox moves do not change membership. There is no React
threading implementation or second outgoing-mail threading implementation.

Reference nodes retain unresolved ancestor IDs in an indexed account/header
registry. A later parent connects to that registry without rescanning mailboxes.
Ordinary insertion queries only its normalized IDs and existing candidates.
Merging updates only affected memberships/reference nodes. Account-scoped
transaction advisory locks serialize concurrent mailbox workers; all updates
roll back with message persistence if reconciliation fails.

Every newly discovered message starts with a local conversation UUID equal to
its local message UUID. When evidence joins groups, the lexicographically
smallest UUID survives. Losing IDs remain as redirects; redirects to a losing
group are flattened to the survivor. Messages and placements are never copied.
Reconciliation is idempotent, and arrival order does not change final membership.

Late Message-ID collisions invalidate previously unique parent evidence. Only
the affected components are rebuilt from retained headers, with ambiguous
parents excluded. Actual header changes similarly retract stale links. These
exceptional repairs may split a component and reactivate its original local
IDs. Ordinary synchronization with unchanged headers does not rebuild it.

## Outgoing mail

Existing Phase 2D Message-ID generation and Reply/Reply All In-Reply-To and
References derivation are unchanged. A synchronized Sent message, an external
Gmail/Outlook reply and a later synchronized Sent reply naturally connect through
those headers. Maildock-managed and server-managed Sent copies enter the model
through the existing synchronization path. Outgoing records awaiting a local
Sent copy are not additional displayed messages; an incoming reply can retain
their unresolved Message-ID until the Sent copy arrives.

Forward continues to use the existing Phase 2D behavior: no inherited reply
headers. Forwarded subject/body content has no influence on membership.

## Optional presentation and mailbox semantics

The middle list pane selects between `FlatMessageList` (Off) and
`ConversationMessageList` (On). Both reuse `MessageRow` and select one specific
message for the same `MessageReader` in the right pane. The right pane contains
no conversation history, conversation reader or diagnostic selection controls.

Off uses the existing message query and keyset cursor. On uses a PostgreSQL
window query over visible placements in the selected mailbox, choosing the
newest message by internal date/local UUID for each conversation. Mailbox
membership and unread state remain scoped to that mailbox; a Sent-only
conversation never appears in Inbox. Headers display the normalized subject,
account-level message count, mailbox unread indicator and expansion chevron.
Subject normalization removes Re:/Fw:/Fwd: prefixes for display only; it has no
influence on membership. Keyset pagination operates on representative messages,
without OFFSET or downloading an entire mailbox to the browser.

Conversation headers expand/collapse without selecting a message. Expanding a
group fetches its complete account-level member metadata in one SQL query,
ordered by sent date (falling back to internal date), then local UUID. The
`metadataOnly=true` endpoint avoids retrieving cached body content. Expanded
groups refresh while visible, and collapsing cancels their outstanding request.
Children show sender, subject, timestamp, unread dot and selected highlight;
messages in Sent and other mailboxes are included. If a message has multiple
placements, the selected list mailbox is preferred when available. Unavailable
placements have disabled children. Clicking a child opens exactly that message
in the existing reader, with its secure HTML policy, attachments and lazy body
fetch. No body content is rendered by either list component.

The selected message and its mailbox placement determine the detail, content,
Reply, Reply All, Forward, Read/Unread, Flag, Archive and Trash endpoints. A row's
aggregate unread state is not used as the selected message's read state once its
detail has loaded. No whole-conversation actions are introduced. Grouped actions
wait for the existing command result and reload affected display data; classic
optimistic action behavior remains unchanged.

Both new API endpoints use existing owner access checks; changing settings also
uses existing same-origin mutation protection. Account boundaries are checked
when opening history, including redirects.

## Verification

Focused PostgreSQL tests cover cross-provider standard headers and outgoing
reply derivation, Sent/Inbox membership, account isolation, subject-only splits,
missing/duplicate IDs, all six A/B/C synchronization orders, historical
checkpoint persistence, late collisions, safe group merging, redirect lookup,
repeated reconciliation, Forward, settings defaults/persistence, classic and
grouped lists, mailbox counts/unread, chronological full history, pagination,
placement changes, populated Phase 2F migration and concurrent workers.

UI tests cover the two list modes, expansion/collapse, chronological children,
selected/unread state, Inbox/Sent context, exact message selection, all existing
reader actions, absence of a conversation reader, presentation switching and
setting persistence requests. Metadata tests verify body omission and preferred
mailbox placements. Existing Phase 0–2F tests remain part of the full suite.

Required checks: `pnpm lint`, `pnpm typecheck` (web and worker), `pnpm test`,
and `pnpm build` (Next.js production build and worker compilation).

Verified on October 4, 2026 with Node.js 24.19.0: lint, both typechecks, all
445 tests across 41 files, and the web/worker production build passed. Drizzle
generation reports no schema drift. Migrations were exercised in isolated
PostgreSQL 18.6 test containers, including a populated Phase 2F upgrade; the
application database was not migrated by this implementation session. Apply
the forward migration with `pnpm db:migrate` before starting the updated app.

## Known limitations

- No subject heuristics or provider-specific optimizations; mail without usable
  preserved headers can remain split. Ambiguous IDs deliberately leave parents
  split. Identical copies stored as separate local messages remain separate
  message records under existing Maildock identity rules.
- A large merge or exceptional component repair costs work proportional to that
  component. The account advisory lock serializes threading writes across its
  mailboxes; there is no full-account scan during ordinary incremental insertion.
  Initial migration processes all existing messages once.
- Grouped queries rank the relevant local mailbox rows. Indexes bound mailbox
  access, but there is no precomputed per-mailbox conversation summary table.
- Expansion returns all local member metadata for that conversation. Groups
  start collapsed; bodies are fetched only through the existing selected-message
  reader. No conversation-wide bulk actions or bulk body download is implemented.
- Pagination remains a live keyset list: newly synchronized mail or merges can
  move a representative between pages. Settings changes in another browser tab
  are reflected in its UI after a page reload.
- Chronology depends on stored email timestamps. Only locally synchronized mail
  is available; unresolved ancestors remain reference nodes until discovered.
