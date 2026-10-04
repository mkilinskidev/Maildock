# Phase 2J — Rich HTML Compose

Implemented against `c20e47c92686e2dcdd1a46d9aba427461ad1781a`.

## Editor and document boundary

The existing Compose form now contains a focused Lexical editor. Direct dependencies are pinned to **0.52.0**: `lexical`, `@lexical/react`, `@lexical/rich-text`, `@lexical/list`, `@lexical/link`, `@lexical/selection`, `@lexical/table`, `@lexical/utils`, `@lexical/extension`, and `@lexical/history`. The composer uses `LexicalExtensionComposer` with a stable extension instance and RichText/History/List/Link/Table/HorizontalRule extensions, replacing the legacy composer/plugins and deprecated React horizontal-rule node. History retains the previous 1,000 ms merge delay. React renders ContentEditable and custom image decorators. No Playground code, architecture, theme, or infrastructure was copied. `esbuild` is a development dependency for mounting the actual composer in the browser security harness.

`drafts.rich_document` stores a JSONB document shaped as `{ version: 1, editor: { root: ... } }`. This is the authoritative editable body. JSON serialization removes runtime prototypes; server validation accepts only a small, explicitly enumerated subset of serialized nodes. Container typing caches are validated and normalized; text formatting lives on text nodes. Nodes contain no executable behavior, binary bytes, data URLs, object URLs, or trusted MIME headers. Unknown node types, versions, keys, unsupported CSS, invalid structure and excessive content are rejected.

`rich-document.ts` is the only document validation and email serialization boundary. It imports neither React nor Lexical. Mail application services consume this validated JSON boundary rather than mounting an editor. `plain_text` is a derived compatibility/cache field, not a second editable body. Legacy requests without a document are converted to one before persistence. When both representations arrive, the rich document wins and the supplied plain text is overwritten with the generated alternative.

## Persistence and migration

Forward-only migration `0020_mighty_slayback.sql` adds rich document/HTML snapshot fields and extends existing attachment associations with inline disposition and server-owned CIDs. Historical migrations remain unchanged. Only active legacy drafts are upgraded; consumed drafts and their immutable MIME remain untouched.

Legacy text is represented as a paragraph containing a text node with normalized newlines. This preserves empty/trailing lines without expanding a draft with many line breaks into hundreds of thousands of nodes. The HTML serializer emits explicit `<br>` for these newlines. Old localStorage recovery copies without a document take the same upgrade path. Malformed rich recovery copies are rejected before mounting the editor.

The Phase 2F one-second debounce, stable client draft UUID, revisions, row locking, conservative two-tab conflict handling and idempotent handoff remain in use. Restoring a draft does not regenerate its quote. Recovery contains only JSON and durable resource IDs; it is capped at 1 MB UTF-8. Above that ceiling, browser recovery is removed and server autosave remains authoritative. Unsupported/oversized editor changes block saving and sending until undone. Uploading or failed attachments also block sending.

## Formatting, links and paste

The compact toolbar supports undo/redo, paragraphs, H1–H3, block quotes, eight font sizes (10–48 px), bold, italic, underline, strike, text color, left/center/right alignment, numbered/bulleted lists, indent/outdent, links and horizontal rules. Conventional Lexical keyboard shortcuts remain available; Ctrl/Cmd+K opens link editing. Empty link input removes the link. Labels, focus styles, pressed formatting controls and disabled states are exposed to assistive technology. The editor has a labeled textbox and uses Lexical's contenteditable/IME handling.

Browser HTML paste and external HTML drag first pass through DOMPurify in an inert document, then the same controlled DOM-to-document importer used by quoting. The importer traverses paragraphs, breaks, headings, basic font formatting, safe color/size, alignment, lists, indentation, quotes, links and simple table cells/spans. It normalizes basic Office list markers. Scripts, forms, frames, object/embed, SVG, resource hints, stylesheets, event handlers, unsupported resource CSS, source classes and Office metadata never become authoritative editor markup. Clipboard images are handled separately from clipboard HTML. HTML-pasted `<img>` sources are deliberately omitted rather than automatically fetched or treated as uploaded resources. Private Lexical clipboard JSON is not trusted as a shortcut around this policy.

