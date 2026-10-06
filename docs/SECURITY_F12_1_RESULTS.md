# F12.1: request-body integrity and native diagnostic boundary

Review date: 2026-10-06, Europe/Warsaw. Scope: F12-01 and F12-02 only.

## 1. Baseline and scope

Baseline HEAD: `908859ed596c2eda2f956377b084b939626ae272` (`security: establish safe diagnostic boundaries`). Repository: `mkilinskidev/Maildrop`; workspace: `D:\Projects\JS\Maildock`.

`docs/SECURITY_F12_DISCOVERY.md` was authoritative input and already untracked on entry. It was not edited. F1-F11 were not redesigned. F12-03 through F12-06 were not implemented. No commit, push, deployment, real mail account, or external mail provider was used. Automated tests were explicitly requested for this session.

**F12-01 and F12-02 pass the focused production-image and automated regressions. F12 as a whole remains open.**

## 2. Reproduction and root cause

The retained baseline image `maildock-f12-review:908859e` was started with disposable PostgreSQL 18.6, synthetic secrets, and `https://f12.invalid`. Before changing application code:

- `POST /api/setup?f12=F12_1_BEFORE_QUERY_CANARY` with an 11 MiB synthetic JSON body returned 413, and the exact marker appeared in container **stderr**. Separate stdout/stderr captures are retained under `.security-results/f12/before.*.log`.
- Real setup, initial MFA enrollment, password login, and TOTP login established a business session. An 11,534,336-byte staged upload returned **201**, but the database and disk contained only **10,484,541 bytes**. The discovery report observed 10,455,620 bytes; chunk boundaries account for the different truncated lengths.

The framework drops the entire chunk crossing its ceiling, rather than forwarding exactly the first 10 MiB. Its normal EOF lets storage hash and publish a shorter file successfully. The storage hash is correct for those shortened bytes, but cannot prove the original request survived an upstream truncation.

## 3. Exact installed Next 16.3.6 mechanism

Inspected the installed package and configuration types, not another Next release:

- `dist/server/config-shared.d.ts`: `experimental.proxyClientMaxBodySize` is a `SizeLimit`, accepting a byte number or size string, with a documented 10 MiB default. `middlewareClientMaxBodySize` is deprecated.
- `dist/server/config-schema.js` and `dist/server/config.js`: the size is normalized using the bundled `bytes` parser for strings. Numbers are accepted; normalization rejects NaN and values below one. Setting both old and new options is rejected. There is no supported overflow-rejection or URL-warning-redaction switch.
- `dist/server/lib/router-utils/resolve-routes.js` constructs `clonableBody` request metadata using this limit. Constructing the object alone does not attach its data consumer or buffer the body.
- `dist/server/next-server.js`, `runMiddleware`: matching Node proxy requests other than GET/HEAD call `cloneBodyStream()` **before** calling the application proxy adapter. `finalize()` runs in `finally` before forwarding to the route.
- `dist/server/body-streams.js`, `getCloneableBody`: a `data` listener pushes chunks into a PassThrough clone and a separate Readable replay buffer. It ignores backpressure. This is **eager memory buffering, not disk spooling**. On overflow, the original implementation includes `readable.url` in `console.warn`, pushes normal EOF to both clones, drains/discards subsequent bytes, and later replaces the original request with the shortened replay stream.
- `src/proxy.ts` originally matched the staged upload and public setup/auth routes, so this clone stood ahead of their route-level guards and readers even though Maildock's proxy never reads a body.
- Next's `handleCatchallMiddlewareRequest` catches errors from `runMiddleware` itself. It normally logs the error and renders 500; an outer `router-server.js` catch is too late to select 413 for this path.

Corresponding ESM implementations were inspected and patched consistently with CJS. The actual production server uses the installed patched CJS implementation.

## 4. Selected design and alternatives

The architecture has two finite body boundaries:

