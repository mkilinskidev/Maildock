# Phase 3E — Desktop Notifications

Maildock delivers native browser/system notifications while an authenticated Maildock tab is open. There is no Web Push, service worker, closed-browser delivery, incoming-mail toast, or message-list comparison.

## Arrival boundary and durable publication

`DeltaSyncService.newBatch` explicitly opts into arrival publication through `MessageService.persistBatch`. Recent sync and historical backfill use the same persistence method without that option. The empty-mailbox recent-window bootstrap also excludes publication until its final UID frontier is established; normal delta batches beyond that frontier can publish.

Persistence locks the owned mailbox row and verifies successful recent sync and matching recent/delta UIDVALIDITY before publishing. An event is inserted only in the branch that actually inserts a new mailbox placement. Placement, metadata, notification event and delta UID checkpoint commit together. Existing placements, duplicate observations, flag changes, removals, failed transactions and UIDVALIDITY rebuilds produce no new notification. The mailbox lock serializes concurrent duplicate persistence. The event's unique mailbox/UIDVALIDITY/UID index additionally prevents repeating a retained arrival if a removed placement is re-observed.

Maildock command destinations are excluded using their exact destination UID/UIDVALIDITY. While a command is in progress, or when a server does not return destination UIDs, source provider ID or RFC Message-ID identifies its reconciliation result. Messages lacking either identifier use a conservative source metadata match (internal date, size, subject and From). This can suppress an indistinguishable duplicate in that destination folder. Attempted commands remain eligible for suppression after uncertain failures. Outgoing messages and Sent copies are excluded using the account-scoped outgoing RFC Message-ID or exact recorded APPEND identity. These checks also work while an operation has not yet recorded its final remote UID. Ordinary mail in the same destination still publishes.

PostgreSQL `notification_events` stores only an arrival sequence, account/mailbox/message IDs, UID/UIDVALIDITY, bounded sender display text, bounded subject and creation time. It contains no body, snippet, MIME, attachment, credential or OAuth token. Sender display text is limited to 256 characters and subject to 512. Account display names are read at consumption time. Events older than seven days are deleted during arrival publication and authenticated polling.

Migration `0024_bored_pete_wisdom.sql` adds this table and the notification preferences, sequence and checkpoint in the existing `instance_state` singleton. Generated migration metadata is included. Apply it with the normal `pnpm db:migrate` workflow before deploying the updated web and worker processes. The migration preserves existing owner authentication and mail preferences.

## Settings and browser permission

Settings > Notifications reuses the existing settings rail and preference controls. Changes save through `NotificationService` and `/api/settings/notifications`.

Defaults:

- Desktop notifications disabled until explicitly enabled.
- Inbox messages only (case-insensitive INBOX path or the Inbox special-use attribute).
- All enabled accounts selected. A null selection means all enabled accounts, including accounts enabled later; an explicit list preserves the owner's selection.
- Background-only delivery enabled.

Only enabled accounts have selection checkboxes. Disabled accounts are also filtered on the server at delivery time. Folder and account filtering is applied independently. Saving preferences advances the checkpoint, so changing filters or enabling notifications cannot replay earlier arrivals.

The enable checkbox requests browser Notification permission directly from the user gesture, only when permission is `default`. Already granted permission enables without another prompt. Denial leaves notifications disabled and explains how to change the browser's site settings. A denied permission is never automatically retried; enabling remains unavailable until the browser reports a different permission. Missing Notification API or an insecure context has an explicit unsupported state. Existing enablement can always be turned off. Browser permission is checked again at delivery, and the Settings permission display refreshes on window focus.

