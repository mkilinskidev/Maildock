# Phase 3D — Mail Interactions

Implemented from HEAD `7572f6280daa6ad711789cc510e39c1ce66295ae`.

## Automatic read preference

Settings > Mail presents **Immediately**, **After [N] seconds**, and **Never automatically** as native radio choices. The compact inline seconds input is enabled only for After. The default is **After 2 seconds**; delays accept whole seconds from 1 to 3600. Changes save automatically: choices save immediately, while valid delay edits save after a 400 ms typing pause or on blur. Invalid delays remain visible without a persistence request. Conversation view and auto-read appear as sibling sections with matching headings, descriptions and spacing. The existing persisted modes (`immediately`, `after`, `manually`) remain unchanged. Automatic saving persists the value through the owner-protected, Origin-checked `/api/settings/auto-read` endpoint and `MailPreferencesService`, using the existing `instance_state` singleton. Migration `0023_exotic_menace.sql` adds the defaulted JSON setting; it preserves conversation, authentication and other existing settings. Apply it using the normal application migration process before running the updated application.

Opening an unread message schedules the existing `mark_read` action. Changing the opened message, mailbox, view, Compose state or preference cancels the timer. Unmount also cancels it. Already-read messages are skipped, and an opened message is attempted once per opening rather than repeatedly on metadata polls or after a failure. Auto-read does not produce user-action success feedback; its command failures remain visible.

The opened detail is the authoritative read/flag state when available. Conversation actions use the actual opened member and its placement, including members in Sent or other folders. Search uses the result's account/mailbox context; All Inboxes uses each source placement. Search querying, pagination and preparation remain on their existing paths.

## Selection and shared message actions

Row checkboxes appear on hover or keyboard focus in normal mailboxes and All Inboxes. Once any message is checked, selection mode keeps all row checkboxes visible; clearing selection returns to the clean list. Checkbox space stays reserved, preserving text alignment and the existing unread indicator. A compact **Select all loaded messages** checkbox beside Refresh in the list header selects the messages already loaded into the list, including loaded pagination; it does not fetch or select an entire remote mailbox. Conversation groups expose selection on loaded member rows, never on their aggregate representative. Collapsed groups do not add hidden members to Select all.

Each selected target stores its message ID, account ID, mailbox ID and original read/flag state. Selection is cleared when the account/mailbox, All Inboxes, search/drafts view or conversation presentation changes. Opening a message does not discard checkbox selection.

Bulk Mark read, Mark unread, Archive and Delete all call the same `act` handler used by individual actions and automatic read. That handler projects local state, submits one existing durable message command for each explicit placement, and tracks command status. It does not invoke a provider directly or introduce a bulk mutation endpoint. Same-placement pending actions are guarded. Archive/Delete require the existing source account's MOVE capability and available destination role mapping; a mixed selection disables a move unless every target supports it. Delete means the existing move-to-Trash action, with no new permanent-delete behavior.

An enqueue failure rolls back only its target. Remote failures restore the failed target's read/flag state or removed row, refresh the existing list/detail/search reconciliation paths, and remove its count adjustment. Other successful or pending commands retain their state. Loaded pagination survives first-page reconciliation. Status requests are separated by account and chunked to the existing 50-command API limit. Terminal commands are processed once, and existing unread-count adjustments remain until delta synchronization catches up. Server command validation and mailbox-scoped UID/UIDVALIDITY semantics are unchanged.

## Toolbar and feedback

One shared `MailToolbar` sits above the reader header/content in the detail pane and remains stable while the body scrolls. An opened message shows the original compact Reply, Reply all, Forward, Archive, Trash, read/unread and flag/unflag icons with their existing tooltips and accessible labels. A separator groups reply actions apart from message management. Checkbox selection switches it to the selected count and compact Mark read, Mark unread, Archive and Trash icons. There is no More menu. Reply/forward call the existing preparation implementation; Compose and sending use their existing paths.

User actions show a dismissible status after command completion, such as **Message archived** or **4 messages marked as unread**. Enqueue acceptance alone does not claim success. Mixed results report the confirmed success count and failure count. Failures also have a persistent action error that ordinary list refresh cannot erase. Undo is not included.

The existing empty-account prompt now links to `/accounts?add=1`, completing the established Phase 3C onboarding entry point already expected by its regression test.

## Keyboard shortcuts

- C opens Compose using the existing account availability rule.
- R, A and F prepare Reply, Reply all and Forward for the opened message when no checkbox selection is active.
- Delete moves eligible selected messages, or the opened message, to Trash.
- Ctrl/Cmd+Enter submits the existing Compose form.

All shortcuts respect already-handled events, repeats, IME composition, editing targets and unexpected modifier combinations. Inputs, textareas, selects, contenteditable descendants and Lexical editors are guarded, including Ctrl/Cmd+Enter. Send therefore works from a non-editing focused element in Compose, such as its Send button. Browser Ctrl/Cmd shortcuts otherwise retain their normal behavior.

## Verification

Focused coverage includes default/immediate/custom/manual auto-read, timer cancellation and read-state guards, stale list versus opened detail, conversation member placement, search and All Inboxes context, bulk read/unread/Archive/Trash, partial enqueue and remote failures, selection lifecycle, toolbar/preparation behavior, keyboard typing/modifier guards, Send submission and status batching. API tests exercise preference validation and owner/Origin denial. PostgreSQL integration verifies persistence and coexistence with existing singleton settings. Existing reply/forward tests explicitly choose manual read mode to isolate preparation from auto-read.

Final checks:

- `pnpm test`: **62 files / 687 tests passed**.
- `pnpm test:security`: **2 files / 35 tests passed**.
- `pnpm test:security:browser`: passed, including reader isolation, zero third-party Compose requests and no editor errors. The first run timed out at the existing Compose DOM text-selection assertion while other checks were running; the unchanged harness passed on retry.
- `pnpm typecheck`: application and worker passed.
- `pnpm lint`: passed with the pre-existing unused `writeFile` import warning in ignored `.security-results/signature-settings-preview.mjs`.
- `pnpm build`: application and worker passed. Build used a process-only HTTPS `APP_ORIGIN` override; local configuration was not edited.
- Changed TypeScript/TSX/CSS/Markdown Prettier checks and `git diff --check`: passed.
- Actual-component browser layout and All Inboxes bulk fixture: passed with no runtime errors. The refinement fixture also checks hover/keyboard-focus visibility, selection-mode entry/exit, unchanged sender alignment and unread indicators, compact header select-all, native radio/inline-input sizing, automatic saves and validation.

Browser screenshots and the actual-component layout fixture are under ignored `.security-results/phase3d-*`. The fixtures check light/dark Mail and Settings layouts at 1440, 1000 and 600 pixels, stable toolbar placement, matching preference-section headings, bulk command account context and no runtime errors. The existing minimum-width three-pane layout and its intentional horizontal overflow below 880 pixels are preserved.

No avatars, notification system, logging, OAuth, branding, Compose toolbar responsiveness, or overall mail layout redesign was introduced. Live external IMAP/SMTP operations were not exercised; provider and PostgreSQL integration fixtures cover the durable architecture.