1. **Canonical raw staged upload:** exclude only `/api/attachments/staged` (including its trailing slash form) from the supported proxy matcher. The route already checks the business session and exact Origin before reading. Its body streams directly through the route to `LocalBlobStorage`, which enforces the configured 15 MiB default / 100 MiB supported maximum by counting actual bytes.
2. **Every other proxy-matched request:** explicitly retain the **10,485,760-byte** framework ceiling. A minimal pinned Next patch rejects overflow before replay/route invocation, returns a fixed **413**, and replaces the native URL-bearing warning with a fixed diagnostic.

The framework ceiling is intentionally **not an upload ceiling**. A staged request exceeding 10 MiB is valid up to its application limit because it never enters the clone. All body-reading V1 routes other than staged upload remain behind the finite clone ceiling. The largest explicit proxied application wire allowance is 3,100,000 bytes, leaving 7,385,760 bytes of headroom. Ordinary settings/account JSON has small bounded semantic fields and remains subject to the 10 MiB transport cap; arbitrary padding or unused JSON properties do not require a larger supported wire contract.

Rejected alternatives:

- Infinity or an arbitrary large ceiling: retains truncation/disclosure and increases eager unauthenticated buffering.
- A 100+ MiB framework ceiling: unnecessary when uploads can bypass cloning through a supported matcher; would buffer large unauthenticated bodies before existing application guards.
- 150 MiB: this is the maximum **server-generated outgoing MIME** allowance, not an HTTP upload size.
- Reducing attachments to 10 MiB: breaks the documented default and supported configuration.
- Excluding all API routes or disabling proxy: unnecessarily changes page/API defense layers. Only the independently guarded raw-body endpoint is excluded.
- Content-Length-only rejection: cannot protect chunked bodies or replace stream completion/count/hash checks.
- Global console monkeypatches, suppression of all Next warnings, or an ingress-only fix: would weaken the diagnostic/application guarantees.
- A dependency patch alone with a 10 MiB clone: rejects legitimate uploads above 10 MiB. Raising that clone without changing its eager buffering would create an avoidable larger memory boundary.

Supported matcher/configuration mechanisms solve the upload architecture, but cannot redact native warnings or reject native clone overflow. The remaining patch is therefore necessary and limited to `body-streams.js` and the middleware error handler in `next-server.js`, in CJS and ESM.

## 5. Complete V1 request-body model

All paths below are relative to `/api`. `J` means the existing JSON media-type check (`application/json`, with its existing parameter handling); `P` means the finite 10,485,760-byte proxy ceiling, now rejecting overflow. Unless specified, there is no application body-read deadline. The proxy clone buffers before the application reader; deadlines in public readers begin at application invocation, not at first ingress byte.

