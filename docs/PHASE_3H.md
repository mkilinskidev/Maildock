# Phase 3H - Final UX and Branding

Implemented as targeted polish of the Phase 3 components. All changes remain
uncommitted. No commit, amendment, push, live deployment or live account mutation
was performed.

## Changes

- Compose and signature formatting controls share logical groups and a compact
  overflow disclosure below a 750px editor-container width. Common formatting,
  links and signature insertion remain available in the main toolbar. Commands,
  the stable Lexical editor, selection handling and undo history are preserved.
- Font size reflects the selection, including mixed/custom values. Color reflects
  supported hex/RGB selection values; mixed/custom colors have an explicit label.
  Active formatting uses the current theme's foreground token.
- Compose has tighter fields, one outer scrolling flow for its growing body, a
  sticky footer with wrapping actions, a save-and-close tooltip, and explanations
  for sending prerequisites. Cc/Bcc remain visible.
- One MaildockBrand component reuses the envelope and accent tile on login, setup,
  Mail and Settings. A matching SVG favicon uses the existing light-theme accent.
  Page titles identify Mail, Settings, Sign in and Setup.
- Maildock drafts replace Local drafts throughout user-facing copy. The workspace
  explains that drafts are saved in Maildock and are not synced to the provider.
  Provider Drafts retain their remote names, have a Provider badge, and explain
  their read-only relationship to the provider's editor.
- The draft list has loading, retry and non-overlapping empty/error states,
  account context from the existing list response, and explicit recovery-copy
  wording. Reopening a conflicted saved draft handles fetch failures. Persistence,
  revisions, browser backups, conflict checks, discard and send rules are preserved.
- Entering Maildock drafts clears the inactive mail selection and avoids rendering
  an unrelated message; an active composition stays intact.
- Reader errors are separate from list errors and have a reader-local Retry.
  Empty mail views use existing account/sync evidence. Sync requests always clear
  pending state after request/follow-up failures and identify a request as a request,
  rather than claiming that synchronization has completed. Existing sync jobs and
  normal polling remain unchanged.
- Diagnostics distinguishes receiving-mail evidence from explicit manual tests.
  An untested account reads Manual connection test: Not run even when sync has
  succeeded. IMAP sync does not imply SMTP health. Friendly summaries preserve
  raw states in expandable details, and mailbox timestamps choose the latest
  successful recent/delta sync consistently.
- Notifications has a stable Saving / Changes saved area, transient success and
  distinct accessible error feedback. Search and HTML display have direct Retry;
  signatures and OAuth configuration have explicit loading/retry states.
- Message actions use the same flag symbol as list rows. Search rows align unread,
  flag and attachment indicators with ordinary rows. Attachment actions consistently
  say Download, Downloading or Retry download.
- Login/setup/logout release pending controls on network or response failures and
  announce errors. Setup exposes its existing username/password length requirements.

## Validation

- Full existing suite: 71 files, 823 tests passed.
- Security suite: 2 files, 39 tests passed.
- Chromium-based browser security harness: passed using installed Microsoft Edge,
  including untrusted email isolation, rich Compose and signature coverage.
- Web and worker typecheck: passed.
- Lint: no errors; the existing unused-writeFile warning in the ignored
  signature-settings-preview.mjs helper remains.
- Local production web build and worker compilation: passed. APP_ORIGIN was
  overridden to HTTPS only for the build process; .env was not changed.
- Linux Docker production image: passed, tagged maildock:phase3h-validation.
  Live application containers and volumes were not changed.
- Browser fixtures mounted actual components with synthetic APIs and compiled
  production CSS. Compose checked at 1440x900, 1366x768, 1280x800, 1000x760 and
  880x700 in light/dark themes. Overflow controls, footer fit, draft-reader clearing,
  reader Retry and both sync-request failure stages passed. At 1366 and 1280 the
  collapsed toolbar is 49px high; at 1000 and 880 its grouped layout is 85px.
  The intentional horizontal overflow below 880px was preserved.
- Signature editor checked at 1440, 1366, 1000 and 880 widths, including overflow
  and selected size/color reflection. Diagnostics checked successful sync with no
  manual test. Existing Settings fixture checked General, IMAP, Diagnostics, OAuth,
  light/dark layouts, dirty navigation and remote-image controls.
- Login/setup network and malformed error-response recovery, and logout network
  recovery, passed in browser fixtures without runtime exceptions.
- Changed-file Prettier check and git diff --check: passed. The additional
  repository-wide pnpm format:check reports 21 unchanged, pre-existing files:
  migration metadata, docs/IMAP_CONDITIONAL_STORE.md, docs/PHASE_2K.md and
  src/components/account-connection-fields.tsx. These were not reformatted in
  this UX phase.
- Existing test changes only replace three expectations/click labels for the
  authorized Maildock drafts terminology. No new unit or integration tests.
