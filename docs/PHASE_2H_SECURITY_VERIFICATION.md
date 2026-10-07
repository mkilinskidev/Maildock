# Phase 2H adversarial security verification

Reviewed baseline: `9eda96915cc5e0910a414d90701df900ae58b2bb`.
Date: 2026-10-04. The checkout started at this exact commit with no local changes.

**Result:** No exploitable HTML execution, default remote-loading, sandbox escape,
CID cross-message access, or sender-permission escalation was demonstrated by
this review. The new browser corpus produced **zero email-controlled requests
and zero browser network attempts before permission**. After permission, **only
IMG requests and an IMG redirect chain** occurred. This is evidence for the
tested corpus and browser, not a proof against every future parser/browser bug.

Two implementation limitations were demonstrated: raster identification checks
magic bytes rather than full image validity, and authenticated rendering JSON
has no route-specific byte ceiling. Neither became an execution or authorization
bypass in these tests. Sender preferences also intentionally span the owner's
configured accounts when the exact From address matches.

## 1. Attack surface reviewed

The implementation under review was read before writing the new corpus. Existing
tests were treated as context, not as the security specification.

| Surface                | Implementation and security-relevant result                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIME/body selection    | `display-parts.ts`, `imap-smtp-mail-provider.ts`: selected text parts only; attachment/name exclusions, UIDVALIDITY, byte bounds, content-type and charset checks, fatal UTF-8 decoding. ImapFlow supplies decoded download streams.                                              |
| Persisted HTML/history | `message-content-service.ts`: versioned sanitization, plain fallback, output size limit, selective historical body refresh. `email-rendering-service.ts` re-sanitizes unknown policies when a historical representation is available.                                             |
| HTML                   | `sanitize-email-html.ts`: fresh non-executing/non-loading JSDOM; DOMPurify HTML profile; scripts/foreign namespaces/active elements forbidden; clobbering defenses and id/name removal; final DOMPurify pass.                                                                     |
| CSS                    | PostCSS property/selector/at-rule filtering; only conservative media rules; URL, image, escape, comment, variable and unsupported function filtering in declarations. CSS resource permission never follows image consent.                                                        |
| URL capabilities       | Sender data attributes removed before generated `data-maildock-remote`/`data-maildock-cid` attributes; resource attributes stripped; only absolute HTTP(S) IMG URLs without credentials can activate. Protocol-relative IMG URLs normalize to HTTPS.                              |
| Rendering              | `render-email-document.ts`: removes IMG src first; activates validated remote references or raster data mappings; validates links; CSP precedes sender markup. Its input contract is sanitized/versioned HTML, not arbitrary raw HTML.                                            |
| Browser/application    | `rich-email-body.tsx`, `message-reader.tsx`, `content-security-policy.ts`, `proxy.ts`: srcdoc isolated from the application DOM; parent CSP shared across navigation; per-message component key resets transient permission.                                                      |
| Sender trust           | `remote-content-sender-service.ts`, render POST, settings GET/DELETE and `remote-content-settings.tsx`: exact normalized parsed mailbox preference; owner authentication and exact Origin on mutations.                                                                           |
| CID/blob               | Rendering service, attachment discovery/metadata/service/worker, `blob-storage.ts`, `local-blob-storage.ts`: message-scoped candidates, unique normalized CID, raster MIME/signature validation, immutable blob metadata, byte/size/SHA-256 verification, generated storage keys. |
| API                    | Render POST, sender preference endpoints, attachment metadata/preparation/download, owner access/session validation and Origin checks. No public inline arbitrary-HTML endpoint or client-supplied storage path.                                                                  |

## 2. Dedicated adversarial fixtures and pipeline

New files in `tests/security/`:

- `fixtures.ts`: six named hostile HTML classes, base64 multipart/related MIME
  builder, inline attachment resources and a valid PNG.