| Class and exact route/method                                                                                                                                                                                                                                                                                         | Media type / reader                                                                     | Application body bytes and deadline                                                                           | Maximum supported HTTP body / handling                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public `setup POST`                                                                                                                                                                                                                                                                                                  | J, bounded byte reader                                                                  | 4,096; 10 seconds                                                                                             | 4,096; fixed 4 KiB application buffer plus P; bootstrap/Origin/admission unchanged                                                                                           |
| Public `auth/sign-in/username POST` through `auth/[...all]`                                                                                                                                                                                                                                                          | J, `initialMfaHttp`                                                                     | 4,096; 10 seconds                                                                                             | 4,096; strict username/password parser and F8 admission unchanged                                                                                                            |
| `auth/initial-mfa/start POST`, `auth/initial-mfa/complete POST`                                                                                                                                                                                                                                                      | J, `initialMfaHttp`                                                                     | 4,096; 10 seconds                                                                                             | 4,096; owner/bootstrap/ceremony checks unchanged                                                                                                                             |
| `auth/mfa/totp POST`, `auth/mfa/recovery POST`, `auth/mfa/cancel POST`                                                                                                                                                                                                                                               | J, `initialMfaHttp`                                                                     | 4,096; 10 seconds                                                                                             | 4,096; password-challenge/admission/empty-object rules unchanged                                                                                                             |
| `auth/mfa/manage/authenticator/start POST`, `resume POST`, `complete POST`; `auth/mfa/manage/recovery/regenerate POST`                                                                                                                                                                                               | J, `initialMfaHttp`                                                                     | 4,096; 10 seconds                                                                                             | 4,096; authenticated management/replacement proof and transaction rules unchanged                                                                                            |
| `auth/sign-out POST` through `auth/[...all]`                                                                                                                                                                                                                                                                         | Bodyless or J if a body exists; body is not parsed                                      | No separate byte counter/deadline                                                                             | Bodyless protocol; supplied unused body bounded by P. Existing Origin/session/revocation semantics unchanged                                                                 |
| Other `auth/[...all] POST` suffixes                                                                                                                                                                                                                                                                                  | Rejected by existing allowlist; no application read                                     | No accepted protocol                                                                                          | 404 below P / 413 above P; no new auth endpoint enabled                                                                                                                      |
| `attachments/staged POST`                                                                                                                                                                                                                                                                                            | Raw file, existing content-type normalization and inline raster validation; Node stream | `MAILDOCK_MAX_ATTACHMENT_BYTES`: default 15,728,640; allowed 1,024..104,857,600; no application read deadline | Exactly the configured limit, no JSON/base64/multipart overhead. Streams to a temporary disk file with actual byte counting; **no proxy clone**                              |
| `outgoing POST`                                                                                                                                                                                                                                                                                                      | J, counted chunks then JSON                                                             | 3,100,000; no application deadline                                                                            | 3,100,000 including all JSON/UTF-8/escaping overhead; UUID references to attachments, not embedded attachment bytes                                                          |
| `drafts POST`; `drafts/[id] PATCH, DELETE`; `drafts/[id]/send POST`                                                                                                                                                                                                                                                  | J, `readDraftRequest`                                                                   | 3,100,000; no application deadline                                                                            | 3,100,000 including encoding/JSON overhead; overflow retains existing 400 validation response below P                                                                        |
| `signatures POST`; `signatures/[id] PATCH, DELETE`; `signatures/[id]/snapshot POST`; `accounts/[id]/signatures PUT`                                                                                                                                                                                                  | J, `readDraftRequest`                                                                   | 3,100,000; no application deadline                                                                            | 3,100,000 including rich-document JSON/escaping overhead; same existing validation behavior                                                                                  |
| `accounts POST`; `accounts/test POST`; `accounts/[id] PUT`                                                                                                                                                                                                                                                           | J, `request.json()`                                                                     | Semantic account/connection schema; no separate byte counter/deadline                                         | P. Two password fields max 4,096 characters each; usernames/hosts/identity fields bounded. Compact schema-valid encoding, even with six-byte JSON escapes, fits below 64 KiB |
| `accounts/[id]/test POST`                                                                                                                                                                                                                                                                                            | Bodyless or J; `request.text()` then JSON                                               | Same connection/credential validation; no separate counter/deadline                                           | P; saved-credential bodyless operation remains valid                                                                                                                         |
| `accounts/[id]/enabled PATCH`; `accounts/[id]/order PATCH`; `accounts/[id]/mailbox-roles/[role] PUT`; `accounts/[id]/settings PUT`                                                                                                                                                                                   | J, `request.json()`                                                                     | Bounded booleans/order/UUIDs/identity/folder/signature settings; no separate counter/deadline                 | P; compact semantic body well below 64 KiB                                                                                                                                   |
| `accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/actions POST`                                                                                                                                                                                                                                              | J, `request.json()`                                                                     | Strict single action enum; no separate counter/deadline                                                       | P; no message content/attachment bytes in request                                                                                                                            |
| Same message prefix, `render POST`                                                                                                                                                                                                                                                                                   | J, `request.json()`                                                                     | `loadImages`/`trustSender` booleans; no separate counter/deadline                                             | P; rendering output is a response, not request body                                                                                                                          |
| `notifications POST`                                                                                                                                                                                                                                                                                                 | J, `request.json()`                                                                     | Strict `start`/`poll` enum; no separate counter/deadline                                                      | P                                                                                                                                                                            |
| `settings/auto-read PUT`; `settings/conversation-view PUT`; `settings/notifications PUT`                                                                                                                                                                                                                             | J, `request.json()`                                                                     | Small existing preferences schemas; no separate counter/deadline                                              | P                                                                                                                                                                            |
| `settings/remote-content-senders DELETE`                                                                                                                                                                                                                                                                             | J, `request.json()`                                                                     | Address max 320 characters; no separate counter/deadline                                                      | P                                                                                                                                                                            |
| `settings/oauth-providers PUT`                                                                                                                                                                                                                                                                                       | J, `request.json()`                                                                     | Existing provider/client ID/client secret schema; no separate counter/deadline                                | P; provider configuration only, not an OAuth callback POST                                                                                                                   |
| Bodyless mutations: `accounts/[id] DELETE`; `accounts/[id]/mailbox-roles/[role] DELETE`; `accounts/[id]/mailboxes/discover POST`; `accounts/[id]/mailboxes/[mailboxId]/messages/refresh POST`; message `content POST`, `prepare POST`; `attachments/[attachmentId] POST`; `attachments/staged/[attachmentId] DELETE` | No application body read                                                                | No semantic request body                                                                                      | Normal wire body is zero; unexpected supplied bodies still bounded by P                                                                                                      |
| OAuth Google/Microsoft `start`, `callback`                                                                                                                                                                                                                                                                           | GET only                                                                                | No request body / no POST handler                                                                             | State/PKCE/owner protections unchanged; provider-related PUT inventoried above                                                                                               |
| Other API GET routes / automatic HEAD / unsupported methods                                                                                                                                                                                                                                                          | No V1 body-reading mutation protocol                                                    | No accepted request body                                                                                      | No new route, method, multipart endpoint, or server action introduced                                                                                                        |