Native notification construction requires a supporting desktop browser and a secure context. Browser/OS delivery, focus policy and background timer throttling remain under browser control. The implementation follows the [Notification permission API](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static) and [notification click behavior](https://developer.mozilla.org/en-US/docs/Web/API/Notification/click_event).

## Consumption, deduplication and navigation

Enabled Mail and Settings views poll `/api/notifications` every ten seconds, including while the tab is hidden. Polls do not overlap. The endpoint returns at most 50 events and only the notification metadata needed by the browser.

Polling is a POST because it mutates the durable checkpoint. Both settings APIs and notification consumption require the existing owner authentication. Settings PUT and consumption POST require the existing Origin/CSRF check. Invalid payloads are rejected and polling responses use `Cache-Control: no-store`.

The owner instance shares one PostgreSQL checkpoint across tabs and browsers. Event sequence allocation and consumption serialize on the singleton row, preventing committed events from being skipped through sequence/commit reordering and ensuring simultaneous consumers cannot claim the same event. At startup, the browser establishes a baseline at the latest committed arrival. This deliberately discards mail accumulated while the tab was closed, along with any unclaimed mail before that startup; opening or reloading another tab also establishes a fresh shared baseline.

Each poll advances the checkpoint before returning its claimed batch, including excluded, disabled, removed, stale-epoch and foreground-suppressed arrivals. Consumption is **at most once**: a network failure, browser crash or unsupported native constructor after commit can lose a notification, but cannot replay it as new after refresh. This is a desktop attention feature, not a guaranteed delivery channel. The mail itself remains available through normal synchronization. Batches preserve their remaining checkpoint range. Events older than two minutes are consumed without displaying a burst after a long browser suspension.

The browser also guards duplicate IDs within and across polling responses and uses an event-specific native notification tag. Background-only mode suppresses display exactly when the tab is both visible and focused. Suppression consumes the arrival; losing focus later does not replay it. No polling path requests permission.

The notification title is the sender's display name, falling back to their address or Unknown sender. Its primary text is the subject, with account display name on a secondary line where the OS displays it. No message content is included.

Click prevents the browser's default click action, requests focus for the existing window, opens the event's account/mailbox/message and closes the notification. Mail view uses its existing navigation and detail-loading paths, clearing All Inboxes/search/drafts/selection context and leaving Compose presentation. Conversation mode opens the actual placement. Settings navigates the same tab to a validated account/mailbox/message URL on the home page. No `window.open` or new-tab flow is used. Normal message APIs remain authoritative for ownership and message availability. Unmount stops polling and closes notifications owned by that component.

## Verification

Focused PostgreSQL tests cover normal delta inserts, recent/backfill exclusion, empty bootstrap, pre-recent and epoch guards, duplicate persistence, rollback, flag/removal exclusion, known and uncertain command destinations, outgoing suppression, Inbox/all-folder filtering, selected and disabled accounts, identical UIDs across accounts, durable checkpoints, simultaneous consumers, startup baselines, bounded batches, stale/removed placements and retention.

Browser-component tests cover granted/default/denied/unsupported permissions, explicit enablement, no repeated denial requests, default settings, folder/account/background preferences, visible/focused suppression, consumption without foreground replay, response deduplication, reload baselines, overlapping-request prevention, unmount cancellation, content privacy and same-window clicks. Actual MailClient tests verify notification navigation from All Inboxes in both flat and conversation modes and explicit placement navigation from Settings. Real-session security integration exercises authentication, cross-origin and missing-Origin denial for the new APIs, valid owner requests and input validation.

Existing mail-interaction assertions were updated to locate the existing icon toolbar by accessible labels rather than obsolete visible button text. Product toolbar behavior was not changed.

Completed checks:

- `pnpm test`: 63 files / 713 tests passed.
- `pnpm test:security`: 2 files / 36 tests passed.
- `pnpm test:security:browser`: passed, including reader isolation and Compose/signature security.
- `pnpm typecheck`: application and worker passed.
- `pnpm lint`: no errors; the existing unused `writeFile` warning remains in ignored `.security-results/signature-settings-preview.mjs`.
- `pnpm build`: Next application and worker passed with a process-only HTTPS `APP_ORIGIN` override; local configuration was not modified.
- Changed source/test/document formatting and `git diff --check`: passed.

External live IMAP/SMTP and OS notification delivery were not exercised; provider, PostgreSQL and browser-component fixtures verify the implementation boundaries. Test/security/build logs remain in ignored `.phase3e-*.log` files.