- `pipeline.ts`: MIME fixture decoding and production provider/sanitizer adapter.
- `adversarial.test.ts`: 19 parser, resource, CID/signature and parsed-From tests.
- `authorization.integration.test.ts`: 15 API/session/PostgreSQL/blob tests.
- `browser.ts`: standalone Playwright/local HTTP request trap.

The fixtures bypass external provider filtering. `mailparser` decodes the local
MIME with `skipImageLinks`, `skipHtmlToText` and `skipTextToHtml`: it must not
substitute CID data URLs or synthesize another body. The resulting decoded HTML
enters the **actual `ImapSmtpMailProvider.fetchMessageContent` implementation** at
the ImapFlow download-stream seam, followed by the actual sanitizer and renderer.
The integration suite derives attachment metadata from the decoded MIME and
uses actual content/rendering/attachment services and real disposable storage.

This adapter does **not** exercise live IMAP protocol/BODYSTRUCTURE parsing or
ImapFlow's wire transfer/charset decoder. Existing provider tests exercise type,
charset, UIDVALIDITY and size failures; neither suite is a live hostile IMAP test.

The added corpus includes numeric/entity/tab/percent encoded javascript links;
SVG script/events/use/image/foreignObject; MathML/table mutation shapes;
noscript/xmp/select/table parser differentials; quote/entity reserialization;
clobbering forms and names; forged internal resource attributes; credential,
relative, protocol-relative and encoded image URLs; CSS hex escapes, comment
splitting, escaped imports, image-set, custom properties and var/expression.
It also covers img/srcset, picture/source, legacy backgrounds, imports/fonts,
stylesheets, preload/prefetch/DNS hints, frames, objects/embeds, media/posters/
tracks, forms, meta refresh, base and navigation attempts.

These are adapted XSS-style patterns, not a claim of an exhaustive external XSS
corpus or a randomized fuzzer. Existing legitimate table, typography, body color,
CID, link and fallback tests remain in the full suite.

## 3. Real-browser methodology

Playwright 1.63.0 drove installed Microsoft Edge **154.0.4258.48** headlessly.
Two ephemeral loopback HTTP origins separate the parent fixture and hostile
resource trap. Every trap request records its URL and Referer. Browser request
events also record attempts that fail before the trap receives HTTP.

The parent HTTP response sends the **exact shared production CSP generator's
output**. The harness reads and checks the sandbox/referrer attributes in the
actual React component source, then constructs an iframe with those attributes.
Existing React UI tests separately assert the actual mounted component attributes.
The parent control script is authorized with a nonce; it assigns the production
renderer output to srcdoc and a Load images button switches to permission-enabled
output. Fresh browser contexts isolate fixtures and prevent cache/trust leakage.

This is a production-policy/component-parity fixture, **not a browser login to
the running Next application or a live mailbox**. Actual route handlers, owner
sessions and persistent trust are tested separately in integration tests.
Trusted permission and one-message permission converge on the same renderer
boolean; the browser harness exercises that output through its local button.

Measurements wait 800 ms after default rendering and 1200 ms after consent.
The trap returns actual image bytes as a positive loading control; a hardcoded
per-fixture allow-list and exact received-request set prevent tests from deriving
their expected result from whatever the sanitizer happens to emit.

## 4. Default remote requests

**Real browser: 0 received requests and 0 browser network attempts across all six
hostile fixture classes.** CID and the separate defense control also received zero.
No trap request occurred during MIME decoding or sanitization. App-owned parent
fetches use the separate parent origin and are not counted as email resources.

| Fixture                        | Default received | Default attempts | Consent received | Consent attempts |
| ------------------------------ | ---------------: | ---------------: | ---------------: | ---------------: |
| execution-and-navigation       |                0 |                0 |                1 |                1 |
| foreign-content-and-clobbering |                0 |                0 |                0 |                0 |
| resource-surface               |                0 |                0 |                5 |                5 |
| css-differentials              |                0 |                0 |                0 |                0 |
| parser-mutations               |                0 |                0 |                2 |                2 |
| url-and-forged-capabilities    |                0 |                0 |                3 |                4 |
| **Total**                      |            **0** |            **0** |           **11** |           **12** |