- Browser helpers, screenshots and validation logs are under ignored
  .security-results/phase3h-* and are not repository deliverables.

## Intentionally deferred audit items

- Optional Cc/Bcc disclosure: spacing and footer changes resolve the primary laptop
  problem while preserving current field visibility and keyboard order.
- Replacing native link/image/description prompts and settings confirmations with
  custom dialogs: requires additional focus/selection and navigation safeguards;
  the existing interactions remain in this narrow polish phase.
- New draft-discard confirmation/undo: the existing explicit discard flow remains
  unchanged to preserve draft lifecycle behavior. Accidental discard remains a
  small V1 UX concern.
- Exhaustive disabled-action explanations: Send prerequisites are explained;
  Archive/Trash still use existing eligibility rules and tooltips. Distinguishing
  every capability, destination and account-state cause is deferred.
- Broad unification of all status components and conversation-header metadata:
  targeted feedback/row fixes are included; existing conversation structure and
  unrelated preference saving semantics remain intact.

## Remaining release verification

The automated/browser fixtures do not establish live Gmail/Microsoft/manual IMAP
connectivity, SMTP delivery, notification permission UX across every browser, or
provider-specific draft rendering. Existing live provider smoke checks remain
part of release-candidate verification. Native prompts and immediate draft discard
are the intentionally retained product rough edges. No new validation failure
remains; the repository-wide formatting check reports the pre-existing debt above.

## Files changed

- [src/app/accounts/page.tsx](D:/Projects/JS/Maildock/src/app/accounts/page.tsx)
- [src/app/layout.tsx](D:/Projects/JS/Maildock/src/app/layout.tsx)
- [src/app/login/page.tsx](D:/Projects/JS/Maildock/src/app/login/page.tsx)
- [src/app/page.tsx](D:/Projects/JS/Maildock/src/app/page.tsx)
- [src/app/setup/page.tsx](D:/Projects/JS/Maildock/src/app/setup/page.tsx)
- [src/app/styles.css](D:/Projects/JS/Maildock/src/app/styles.css)
- [src/components/account-settings.tsx](D:/Projects/JS/Maildock/src/components/account-settings.tsx)
- [src/components/attachment-list.tsx](D:/Projects/JS/Maildock/src/components/attachment-list.tsx)
- [src/components/draft-list.tsx](D:/Projects/JS/Maildock/src/components/draft-list.tsx)
- [src/components/global-search-results.tsx](D:/Projects/JS/Maildock/src/components/global-search-results.tsx)
- [src/components/login-form.tsx](D:/Projects/JS/Maildock/src/components/login-form.tsx)
- [src/components/logout-button.tsx](D:/Projects/JS/Maildock/src/components/logout-button.tsx)
- [src/components/mail-client.tsx](D:/Projects/JS/Maildock/src/components/mail-client.tsx)
- [src/components/mail-composer.tsx](D:/Projects/JS/Maildock/src/components/mail-composer.tsx)
- [src/components/mail-toolbar.tsx](D:/Projects/JS/Maildock/src/components/mail-toolbar.tsx)
- [src/components/mailbox-tree.tsx](D:/Projects/JS/Maildock/src/components/mailbox-tree.tsx)
- [src/components/message-reader.tsx](D:/Projects/JS/Maildock/src/components/message-reader.tsx)
- [src/components/notification-settings.tsx](D:/Projects/JS/Maildock/src/components/notification-settings.tsx)
- [src/components/oauth-provider-settings.tsx](D:/Projects/JS/Maildock/src/components/oauth-provider-settings.tsx)
- [src/components/rich-composer.tsx](D:/Projects/JS/Maildock/src/components/rich-composer.tsx)
- [src/components/rich-email-body.tsx](D:/Projects/JS/Maildock/src/components/rich-email-body.tsx)
- [src/components/settings-shell.tsx](D:/Projects/JS/Maildock/src/components/settings-shell.tsx)
- [src/components/setup-form.tsx](D:/Projects/JS/Maildock/src/components/setup-form.tsx)
- [src/components/signature-settings.tsx](D:/Projects/JS/Maildock/src/components/signature-settings.tsx)
- [src/modules/mail/domain/draft.ts](D:/Projects/JS/Maildock/src/modules/mail/domain/draft.ts)
- [tests/mail-composer.test.tsx](D:/Projects/JS/Maildock/tests/mail-composer.test.tsx)
- [tests/mail-interactions.test.tsx](D:/Projects/JS/Maildock/tests/mail-interactions.test.tsx)
- [src/app/icon.svg](D:/Projects/JS/Maildock/src/app/icon.svg)
- [src/components/maildock-brand.tsx](D:/Projects/JS/Maildock/src/components/maildock-brand.tsx)
- [docs/PHASE_3H.md](D:/Projects/JS/Maildock/docs/PHASE_3H.md)
