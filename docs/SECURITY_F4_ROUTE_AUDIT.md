# F4 route audit

Inventory of current source before implementation. Every application endpoint is browser-facing except public health probes. OAuth start/callback GETs are protocol operations (pending state/account connection), not ordinary read-only GETs. No explicit HEAD/OPTIONS/TRACE exports exist; Next supplies HEAD for GET and OPTIONS handling.

| Route | Method | Authentication | Previous Origin boundary | Previous body policy | Classification after fix |
| --- | --- | --- | --- | --- | --- |
| /api/accounts/[id]/conversations/[conversationId] | GET | Owner session | None | No body | Read-only |
| /api/accounts/[id]/enabled | PATCH | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id]/mailbox-roles/[role] | PUT | Owner session | None | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id]/mailbox-roles/[role] | DELETE | Owner session | None | No body | A: application mutation |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/actions | POST | Owner session | None | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/content | POST | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/prepare | POST | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/render | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId] | GET | Owner session | None | No body | Read-only |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages/refresh | POST | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/accounts/[id]/mailboxes/[mailboxId]/messages | GET | Owner session | None | No body | Read-only |
| /api/accounts/[id]/mailboxes/discover | POST | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/accounts/[id]/mailboxes | GET | Owner session | None | No body | Read-only |
| /api/accounts/[id]/message-commands | GET | Owner session | None | No body | Read-only |
| /api/accounts/[id]/order | PATCH | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id] | GET | Owner session | None | No body | Read-only |
| /api/accounts/[id] | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id] | DELETE | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/accounts/[id]/settings | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id]/signatures | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/[id]/test | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts | GET | Owner session | None | No body | Read-only |
| /api/accounts | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/accounts/test | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/application-events | GET | Owner session | None | No body | Read-only |
| /api/attachments/[attachmentId]/download | GET | Owner session | None | No body | Read-only |
| /api/attachments/[attachmentId] | GET | Owner session | None | No body | Read-only |
| /api/attachments/[attachmentId] | POST | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/attachments/staged/[attachmentId] | GET | Owner session | None | No body | Read-only |
| /api/attachments/staged/[attachmentId] | DELETE | Owner session | Opt-in exact Origin | No body | A: application mutation |
| /api/attachments/staged | POST | Owner session | Opt-in exact Origin | Binary | A: application mutation |
| /api/auth/[...all] | GET | Optional session lookup | Better Auth | No body | B: Better Auth |
| /api/auth/[...all] | POST | Login public; logout session cookie | Better Auth | Better Auth JSON | B: Better Auth |
| /api/drafts/[id] | GET | Owner session | None | No body | Read-only |
| /api/drafts/[id] | PATCH | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/drafts/[id] | DELETE | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/drafts/[id]/send | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/drafts | GET | Owner session | None | No body | Read-only |
| /api/drafts | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/health/live | GET | Public | None | No body | D: health probe |
| /api/health/ready | GET | Public | None | No body | D: health probe |
| /api/mail/all-inboxes | GET | Owner session | None | No body | Read-only |
| /api/notifications | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/oauth/google/callback | GET | Owner session | OAuth state/PKCE | No body | C: OAuth protocol |
| /api/oauth/google/start | GET | Owner session | OAuth state/PKCE | No body | C: OAuth protocol |
| /api/oauth/microsoft/callback | GET | Owner session | OAuth state/PKCE | No body | C: OAuth protocol |
| /api/oauth/microsoft/start | GET | Owner session | OAuth state/PKCE | No body | C: OAuth protocol |
| /api/outgoing/[id] | GET | Owner session | None | No body | Read-only |
| /api/outgoing | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/search | GET | Owner session | None | No body | Read-only |
| /api/settings/auto-read | GET | Owner session | None | No body | Read-only |
| /api/settings/auto-read | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/settings/conversation-view | GET | Owner session | None | No body | Read-only |
| /api/settings/conversation-view | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/settings/notifications | GET | Owner session | None | No body | Read-only |
| /api/settings/notifications | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/settings/oauth-providers | GET | Owner session | None | No body | Read-only |
| /api/settings/oauth-providers | PUT | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/settings/remote-content-senders | GET | Owner session | None | No body | Read-only |
| /api/settings/remote-content-senders | DELETE | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/setup | GET | Public | None | No body | B: setup status |
| /api/setup | POST | Bootstrap secret | Explicit exact Origin | Bounded JSON / URL-encoded / multipart form | B: first-run setup |
| /api/signatures/[id] | GET | Owner session | None | No body | Read-only |
| /api/signatures/[id] | PATCH | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/signatures/[id] | DELETE | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/signatures/[id]/snapshot | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |
| /api/signatures | GET | Owner session | None | No body | Read-only |
| /api/signatures | POST | Owner session | Opt-in exact Origin | JSON; no media-type constraint | A: application mutation |

## Result and root cause

F4 is CLOSED in the working tree, subject to the validation recorded below. No commit, amend, push or history rewrite was performed. HEAD includes both requested F1/F3 baseline commits (e2363cd and d84603e).