## 5. Load images remote requests

**Real browser:** received only `/img`, `/tracker`, `/redirect`, `/redirect-img`,
`/svg-as-img`, `/html-as-img`, `/nested-img`, `/select-img`, `/entity`,
`/encoded%2Fimg`, and `/query-img?x=%22&y=1`. Every browser attempt was of type
`image`; every received request had no Referer. The redirect destination was
still fetched in IMG context. SVG/HTML responses to IMG did not execute scripts,
load nested images/iframes, show dialogs, change the parent or open popups.

There was one additional permitted IMG attempt: `/protocol-relative`, normalized
to HTTPS. The HTTP-only trap cannot complete TLS on that port, so it received no
HTTP request for that attempt. This proves permission-gated dispatch, not a
successful protocol-relative HTTPS image decode.

**Zero** script/onerror, iframe/frame, CSS background/import, font/stylesheet,
preload/prefetch, object/embed, media/source/poster, form, forged-reference,
credential URL, SVG nested-resource or automatic navigation requests occurred.
The separately user-clicked `/safe-link` request is excluded from these totals.

## 6. Sandbox, CSP and isolation

Actual component policy:

```text
sandbox="allow-popups allow-popups-to-escape-sandbox"
referrerPolicy="no-referrer"
```

No allow-scripts, allow-same-origin, allow-forms, allow-top-navigation or
allow-top-navigation-by-user-activation token is present.

Parent CSP retains nonce/strict-dynamic scripts, self-only connections, no
objects, no base URLs and self-only form actions. Its image ceiling permits
HTTP(S)/data. The inherited policy and frame meta CSP are both present in the
browser test. Frame policy denies scripts, objects, frames, connections, media,
fonts, forms and base URLs; default IMG is data-only, and consent only adds
HTTP(S) to img-src. Sanitized inline CSS remains allowed.

**Real browser:** parent sentinel remained unchanged; no automatic popup or
dialog; parent URL remained unchanged in both modes. Automation-issued diagnostic
reads of parent.document, iframe document.cookie and localStorage all threw due
to the opaque sandbox origin. These privileged Playwright evaluation probes test
origin access; they are **not evidence that email JavaScript executed**.

A separate defense control deliberately inserts raw script/event, stylesheet/
font/background, form, iframe, object and media markup after sanitization while
retaining the default production frame CSP. No trap request, parent modification,
popup or dialog occurred. Clicking its submit and `_top` link could not submit
or navigate the parent. This control is test-only and never reaches a production
endpoint. It is a default-mode CSP/sandbox check, not a claim that consent-mode
CSP alone blocks CSS background requests: after consent, **the CSS sanitizer is
essential**, because CSS images and IMG share img-src.

**Real browser:** the legitimate safe external link opened on an explicit click;
popup `window.opener` was null and Referer absent. **Unit/UI:** link schemes,
target/rel/referrer attributes and per-message permission reset passed.

## 7. CID isolation and raster checks

**New integration:** a CID available only in message B could not resolve in A,
even when B's attachment/blob UUIDs were supplied as extra JSON. Direct
`inlineResource(A, attachmentB, cidB)` rejected. A blob UUID cannot substitute
for an attachment UUID. A valid cached attachment still required owner auth
at the download route. Unreferenced attachments were never queued.

Duplicate CIDs that collide after domain normalization failed without preparing
either part. Missing/malformed percent/NUL references stayed unresolved/inert.
Local identifier case is preserved; domain case is normalized. SVG CID was
ineligible, and SVG bytes labeled image/png failed signature validation. Ordinary
SVG/HTML failed every supported raster-type check; empty buffers failed.

Valid cached PNG CID was embedded without remote consent. **Real browser:** it
decoded at width 1 with zero remote requests. **Integration:** storage errors and
physically corrupted bytes yielded an omitted IMG resource/inline failure;
download returned a generic 503. The database refused blob SHA-256 metadata
mutation, and actual byte corruption was caught against its immutable snapshot.
Existing full integration tests also cover selective CID fetch, cache reuse,
pending/failure handling and related worker behavior.

