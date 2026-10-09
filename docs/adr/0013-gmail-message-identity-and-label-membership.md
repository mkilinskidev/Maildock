# ADR 0013: Native Gmail identity and label memberships in shared tables

- Status: proposed — awaiting P0 review
- Date: 2026-10-09
- Supersedes: original Gmail audit legacy identity bridge, aliases, canonicalization journal and dedicated identity-table recommendation
- Superseded by: none

## Context

`messages` already has a local UUID and text `provider_message_id`; `mailbox_messages` already represents placements but requires IMAP UIDs. A fresh database removes any need to merge historical Gmail UUIDs or prove old identifier provenance. Gmail represents one message with multiple labels; thread label unions are not per-message membership.

## Decision

Reuse shared tables. Enforce one Gmail message per `(account_id,provider_message_id)` with a Gmail-only partial unique index; keep IMAP provider-ID semantics unchanged. Generate/return the same local UUID on retries/conflicts. Store Gmail native message/thread/label/history IDs as text, never IMAP UIDs or unsafe numbers. RFC Message-ID does not establish remote uniqueness.

Reuse mailbox rows keyed by native label ID and membership rows unique on `(mailbox_id,message_id)` for Gmail. Add transport discriminators, conditional NULL/required locator constraints and composite ownership/transport FKs. Keep real positive UID/UIDVALIDITY and current remote placement uniqueness for IMAP. No Gmail identity table or second message store is required.

Gmail read/star state is global per message and is projected atomically into each current membership for existing DTOs. Label removal affects membership, not cached message/body/blob identity. Native remote absence is tombstoned without breaking pinned local references. Existing content/attachments/blobs/search/conversations/drafts/outgoing tables remain authoritative.

Inbox projects to existing `INBOX`; system/user labels become folder views. All Mail is a synthetic view excluding Spam/Trash, with no invented remote label. Recommend excluding remote DRAFT records from ordinary views while accounting for their IDs in sync; local Drafts is unchanged. Gmail thread ID is supplemental; current RFC grouping and preference remain.

Archive removes INBOX while preserving labels; a reviewed custom user archive mapping may add that label. Native Trash remains native Trash. Counters distinguish complete remote label totals from partially loaded local messages. Stable mailbox UUIDs survive label rename. Proposed locator changes also cover attachments, commands and notification uniqueness.

## Consequences and review gates

UUID stability applies within one installation and native recovery, not across the future reset. Fresh setup intentionally invalidates former local links/state. No UUID aliasing, IMAP ID conversion, old record deduplication or cache bridging is implemented. Upserts prevent duplication in the **new** native store only.

P0 review must settle remote DRAFT presentation and manual role mapping restrictions. Future DDL must preserve shipped migration hashes and include security authority and native restore compatibility, not just ORM columns.

Details: [database proposal](../architecture/gmail-api-p0-database-design.md). Protocol basis: [message schema](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages), [label semantics](https://developers.google.com/workspace/gmail/api/guides/labels).