Links allow HTTP, HTTPS and mailto. Remote image nodes allow HTTP/HTTPS only, without URL credentials or control characters. User-supplied CID, javascript, file, blob and data URLs are rejected. Output links do not impose reader-specific target behavior.

## Images, attachments and BlobStorage

There is still one staged upload endpoint, one `AttachmentService`, one BlobStorage and one reusable browser upload operation. All picker, paste and drop uploads share that operation and existing size/integrity limits. Uploads include the stable draft ID; staged resources are claimed atomically by a draft. They cannot be substituted into another draft. Existing unbound legacy normal uploads can be claimed once, while new inline uploads require a matching draft binding.

Clipboard raster files and raster files dropped in the editor upload first, then insert a document image node at the captured caret/drop position. Only a successful durable upload can create that node. Preview uses an authenticated, same-origin GET on the existing staged attachment route, scoped to the exact draft/resource relationship. The preview verifies size, SHA-256 and the existing safe raster signature policy, sets nosniff/no-store and rejects SVG. No local preview URL is stored in JSON. Failed uploads remain visible and removable; missing previews have a retry action.

An image dropped in the normal attachment area is a normal attachment. Non-images dropped anywhere in Compose are normal attachments. Embedded resources use `draft_attachments` with `inline=true`, a blob reference, filename/type and a server-generated UUID CID under `maildock.invalid`. The document stores the stable attachment resource ID, not the CID. Selection, deletion, alt text and four bounded display widths are supported. Aspect ratio is preserved and display dimensions are limited; original binary bytes are not recompressed.

Explicit “Image from URL” inserts a remote node, displayed as a non-loading placeholder. Remote nodes also remain placeholders after restore or quote preparation. Maildock never downloads, proxies or caches these URLs while composing or generating MIME; outgoing HTML retains the URL for the recipient's client to decide whether to load.

Draft associations pin blobs exactly as existing normal attachments do. Removing an image excludes its association from the next save. Discard deletes associations only, with no unsafe shared-blob deletion. Unreferenced staged/orphan bytes remain subject to the existing conservative storage lifecycle.

## Reply, Reply All and Forward

Existing source placement, account/mailbox/message checks, recipient/self-dedup rules, lack of Bcc inheritance, and threading derivation remain authoritative. Usable local Phase 2H sanitized HTML goes directly through the stricter outgoing importer, retaining useful formatting and tables. Plain-only source messages use the text-to-document path. The result contains an empty response paragraph, existing derived separator/header and a rich quote.

Remote images in received HTML are preserved only as validated URL nodes; preparation/import/autosave never activates them. For CID images, candidates are selected only from the exact source message after its account/mailbox placement has been validated. CID normalization and ambiguity checks reuse the reader policy. Missing local resources use the existing attachment fetch jobs; verified cached safe raster blobs are associated with the draft and assigned a new outgoing CID. Missing, failed, ambiguous, corrupt or unsupported images become explicit unavailable-image placeholders. A source cannot cause another message/account's attachment or guessed blob to be embedded.

Forward retains existing visible normal attachment selection and fetch behavior. Referenced inline resources are carried separately in the shared association table and are not displayed twice. Reply modes inherit no normal attachments. Forward inherits no threading.

## Serialization, handoff and MIME

The validated tree produces deterministic conservative HTML: semantic paragraphs/headings, inline text styles, lists, blockquotes, safe links, rules, tables and bounded images. No editable DOM, implementation attributes, arbitrary source HTML, runtime classes, scripts or resource-loading CSS is sent. Plain text is generated by walking the same tree, preserving paragraph/break/list/indent/quote/table semantics and adding link URLs and image descriptions. It is not generated by regex tag stripping.

The existing draft-to-outgoing transaction still locks and validates the expected revision, resolves authoritative source/threading and attachment/resource associations, verifies every blob, generates HTML/plain and final MIME, snapshots everything and marks the draft consumed. Failure rolls back the handoff. Repeated/concurrent Send returns the existing outgoing ID.

The existing `buildOutgoingMime` now supplies both alternatives to Nodemailer. Normal rich mail uses `multipart/alternative`. With CID resources, Nodemailer puts a related HTML/image branch inside the alternative; normal attachments introduce the surrounding `multipart/mixed`. Raster parts carry server-controlled Content-ID and inline disposition; normal files carry attachment disposition. MIME URL/file fetching remains disabled.