**Demonstrated limitation:** PNG magic bytes followed by SVG text pass
`isSafeRaster`. This checks a signature, not that the complete file is a valid
raster. The browser rejected that data:image/png payload (naturalWidth 0), with
no script or SVG subresource execution. It cannot be promoted into an SVG/document
context by the current renderer. Do not reuse this helper as a general safe-file
validator, or introduce inline/document endpoints relying on it. Full image
decoding validity and every malformed JPEG/GIF/WebP/AVIF variant were not verified.

Ordinary authenticated attachment downloads are owner-wide and intentionally
addressed by attachment ID. Message isolation applies to automatic CID resolution,
not to preventing the single owner from explicitly downloading another owned
message's attachment.

## 8. Direct API authorization attacks

**New integration:** actual production route functions were invoked with Request
objects, a real Better Auth owner login/session cookie, migrated disposable
PostgreSQL, and actual services/storage. Only application singleton wiring was
replaced. No authentication check was weakened or mocked to accept requests.
This tests handlers directly, not Next's HTTP/proxy serialization layer.

- Missing/guessed sessions: 401 before resource preparation or preference writes.
- Missing, literal null, foreign and origin-prefix-confusion mutation Origin: 403.
  Origin-protected deletion could not revoke a rule; authenticated valid-origin
  deletion normalized case/whitespace and restored blocking.
- Account/mailbox/message substitutions and nonexistent message UUID: 404 before
  trust writes. Invalid/path identifiers: 400. Guessed attachment IDs/blob-as-
  attachment ID: generic unavailable response (download uses 409).
- Render malformed JSON: generic 503; incorrect JSON types/options: 400. Both
  fail closed. Sender DELETE malformed JSON/overlong address: 400.
- Unknown sender/account/attachment/blobPath fields never become capabilities or
  storage paths. A **1 MiB unknown JSON field is accepted and stripped**, with
  images still blocked and no trust write. There is no handler body-size ceiling;
  this is not a demonstrated unauthenticated exploit, because auth runs first.
- Injected filesystem/database error details were absent from render responses;
  real integrity-failure download responses were also generic. Existing route
  tests cover renderer database failures and private/no-store/nosniff success
  headers. No navigable trusted inline document endpoint exists.

Settings GET/DELETE do not catch arbitrary database outages locally; unexpected
exceptions rely on Next's application error boundary. Production HTTP behavior
for such outages was reasoned from code, **not dynamically verified here**.

## 9. Trusted sender attacks

**New unit/integration:** the display name `trusted@example.test` accompanying
`EVIL@Example.Test` resulted only in `evil@example.test` trust. Case variants of
that exact parsed mailbox matched; other mailboxes in its domain, the display-name
address, and the same local part at another domain remained blocked. Multi-address
and group From were ambiguous/untrustable. No extra rule was created from an
ambiguous From. Creation/removal required actual owner session and mutation Origin.

The database key is **address only**, not receiving account + address. A message
with the same exact sender in a different owner account therefore matches the
same rule; a different address does not inherit permission. This existing scope
is explicitly documented rather than changed by this verification.

**From is not cryptographically authenticated.** An attacker forging a previously
trusted From address can trigger that privacy preference. Sender trust is a
privacy convenience, not a security identity boundary. SPF/DKIM/DMARC were not
implemented or evaluated.

## 10. Vulnerabilities discovered

No exploitable bypass of the reviewed HTML/remote-permission/CID authorization
boundary was demonstrated. The signature-only detector, lack of authenticated
JSON size ceiling, cross-account address-preference scope, and reliance on the
framework for settings database errors are explicitly retained limitations.
“No bypass demonstrated” does not mean these implementations have been formally
proved secure.

## 11. Fixes and scope