Inventory covers all 42 mutation route files and their exported POST/PUT/PATCH/DELETE methods. Bodyless mutations are included to account for unexpected caller bodies. No route was broadly rewritten merely because it uses `request.json()`.

The 100 MiB outgoing-attachment aggregate and 150 MiB outgoing-MIME configuration maxima apply to stored attachments selected by UUID and MIME constructed on the server/worker. They are not JSON/base64 HTTP uploads. Incoming provider base64/transfer decoding likewise is not an HTTP V1 request path. There is no multipart FormData upload; filename/disposition/draft ID travel in headers, outside the raw body count. JSON wire counters include escaping and UTF-8 bytes, not just parsed string lengths.

## 6. Upload integrity and preserved controls

The storage implementation was not changed. It consumes the route's actual asynchronous stream, counts each accepted chunk once, hashes those same bytes, handles partial filesystem writes, fsyncs, closes, atomically renames, and syncs the destination directory where supported. Overflow or source failure exits before publication and removes the temporary file. `AttachmentService.upload` registers the completed blob/staged attachment in its existing transaction; ready/201 follows storage completion and registration.

The excluded endpoint retains its first-operation `requireOwnerApiAccess` guard, which validates the immutable owner/business session and exact Origin for mutations. Authentication, MFA readiness, UUID storage keys, configured attachment limit, content-type normalization, inline-image validation, and transaction semantics are unchanged. The route produces JSON, so bypassing the page nonce/CSP proxy does not introduce an HTML rendering path; configured nosniff/referrer/frame headers remain. Every other page/API retains its proxy coverage. Route-policy regression inventories the upload guard independently.

Successful acceptance means every byte of the **HTTP-framed request body** reached the storage counter/hash/publication path. Content-Length is not used to accept or hash uploads; chunked uploads receive identical storage enforcement. Incomplete declared-length and chunked transports propagate source failure and do not publish a staged row.

HTTP framing matters: bytes following a smaller Content-Length are the next HTTP message, not discoverable extra bytes of the first body. The raw TCP regression sends a smaller declaration with a malformed suffix; Node returns 400, no 201, and no staged row is published. This does not claim an application can identify an otherwise valid subsequent pipelined request as belonging to a preceding body, or infer bytes a client never delivered. A client disconnect after a completely delivered body is also distinct from an incomplete body.