`outgoing_messages` snapshots the document, HTML and plain text. Existing `outgoing_message_attachments` snapshots inline disposition, stable resource ID, CID, blob, size and hash alongside normal attachment metadata. Database immutability guards cover the new fields; the existing attachment snapshot guard covers the extended rows. Final MIME is still stored once in BlobStorage. SMTP retries never regenerate it. Sent APPEND receives the exact same verified bytes. Bcc remains envelope-only; stable Message-ID, Date, In-Reply-To, References, OAuth and SMTP uncertainty behavior remain unchanged. Search continues through ordinary synchronization without direct compose/index coupling.

## Limits and security verification

| Boundary                                | Limit                                        |
| --------------------------------------- | -------------------------------------------- |
| Serialized document                     | 2,000,000 UTF-8 bytes                        |
| Generated HTML                          | 3,000,000 UTF-8 bytes                        |
| Generated plain text                    | 2,000,000 UTF-8 bytes and 500,000 characters |
| Nodes / depth                           | 20,000 / 32                                  |
| Individual text node                    | 500,000 characters                           |
| Inline / remote image nodes             | 50 / 100                                     |
| Normal attachments + embedded resources | 100 total                                    |
| URLs / image alt text                   | 2,048 / 500 characters                       |
| Indentation / embedded display width    | 8 levels / 640 px                            |
| Expanded table cell area                | 50,000 total span cells                      |
| Browser recovery                        | 1,000,000 UTF-8 bytes                        |
| Draft/compose HTTP requests             | Existing 3,100,000-byte ceiling              |
| Individual attachment                   | Existing configurable default 15 MiB         |
| Combined attachment bytes               | Existing configurable default 18 MiB         |
| Final MIME                              | Existing configurable default 25 MiB         |

The final MIME ceiling remains authoritative. Tree, string, array, depth and generated-output bounds prevent small malicious documents from producing unbounded output. The Phase 2H reader sanitizer, CSP, sandbox, remote-image permissions, trusted senders, CID isolation and download behavior were not rewritten.

Focused tests cover model validation/serialization, malformed/oversized documents, safe/hostile HTML import, actual parsed MIME, legacy migration, rich draft restore, source CID transfer, ownership rejection, corrupted blobs, immutable snapshots and identical SMTP retry/Sent bytes. Existing UI tests now operate the real Lexical editor rather than a textarea. The browser security command additionally mounts the actual MailComposer with local API fixtures and verifies zero third-party requests for quoted remote content, hostile paste/HTML drag and explicit URL images, plus formatting, table paste, clipboard/file drops, draft reload, inline deletion and failed uploads. Clipboard/drop events are generated in the real browser; this does not claim an OS-level screenshot/clipboard test or delivery interoperability with live Gmail/Outlook accounts.

Final verification: 51 test files / 568 tests passed, including PostgreSQL integration and parsed MIME checks. Lint, application/worker typecheck and production build passed. Browser checks reported zero third-party compose requests and zero editor errors, including link insertion/edit/removal. The build used a process-only HTTPS `APP_ORIGIN` override; local configuration was not changed.

Verification commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:security:browser`. Production build requires an HTTPS `APP_ORIGIN`; development's HTTP origin is not production-valid.

## Known limitations

- Paste/quoting deliberately drops unsupported CSS, external stylesheets, complex layout, private editor metadata and HTML image sources. Basic tables survive, but there is no table-creation toolbar or full Word layout fidelity.
- Remote images never preview automatically. Missing quoted CID data is an explicit placeholder; there is no remote-image-to-CID conversion.
- Link/image URL/alt editing uses small native prompts, and image sizing offers bounded presets. Image transforms, signatures and the Phase 3 visual redesign remain out of scope.
- Safe raster checks reuse Phase 2H policy; they do not recompress or rewrite original bytes.
- Browser verification uses the installed Chromium/Edge browser and local API fixtures. Server durability/isolation are verified separately against PostgreSQL/BlobStorage; live-provider sending and a full browser matrix are not part of this run.