No production code, policy, schema, migration or runtime endpoint changed.
Added only dedicated fixtures/tests, the dev-only Playwright dependency and
lockfile entries, two package test commands, this report, and an ignored
`.security-results/` artifact directory. No runtime database or mail account was
modified. Since no boundary vulnerability was reproduced, no speculative
sanitizer tightening or before/after production fix was introduced.

## 12. Remaining risks and evidence boundaries

- One Chromium-based browser was tested; Firefox/WebKit/mobile and future engine
  changes are unverified. Finite observation windows are not exhaustive fuzzing.
- Browser testing used production output/policies in a local fixture, not the live
  authenticated application. Proxy CSP attachment is code-reviewed; mounted React
  attributes and state reset are unit/UI-tested; real sessions/API/trust are
  integration-tested. Live IMAP, historical refresh and worker delivery are not
  end-to-end browser claims.
- The user's previously reported real-world opening of HTTP-image email produced
  zero remote requests before Load images, and one-message/persistent sender
  permission behaved correctly. This remains **user-manually verified** evidence;
  this review did not repeat it against the user's mailbox.
- Signature checks do not validate full raster structure. Browser image decoders
  and current DOMPurify/JSDOM/PostCSS versions remain part of the trusted base.
- Sanitizer CPU/memory, huge JSON bodies and cumulative many-CID render size were
  not load-tested. Existing per-part/blob size bounds are not an aggregate response
  or request-body budget.
- Consent allows the remote IMG's host and redirect destinations to learn network
  information. Private-network destinations/redirect host restrictions and
  authenticating sender identity are outside the existing Phase 2H model.
- CSS privacy after image consent depends on continued CSS filtering. Stored-v2
  HTML/data attributes are trusted only as sanitizer output; arbitrary raw HTML
  must never be sent directly to `renderEmailDocument` in production.
- No production HTTP outage/error-leak simulation, successful local HTTPS image
  serving, DNS packet capture or dependency-advisory audit was performed. Removed
  resource hints plus zero browser request attempts were observed, not all possible
  OS/network side channels.

## 13. Automated results and reproduction

Final verification environment: Windows, Node **24.19.0**, pnpm **11.19.0**
(workspace declares pnpm 12.6.0), Docker PostgreSQL **18.6-bookworm** and Edge
**154.0.4258.48**. Existing runtime dependency versions were unchanged.

| Command                      | Final result                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                  | Passed, no diagnostics.                                                                                                                                                                                         |
| `pnpm typecheck`             | Passed, web and worker TypeScript.                                                                                                                                                                              |
| `pnpm test`                  | Passed: **519 tests, 46 files**, including existing integration suites and 34 new security tests.                                                                                                               |
| `pnpm build`                 | Passed: optimized Next build, TypeScript, page generation, worker compilation and import rewriting. Process-local `APP_ORIGIN=https://maildock.test`; local .env unchanged.                                     |
| `pnpm test:security`         | Passed: **34 tests, 2 files** (19 adversarial + 15 real session/API/DB/blob).                                                                                                                                   |
| `pnpm test:security:browser` | Passed: six fixtures in both permission states, CID/polyglot check, raw defense control, opaque-origin probes and explicit safe-link popup. Default **0/0** received/attempted; consent **11/12**, only images. |
| `git diff --check`           | Passed.                                                                                                                                                                                                         |

Early harness runs exposed test-tool issues (tsx function instrumentation,
TypeScript narrowing, URL percent-encoding expectations, actual 409 download
semantics and immutable blob metadata); these were corrected in test tooling.
They were not production bypasses. All final results above are passing runs.

Run with the repository's supported Node 24 runtime:

```sh
pnpm test:security
pnpm test:security:browser
```

On Windows the browser command defaults to installed Edge. Elsewhere install
Playwright Chromium as test tooling (`pnpm exec playwright install chromium`).
`SECURITY_BROWSER_EXECUTABLE` can select an existing Chromium-family executable.
No browser is downloaded into the production image by these scripts.
Integration tests require Docker and create disposable databases/blob directories.
Browser JSON evidence is regenerated at `.security-results/browser.json`.
