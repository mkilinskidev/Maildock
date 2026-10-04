# Phase 3A — Mail Shell & Multi-Account Navigation

Implemented from Phase 2K HEAD `55fd6f5`.

## Mail shell and navigation

The global mail header contains **New message**, the existing global search, and theme controls. New message invokes the existing composer with its existing account, draft, signature and sending behavior. Settings and Sign out remain in the sidebar footer, outside the scrollable mailbox tree.

`MailboxTree` replaces the account selector. Every configured account has an independent collapse control, an email identity and a disabled indicator when appropriate. Favorites contains All Inboxes and the existing global Local drafts view. Selecting a physical mailbox atomically updates the account/mailbox context and resets list pagination, stale requests and reader selection. Selection highlights both the mailbox and its account; collapsing the account preserves selection. Search temporarily suppresses mailbox selection highlights and remains global and flat.

System mailboxes appear in this order: Inbox, Sent, Drafts, Archive, Junk, Trash. Sent/Drafts/Archive/Junk/Trash come from available semantic role mappings, including manual mappings with localized folder names. Maildock's existing role model does not define an Inbox role: Inbox uses the IMAP protocol-reserved, case-insensitive `INBOX` path. No other English folder names are inferred. Repeated mappings do not create duplicate navigation entries.

Other folders starts collapsed and can be expanded independently for each account. Its tree follows the server-provided IMAP delimiter, including nonselectable container mailboxes and synthetic ancestors where a server omits parent records. A null delimiter keeps a path flat. Children of a system mailbox retain their full ancestry under Other folders. The selected Other folders branch remains highlighted when collapsed. Missing folders are omitted.

The existing reported unread counts and optimistic read/unread adjustments are reused. Mailbox metadata now polls all configured accounts with independent failure handling. All Inboxes displays a combined reported unread count only when every participating Inbox has a known count; this may differ from the number of locally synchronized messages.

## All Inboxes

The authenticated, non-cacheable `GET /api/mail/all-inboxes` endpoint calls `MessageService.listAllInboxes`. This is a local PostgreSQL query over existing messages and mailbox placements. It includes only enabled accounts and active, selectable protocol Inbox mailboxes, excludes action-hidden placements, and carries the original account ID, mailbox ID and message ID. No messages are copied, no schema migration is needed, and no live IMAP search is performed.

Results use descending internal date/message ID ordering and bounded keyset pagination. Cached ready plain text supplies optional snippets; the query never fetches content to make snippets. Normal flat mailbox lists also reuse cached plain text for previews.

When conversation mode is enabled, the existing `ConversationService.list` accepts an All Inboxes scope. Conversation partitions include account identity, and expansion uses each representative's actual source account and preferred Inbox placement. Expanded members can still reside in another mailbox of that same account. Search remains an individual-message list regardless of conversation mode.

`MailClient` resolves reader/action context from the selected source placement. The existing MessageReader, content/render/attachment endpoints, queued actions, semantic move availability and compose preparation handle read/unread, flag/unflag, archive, trash, Reply, Reply All and Forward. Optimistic selection after a move also resolves the next message's source account. All Inboxes relies on existing background synchronization and local list polling; its mailbox-specific manual Sync control is disabled.

## Dates and list layout

The shared `messageDate` helper uses the browser's locale and local calendar/timezone. Today's messages show a time, other dates in the current calendar year omit the year, and dates in another calendar year include it. Every message-row date and search-result date has a full local date/time title. No month names or locale are hardcoded.

Message rows emphasize sender and readable subject, render available cached snippets as secondary text, align dates consistently, and keep unread, flag and attachment indicators. All Inboxes adds source-account context. Selection uses a stronger tinted background and accent edge, with a subtle hover state.

The desktop three-pane grid uses a bounded flexible sidebar and flexible message/reader columns. Below its practical minimum width of 880px, horizontal overflow preserves the three panes. No stacked mobile mail layout, Settings redesign, MessageReader redesign, Compose redesign or multi-select/action-toolbar redesign is introduced.

## Verification

Focused tests cover simultaneous accounts, independent collapse/expand, all semantic role ordering, nested/container/delimiter behavior, selection, source-aware All Inboxes reader/actions/compose preparation, conversation expansion, date/calendar/locale boundaries, authenticated pagination and sanitized API errors. PostgreSQL integration covers multiple accounts in both list modes, account isolation, enabled-account filtering, excluded Sent/hidden placements and keyset pagination. Existing search, composer, unread count, conversations and security regressions run with the full suite.

- `pnpm test`: **55 files / 608 tests passed**, including PostgreSQL integration and security tests.
- `pnpm test:security`: **2 files / 35 tests passed**.
- `pnpm test:security:browser`: passed on isolated rerun, with zero third-party Compose requests and zero editor errors. The first run timed out in the existing Compose link-selection check; no security harness code was changed.
- `pnpm typecheck`, `pnpm lint`, production application/worker `pnpm build`, targeted Prettier checks and `git diff --check`: passed. Lint reports one existing unused-import warning in the ignored `.security-results/signature-settings-preview.mjs` helper.
- Actual MailClient browser preview at 1440×900 and 1000×760: three panes and accessible fixed sidebar footer, with zero browser runtime errors. Preview screenshots are in the ignored `.security-results/mail-shell-desktop.png` and `.security-results/mail-shell-narrow.png` files.

The build used a process-only HTTPS `APP_ORIGIN` override; local configuration was not edited. Validation used local browser fixtures and PostgreSQL containers, not live provider delivery. Narrower windows retain the deliberate 880px desktop minimum width and horizontal overflow.
