# Phase 2E — Attachments

Phase 2E extends the Phase 1D content path and Phase 2C/2D outgoing pipeline. Remote incoming mail remains authoritative. Opening a message discovers attachment metadata, not binary payloads. All new outgoing messages have a complete immutable MIME blob before becoming queued. SMTP and optional Sent-copy APPEND use exactly the same verified bytes.

## Persistent storage and backups

`attachments_data` is now authoritative persistent application data.

A PostgreSQL backup alone is no longer a complete Maildock backup. Back up PostgreSQL, the existing `attachments_data` Docker volume, and the credential encryption master key/deployment secrets. Quiesce the app and worker for a consistent database/volume backup and restore the matching sets together. Do not delete or recreate the attachment volume during upgrades.

The existing `ATTACHMENTS_PATH=/var/lib/maildock/attachments` is reused. Dockerfile ownership and both mandatory services (`app`, `postgres`) are unchanged. The only Compose changes pass through the three configurable byte limits; the volumes remain exactly `postgres_data` and `attachments_data`. No additional volume, `/data`, object-store service or binary database columns were introduced.

`BlobStorage` is the narrow application port: `put`, `open`, `exists`, `delete`. It accepts opaque binary objects without mail semantics or filenames. `LocalBlobStorage` implements it using the configured root:

```text
ATTACHMENTS_PATH/
  blobs/<first-two-key-characters>/<random-UUID-key>
  tmp/<random-UUID>
```

Keys are generated internally and validated against a canonical UUID-v4 grammar for every filesystem operation. MIME/upload names cannot influence paths. Future S3/Azure Blob adapters can implement the same port without changing mail services. Browser requests never accept or return storage keys or filesystem paths. Storage is outside Next.js public/static serving.

Writes stream to an exclusive temporary file, count actual bytes, compute SHA-256, enforce the limit, fsync and close, then atomically rename. On supported platforms the final directory is fsynced. A failed/interrupted write removes its temporary file. Hard crashes can leave temporary or complete orphan files. A DB association is created only after a complete blob was published. Reads used for outgoing construction, SMTP, APPEND and authenticated download check both actual size and SHA-256. Normal incoming caches and forwarded attachments can share a single immutable physical object; hashes are integrity metadata, not cross-account identity.

## Forward-only schema migration

Migration `0015_glorious_charles_xavier.sql` adds:

- `blobs`: immutable storage key, authoritative byte size, SHA-256 and creation time. Foreign keys protect objects with durable references.
- `message_attachments`: UUID identity; local message; frozen source mailbox/UIDVALIDITY/UID; numeric MIME part ID; nullable filename, declared size and Content-ID; content type, disposition, inline/user-visible classification; nullable blob association; fetch state/error/timestamps. Unique identity is `(message_id, part_id)`, never filename.
- `staged_attachments`: opaque staged ID, safe filename/type, blob reference, ready/removed/consumed status, creation and expiry. Size/hash come from the immutable blob registry.
- `outgoing_message_attachments`: outgoing ID, deterministic position, blob reference and snapshotted filename/type/size/hash. This association is independent of staging after creation and protected against updates.
- `outgoing_messages.mime_blob_id`: authoritative MIME object for new rows. `mime_base64` becomes nullable, with a constraint requiring exactly one source. Historical values are untouched. The existing immutable outgoing trigger now protects the MIME blob reference as well as all previous snapshot fields.

No historical migrations were rewritten. Blob metadata and outgoing attachment snapshot updates are rejected by database triggers.

## Incoming discovery, identity and fetch

The existing IMAP BODYSTRUCTURE normalization supplies actual MIME facts. `MessageService.persistBatch` records attachment metadata during recent/delta/backfill synchronization. The content detail path also lazily persists metadata for messages synchronized before Phase 2E, without fetching remote binaries. Duplicate names remain separate part IDs. Missing filenames are supported. Attached `message/rfc822` is one object, not a list of its nested body parts. Ordinary text/plain and text/html bodies are excluded. Inline resources retain Content-ID, disposition, part identity and type but are hidden from the normal attachment list when they are only resources.

