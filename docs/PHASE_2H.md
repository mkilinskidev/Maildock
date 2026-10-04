# Phase 2H — Rich HTML email and image privacy

## Received message rendering

The existing MessageReader and Phase 1D isolated `srcdoc` iframe remain the reader. A usable sanitized HTML body is preferred over the multipart plain-text alternative; plain text remains the fallback when HTML is absent, empty, unavailable or cannot be rendered. Composition remains plain text. Reply/Reply All/Forward quoting removes retained style blocks before deriving plain text, so CSS never appears in the quoted message.

The pipeline is: selective IMAP text-part fetch → DOMPurify HTML-only sanitization → CSS and resource filtering → final DOMPurify pass → immutable sanitized HTML in `message_contents` → deterministic rendering with CID mapping and remote-image permission → sandboxed iframe with CSP. No email HTML enters the application DOM. JSDOM parses without scripts or resource loading.

Sanitization and remote-resource blocking solve different problems. DOMPurify removes active HTML and unsafe protocols, but is neither a CSS security boundary nor a tracking protection filter. Explicit attribute filtering, CSS parsing and a restrictive iframe CSP enforce privacy separately.

## Sanitizer and CSS policy

`email-html-v2` uses the HTML profile only, DOM clobbering protection, named-property sanitization and explicit removal of id/name. Scripts, forms and controls, nested frames, objects, embeds, SVG/MathML, media, metadata, base URLs, external stylesheets and resource hints are removed. Unknown URL schemes are rejected.

Tables, legacy presentation attributes, classes, inline styles and style blocks retain useful typography, spacing, colors, borders, alignment and layout. Body presentation is preserved in an isolated wrapper. PostCSS parses styles; a conservative property allow-list retains inert presentation. Imports, font faces and all at-rules except conservative media queries are removed. URL/image functions, escapes, variables, expressions, legacy behavior, unsupported functions and malformed CSS are discarded. Resource-bearing CSS stays disabled even after Load images. This prevents both obvious and obfuscated CSS tracking.

Resource attributes are stripped. Only generated inert `data-maildock-remote` and `data-maildock-cid` references survive in stored HTML. Sender-supplied data attributes cannot forge these references. A second DOMPurify pass follows rewriting. Rendering only activates validated image references and safe link attributes; it inserts no untrusted HTML or CSS. Do not render stored HTML directly or add other resource-bearing attributes after sanitization.

Maildock's small base stylesheet supplies a neutral white background, readable font/color, wrapping, responsive images and maximum table widths. Sender styling is preserved where safe. There is no dark-mode inversion or arbitrary recoloring. Complex fixed-width nested layouts may still scroll.

## Sandbox, CSP and links

The iframe does not allow scripts, same-origin access, forms or top navigation. It allows popups and popup sandbox escape solely so links can open usable external pages. Every allowed HTTP/HTTPS/mailto link targets `_blank` with `noopener noreferrer` and `referrerpolicy=no-referrer`. Dangerous and unknown link schemes are removed. Links work independently of image permission.

The document CSP precedes all sender content. Default sources, scripts, objects, frames, connections, media and fonts are denied; form actions and base URLs are denied. Inline sanitized CSS is allowed. Image sources are restricted to generated local raster data URLs by default. Explicit image permission additionally allows HTTP/HTTPS images. The iframe and document both suppress referrers.

A srcdoc document inherits the embedding page's CSP; its meta policy cannot grant capabilities denied by that parent policy ([CSP policy inheritance](https://www.w3.org/TR/CSP/#security-inherit-csp)). The application's parent CSP therefore permits HTTP/HTTPS image sources as a ceiling. This ceiling is consistent across application pages because Next client navigation from login or Settings retains the original document's CSP. Application DOM remains controlled by Maildock; email markup only exists in the sandbox. The email's separate CSP still denies HTTP/HTTPS images before consent, and pre-render filtering removes all active remote resource attributes. Changing the parent image ceiling does not enable scripts, connections, forms or plugins. Browser checks must include the actual parent response CSP as well as the email meta policy; testing a standalone iframe document alone misses this interaction.

## Remote-resource threat model and controls

Opening a message does not contact email-controlled resource hosts by default. Tracking pixels, img/srcset, background attributes, CSS resources, stylesheets, fonts, media, posters, hints and nested contexts are blocked before browser rendering. CSP is an additional defense, not the primary resource filter. No remote images are fetched or proxied by the Maildock server.

A privacy notice appears when the stored message had blocked resources. Load images changes only the displayed message's component state; moving to another message resets permission. It enables validated HTTP/HTTPS `img` sources, while active content and CSS resource fetching remain forbidden. Loading remote images can reveal the user's IP address, opening time and client network behavior to those hosts.

Always load from this sender persists the single actual parsed From mailbox, trimmed and case-insensitively normalized, never the display name or domain. Ambiguous multi-address From headers cannot be trusted by the reader. Future messages from that exact address automatically load images. Sender-address rules are user preferences, not authentication of the sender: a forged From address can match an existing preference. Accounts & Settings shows the list and a Remove action; removal restores default blocking on subsequent rendering. One-message Load images remains independent of persistent trust.

The forward migration `0018_sloppy_thaddeus_ross.sql` adds only `remote_content_senders(address primary key, created_at)`. Presence means allowed; removing a row revokes permission. Existing migrations and message-body schema are unchanged. Apply with the existing `pnpm db:migrate` workflow.

## CID and BlobStorage