The previous access checker defaulted its mutation boolean to false. The message-action POST and mailbox-role PUT/DELETE omitted that boolean, so authenticated requests could reach business operations without Origin validation. JSON readers also accepted text/plain bodies. The inventory above was generated from current route source before edits, not PHASE documentation.

There are 68 exported methods across 49 route files: 31 GET, 19 POST, 8 PUT, 4 PATCH and 6 DELETE. All 37 unsafe exports have a reviewed boundary: 35 use the application policy (A), one is Better Auth POST (B), and one is setup POST (B). There are no unclassified unsafe exports. OAuth comprises four explicit GET protocol endpoints (C); public health probes are category D. Explicit HEAD/OPTIONS exports are absent. Framework-generated HEAD/OPTIONS do not introduce a mutation handler.

## Fail-closed policy

requireOwnerApiAccess(request) delegates to checkOwnerApiAccess(auth, config, request), without a mutation argument. The checker first verifies the owner session and its absolute expiry. Every method except GET, HEAD and OPTIONS then requires an Origin header exactly equal to configured APP_ORIGIN. Unknown methods are treated as unsafe too. Missing, null, sibling, mismatched scheme/port or trailing-slash Origin fails; neither Referer nor Host substitutes for it. Existing canonical configuration and exact comparison are unchanged.

An invalid session returns 401; invalid Origin returns 403 before body parsing, business mutations, queue calls or provider actions. There is no skipOrigin flag or generic exception option. Application routes must call the guard before any application work. The architectural test enumerates current route functions, requires that ordering and rejects an unreviewed method export; exact reviewed protocol/bootstrap/public entries are listed explicitly.

GET reads remain usable without Origin. A message-detail read may persist derived attachment metadata as cache maintenance; it does not change user mail state or invoke IMAP/SMTP mutations. Session validation may perform Better Auth session maintenance, which is separate from application business effects.

## Explicit boundaries and exceptions

- Better Auth: the catch-all exposes only GET get-session and POST sign-in/username or sign-out. Better Auth 1.7.5 owns CSRF validation and its application/json router. Local installed source was inspected: dist/api/middlewares/origin-check.mjs and dist/api/index.mjs. Cookie-bearing unsafe requests require a trusted Origin or Referer under Better Auth's own policy. trustedOrigins remains exactly [APP_ORIGIN]. disableOriginCheck and disableCSRFCheck are now explicitly false, including tests; upstream otherwise defaults Origin checks off in a test runtime. Its login protocol is intentionally not wrapped in an owner-session check. Better Auth may accept a trusted Referer, unlike the stricter application policy.
- Setup: POST requires the bootstrap secret, exact Origin, first-run availability and bounded existing JSON/form parsing. The 4096-byte streaming limit, timeout, attempt limiting and concurrency controls are unchanged; the complete existing F1/F3 regressions pass. GET reports initialization status publicly.
- Google/Microsoft OAuth: start and callback are authenticated protocol navigation. Start creates 32 random bytes of state and S256 PKCE; the callback requires the current owner session, provider/session-bound state and a 10-minute expiry. State is consumed atomically via DELETE ... RETURNING before token exchange, making it single-use. PKCE code verifiers are encrypted in storage. A callback does not need Maildock Origin because external-provider navigation is legitimate. Both providers' algorithms were inspected and left intact. Comments on all four route files identify the boundary; existing provider and route regressions cover expiry, binding, replay and legitimate callbacks without Origin.
- Health: GET live/ready are intentionally public probes and carry no application mutation.

## Content-Type changes

26 JSON-consuming application methods now check application/json before parsing. Comparison is case-insensitive, trims whitespace, and accepts parameters such as charset=utf-8. text/plain, missing Content-Type, forms, fabricated application/json-evil and unneeded +json variants return 415. The application currently sends application/json and needs no additional JSON media types.

POST accounts/[id]/test retains its optional body: a bodyless request tests saved credentials without requiring a JSON header; a supplied body must be JSON. Raw staged-attachment uploads keep binary media types. Bodyless mutation endpoints do not require a JSON header. Setup keeps its intentionally supported forms and bounded parser; outgoing and draft streaming byte limits are preserved.

## Tests added and updated

- tests/security/mutation-policy.integration.test.ts adds 18 regression cases using actual Request/Response route handlers, the real access checker, Better Auth signed login/session cookies, owner provisioning and PostgreSQL. Only downstream business services are mocked so side-effect absence can be asserted. It covers POST/PUT/PATCH/DELETE, a nonstandard unsafe PROPFIND, safe GET/HEAD/OPTIONS without Origin, missing/forged/null/sibling Origin, message-action text/plain and other media types, valid parameterized JSON, role PUT/DELETE, optional-body diagnostics, and real auth login/session/logout.
- tests/security/route-policy.test.ts adds one lightweight architectural inventory regression with an exact reviewed-boundary list and checks guard/media-type ordering.
- Existing access-helper mocks/assertions were adapted to the new flag-free API; phase0 and authorization integration tests now exercise the default policy. Their rejection and business assertions were retained. One account-creation error fixture gained the legitimate JSON header so it continues checking error redaction after media-type validation.
- Existing bootstrap, Google/Microsoft OAuth, signatures, notifications, compose/drafts, attachments and account suites were run as part of the full suite.