Reader Download requests `POST /api/attachments/:attachmentId`. Uncached attachments transition to durable pending state and enqueue `attachment-fetch-v1`. Payload contains **only** `attachmentId`; the worker reloads credentials, mailbox path, epoch, UID and part identity from authoritative DB data. HTTP never waits for IMAP. A 30-second repair poller reschedules pending/fetching rows after queue outages or worker crashes. The UI polls status every 2.5 seconds and automatically starts the authenticated download once ready following the user's click. Ready cached attachments show an Open link. Revisiting a message does not automatically download its cached files.

An attachment-scoped PostgreSQL advisory session lock prevents concurrent remote fetches. The worker resolves OAuth before reserving a connection, reloads the row under the lock, and skips ready rows. It verifies enabled account, active/selectable mailbox, exact source placement and mailbox epoch. The provider opens read-only, checks remote UIDVALIDITY, fetches BODYSTRUCTURE with `{uid: true}`, verifies the exact attachment part belongs to that UID, then retrieves bounded BODY.PEEK partial chunks using that same UID. Sequence numbers are never identity. Epoch mismatch fails safely and requests the existing recent synchronization path; it never guesses another placement.

The adapter decodes base64/quoted-printable transfer encoding without applying charset or format=flowed conversions to attachment files. Actual decoded byte count is enforced in both provider and storage. An additional wire-byte budget bounds malformed input. A server that ignores partial fetch limits is rejected. ImapFlow protocol objects do not leave the adapter; it owns the connection until its async binary consumer finishes.

After publication, blob metadata is inserted and the ready association is updated by autocommit on the same reserved lock connection. DB failure can leave a complete orphan blob; it cannot expose partial bytes. A missing/corrupt cache can be prepared again from the original authoritative placement. Subsequent valid cached downloads do not fetch from IMAP. No automatic retry of failed attachments is hidden from the user.

## Authenticated downloads and uploads

Every attachment endpoint calls the existing owner authentication guard; POST/DELETE also use existing Origin/CSRF checks. The UUID is resolved through authoritative attachment/message/account relationships. The application remains single-owner, with no new users, tenants or RBAC.

`GET /api/attachments/:attachmentId` returns safe status metadata with private/no-store caching. `GET /api/attachments/:attachmentId/download` requires ready state, reads and verifies bounded cached bytes, and returns:

- `Content-Disposition: attachment` for every file type;
- safe ASCII fallback and UTF-8 `filename*`, removing controls, CR/LF, separators and bidi overrides;
- `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`;
- `Cache-Control: private, no-store`, sandbox CSP and no-referrer.

No attachment is rendered or executed in the Maildock origin. Errors suppress physical paths and protocol details.

`POST /api/attachments/staged` accepts one raw streamed file. `X-Attachment-Filename` is URI-encoded metadata, not a path. Content-Type is syntactically validated with an octet-stream fallback; it is not a trusted claim about content. Browser Content-Length, file size and hashes are never authoritative. Upload is bounded while streaming, without `request.formData()` buffering. A ready staged row appears only after blob publication and database commit. The client receives an opaque staged ID, safe name/type, authoritative size and state.

`DELETE /api/attachments/staged/:attachmentId` marks an unconsumed staged selection removed; it never physically deletes bytes. Incoming Forward removals only change the current compose selection.

## Outgoing snapshots, MIME and failure boundaries

Compose sends an ordered list of `{kind: "staged" | "incoming", id}`. The strict input schema rejects duplicates, storage keys and arbitrary extra fields. Each staged ID must be ready and unexpired; it is locked and consumed in the outgoing creation transaction. Incoming IDs require Forward context, belong to its verified source message, and must be user-visible and ready. Unavailable or corrupt selections fail creation instead of being silently omitted.

The server enforces total payload size, reads verified attachment bytes, freezes safe metadata and ordering, and uses the existing Nodemailer MailComposer to create text/plain or multipart/mixed with base64 attachment parts. Bcc is absent from MIME; the SMTP envelope retains recipients. Message-ID, Date and server-derived reply threading remain fixed. The MIME stream is bounded while building, including encoding/header overhead, then persisted once to BlobStorage. Only afterwards are the outgoing row and attachment snapshots committed as queued. A transaction failure leaves an orphan object, not a sendable partial row. Reads/building use bounded memory, not unbounded remote payload buffering.

