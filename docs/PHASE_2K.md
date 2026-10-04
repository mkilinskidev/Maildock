# Phase 2K — Rich Email Signatures

Implemented on Phase 2J HEAD `ee318697d22dd0e3ad91d608dfff3ee32b7f88fb`.

## Editing and persistence

Settings has a small Signatures section for adding, editing, naming and deleting global reusable definitions. Editing mounts the existing Lexical `RichComposer`, with its formatting, paste, image upload and blocked remote-image previews. The signature-insertion control is omitted from template editing. Templates use an explicit Save/Cancel flow; Compose retains its existing autosave.

Migration `0021_graceful_wallop.sql` adds:

- `signatures`: UUID, name, authoritative version-1 `RichDocument`, and revision for optimistic edit/delete concurrency. There are no separately editable HTML/plain fields.
- `signature_resources`: template/resource associations referencing the existing `blobs` table. Template deletion cascades associations, never shared blob bytes.
- `account_signature_defaults`: one optional row per account, with nullable New, Reply and Forward signature foreign keys. Reply All shares Reply. Signature deletion uses `ON DELETE SET NULL` for every default; account deletion cascades its preferences.

Existing drafts, account credentials and immutable outgoing records are not migrated or rewritten. Definitions are global within Maildock's existing single-owner instance; accounts reference definitions rather than own copies.

## Snapshot and resource semantics

The existing staged-upload endpoint, `AttachmentService`, BlobStorage, safe raster/integrity policy and authenticated compose-preview endpoint serve both editors. The Phase 2J browser upload operation was extracted into `uploadComposeFile` and reused. A template's UUID binds its uploads through the existing staged owner/draft binding; only resources bound to that exact template, or already pinned by it, may be saved into its document. Raw bytes, base64, paths and CIDs never enter the editable document.

The snapshot API locks a definition against concurrent edits/deletion, validates its document, copies JSON content and remaps each embedded resource to a fresh staged UUID bound to the destination draft. These associations reference the **same blob rows and bytes**. Distinct insertions get distinct resource identities, without copying image bytes. The ordinary `DraftService` then claims these staged resources and creates durable `draft_attachments`, assigning ordinary server-owned CIDs. A saved draft has no foreign key to the template. Editing or deleting the template cannot alter its text or invalidate its embedded images. Even a snapshot obtained before template deletion can subsequently be saved through the normal draft path.

Removing or replacing signature content excludes unreferenced images from the next ordinary draft save. As in Phase 2J, unclaimed stages expire after 24 hours; saved template/draft associations pin their blobs without that expiry. Cancellation and deletion leave byte cleanup to the existing conservative storage lifecycle.

Sending has no signature-specific MIME implementation: the validated draft tree flows through the existing RichDocument HTML/plain serializer, attachment verification, immutable outgoing handoff and `buildOutgoingMime`. The structural signature block serializes as an ordinary `div`; template IDs and comparison metadata do not appear in email HTML. SMTP retries and Sent APPEND continue using the immutable MIME bytes.

## Automatic and manual insertion

New messages append the default after editable content. Reply/Reply All and Forward insert it after the editable response region, before the source header and quoted/forwarded content. The editor captures the original source blocks structurally so additional response paragraphs typed while loading stay ahead of the signature. Insertion becomes normal durable draft content and participates in existing autosave, recovery and reopen. Restoring a draft never regenerates its signature from a template.

The existing toolbar has a Lucide Insert signature icon near Link/HR/image actions. A single definition inserts directly; multiple definitions offer a compact selector; an empty catalog explains where to create a signature. Manual insertion restores the captured caret and inserts ordinary rich nodes with no automatic identity.

Automatic insertion uses a validated root-level `maildock-signature` element containing copied rich blocks, a template UUID and a SHA-256 fingerprint. The fingerprint covers canonical, normalized content and container formatting, including image identities and attributes. It uses exact structural comparison, never text matching. Lexical persists this node through normal document serialization.

From changes reload account defaults. Only one recognizable automatic block whose current structure still matches its fingerprint is eligible for replacement/removal. After asynchronous snapshot loading, the editor rechecks the complete subtree before mutating it, so edits made during that request win. The replacement receives fresh independent resource associations and a new fingerprint. None removes an untouched block. Manual insertion, edited blocks, duplicate/ambiguous markers and deleted markers are preserved conservatively. A session that removes an untouched automatic block for None can insert the next default on a later From switch. Reopened drafts without a recognizable automatic block are left alone.

Automatic signature loading/snapshot failures offer Retry signatures and block Save/Send until resolved; supported user edits can still enter the existing browser recovery copy while loading. Account switching and manual insertion are gated during an insertion. Other Compose and Settings layouts retain their existing structure.

## Security and verification

All new APIs use the existing owner-session guard and exact mutation-Origin checks. Request bodies use the bounded draft reader; definitions use the server-side rich-document validator and existing document/image limits. Unknown properties, unsafe URLs, foreign upload bindings, guessed resources and automatic identity inside templates are rejected. Signature previews use the existing verified, authenticated safe-raster response. MIME handoff revalidates draft ownership and blob integrity. Remote signature images remain non-loading placeholders: Maildock never fetches, proxies or caches their URLs.

Focused coverage includes CRUD/revision conflicts, defaults and deletion cleanup, New/Reply/Reply All/Forward placement, autosave/reopen, single/multiple/empty toolbar behavior, template-editor control omission, inline-image snapshots, shared blob counts, template edit/delete independence, saving a pre-deletion snapshot, exact account replacement/removal, manual/edited/concurrent-edit preservation, and parsed outgoing HTML/plain/CID MIME. Real-session security integration tests exercise the new API guards. The real-browser harness mounts the actual composer and checks signature images, blocked remote previews, selection, placement, account changes, edited/manual preservation and reopening after catalog deletion.

Final verification:

- `pnpm test`: **52 files / 586 tests passed**, including PostgreSQL integration and actual MIME parsing.
- `pnpm test:security`: **2 files / 35 tests passed** (also included in the full test run).
- `pnpm test:security:browser`: passed; **zero third-party Compose requests and zero editor errors**, including signature placement, images, insertion, account switching and reopen.
- `pnpm typecheck`, `pnpm lint`, production application/worker `pnpm build`, targeted Prettier checks and `git diff --check`: passed.

The production build used a process-only HTTPS `APP_ORIGIN` override; local configuration was not edited. One concurrent browser run timed out at the existing link-selection wait; the isolated rerun passed. Browser results and the Compose screenshot are generated in the existing ignored `.security-results` directory.

## Known limitations

- Template edits require explicit Save. There is no template autosave, history browser, import/export or account-specific copy editor.
- Conservative identity detection may leave a signature unchanged when its structure/marker has been altered. It never guesses text ranges or inserts an automatic default into a reopened draft lacking a recognizable marker.
- The small toolbar selector and Settings controls are deliberately functional; visual redesign remains for Phase 3.
- Phase 2J's formatting, image limits, blocked remote previews, safe raster policy and conservative orphan cleanup remain unchanged. Combined signature/quote resources must fit the existing draft/MIME limits.
- Browser checks use the installed Chromium-family browser and local API fixtures; real database/blob isolation and actual MIME parsing are checked separately. Live Gmail/Outlook delivery and a full browser/client matrix were not exercised.