## Validation

Runtime: Node 24.19.0, satisfying the repository's Node 24 requirement; dependencies and lockfile were not modified. PostgreSQL integration tests used Docker test containers.

- Focused security and related integration suites: 10 files, 149 tests passed. Command: node node_modules/vitest/vitest.mjs run tests/security tests/phase0.integration.test.ts tests/phase1f.integration.test.ts tests/google-oauth.integration.test.ts tests/google-oauth-routes.test.ts tests/account-provider-flow.test.ts.
- Full suite: 77 files, 906 tests passed on the final tree (node node_modules/vitest/vitest.mjs run).
- pnpm typecheck: passed for application and worker.
- pnpm lint: passed, zero errors; one pre-existing unused writeFile warning in ignored .security-results/signature-settings-preview.mjs.
- pnpm build: passed, including Next production compilation and worker compilation/import fix. The first attempt was blocked by local .env APP_ORIGIN=http in production; final validation used process-only APP_ORIGIN=https://localhost:3000. No environment file was edited.
- git diff --check: passed.
- Final searches found no boolean mutation flags in application guard call sites. Authentication, exact Origin logic, setup bounds and OAuth state/PKCE were reviewed for accidental weakening.

Logs are in ignored .security-results/f4-focused.log, f4-full-suite.log, f4-typecheck.log, f4-lint.log and f4-build.log.

## Remaining assumptions and findings

No new security vulnerability outside F4 was confirmed. This was a focused white-box review of current API routes, not a complete re-audit of MFA or other findings. Correct APP_ORIGIN configuration remains required. Nonbrowser clients performing application mutations must send that exact Origin. Better Auth retains its own protocol semantics rather than the application's stricter missing-Origin rule.

Integration regressions invoke real route handlers directly rather than opening a TCP server/browser. Signed session validation and PostgreSQL are real; affected business effects are mocked for rejection assertions, and existing service/provider integration suites provide broader coverage. This task did not test live external-provider consent or live IMAP/SMTP services. The architectural test protects the current route declaration convention and is intentionally lightweight, not a general source-code security proof.

## Changed files

- docs/SECURITY_F4_ROUTE_AUDIT.md
- src/app/api/accounts/[id]/enabled/route.ts
- src/app/api/accounts/[id]/mailbox-roles/[role]/route.ts
- src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/actions/route.ts
- src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/content/route.ts
- src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/prepare/route.ts
- src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/render/route.ts
- src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/refresh/route.ts
- src/app/api/accounts/[id]/mailboxes/discover/route.ts
- src/app/api/accounts/[id]/order/route.ts
- src/app/api/accounts/[id]/route.ts
- src/app/api/accounts/[id]/settings/route.ts
- src/app/api/accounts/[id]/signatures/route.ts
- src/app/api/accounts/[id]/test/route.ts
- src/app/api/accounts/route.ts
- src/app/api/accounts/test/route.ts
- src/app/api/attachments/[attachmentId]/route.ts
- src/app/api/attachments/staged/[attachmentId]/route.ts
- src/app/api/attachments/staged/route.ts
- src/app/api/auth/[...all]/route.ts
- src/app/api/drafts/[id]/route.ts
- src/app/api/drafts/[id]/send/route.ts
- src/app/api/drafts/route.ts
- src/app/api/notifications/route.ts
- src/app/api/oauth/google/callback/route.ts
- src/app/api/oauth/google/start/route.ts
- src/app/api/oauth/microsoft/callback/route.ts
- src/app/api/oauth/microsoft/start/route.ts
- src/app/api/outgoing/route.ts
- src/app/api/settings/auto-read/route.ts
- src/app/api/settings/conversation-view/route.ts
- src/app/api/settings/notifications/route.ts
- src/app/api/settings/oauth-providers/route.ts
- src/app/api/settings/remote-content-senders/route.ts
- src/app/api/signatures/[id]/route.ts
- src/app/api/signatures/[id]/snapshot/route.ts
- src/app/api/signatures/route.ts
- src/modules/auth/application/api-access-check.ts
- src/modules/auth/application/api-access.ts
- src/modules/auth/application/json-media-type.ts
- src/modules/auth/infrastructure/auth-factory.ts
- tests/account-order-api.test.ts
- tests/account-provider-flow.test.ts
- tests/account-settings-api.test.ts
- tests/attachment-api.test.ts
- tests/auto-read-api.test.ts
- tests/compose-preparation-api.test.ts
- tests/draft-api.test.ts
- tests/email-rendering-api.test.ts
- tests/outgoing-api.test.ts
- tests/phase0.integration.test.ts
- tests/security/authorization.integration.test.ts
- tests/security/mutation-policy.integration.test.ts
- tests/security/route-policy.test.ts

## Diff summary

Standard git diff --stat (tracked files): 50 files changed, 160 insertions(+), 64 deletions(-). Four new unstaged/untracked files are listed above and are not included by that Git command: this audit, the JSON media-type helper, and the two new regression files. No changes were staged or committed.