The owner-authenticated, Origin-checked message render POST validates opaque account/mailbox/message IDs through the existing message placement service. It derives attachment metadata from the stored MIME structure and considers only CID references in the sanitized HTML. Content-ID brackets/whitespace and URI encoding are normalized; the local identifier preserves case and the domain is case-insensitive. Duplicate IDs are treated as ambiguous.

Only matching parts from that exact message are eligible. AttachmentService additionally validates message ID, attachment ID, normalized CID and MIME type before serving bytes. It never accepts browser-supplied blob paths or storage keys. Referenced unfetched parts are queued through the existing attachment fetch worker; unrelated attachments are never requested. Pending parts refresh the reader, cached parts are reused, and failed/missing parts leave a usable reader with an unobtrusive notice. Existing inline visibility rules and ordinary attachment downloads remain unchanged.

The Phase 2E BlobStorage, maximum attachment bytes, SHA-256 integrity verification and worker locks are reused. Only PNG/JPEG/GIF/WebP/AVIF parts with matching raster signatures may render inline. SVG and other script-capable/unsupported types are refused. Verified raster bytes are returned inside the authenticated rendering response as data URLs. No filesystem/storage identifiers enter email HTML. The JSON response is private/no-store and nosniff; there is no navigable inline trusted-document endpoint or Content-Disposition ambiguity. Ordinary download endpoints retain their existing attachment disposition and security headers.

## Historical messages and failure behavior

Existing v1 HTML permanently lost images and styling during its earlier sanitization. On opening such a message, the existing content scheduler lazily refreshes only its selected HTML/plain body parts into the same content row under v2. This is not a full raw-MIME download or mailbox resync. Plain-only historical messages are unchanged. CID metadata is derived lazily from existing MIME structure and parts are fetched selectively.

Sanitizer failures retain plain text where available. Empty/formatting-only HTML falls back to text. Invalid remote URLs stay inert; malformed CSS is removed. Missing/failed/unsafe CID parts do not crash the reader. Rendering endpoint failures show plain text and never raw HTML. Failed historical refreshes preserve the existing plain fallback and offer the existing Retry download action.

## Verification and limitations

Reader readiness checks for message content and pending CID resources use runtime configuration `MAILDOCK_CONTENT_POLL_INTERVAL_MS` (default 400 ms, accepted range 100–2500 ms). The delay doubles every five seconds of waiting and is capped at 2500 ms: with the default, checks wait 400 / 800 / 1600 / 2500 ms after each response at elapsed times 0 / 5 / 10 / 15 seconds. Requests do not overlap and are cancelled when the reader switches messages. This reduces the delay in noticing completed jobs; it does not accelerate IMAP downloads or the worker queue. It is separate from mailbox synchronization's `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`. Docker Compose passes the value to the app at runtime; recreate the app container after changing `.env` to apply it (no image rebuild needed for later value changes).

Focused tests cover hostile HTML/CSS, remote default blocking and resource dispatch, selective CID fetch/cache/ownership/type checks, sender persistence and removal, per-message UI permission, HTML preference/plain fallback, link/sandbox protections, API authentication/Origin checks, and historical selective refresh. The full existing suite covers attachment, reply/forward and conversation regressions. Run lint, web/worker typecheck, full tests and production build.

Only img-based remote content can be explicitly enabled. Srcset, CSS backgrounds, fonts, stylesheets and media remain disabled. CID CSS backgrounds and CID srcset are not implemented; image-tag CID references are supported. Relative image URLs lacking a usable absolute host stay blocked; protocol-relative images use HTTPS after permission. Complex CSS selectors/layouts can lose unsupported styling. CID fetch failures currently require the existing attachment preparation/retry flow where available; missing invisible inline parts have a status notice but no dedicated retry button. Large CID images increase render response size because verified data is embedded. No rich composition, image proxy, advanced dark-mode algorithm, sender authentication or redesign is introduced.

## Implementation verification (2026-10-04)

- `pnpm lint`: passed, no warnings.
- `pnpm typecheck`: passed for web and worker.
- `pnpm test`: 485 tests passed across 44 files, including PostgreSQL/Testcontainers integration tests and all earlier phase regressions.
- `pnpm build`: passed with process-local `APP_ORIGIN=https://maildock.test`; the local development `.env` uses HTTP and production configuration correctly rejects it. No local configuration file was modified.
- Browser fixture checks exercised plain text, corporate HTML, table newsletter, local CID, blocked remote images, tracking CSS/pixel, enabled-image/trusted-policy simulation and hostile HTML. The local resource server saw no email-resource requests before permission (only the parent preview favicon); after enabling images it saw three image requests without referrers and no stylesheet/frame/CSS tracking requests. The CID raster decoded locally. Parent content stayed intact.
- These browser checks used disposable fixtures with the production sanitizer/renderer and iframe policy, not a live account. Actual sender trust persistence/removal, attachment fetch and historical-message flows were verified in API/UI/database tests. External-link popup behavior could not be completed in the in-app browser; target/opener/referrer and sandbox attributes are covered by regression tests.

The migration was applied to disposable test databases by the test suite; it was not applied to the user's runtime database. Apply the forward migration during deployment with `pnpm db:migrate`.

### Parent CSP regression follow-up

The earlier browser fixtures did not include the application response CSP, so they missed inherited `img-src 'self' data:` blocking consented remote images. The corrected browser fixture serves the exact parent CSP from the shared policy generator and loads a raster image from a different local origin. Default rendering made no image-host request; one-message and trusted-policy rendering each decoded the remote image without CSP warnings, while returning to default did not request it again. CID still decoded locally, scripts remained removed and no CSS tracking request occurred. The full suite (485 tests), lint, web/worker typecheck and production Docker build passed after this correction.