`loadOutgoingMime` is the shared compatibility boundary: verified blob-backed MIME first, otherwise canonical legacy `mime_base64`. SMTP and Sent-copy never reconstruct MIME or re-encode attachments on retry/recovery. Missing/corrupt MIME before the sending claim is a local failed state with no SMTP attempt and no false uncertainty. Once `sending` is durably claimed, existing sending → uncertain crash recovery and ambiguous-result handling are unchanged. There is no new resend pipeline.

Maildock-managed Sent APPEND loads the identical MIME before claiming `saving`. A MIME read failure after SMTP success marks only Sent-copy failed; SMTP stays sent. Existing APPEND ambiguity/reconciliation remains intact. Server-managed Sent never APPENDs, including messages with attachments.

## Compose and Forward

The existing composer adds a Lucide paperclip button/native multi-file picker, attachment names/sizes, upload/preparation/error states and Remove. An unfinished or failed selected attachment blocks Send without resetting recipients, subject, body, source or sending account.

Forward selects original normal attachments by default, references incoming attachment IDs and schedules preparation for uncached selections. Ready incoming blobs are reused, not copied. Users can remove individual attachments before Send. A selected failed/unavailable original must be retried or removed. Inline/CID-only resources are not automatically forwarded.

Reply and Reply All never select originals automatically. Users can upload new local files through the same composer. Phase 2D recipient and threading derivation remains authoritative. Phase 1D HTML sanitization/iframe isolation is unchanged; CID/inline rendering, remote-image policy changes, previews, galleries, rich composition, drafts, extraction, antivirus and resumable uploads remain deferred.

## Limits and lifecycle

| Environment variable                     |             Default | Meaning                                           |
| ---------------------------------------- | ------------------: | ------------------------------------------------- |
| `MAILDOCK_MAX_ATTACHMENT_BYTES`          | 15,728,640 (15 MiB) | Actual bytes of one uploaded/fetched attachment   |
| `MAILDOCK_MAX_OUTGOING_ATTACHMENT_BYTES` | 18,874,368 (18 MiB) | Sum of selected outgoing attachment payloads      |
| `MAILDOCK_MAX_OUTGOING_MIME_BYTES`       | 26,214,400 (25 MiB) | Final immutable MIME including base64 and headers |

Defaults are centralized. Configuration is validated and forwarded by Compose. A 25 MB file is not a 25 MB SMTP message. Declared remote size is informational until actual bytes are cached.

Phase 2E deliberately provides a conservative GC seam instead of destructive automatic collection. Staged uploads expire after 24 hours; removed/expired rows become cleanup candidates. Cached incoming blobs and outgoing attachment/MIME blobs remain retained. Temporary hard-crash leftovers and complete physical/registry orphans are eligible for future reconciliation. No physical blob is deleted based on age. Future GC must check all four durable reference kinds and serialize against publication/snapshot creation. A forwarded cache removal cannot delete its incoming object. Recovery-required SMTP and Sent-copy MIME must remain available. A temporary leak is preferred to deleting mail data.

No binary content, MIME, bodies, credentials, Bcc lists or filenames are added to operational logs.

## Automated verification

Focused storage, MIME/provider, API, PostgreSQL integration and composer tests cover opaque paths, atomic writes/interruption, server hashes/counts, overflow, duplicate/missing names, inline metadata, lightweight reader discovery, exact UID/epoch/part, concurrent locks, cache reuse, failure recovery, authenticated forced downloads, streamed staging, immutable association/MIME integrity, legacy delivery, exact SMTP/APPEND bytes, Forward/Reply selection, upload/preparation UI states and conservative lifecycle. Existing Phase 0–2D SMTP/APPEND uncertainty tests remain in the full suite.

Verification on 2026-10-01: lint passed without warnings; both web/worker typechecks passed; the full suite passed **375 tests in 39 files**, including **63 additional cases**; production Next.js and worker build passed. The emitted worker composition also imports successfully in Node. `docker compose config --services` reports only `app` and `postgres`; `--volumes` reports only `postgres_data` and `attachments_data`. `git diff --check` passed and the final diff was reviewed for unrelated changes. Live provider acceptance requires the owner's accounts and is separate from simulated protocol/database tests.