## 7. Native diagnostic fix and patch delivery

On clone overflow, the patched dependency records `NEXT_PROXY_BODY_TOO_LARGE`; `finalize()` throws before replacing the original request with its truncated replay. The middleware catch handles only this code and sends 413 with `Request body is too large.`. Other Next error handling remains intact.

The single overflow warning becomes:

```text
Request body exceeded the configured proxy limit; rejecting request.
```

No Request, URL, query, body, or attacker-controlled diagnostic field is passed to it. No global console monkeypatch or broad warning suppression was added. This closes the established body-clone diagnostic path, not all arbitrary framework diagnostics.

Patch: `patches/next@16.3.6.patch`, scoped to four generated files (two mechanisms, CJS/ESM). `pnpm-workspace.yaml` pins `next@16.3.6` in `patchedDependencies`; pnpm regenerated the lockfile's patch hash and dependent snapshot references. SHA-256: `c6de0ed836e1f0915ff0ae22ca969bf11f17dc581fa52b201ea264d9cf24c7fb`.

The existing Dockerfile already copies `patches` **before** frozen dependency installation, then carries the installed dependency into standalone and worker runtime trees. No Dockerfile change was necessary. `.dockerignore` now excludes `.security-results`, keeping disposable probe inputs, logs, and the temporary Next patch checkout out of the build context. This is not a redesign of final dependency pruning (F12-04).

## 8. Resource and memory implications

No 100+ MiB unauthenticated clone was introduced. Proxied requests retain their previous 10 MiB ceiling; each clone/replay queue can retain up to that bounded prefix, with stream/object/Request conversion and parsing overhead. The patched overflow still drains/discards the remainder and rejects after source completion, as the old finalization path awaited completion. It does not add a new early-connection cutoff, clone deadline, or global concurrency limit.

Public setup/login/MFA retain their 4 KiB application buffers, 10-second application deadlines, and existing database-backed admission controls. The framework sees and buffers bytes first on those routes, as before. The application deadline does not bound the preceding eager clone stage. This residual pre-guard 10 MiB work/concurrent-request cost is **unchanged**, rather than expanded to 100/150 MiB. Ingress/connection/time limits remain defense in depth, not the upload integrity mechanism.

The staged path no longer attaches the clone's eager `data` listener. Inspection of the installed Node request adapter shows the original IncomingMessage passed as the Request body; the upload route uses `Readable.fromWeb` and storage awaits each disk write. There is no request-sized replay array or Buffer.concat in this upload path. The raw body is streamed into its bounded temporary file. Small stream queues/conversion buffers exist; inline-image validation may subsequently read the completed file, as before. Total disk growth/concurrency/inline validation budgets are existing application/operator concerns, not new unbounded pre-auth clone storage.

The production probe deliberately buffers synthetic expected/persisted bytes in its **separate test process** to compare SHA-256. That is test memory, not evidence of server buffering. Resource conclusions here come from the exact installed execution path and its queues; no OOM, slow-disk, or concurrency load benchmark is claimed.

## 9. Actual production image validation

Built the real Dockerfile with frozen installation and the patch, Next standalone output, and compiled worker. Final local image: `maildock-f12-1:local`, linux/amd64; image ID/manifest-list digest `sha256:925a5be97d1c2eb4cb1fe6c7ef2e2ed4103876ffaa959f281af52c1e604dd894`. Runtime Node 24.21.0 / Next 16.3.6. No ports were published by the test runner.

The automated image runner created uniquely named disposable PostgreSQL/network/blob volume, started the normal all-role entrypoint, waited for readiness, rejected oversized setup before initialization, completed real setup + initial MFA + password/TOTP business login, and ran the following through the production Next server. It inspected the database, actual filesystem sizes, persisted SHA-256, and expected SHA-256 for every successful upload:

| Probe                                                                            | Result                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1,024-byte upload                                                                | 201; response, DB, disk size and hash exact                                 |
| 10 MiB - 1 = 10,485,759                                                          | 201; size/hash exact                                                        |
| 10 MiB = 10,485,760                                                              | 201; size/hash exact                                                        |
| 10 MiB + 1 = 10,485,761                                                          | 201 on staged path; size/hash exact, proving bypass of clone ceiling        |
| 11 MiB = 11,534,336                                                              | 201; size/hash exact; original defect fixed                                 |
| Default 15 MiB = 15,728,640                                                      | 201; size/hash exact                                                        |
| 11 MiB chunked                                                                   | 201; size/hash exact                                                        |
| Default limit + 1, fixed-length and chunked                                      | 413; no staged publication; no leftover temporary file                      |
| No business session / foreign Origin                                             | 401 / 403; no publication                                                   |
| Declared 2,048 bytes, send 1,024 and disconnect                                  | Client ECONNRESET; no publication; asynchronous temporary cleanup completed |
| Incomplete chunked client disconnect                                             | Client ECONNRESET; no publication; temporary cleanup completed              |
| Declared length smaller than sent, malformed next-message suffix                 | Native HTTP parser 400; no 201 or staged publication                        |
| Proxied setup, 10 MiB + 1, plain query marker                                    | Fixed 413; marker absent from stdout and stderr                             |
| Same, percent-encoded marker                                                     | Fixed 413; encoded and decoded markers absent from both streams             |
| Same, encoded newline/CR/ESC attempt                                             | Fixed 413; no marker or forged extra log line                               |
| Same, 2,048-character long marker                                                | Fixed 413; exact long marker absent from both streams                       |
| Proxied `/login` POST, 10 MiB + 1                                                | 413; page marker absent from both streams                                   |
| Fresh setup, login, initial MFA, TOTP, authenticator management with 4,097 bytes | 413; existing 4 KiB public/body boundary preserved                          |
| Separate web instance with `MAILDOCK_MAX_ATTACHMENT_BYTES=104857600`: 16 MiB     | 201; size/hash exact                                                        |
| Same configured maximum: 100 MiB chunked                                         | 201; size/hash exact                                                        |
| Same: 100 MiB + 1 chunked                                                        | 413; no publication; no temporary file                                      |

Default container stderr contained **exactly five** fixed overflow-warning lines and no other lines in the final run. The runner asserts both streams independently; it checks encoded and decoded markers and the forged-line marker. High-limit container stderr was empty. Bodies are streamed by the synthetic HTTP client in 64 KiB chunks where appropriate; no real account/provider was configured.

Evidence: `.security-results/f12/image-run.{stdout,stderr}.log` and `.security-results/f12/image/{default,high}.{stdout,stderr}.log`, plus the corresponding `*.probe.*.log` files. These are ignored local evidence, not release assets. The runner removed its uniquely named containers, volumes, temporary secrets, and network in `finally`. Earlier manually created F12.1 resources were also removed; pre-existing user containers were untouched. Local baseline/fixed image tags remain.

## 10. Automated results and reproducibility

```powershell
docker build -t maildock-f12-1:local .
node tests/security/f12-image.mjs maildock-f12-1:local
pnpm exec vitest run tests/security
pnpm typecheck
pnpm exec eslint . --ignore-pattern '.security-results/**'
pnpm exec prettier --check next.config.ts src/proxy.ts tests/security/f12-body-boundary.test.ts tests/security/f12-production.mjs tests/security/f12-image.mjs
git diff --check
```

- **Production-image runner: PASS.** Fresh real setup/MFA, default and 100 MiB configurations, exact-byte persistence, rejection/abort cases, native canaries, separate stdout/stderr assertions, and resource cleanup.
- **Security suite: 25 files / 356 tests passed** on the final patch (86.37 seconds). Nine new installed-code/storage/matcher/patch-delivery tests are included.
- **Typecheck: PASS**, web and worker configurations.
- **ESLint: PASS** with ignored disposable `.security-results` outputs excluded; changed code/scripts also linted directly.
- **Changed-file Prettier and git diff whitespace checks: PASS.**

