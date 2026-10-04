# Phase 2F - Local Drafts & Autosave

Maildock drafts are local application records in PostgreSQL. They are separate
from synchronized messages in an IMAP Drafts mailbox. Creating, saving,
restoring or discarding a draft performs no IMAP APPEND or remote draft update.
IMAP Draft synchronization is deferred.

## Persistence and restore

Forward migration `0016_natural_starfox.sql` adds `drafts` and
`draft_attachments`; historical migrations remain unchanged. A draft stores
its selected sending account, editable To/Cc/Bcc strings, subject, plain text,
compose mode, immutable source account/mailbox/message context, timestamps,
revision, active/consumed status and optional outgoing message identifier.
Source context is represented by a typed JSON object and is accepted only on
creation. Browser In-Reply-To and References fields are rejected; the existing
send service derives threading from the authoritative source message.

Use **Local drafts** in the existing sidebar to resume or explicitly discard a
draft. Closing the composer saves the draft; it does not discard it. Restoring
loads the saved body directly without running compose preparation again, so
Reply, Reply All and Forward quotes are not duplicated. Attachments preserve
selection and order. A currently unavailable sending account remains selected
on restore, and the existing send validation determines whether it can send.

## Autosave and revisions

The composer debounces changes for approximately one second, skips unchanged
snapshots and serializes saves. Changes made during the first create request
are drained into the same draft after creation. A stable client UUID makes
initial create retries safe even when its HTTP response is lost. A create retry
returns the existing record and never replaces newer content.

PATCH requires `expectedRevision`. The service locks the draft row and updates
only an active draft at that revision; revision 5 becomes 6. Stale requests,
two-tab races and saves after handoff receive HTTP 409. Source context cannot be
changed by PATCH. Draft validation accepts unfinished recipients such as `jan@`
and empty subject/body; strict recipient/header/MIME validation happens on Send.

The UI displays Saving, Saved or Save failed, offers Retry save for transport
failures, and reports conflicts without overwriting the server draft. Close the
composer and reopen from Local drafts to load the authoritative version.

A browser-local recovery snapshot protects edits in the debounce window. It is
merged into the local draft list after reload and is replayed with its saved
revision, so recovery cannot silently overwrite another tab. Page hide and
visibility changes also attempt a flush. PostgreSQL is the durable authority;
browser recovery is an additional fallback, not a remote synchronization path.
Successful saves remove the browser recovery snapshot. A conflicting recovery
copy can be explicitly discarded or the server version reopened from the list.

## Attachments and blob lifecycle

Draft attachment associations refer to existing Phase 2E blob UUIDs and retain
filename, content type and position. Staged uploads are pinned when saved;
subsequent staged expiry/removal does not invalidate that draft reference.
Cached Forward attachments reuse their existing blobs. Forward selections still
being prepared retain their incoming attachment identity and are promoted to
blob references when preparation completes or on restore/save. Reply and Reply
All do not automatically select original attachments.

Removing/discarding a draft removes associations only. It never deletes binary
objects. Blob foreign keys restrict deletion while draft/outgoing references
exist. Any future garbage collector must inspect draft attachment references in
addition to incoming, staged and outgoing references; age alone is insufficient.
Physical orphan cleanup remains deferred, as in Phase 2E.

## Draft to outgoing handoff and idempotency

`POST /api/drafts/:id/send` requires `expectedRevision` and delegates to the
existing `OutgoingMessageService.create` operation. Its existing transaction
first locks the draft row, checks revision, and loads the saved content and
attachment selection. It uses the existing account/source validation, blob
integrity checks, MIME builder and outgoing attachment snapshot model.

Once the outgoing record and frozen attachments are created, the same transaction
marks the draft consumed and associates it with that outgoing identifier.
Validation, source, attachment or MIME preparation failures roll back and leave
the draft active. A concurrent save either wins first (Send conflicts) or loses
to consumption (save conflicts). A consumed draft cannot be reactivated by PATCH
or a delayed create retry.

Repeated/concurrent Send requests and retries after a lost HTTP response return
the already-created outgoing identifier and current delivery status, regardless
of the old expected revision. They never create another outgoing record. The
existing queue repair, SMTP uncertainty handling and Sent-copy state machine
remain responsible for delivery after commit; failed or uncertain SMTP does not
reactivate the draft.

## API and limitations

Owner authentication protects every draft endpoint, and mutation endpoints use
the existing Origin/CSRF guard. Request bodies are bounded before JSON parsing.
Draft list/detail responses are private and non-cacheable.

Autosave cannot persist binary uploads that have not finished uploading. Reload
recovery retains completed attachment selections; interrupted uploads must be
attached again. Browser recovery depends on available local storage and does
not transfer between browsers or devices; successfully saved PostgreSQL drafts
do. Losing an HTTP PATCH response may lead to a safe revision conflict requiring
reopen, rather than silently retrying an overwrite. Live list synchronization
between tabs, remote draft synchronization and automatic conflict merging are
deferred.

## Verification

Focused UI, API and PostgreSQL integration tests cover debounce, unchanged
snapshots, initial-create retries, full restore, partial recipients, immutable
source/quotes, conflicts, staged and Forward blob reuse, discard, pre-send
failures, competing autosave/Send, consumed drafts, repeated/concurrent handoff
and lost Send responses. The full suite retains SMTP uncertainty and Sent-copy
regression coverage. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