## Manual acceptance scenarios — not performed against live accounts

### A. Incoming dPoczta / standard IMAP

1. Send a PDF to the account and synchronize.
2. Open it; verify attachment metadata appears and no binary has been fetched.
3. Click Download; verify Preparing if uncached, then download and compare the exact PDF.
4. Download again; verify cache reuse without another IMAP fetch.

### B. Outgoing dPoczta / Maildock-managed Sent

1. Compose, upload a PDF and Send.
2. Verify the recipient gets the exact file and SMTP sends once.
3. Verify the Maildock APPEND copy contains the same attachment.
4. Open the synchronized Sent message; verify metadata and download.

### C. Microsoft / Hotmail server-managed Sent

1. Compose using the Microsoft OAuth account, attach a file and Send.
2. Verify the recipient's attachment and the server-managed Sent copy.
3. Verify Maildock does not APPEND a duplicate.

### D. Forward

1. Receive a PDF and open Forward; verify default selection.
2. Remove it, Send, and verify the outgoing mail excludes the PDF.
3. Forward again, retain the file, wait for uncached preparation and Send.
4. Verify the recipient receives the exact attachment and cached bytes are reused when available.

### E. Reply

1. Reply to mail containing attachments; verify no original is selected.
2. Upload a new local attachment and Send.
3. Verify reply threading and delivery of only the new file. Repeat selection check with Reply All.

## Implementation report

1. **Schema:** four new attachment/blob tables, nullable legacy MIME and an authoritative MIME blob FK; one forward migration and immutable snapshot triggers.
2. **BlobStorage:** opaque immutable objects through put/open/exists/delete; atomic local streaming writes and verified bounded reads.
3. **Existing path:** all incoming caches, staged files and outgoing MIME use the existing ATTACHMENTS_PATH root and volume.
4. **Compose:** only three limit environment variables added; no services or volumes added/renamed; Dockerfile unchanged.
5. **Discovery:** actual synchronized BODYSTRUCTURE, plus lazy historical-message discovery in the content detail path; no eager binary downloads.
6. **Fetch:** attachment-ID-only durable pg-boss jobs, authoritative relationship/epoch/UID/part checks, advisory locking and repair polling.
7. **Download security:** owner authentication, forced safe Unicode attachment headers, octet-stream/nosniff/private/no-store/sandbox, no public storage keys.
8. **Staging:** streamed authenticated upload; blob before ready row; actual size/hash and 24-hour expiry; remove marks metadata only.
9. **Outgoing snapshot:** ordered immutable associations and frozen filename/type/size/hash, independent of staging.
10. **MIME compatibility:** new blob-backed MIME; legacy base64 remains readable without migration/rewrite; shared verified loader for SMTP and APPEND.
11. **Multipart:** Nodemailer multipart/mixed, exact decoded file bytes and deterministic selection order; plain text without attachments; Bcc omitted and ID/Date/threading preserved.
12. **Forward:** normal originals selected by default, cached object reuse, durable preparation of uncached files, Send blocked until selected files are ready, optional individual removal.
13. **Reply / Reply All:** no automatic original attachments; manual new uploads use the same composer and delivery pipeline.
14. **Lifecycle:** conservative reference-aware GC seam; no physical age-based deletion; expiry/removal/orphan metadata available for later collection; recovery blobs retained.
15. **Limits:** 15 MiB single file, 18 MiB combined payload, 25 MiB final MIME by default; configurable and enforced server-side.
16. **Tests:** five new storage/MIME/provider/API/integration test files, four composer cases, and existing migration/outgoing assertions adapted to blob MIME.
17. **Checks:** lint, both typechecks, all 375 tests, production build, emitted worker import, Compose inventory and diff checks passed.
18. **Manual acceptance:** scenarios A–E documented; live dPoczta/standard IMAP/Microsoft/Hotmail delivery checks were not performed.
19. **Remaining limitations:** automatic physical GC is deferred; inline/CID rendering and the other excluded features remain deferred; MIME/download reads are bounded in memory; an unavailable frozen remote placement fails safely rather than guessing another mailbox identity. Providers ignoring bounded partial IMAP fetches are rejected.