`f12-body-boundary.test.ts` exercises the actual installed Next module at/below/above a deterministic small clone limit, abort propagation, CJS/ESM rejection, locked patch SHA-256, Docker patch-copy ordering, proxy matcher specificity, and storage exact-byte/partial cleanup behavior. Overflow tests and the image's 11 MiB regression fail against the original behavior. `f12-image.mjs` is an explicit opt-in Docker regression, not a test automatically pointed at a user's live installation. `f12-production.mjs` asserts the synthetic origin/database naming before touching data.

Validation corrections, not counted as passes: the first image build captured an outdated test import name (`unstable_doesProxyMatch`); the installed 16.3.6 testing export is `unstable_doesMiddlewareMatch`, and the corrected build passed. The first runtime invocation preceded server readiness; the final runner waits for readiness. An immediate abort-cleanup assertion raced server-side cleanup; the test now waits up to two seconds for completion. The first error-handler patch targeted the outer router and returned 500; production evidence located the inner middleware catch, which the final patch handles directly. An unfiltered ESLint invocation scanned the disposable Next patch checkout/generated prior probe files; the filtered repository check passed. Failed path/glob inspection commands made no source changes. No failed attempt is used as final runtime evidence.

## 11. F1-F11 regression assessment

- F1/F4 mail rendering, attachment/resource isolation and safe content handling: no rendering or content-validation implementation changed; existing adversarial coverage passed.
- F2/F3 setup/readiness/business authorization: real fresh provisioning and pre-MFA upload denial reproduced, followed by owner business access. Setup bounds/bootstrap/Origin logic unchanged.
- F5 MFA and F6 logout/session lifetime: no protocol/schema/transaction change; existing initial MFA, management, enrollment race, recovery, logout, revocation and session-lifetime regressions passed.
- F7 username consistency and F10 owner binding: unchanged; existing username/owner-binding/authorization suites passed. The upload bypass retains its independently inventoried immutable-owner/business-session guard.
- F8 admission: existing admission integration tests passed; 4 KiB readers/deadlines/reservation code unchanged. No larger unauthenticated framework clone introduced.
- F9 forwarding-header/ingress policy: existing ingress/header/Compose tests passed. No forwarded-IP trust, Origin relaxation, production port publication, or ingress configuration change.
- F11 diagnostics: existing logger, web, worker and process integration tests passed. Native body-limit warning is additionally bounded; no claim of universal framework sanitization.

The final image included the worker and normal all-role entrypoint. No provider send/sync, restoration, privileged-role migration, broad dependency audit, or unrelated F12 remediation is claimed.

## 12. Exact working-tree snapshot

`git diff --stat` (Git excludes untracked additions from this command):

```text
 .dockerignore       |  1 +
 next.config.ts      |  4 ++++
 pnpm-lock.yaml      | 11 ++++++-----
 pnpm-workspace.yaml |  1 +
 src/proxy.ts        |  7 ++++++-
 5 files changed, 18 insertions(+), 6 deletions(-)
```

`git status --short`:

```text
 M .dockerignore
 M next.config.ts
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
 M src/proxy.ts
?? docs/SECURITY_F12_1_RESULTS.md
?? docs/SECURITY_F12_DISCOVERY.md
?? patches/next@16.3.6.patch
?? tests/security/f12-body-boundary.test.ts
?? tests/security/f12-image.mjs
?? tests/security/f12-production.mjs
```

New patch, tests and this report remain untracked/unstaged and are therefore listed in status, not the tracked diff stat. HEAD remains the baseline; no commit or push was made.

## 13. Remaining F12 findings

F12-03 (scoped non-superuser application database authority) and F12-05 (secure restore/update/capacity operator contract) remain release-blocking under discovery. F12-04 (development dependency payload retention) and F12-06 (Compose tuning passthrough) also remain open. Their implementations and operator procedures were not changed here. This result closes only the two requested body/diagnostic findings and does not mark F12 itself closed.

F12.1 BODY BOUNDARY: PASS
