# ADR 0015: SMTP-first sending, native Gmail Sent and local drafts

- Status: proposed — awaiting P0 review, including existing Sent preference semantics
- Date: 2026-10-09
- Supersedes: original Gmail audit API-sending/cloud-draft roadmap as part of first native receiving release
- Superseded by: none

## Context

Maildock stores immutable outgoing MIME before SMTP, separates accepted delivery from Sent-copy status and never automatically resubmits uncertain sends. Local drafts/autosave/pins are independent of remote folders. Gmail stores SMTP-submitted sent messages itself; another MIME copy can duplicate Sent. The current UI also offers “Maildock saves a copy in Sent.”

## Decision

Use Gmail REST only for receiving/sync/content/actions in Phase 1. Preserve current SMTP sender, envelope/Bcc, MIME snapshots, queues, definite-failure policy and uncertainty. Local draft UUIDs/revisions/autosave/browser recovery/attachment pins are unchanged; no Gmail draft adoption/mirroring or Gmail API send.

Recommend default `server` Sent policy for Google. Native history ingestion discovers the server-created SENT message using its native identity. Do not create a synthetic received row from the outgoing row; never use IMAP APPEND, Gmail insert/import or a second MIME upload for Google.

For the existing `maildock` option, propose confirming the native Sent message and optionally adding the chosen custom user Sent label to that same message. Native SENT is server-managed and cannot be manually applied. Use existing copy states to track confirmation/custom labeling separately from delivery; missing/ambiguous observation cannot invalidate SMTP acceptance or trigger resend. A generated RFC Message-ID and bounded account/sender/time evidence can correlate the outgoing row only when unambiguous; it never merges received identities.

Generic IMAP `server`/`maildock` policy and APPEND/find-copy remain unchanged. Google API errors do not open an IMAP receiver/Sent-copy fallback. SMTP may continue independently according to existing account readiness, while receiving failures remain visible through existing diagnostics.

## Unresolved UI policy and consequences

Owner review must approve what the existing `maildock` preference means for Google: observing/labeling one native message avoids duplicates but differs from uploading an independent copy. The current wording may require an explicitly permitted Gmail-folder/API-detail explanation. Do not silently force `server`, hide/disable the preference, change global UI wording or claim the native copy can be recreated without review. This is a P0 decision gate, not permission to change UI now.

Future staging must verify native SMTP Sent, aliases/custom Sent label, delayed/multiple candidates and uncertain outcomes. Fresh reset loses local drafts/outgoing history; review uncertain work before the future operator action. API sending or cloud draft synchronization needs a separate request/ADR and is absent from this roadmap.

Details: [SMTP policy](../architecture/gmail-api-p0-fresh-install.md#smtp-sent-and-local-drafts), [roadmap](../architecture/gmail-api-p0-roadmap.md). Protocol basis: [Gmail SMTP client guidance](https://support.google.com/mail/answer/78892), [system label restrictions](https://developers.google.com/workspace/gmail/api/guides/labels).
