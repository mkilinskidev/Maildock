# F11 logging discovery — Maildock V1

Review date: 2026-10-06 (Europe/Warsaw). Reviewed HEAD:
`7b44680fc986dbfe03f9d628cdd0cab99ba3867b`
(`security: establish proxy-independent ingress boundary`).

This is defensive discovery, not implementation or closure of F11. Application
code, dependencies, patches, migrations and deployment configuration were not
changed. No commit, push, deployment, real credentials or live mail/OAuth provider
traffic was used. This report is the only repository change.

The most significant result is a **confirmed session-token disclosure through
Better Auth's independent error logger** during a database lookup failure.
Other demonstrated results include shallow rather than recursive Pino redaction,
unescaped callback-URL logging, and raw failed-job diagnostics persisted by
pg-boss. Normal setup, password login, enrollment and rejected MFA proofs did not
disclose their synthetic credentials in the exercised scenarios. Silence on those
paths does not establish safety of their dependency exception paths.

Evidence labels used below:

- **Runtime:** executed against current application code or installed dependency
  code with synthetic data. The scope of each harness is stated explicitly.
- **Source:** integration and installed source inspected; no claim of a full
  production HTTP/container reproduction.
- **Gap:** not exercised, or serialization dropped data without establishing a
  general sanitization guarantee.

## A. Logging architecture

### Application operational output

[`src/shared/infrastructure/logging/logger.ts`](../src/shared/infrastructure/logging/logger.ts)
constructs Pino 10.3.1 with `level: config.logLevel` and path redaction. No custom
Error serializer, string scrubber, formatter, transport, request serializer,
request middleware, or application log-file destination is configured. The
optional destination argument is used by tests/harnesses. Normal Pino output is
newline-delimited JSON on stdout, including numeric `level`, epoch-millisecond
`time`, `pid`, `hostname`, object fields and `msg`.

[`config.ts`](../src/shared/infrastructure/config/config.ts) defaults `LOG_LEVEL`
to `info` in every environment, including production. Allowed levels are
`fatal`, `error`, `warn`, `info`, `debug`, `trace`; choosing a more verbose Pino
level does not enable IMAP/SMTP protocol tracing. No current application calls at
debug/trace were found.

Construction sites:

- `src/composition/web.ts:4`: returns configuration and a logger; no caller of
  `createWebComposition` was found in current source.
- `src/composition/worker.ts:49`: constructs the active worker logger and passes
  it to jobs, diagnostics, delta synchronization and IDLE watchers.
- `src/modules/accounts/infrastructure/accounts.ts:70`: constructs the logger
  for web account Application Events persistence warnings.
- `src/app/api/auth/[...all]/route.ts:37`: constructs the logout logger.

Pino accepts arbitrary object arguments and free-form messages. Its default
`err` serializer is `pino-std-serializers` 7.1.0: message and stack incorporate
Error causes, enumerable extra properties are copied, and aggregate errors are
serialized. No Maildock error allowlist limits that output. An Error under a
different field does not automatically receive exactly the same `err` handling.
Pino child bindings use redaction, but only with the same limitations as normal
arguments. No production `.child()` calls were found.

### Other output and diagnostic stores

| Mechanism                 | Current behavior                                                                                                              | Boundary                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Better Auth / core 1.7.5  | No `logger` option in `auth-factory.ts`; default level `warn`; timestamped text plus raw console arguments                    | Warn/error on stderr, independent of Pino and `LOG_LEVEL`                               |
| Next.js 16.3.6            | Framework startup/error console output; raw exception handling remains enabled                                                | Independent stdout/stderr; Pino redaction does not apply                                |
| Node process exceptions   | Migration top-level failures and composition failures before the worker's try block can escape                                | Native stderr inspection, independent of Pino                                           |
| `ApplicationEventService` | Inserts fixed event definitions and allowlisted details in `application_events`; persistence failures use fixed Pino warnings | Separate owner-visible diagnostic store, not a Pino database sink                       |
| pg-boss 12.33.7           | Runtime errors forwarded to Pino by `JobRuntime`; handler failures serialized into job `output`                               | Distinguish container output from durable failed-job diagnostics                        |
| ImapFlow 2.0.6            | Every application construction uses `imapOptions()` with `logger: false`; no `logRaw`/`emitLogs` enabled                      | Installed dependency has a separate trace-level logger, but current calls are gated off |
| Nodemailer 10.0.10        | `logger: false`, `debug: false`                                                                                               | Logger methods are no-ops; a fixed DNS-family warning can independently use console     |
| Microsoft MSAL            | `piiLoggingEnabled: false`, no-op `loggerCallback`                                                                            | Current callback discards MSAL logging; raw errors still require safe handling          |
| postgres.js 3.4.9         | Debug default false; application suppresses notices with `onnotice`                                                           | No configured SQL logging; thrown errors still carry diagnostics                        |
| pg 8.23.0                 | Used internally by pg-boss, no application SQL/debug logger                                                                   | Server error detail can contain data; hiding Client.password is not error sanitization  |

`scripts/container-entrypoint.mjs` starts migration/web/worker children with
`stdio: "inherit"`. Both stdout and stderr therefore reach the container/platform.
Application Pino and native/dependency text coexist in that stream.

## B. Redaction architecture

### Exact configured paths

The following is an exhaustive representation of `logger.ts:12–61`, including
its `.flatMap()` expansion. Matching is case-sensitive.

| Field or path               | Exact configured variants                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `password`                  | `password`, `*.password`, `**.password`                                                    |
| `auth.pass`                 | `auth.pass`, `*.auth.pass`, `**.auth.pass`                                                 |
| `secret`                    | `secret`, `*.secret`, `**.secret`                                                          |
| `proofCode`                 | `proofCode`, `*.proofCode`, `**.proofCode`                                                 |
| `totpURI`                   | `totpURI`, `*.totpURI`, `**.totpURI`                                                       |
| `recoveryCodes`             | `recoveryCodes`, `*.recoveryCodes`, `**.recoveryCodes`                                     |
| `backupCodes`               | `backupCodes`, `*.backupCodes`, `**.backupCodes`                                           |
| `replacementAuthority`      | `replacementAuthority`, `*.replacementAuthority`, `**.replacementAuthority`                |
| `tokenDigest`               | `tokenDigest`, `*.tokenDigest`, `**.tokenDigest`                                           |
| `sessionToken`              | `sessionToken`, `*.sessionToken`, `**.sessionToken`                                        |
| `token`                     | `token`, `*.token`, `**.token`                                                             |
| `accessToken`               | `accessToken`, `*.accessToken`, `**.accessToken`                                           |
| `refreshToken`              | `refreshToken`, `*.refreshToken`, `**.refreshToken`                                        |
| `clientSecret`              | `clientSecret`, `*.clientSecret`, `**.clientSecret`                                        |
| `code`                      | `code`, `*.code`, `**.code`                                                                |
| `authorization`             | `authorization` only                                                                       |
| `cookie`                    | `cookie` only                                                                              |
| `req.headers.authorization` | This exact path only                                                                       |
| `req.headers.cookie`        | This exact path only                                                                       |
| `databaseUrl`               | `databaseUrl` only                                                                         |
| `authSecret`                | `authSecret` only                                                                          |
| `bootstrapSecret`           | `bootstrapSecret`, `*.bootstrapSecret`, `**.bootstrapSecret`                               |
| `bootstrapSecretDigest`     | `bootstrapSecretDigest`, `*.bootstrapSecretDigest`, `**.bootstrapSecretDigest`             |
| `MAILDOCK_BOOTSTRAP_SECRET` | `MAILDOCK_BOOTSTRAP_SECRET`, `*.MAILDOCK_BOOTSTRAP_SECRET`, `**.MAILDOCK_BOOTSTRAP_SECRET` |
| `credentialsEncryptionKey`  | `credentialsEncryptionKey` only                                                            |
| `credentialsEncryption`     | `credentialsEncryption` only; the entire matching subtree is censored                      |

Censor text is `[REDACTED]`; fields are replaced, not removed.

### Actual guarantee

Pino uses installed `@pinojs/redact` 0.4.0, not an assumed older fast-redact
implementation. Its `parsePath`/`redactPaths`/wildcard traversal treats `*` as a
single path segment. `**` is not recursive descent. Pino's namespace splitting
likewise handles `*` specially, not `**`. Runtime results confirm:

- `{ accessToken: value }` and `{ context: { accessToken: value } }` are censored.
- `{ context: { provider: { accessToken: value } } }` is not censored.
- `{ items: [{ accessToken: value }] }` is not censored.
- Protected fields of an ordinary `err` object may be censored after its
  serialization; its secret-bearing message, stack, params and cause text are not.
- `Headers`, Request/Response, URLSearchParams, FormData and Map/Set in the
  tested positions mostly serialize as `{}`. That is data omission, not a
  guarantee that their strings, entries or custom serializers will be safe.
- A URL object under `url` throws during redaction in this installed version:
  the cloned object retains the URL prototype without its private state. No
  log line is produced. Logging its string leaks the query normally.

Classification: **path-based, case-sensitive field redaction**, combined with
Pino's default Error serialization. There is no regex/free-text sanitization and
no repository-specific safe Error serializer. It cannot sanitize arbitrary
secret text embedded in strings.

Callers must never supply passwords, tokens, root keys, provisioning/recovery
material, decrypted configuration, full URLs with queries, request/response
objects, raw database/provider errors, SQL parameter arrays, MIME/body/attachment
content, or serialized versions of these values. Current redaction is a fallback
for specific shapes, not authorization to log those objects. `code` also redacts
ordinary machine error codes at protected positions, so safe diagnostic codes
need a separately defined, allowlisted field.

## C. Repository-specific sensitive-data taxonomy

| Class                         | Maildock values                                                                                                                   | Current handling / logging assessment                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL SECRET               | Owner password; bootstrap secret; `AUTH_SECRET`; credential encryption active/previous keys                                       | Setup/password/encryption code does not intentionally log values; dedicated invalid-config cases omit them. Generic object/error logging remains unsafe.                                                                             |
| CRITICAL SECRET               | TOTP secret, provisioning URI, current proof; backup/recovery arrays; replacement authority; proofCode                            | Application ceremonies do not intentionally log input/output. Several field names are redacted only at limited depths. Better Auth errors bypass Pino.                                                                               |
| CRITICAL SECRET               | Session token and authenticated session cookie; token digest (security verifier)                                                  | Session token disclosure confirmed on Better Auth DB failure. A session row ID is distinct from its bearer token.                                                                                                                    |
| CRITICAL SECRET               | Google/Microsoft client secret, code, access/refresh token, PKCE verifier; plaintext OAuth cache                                  | Google provider errors replaced with fixed messages; MSAL callback disabled. Generic query/error inspection can expose values/envelopes.                                                                                             |
| CRITICAL SECRET               | IMAP/SMTP password or OAuth bearer credential; decrypted credential envelope; credential-bearing `DATABASE_URL`                   | IMAP/SMTP option objects contain plaintext under `auth`; they must not be logged. Protocol logging is currently disabled. Root config top-level masks do not cover arbitrary nested copies.                                          |
| SENSITIVE CONTENT             | Plain/HTML body, raw MIME, attachment bytes, whole auth request, cookies/Authorization, entire provider response/protocol payload | No normal application log site for these was found. Raw exceptions/SQL parameters are a secondary path; string redaction cannot protect it.                                                                                          |
| PERSONAL / MAIL METADATA      | Account email and display name; From/To/Cc/Bcc; subject; folder path; attachment filename; Message-ID/provider IDs                | Delta and IDLE Pino events currently log accountName/accountEmail/mailboxPath. Failed metadata writes can reach pg-boss output through raw errors. Subjects, filenames and recipients are not safe generic identifiers.              |
| CONDITIONAL OPERATIONAL ID    | Local account/mailbox/message/outgoing/attachment/command UUID; local job/worker UUID                                             | Locally generated opaque IDs and UUID-validated payload fields do not embed mailbox text. Still linkable within an instance; minimize scope and never confuse with tokens.                                                           |
| SAFE BOUNDED DIAGNOSTIC       | Fixed job/operation/provider/readiness name; route pathname; status; category; retry count; duration; counters                    | Appropriate if bounded/allowlisted; full URL, unvalidated provider code, arbitrary event or exception text is not equivalent.                                                                                                        |
| CONDITIONAL REMOTE CHECKPOINT | Numeric UID/UIDVALIDITY/HIGHESTMODSEQ, `lastSeenUid`                                                                              | Numeric synchronization state, not a bearer secret; reveals mailbox activity and should stay in necessary operational diagnostics. Remote Message-ID/emailId can embed provider/user content and should not be treated the same way. |
| SENSITIVE ENVELOPE            | Encrypted account password/OAuth cache, IV/tag/key ID and serialized credential envelope                                          | Encryption is not permission to create copies in diagnostics. Envelope field names are not generally covered by Pino paths.                                                                                                          |

## D. Logging source inventory

Production levels below describe defaults (`LOG_LEVEL=info` for Pino; independent
Better Auth defaults to `warn`). No normal application full-Request/Response log
call was found. Broad searches covered logger/log/console/stdout/stderr, Error
serialization, JSON.stringify/inspect, process handlers, middleware/proxy and
instrumentation; JSON.stringify in application source primarily builds protocol
bodies, caches, cursors and editor/storage data, not log statements.

| Component                        | Logging site                                                                                     | Data supplied                                                                 | Production level      | Risk / status                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Worker shutdown                  | `composition/worker-process.ts:27`                                                               | Fixed event/message, signal                                                   | info                  | Appropriate bounded signal                                                                                        |
| Worker shutdown failure          | `worker-process.ts:43`                                                                           | Raw `err`, fixed event/message                                                | error                 | Unsafe generic Error sink; source + injected-sink validation                                                      |
| Worker MFA pause                 | `worker-process.ts:118`                                                                          | Fixed `worker.mfa_pending`                                                    | info                  | Useful operational state, no proof values                                                                         |
| Worker startup/readiness failure | `worker-process.ts:128`                                                                          | Raw `err`, fixed event/message                                                | fatal                 | Generic Error serialization; creation at line 15 precedes this try                                                |
| Job runtime failure              | `jobs/infrastructure/job-runtime.ts:18`                                                          | Raw dependency error                                                          | error                 | Synthetic error emission disclosed SQL token parameter; injected event, not a claim pg-boss normally uses Drizzle |
| Job runtime lifecycle            | `job-runtime.ts:28,33`                                                                           | Fixed `jobs.started` / `jobs.stopped`                                         | info                  | Appropriate; no job object/data dump                                                                              |
| Diagnostic persistence failure   | `diagnostics/application/application-event-service.ts:51`                                        | Fixed event plus fixed diagnostic event name                                  | warn                  | Correctly discards DB error/query params                                                                          |
| Diagnostic retention failure     | `application-event-service.ts:75`                                                                | Fixed event/message                                                           | warn                  | Correctly discards error                                                                                          |
| Delta completed                  | `mail/application/delta-sync-service.ts:299`                                                     | UUIDs, account name/email, remote path, reason, duration, counts, lastSeenUid | info                  | Excess personal/folder metadata in routine output                                                                 |
| Delta failed                     | `delta-sync-service.ts:340`                                                                      | Same context, bounded reason/category                                         | warn                  | Safe category, unnecessary metadata; raw error subsequently rethrown at line 367                                  |
| IDLE connected                   | `mail/infrastructure/idle-watchers.ts:162`                                                       | UUIDs, account name/email, path                                               | info                  | Personal metadata repeated on reconnect                                                                           |
| IDLE disconnected                | `idle-watchers.ts:176`                                                                           | Same context, fixed category                                                  | warn                  | No raw error, but unnecessarily repeats metadata and lacks specific cause                                         |
| Logout revocation failure        | `auth/application/logout.ts:40`                                                                  | Fixed event/message only                                                      | error                 | Correct; source + runtime failure injection                                                                       |
| Logout cookie cleanup failure    | `logout.ts:64`                                                                                   | Fixed event/message only                                                      | error                 | Correct; source + runtime failure injection                                                                       |
| Application Events store         | `ApplicationEventService.record`, domain definitions                                             | Fixed definition, local IDs, stripped category/mailboxPath/uidValidity        | DB info/error/warning | Bounded owner-facing diagnostics; mailboxPath intentionally personal                                              |
| Auth expected rejection          | Installed username plugin:154–192                                                                | Fixed reason text                                                             | independent warn      | No password/username interpolation; does not cover app throttle events                                            |
| Auth exception                   | Installed `api/routes/session.mjs:231`, `api/index.mjs:194–215`, context background task handler | Raw exception/message                                                         | independent error     | Confirmed session token in SQL params; no Pino boundary                                                           |
| Auth URL rejection               | Installed `api/middlewares/origin-check.mjs:56,78,114`                                           | Interpolated submitted URL/origin                                             | independent error     | Runtime query disclosure and newline injection on callbackURL                                                     |
| F9 fallback                      | Installed `api/rate-limiter/index.mjs:242`                                                       | Fixed no-IP warning                                                           | independent warn      | Once per loaded module; safe values, misleading operator advice for F9                                            |
| Next errors                      | Installed base-server/log/start-server/error handlers                                            | Raw errors; some outer catches use req.url                                    | independent error     | Direct error sink disclosed synthetic SQL body; URL path source-reviewed                                          |
| Startup native exceptions        | Migration top-level; worker composition before try                                               | Uncaught Error inspection                                                     | stderr                | No application redactor; inspect thrown object properties                                                         |

### Direct console inventory (application/scripts)

Only two explicit console call sites were found outside tests/dependency source:

| Site                                               | Call / content                             | Assessment                                             |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `scripts/container-entrypoint.mjs:5`               | console.error: fixed accepted-role message | Safe; rejected environment value not printed           |
| `src/shared/infrastructure/database/migrate.ts:23` | console.log: fixed migration completion    | Safe; failures escape rather than using this statement |

Dockerfile build command substitutions write freshly generated build-only secrets
to the shell through `process.stdout.write`; these are captured by substitution,
not a normal application log call. No shell tracing is configured there. No
application `uncaughtException`/`unhandledRejection` handler or instrumentation
file was found. Signal handlers do not sanitize native exception output.

## E. Authentication, setup and MFA

### Setup and password/session paths

`api/setup/route.ts` catches expected setup/throttle/validation rejections and
returns fixed responses; unexpected failures return a generic 500 without logging
the exception. `instance-auth.ts` does not log bootstrap values, credentials,
Argon2 results or immutable owner assignment. Successful setup has no security
event. First-run rejection also has none.

Password admission runs through `initialMfaHttp`, which enforces Origin/body
boundaries and maps errors to generic responses without logging input or the
caught exception. F8's shared keys are fixed work categories; login throttling
stores a SHA-256 normalized-username key, not the original username, and neither
is explicitly logged. Expected 429s are silent. The username plugin emits fixed
`User not found`, `Password not found`, `Invalid password` warnings when reached;
successful password login is silent. It is not necessarily a successful MFA login.

Session reads (`getValidOwnerSession`) call Better Auth with cookie headers;
normal validation does not intentionally log a cookie or returned session.
However, **Better Auth internally logs an unexpected session DB error before
Maildock can map or catch it**. `DrizzleQueryError` includes the SQL and parameter
values in its message, plus enumerable `query`, `params` and `cause`. Installed
`pg-core/session.js` constructs this wrapper on failed queries. A failing session
lookup's parameter is the actual session token. This also affects owner/session
readers used by proxy, protected routes and logout: the fixed outer logout event
does not undo a dependency log already emitted.

Catch-all public HTTP is restricted to get-session, username sign-in and the
custom sign-out boundary; blocked Better Auth sign-up/social endpoints should not
be counted as reachable findings. HTTP setup does not call Better Auth sign-up.
Existing session lifetime, immutable-owner and MFA authorization readers remain
correct boundaries; their invariant failures have little distinct audit signal.

Logout success/rejection is silent. Revocation and cookie-cleanup failures use
fixed events without raw errors. A fault in the upstream Better Auth session read
can still log independently. The harness tested both fixed outer failure events
with a stubbed reader/cleanup, and separately the actual dependency DB disclosure.

Origin rejection in Maildock's own prechecks is silent and does not print headers.
An admitted login with a disallowed `callbackURL` reaches the installed origin
middleware and logs that complete user-controlled string. This is distinct from
Maildock's real mail OAuth callbacks; the shipped login UI does not send that field,
but the username protocol accepts it.

### MFA paths

Reviewed `initial-mfa.ts`, `mfa-login.ts`, `mfa-management.ts`, their HTTP wrapper,
MFA cookies, proof throttles and installed two-factor plugin paths. There are no
application logger calls in initial enrollment, secret/URI generation, TOTP proof,
backup-code generation/consumption, login challenge/cancellation, management proof,
replacement creation/completion/cancellation, regeneration or MFA session revocation.

Application errors use fixed messages or `InitialMfaRejected`; whole ceremony
inputs/results are not passed to Pino. Current normal-path code does not log
`proofCode`, provisioning URI, recovery arrays, replacement authority, digest or
session token. Known API failures are converted to bounded responses/rejections.
Unexpected failures may be rethrown internally, while `initialMfaHttp` maps them
to a generic response; this is not protection against logging _inside_ Better
Auth. Its session error paths and other generic exception handlers remain relevant
during MFA operations that read/create/delete sessions.

No sendOTP function is configured and email/SMS OTP endpoints remain unavailable;
installed sendOTP logging is not a current application integration finding.
Instrumentation is explicitly disabled in `auth-factory.ts`.

Runtime enrollment start/complete, invalid initial proof, MFA password challenge,
invalid recovery code and invalid login TOTP were clean in captured console output.
Existing initial-MFA tests additionally cover successful recovery login and
cancellation without secret logging; replacement/regeneration paths were validated
by existing tests, not fabricated additional canary runs. Missing management and
recovery-use audit events are addressed in L/M.

F9's dependency warning uses a module-scoped `ipWarningLogged` flag. It is not
emitted on every request, and the shared limiter key is a fixed `no-trusted-ip`
plus normalized endpoint path. The advice to forward/trust IP headers conflicts
with intentional V1 policy; do not change that policy to silence the warning.

## F. OAuth findings

### Google

`google-oauth.ts` uses fixed endpoints, PKCE, random state hashed for persistence,
session/provider-bound state consumption and encrypted verifier/cache. No explicit
URL/state/code/token/request/response logging is present. `requestToken()` catches
fetch and JSON failures and converts them to fixed `GoogleAuthorizationError`;
non-OK/schema/identity responses are classified without leaking their bodies.
Refresh persists an encrypted refresh token and returns an access token in memory;
it does not log either. Decryption/parse failure becomes a fixed reconnect error.

Callback routes log neither request.url nor query. They convert failures to a
small redirect reason set; callback codes/state do not enter that redirect.
State/provider/session protection and PKCE must remain unchanged.

### Microsoft

`microsoft-oauth.ts:114` disables PII logging and supplies a no-op MSAL callback.
Installed msal-common Logger uses that callback for emitted entries. Token-by-code
and silent-token errors are mapped to fixed Maildock errors. Cache contains
credentials, but is encrypted before storage and not intentionally logged.
MSAL construction/cache setup and DB work outside those token-call catch blocks
can still throw; do not assume all OAuth errors are sanitized at every enclosing
boundary. Current callback catch maps these to fixed redirect reasons.

### Shared exposure boundary

No live provider was contacted. Both providers' invalid-state completion paths
were exercised before token exchange. Existing Google integration tests mock
provider fetch traffic and verify token/response handling.

No normal Maildock OAuth full-URL logger was found. Installed Next outer request
failure logging nevertheless includes `req.url`, which can retain
`?code=...&state=...`; application callback catches alone do not cover failure in
proxy/session processing before the route or framework infrastructure. This is a
**source-reviewed conditional path**, not a reproduced normal callback leak.
Pathname-only logging is appropriate; pathname plus search, request.url, a URL
string or raw query is not. A URL string canary leaked in Pino's matrix.

## G. Mail, provider and content findings

Account creation/edit/testing/encryption/decryption have no explicit raw account
configuration logging. Provider connection objects contain decrypted passwords
or access tokens and usernames; `imapOptions()`/`smtpOptions()` transfer them to
generic library option objects under `auth`. These objects must never become
logger metadata. They currently do not.

ImapFlow creation for work and IDLE uses `logger: false`; no protocol tracing,
logRaw, emitLogs or application log listener is enabled. Installed `getLogger()`
gates normal logging and console fallback on `options.logger !== false`.
`emitLogs` is separately controlled and currently false. Its default internal
logger is trace-level: re-enabling it is not a safe inexpensive diagnostic change.

Nodemailer gets `logger: false, debug: false`, causing its shared logger to return
no-op methods. Installed shared DNS resolution can independently print a fixed
IPv4/IPv6 warning; this inspected warning does not include credential/config
values. Authentication errors may hold server response/command text, but Maildock
`sanitizeError()` uses them only for bounded category classification, then returns
fixed descriptions with no cause or raw response. SMTP AUTH-disabled guidance is
also fixed text. These controls are correct.

The synthetic provider factory failure put password/body markers into a thrown
EAUTH error and raw response; `testConnection()` returned fixed IMAP/SMTP
authentication-rejected messages without markers. This exercised the actual
application sanitization with injected client factories, **not real sockets or
provider logging**. Installed library options/source were separately inspected.

Synchronization logs routine delta/IDLE account name/email/folder path. Other
mail envelope fields, subjects, recipients, Message-ID, body text/HTML, raw MIME,
attachment names/bytes or parser excerpts are not intentionally logged at current
Pino sites. These values are still included in database writes and may be exposed
through raw query failures and failed-job output (H/M).

Mailparser 3.9.28 is installed but **no application import/use was found**. A
malformed-mailparser exception is not claimed as a reachable current path. Current
provider code derives metadata from ImapFlow envelope/bodyStructure/headers and
fetches bounded parts; selected text is decoded with fixed failure messages.
Attachment transfer-decoding and outgoing MIME construction reject bad input
using fixed messages. `fetchMessageContent()` explicitly replaces raw failures.
`fetchAttachment()` has cleanup but no equivalent encompassing catch; the
application AttachmentService catches unknown failures and stores a fixed
unavailable result. Unknown provider errors therefore do not normally dump bytes.
Failure of a subsequent database status/error write is a separate raw-error path.

`MessageContentService.run` normally replaces unknown errors with a fixed reason
before throwing; recent/delta/backfill/discovery instead rethrow the original
error after recording a sanitized status. A failed subject/address/attachment
metadata write can thus leave sensitive parameters in job diagnostics. Filesystem
and crypto errors are not intentionally logged by their infrastructure; crypto
decrypt failure becomes a fixed `CredentialUnavailableError`. OS errors may
contain storage paths, not proven attachment content leakage.

No authenticated-mailbox rendering path intentionally logs subjects, body HTML,
attachment bytes, raw headers or entire render inputs. Framework uncaught errors
remain a distinct boundary; absence of a console call in the renderer does not
sanitize its upstream database exception.

## H. Workers and jobs

| Queue / job                | Payload produced today                     | Field classification / exception path                                                                                                                  |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mailbox-discovery-v1`     | version 1, accountId                       | Literal version + local UUID. Handler invokes discovery; raw service failure can escape.                                                               |
| `mailbox-recent-sync-v1`   | version 1, accountId, mailboxId            | Literal + local UUIDs. Strict schema; raw original failure rethrown by recent service.                                                                 |
| `mailbox-delta-sync-v1`    | version 1, accountId, mailboxId, reason    | UUIDs; bounded idle/poll/manual/post-discovery reason; strict schema; service logs safe category then rethrows original error.                         |
| `mailbox-backfill-sync-v1` | version 1, accountId, mailboxId            | UUIDs, strict schema; original non-epoch failure rethrown.                                                                                             |
| `message-content-fetch-v1` | version 1, accountId, mailboxId, messageId | UUIDs, strict schema; ordinary service errors become fixed reasons; DB cleanup failure can still escape.                                               |
| Attachment queue           | attachmentId                               | Local UUID, strict schema; no attachment filename/bytes in payload.                                                                                    |
| `message-command-v1`       | commandId                                  | Local UUID; operation/remote target read from database, not entire payload; schema parse strips unknown fields rather than universally rejecting them. |
| `outgoing-message-v1`      | outgoingMessageId                          | Local UUID, strict schema; MIME, recipient lists and credentials not job data.                                                                         |
| `sent-copy-v1`             | outgoingMessageId                          | Local UUID, strict schema; raw MIME not job data.                                                                                                      |

Queue names come from application constants. Job/worker UUIDs are operational
identifiers; none is an account password or bearer session token. Version/UUID
validation describes current producers and consumers; it does not make arbitrary
future added fields safe. Some schemas strip extras rather than `.strict()`.

No application `logger.error({ job, error })`, job.data dump or console.error(job)
was found. Web producer PgBoss instances generally have no custom error listener;
an unhandled EventEmitter error is not guaranteed to become a safe route response.
Worker `JobRuntime` registers an error listener but forwards the raw value.
Pollers often swallow periodic failures; absence of logs here is an operational
visibility concern, not an established credential leak.

Installed pg-boss `manager.js` catches a handler error and calls
`fail(name, jobIds, err)`. `mapCompletionDataArg()` uses `serialize-error`, then
stores the result as failed-job `output`. It does **not** necessarily emit the
handler exception as a runtime error event. Runtime fetch/heartbeat/settlement
failures can be emitted separately, sometimes with message/stack/queue/worker
properties attached. Do not conflate these channels.

Discovery/recent/backfill/delta services rethrow raw errors; metadata SQL includes
subject, addresses, paths and attachment metadata. A raw `DrizzleQueryError` at
that boundary can be copied to pg-boss output even though the user-facing sync
error is generic. Actual installed pg-boss processing of a synthetic throwing
handler confirmed a subject marker persisted in output with **zero runtime error
events**. This is a diagnostic-copy issue; it does not assert real mail was used
or that the injected handler was an application service.

Worker startup and shutdown raw errors are also dangerous generic sinks. Current
readiness SQL mostly uses safe bounded identifiers; arbitrary shutdown/runtime
errors cannot be presumed safe merely because current lifecycle inputs are small.
There is no application-wide safe exception policy for those sinks.

## I. Framework, dependencies, startup and retention

### Installed sources followed

- Better Auth: `dist/context/create-context.mjs`, `api/index.mjs`, dispatch,
  session/sign-out/rate-limiter/origin middleware, username and two-factor paths;
  resolved `@better-auth/core/dist/env/logger.mjs`. Default console logger prints
  raw extra arguments; user `LOG_LEVEL=fatal` does not disable it. Existing
  patched Drizzle adapter remains in use; its auth fixes are not changed here.
- Pino: `lib/redaction.js`, `lib/tools.js`, installed `@pinojs/redact/index.js`
  and `pino-std-serializers/lib/err.js`/helpers. Recursive `**` assumption and
  Error.cause/message sanitization are unsupported.
- ImapFlow: resolved patched `dist/cjs/imap-flow.js:getLogger()` and `logger.js`,
  compared with current options. Logging false controls the relevant output.
- Nodemailer: `dist/esm/shared/index.js:getLogger()` and DNS warning,
  SMTP connection/transport and OAuth logger integrations. Debug/protocol logging
  disabled by current options.
- MSAL: current ConfidentialClientApplication options and installed msal-common
  Logger implementation; callback is no-op.
- pg-boss: resolved patched `dist/manager.js`, `worker.js`, `db.js`; ordinary
  handler failures stored via serialization; runtime error events separately
  forwarded. CLI console calls are not the integrated library runtime.
- postgres.js: `src/index.js` and `connection.js`; debug false, notices explicitly
  suppressed, query diagnostics still available on errors. pg: Client password
  hidden from enumerable inspection; this does not strip server `detail` or a
  Drizzle wrapper's SQL parameters.
- Drizzle: `errors.js` and `pg-core/session.js`; failed query messages explicitly
  concatenate params and expose query/params/cause.
- Next: `dist/server/base-server.js:483`, `next-server.js`,
  `lib/start-server.js:229,256`, `app-render/create-error-handler.js` and
  `dist/build/output/log.js`. These log via console outside Maildock redaction.
- MIME parser: installed but not integrated; no full unused-package audit claimed.

### HTTP / rendering exceptions

`next.config.ts` configures standalone output and external packages; it does not
install a safe logger or instrumentation error boundary. `src/proxy.ts` performs
session validation before protected route code. Most API route catches return
fixed or known typed errors without logging; proxy session failure and unexpected
framework failures remain independently handled by dependencies.

Installed Next `BaseServer.logError` calls framework `Log.error` unless quiet;
that logger forwards the object to console.error. A direct call with synthetic
`DrizzleQueryError` containing a body parameter disclosed the marker. This proves
the installed **error sink**, not that a specific production route currently
throws that body query uncaught. Production rendering error handlers also use
console.error; some production sanitization/digests sent to browsers do not make
server output safe.

Installed `start-server` request/upgrade catches log complete `req.url`, then raw
err. No universal automatic header/cookie/body dump was established, and stack
traces alone are not secrets. Error.message/cause/custom fields and full URL
search are the important data paths. Full callback URL disclosure under a real
production Next failure was not exercised; it remains a source-reviewed risk.

### Startup and configuration

`parseConfig()` normally reports variable names and validation messages, not
submitted secret values. Synthetic invalid DATABASE_URL, AUTH_SECRET, active key,
bootstrap key and previous-key JSON cases were clean. Migration creates config
and database at module top level; it has finally cleanup but no catch for raw
errors. Worker composition likewise occurs before its supervised try block.
Native stderr can inspect exceptions arising there.

One concrete exception: malformed `APP_ORIGIN` can reach `new URL()` inside
`superRefine` and throw native `ERR_INVALID_URL` with an enumerable `input` value,
instead of a `ConfigurationError`. A marker in that input was visible in inspected
error output. APP_ORIGIN is normally public, so this is not evidence that invalid
AUTH_SECRET or DATABASE_URL values are currently printed. A miscopied private URL
or secret in that variable could leak; severity is limited accordingly. Valid
credential-bearing origins are rejected with a fixed configuration message.

No demonstrated postgres connection error printed the DATABASE_URL password.
Do not claim that every connection refusal exposes it. Server authentication/SQL
error detail and generic exception object inspection still need normalization.
Readiness returns a boolean after catching errors; it does not print credentials
or probe contents, but offers no component/category diagnostic.

### Output / retention ownership

Maildock does not write operational log files. stdout/stderr collection,
access control, rotation and retention belong to Docker/Coolify/other operators.
Those mechanisms were not reconfigured. They are F12/deployment observations.

`application_events` retention is application-owned: approximate 30 days and
10,000 most recent rows, cleanup on startup/hourly/per-writer intervals. This
applies only to that database store, not Pino/Better Auth/Next container output.
pg-boss has separate job/output storage and retention. This review does not
design a new retention policy for it.

`docs/PHASE_3F.md` correctly distinguishes Pino stdout from Application Events
retention and explicitly documents the account/email/path context. Architecture
claims that secrets/untrusted content never reach logs or that bodies/connection
strings are redacted must be read as desired requirements, **not verified current
guarantees**. Opaque-ID guidance in `docs/ARCHITECTURE.md:465` is stronger than
current routine mail logs. No repository promise of Docker log rotation was found.

## J. Runtime canary results

Temporary harnesses and captures live outside the repository at:
`C:\Users\mateu\AppData\Local\Temp\maildock-f11-20261006`.
Only synthetic values were used. Generated session tokens, base64 bootstrap/key
material and TOTP material from a disposable installation were treated as named
canaries; their actual values are deliberately omitted here. No provider endpoint
was contacted. Auth and jobs used separate disposable PostgreSQL containers,
stopped in finally blocks. Table output is normalized; captures preserve local
raw evidence.

Auth harness intercepted console error/warn/log/info arguments in-process using
Node formatting. Pino used its actual destination stream callback. Exact marker
searches were made against captured output per scenario. These are the writes
that would ordinarily reach stdout/stderr; full production Next/container output
capture was not substituted for them.

| Scenario                                                      | Canaries checked                                             | Captured output (normalized)                                                                 | Result                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Setup invalid bootstrap                                       | owner password, bootstrap marker                             | No output; BootstrapAuthorizationError                                                       | PASS secrecy; GAP audit signal                                                  |
| Setup success                                                 | owner password, generated bootstrap                          | No output; owner initialized in disposable DB                                                | PASS secrecy; GAP completion signal                                             |
| Invalid password login / missing username                     | owner password                                               | Fixed User not found warning; synthetic-secret entropy warning and one no-trusted-IP warning | PASS secrecy; limited rejection signal                                          |
| Throttled login                                               | owner password                                               | 429; no new output                                                                           | PASS secrecy; GAP throttle event                                                |
| Valid password login                                          | owner password, synthetic session                            | 200; no output                                                                               | PASS secrecy; GAP success event; password-only enrollment state                 |
| Session DB lookup failure                                     | generated SESSION_TOKEN_CANARY                               | 500; Better Auth raw DrizzleQueryError includes token parameter                              | OBSERVATION: confirmed secret disclosure                                        |
| Initial enrollment start                                      | owner password, bootstrap, generated TOTP material           | No output; returned provisioning URI kept only in local harness evidence                     | PASS secrecy                                                                    |
| Invalid initial MFA proof                                     | submitted TOTP marker, bootstrap                             | No output; InitialMfaRejected                                                                | PASS secrecy; GAP rejection event                                               |
| Initial enrollment complete                                   | valid generated TOTP, bootstrap, recovery material           | 200; no output                                                                               | PASS secrecy; GAP enrollment event                                              |
| Password MFA challenge                                        | owner password                                               | 200; no output                                                                               | PASS secrecy                                                                    |
| Invalid recovery code                                         | RECOVERY_CODE_CANARY                                         | 401; no output                                                                               | PASS secrecy; GAP challenge failure event                                       |
| Invalid MFA login TOTP                                        | TOTP_CODE_CANARY                                             | 401; no output                                                                               | PASS secrecy; GAP challenge failure event                                       |
| Google invalid callback state (provider completion method)    | OAUTH_STATE_CANARY, OAUTH_CODE_CANARY                        | GoogleAuthorizationError; no output                                                          | PASS; no token exchange; not a full HTTP callback run                           |
| Microsoft invalid callback state (provider completion method) | same state/code markers                                      | MicrosoftAuthorizationError; no output                                                       | PASS; no provider traffic                                                       |
| Logout reader and cleanup failure injection                   | synthetic session marker in thrown objects                   | 500; fixed logout_revocation_failed and logout_cookie_cleanup_failed only                    | PASS at outer logger; separate real session-read leak remains                   |
| Disallowed username-login callbackURL                         | OAUTH_CODE_CANARY, newline/forged-line marker                | 403; complete invalid URL and extra physical line printed by Better Auth                     | OBSERVATION: query text exposure + log injection                                |
| Pino JobRuntime error event injection                         | SESSION_TOKEN_CANARY inside synthetic Drizzle error          | Raw err.message/stack/params in jobs.runtime_error                                           | OBSERVATION: unsafe sink; not a natural pg-boss Drizzle event                   |
| IMAP/SMTP client-factory auth failures                        | IMAP_PASSWORD_CANARY, SMTP_PASSWORD_CANARY, MAIL_BODY_CANARY | No dependency output; returned fixed authentication_rejected messages                        | PASS application sanitizer; GAP actual socket failures                          |
| Invalid secret/database config cases                          | named invalid bootstrap/secret marker                        | ConfigurationError names variable/reason; marker absent                                      | PASS for executed cases                                                         |
| Invalid APP_ORIGIN                                            | input marker                                                 | Native Invalid URL exception includes input                                                  | OBSERVATION: unexpected raw-input exception; inspected, not launched container  |
| Installed Next error sink                                     | MAIL_BODY_CANARY in synthetic SQL exception                  | console.error emits wrapper message/params                                                   | OBSERVATION: direct BaseServer.logError call; GAP production route reproduction |
| Installed pg-boss real handler failure                        | MAIL_SUBJECT_CANARY in synthetic SQL exception               | No runtime error event; canary persisted in pgboss.job.output                                | OBSERVATION: actual dependency diagnostic persistence                           |

Additional redaction scenarios are listed individually in K. Raw capture files:
`pino-capture.log`, `canary-results.json`, `auth-capture.log`, `auth-results.json`,
`framework-capture.log`, `job-results.json`; execution output is in `auth-run.log`
and `job-run.log`. These contain disposable synthetic values, not production data.

Not newly exercised: live mail servers, SMTP delivery/IMAP authentication sockets,
real OAuth token exchange, full production Next build/failure, native production
migration failure, arbitrary MFA storage/backup/replacement exception injection.
Existing auth/MFA/provider/config/job tests complement source review but do not
turn these gaps into runtime canary evidence.

## K. Redaction adversarial matrix

All tests used a synthetic OAUTH_ACCESS_CANARY value unless otherwise described.
OBSERVATION means a canary survived or logging threw; PASS means absence for the
specific ordinary tested shape only. GAP means opacity/dropped serialization,
which does not establish a sanitizer contract.

| Input                                                              | Actual output behavior                  | Status                                                 |
| ------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------ |
| Top-level accessToken                                              | `[REDACTED]`                            | PASS                                                   |
| One-level context.accessToken                                      | `[REDACTED]`                            | PASS                                                   |
| context.provider.accessToken                                       | Value survives                          | OBSERVATION                                            |
| Three-level a.b.c.accessToken                                      | Value survives                          | OBSERVATION                                            |
| items array element with accessToken                               | Value survives                          | OBSERVATION                                            |
| context.items array element with accessToken                       | Value survives                          | OBSERVATION                                            |
| AccessToken / Password mixed case                                  | Values survive                          | OBSERVATION                                            |
| err: Error(secret text)                                            | Message and stack expose text           | OBSERVATION                                            |
| err: Error with secret-bearing Error.cause                         | Cause text joins message/stack          | OBSERVATION                                            |
| Error custom accessToken property under err                        | Extra property censored                 | PASS; other error text must still be safe              |
| Error custom request.body                                          | Body survives                           | OBSERVATION                                            |
| Nested provider error response.accessToken/body                    | Values survive                          | OBSERVATION                                            |
| Top-level lowercase authorization                                  | Censored                                | PASS                                                   |
| Top-level lowercase cookie                                         | Censored                                | PASS                                                   |
| Generic headers.authorization / cookie                             | Values survive                          | OBSERVATION                                            |
| Top-level Authorization / Cookie                                   | Values survive                          | OBSERVATION                                            |
| req.headers.authorization / cookie                                 | Censored                                | PASS                                                   |
| Headers instance                                                   | `{}`                                    | GAP; Object.fromEntries/inspection not covered         |
| Request with URL/body/auth header                                  | `{}`                                    | GAP; not safe after conversion/custom serializer       |
| Response with body/custom header                                   | `{}`                                    | GAP                                                    |
| URL object with secret query under url                             | Throws private-state TypeError, no line | OBSERVATION; no confidentiality guarantee from failure |
| URL string with code query                                         | Value survives                          | OBSERVATION                                            |
| URLSearchParams                                                    | `{}`                                    | GAP; toString leaks                                    |
| FormData                                                           | `{}`                                    | GAP; entries are not sanitized                         |
| Map                                                                | `{}`                                    | GAP; converted entries are not sanitized               |
| Set                                                                | `{}`                                    | GAP                                                    |
| JSON string containing accessToken                                 | String survives                         | OBSERVATION                                            |
| Interpolated/free-form message                                     | String survives                         | OBSERVATION                                            |
| Envelope under credentials with ciphertext/iv/tag                  | Values survive                          | OBSERVATION                                            |
| Nested databaseUrl/authSecret/credentialsEncryptionKey             | Values survive                          | OBSERVATION                                            |
| access_token/refresh_token/client_secret/imapPassword/smtpPassword | Values survive                          | OBSERVATION                                            |
| Child bindings: root and shallow protected key                     | Censored                                | PASS for these positions                               |
| Child bindings: deep.a.accessToken                                 | Value survives                          | OBSERVATION                                            |

No global value-scanning guarantee exists. Censoring a field named `token` does
not remove that same token embedded in `message`, stack, cause, SQL params, URL,
JSON text or mail content. Default serializers run within Pino; independent
console/dependency output never passes through these paths.

### Injection and reserved fields

Pino encoded an accountName newline as `\n`, producing one physical JSON line.
It safely escapes user-controlled string _values_ at the inspected delta/IDLE
sites. A constructed object containing `level`/`time` produced duplicate reserved
JSON keys; standard JSON.parse selected the later supplied values. Message text
remained the fixed final msg in that experiment. This is an unsafe arbitrary-key
caller contract, not an established attacker overwrite in current mail sites:
those build fixed property names and spread a locally constructed fixed-key
context. Username/account/email/mailbox/subject values do not become JSON keys.

Better Auth callbackURL logging is plain interpolated text, so a submitted newline
did create a forged extra physical line. Query/body callbackURL is the tested
vector; HTTP Origin headers cannot simply contain arbitrary literal newlines.
Provider raw exception text on other console paths has no JSON line guarantee.

## L. Security-event coverage

| Event category                           | Existing production evidence                                                                    | Assessment                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Setup completed / rejected               | No dedicated event                                                                              | Completion and unexpected failure would be useful; aggregate/minimize public rejections       |
| Password login failed                    | Some fixed Better Auth warnings                                                                 | Unstructured, not comprehensive; app validation/throttle paths are silent                     |
| Login succeeded after MFA                | No dedicated event                                                                              | Missing useful security signal; do not equate password challenge with completed login         |
| Authentication throttled                 | Response only                                                                                   | Missing bounded admission category/retry signal                                               |
| MFA challenge failed                     | Usually no event                                                                                | Useful aggregate category, without proof/challenge/token                                      |
| MFA enrollment completed                 | No dedicated event                                                                              | Useful state-change signal                                                                    |
| Recovery code consumed                   | No dedicated event                                                                              | Useful security event, without code/index/code array                                          |
| Replacement started/completed/cancelled  | No dedicated event                                                                              | High-value state change, currently silent                                                     |
| Recovery codes regenerated               | No dedicated event                                                                              | High-value state change, currently silent                                                     |
| Logout/revocation failed                 | Fixed logout_revocation_failed                                                                  | Useful and correctly minimized; other MFA/session revocations lack their own distinct outcome |
| Cookie cleanup failed                    | Fixed logout_cookie_cleanup_failed                                                              | Useful operational signal distinct from revocation                                            |
| Owner/session invariant violation        | Mainly generic response or raw exception                                                        | Missing normalized invariant/revocation category; no usernames/session values required        |
| OAuth linking/refresh failure            | Fixed responses/status changes; no dedicated Pino event                                         | No clear normalized operation/provider category in container output                           |
| Provider authentication repeatedly fails | account.connection_failed with category in owner-visible DB; generic IDLE disconnection in Pino | Useful diagnostics exist, but repeated auth failures are not clearly classified in Pino       |
| Worker/jobs/readiness lifecycle          | jobs.started/stopped, worker.mfa_pending/shutdown/start failure                                 | Useful operational state; raw failures need normalization                                     |

For a single owner, the minimum useful **security audit** set is completed
setup/enrollment, completed MFA login, bounded login/proof failure and throttle
summary, recovery use/regeneration, replacement state changes, failed revocation
and invariant rejection. Coalescing repeated public failures is appropriate;
logging every malformed request is unnecessary. Use fixed event/category/operation,
outcome, status/retry duration and where necessary a local opaque ID. Do not add
passwords, proof codes, cookies, replacement authorities, query strings, raw
objects or trusted-client-IP assumptions. Logging remains observational and must
not determine authorization or transaction success.

**Operational diagnostics:** worker/readiness/job failure category, provider type,
link/refresh operation, authentication_rejected, retries/durations/counters and
local account/mailbox IDs. Existing sanitized Application Events and logout
warnings are good models. Best-effort normalized logger failure must not roll back
security controls or block mail work.

**Noise:** every successful poll/sync/reconnect with repeated email/path, repeated
raw exceptions, per-proof secret-less but unbounded logs, and F9 advice suggesting
operators should trust proxy IP headers. Preserve meaningful failures while
minimizing/coalescing routine and attacker-driven output.

## M. Findings

No BLOCKER severity finding is assigned. HIGH/MEDIUM findings below justify an
F11 implementation session. Severity describes the data/trigger, not merely that
the application handles mail.

### F11-01 — HIGH: Better Auth session lookup failures disclose bearer tokens

- **Type:** confirmed secret leakage; independent dependency logging.
- **Affected:** auth-factory (no logger boundary), Better Auth session endpoint,
  getValidOwnerSession/proxy and callers using it.
- **Data:** session bearer token; potentially other SQL parameter/exception data
  on generic dependency error paths. Password/MFA token errors were not all
  runtime-injected and are not claimed confirmed here.
- **Behavior/trigger:** database failure on lookup by signed-cookie token causes
  DrizzleQueryError; Better Auth console.error prints raw error before outer
  response handling. Default production warn level includes errors.
- **Evidence:** disposable real auth login; temporarily renamed session table,
  executed current auth.handler get-session, restored table in finally. 500 and
  exact generated session marker found in captured stderr-equivalent output.
  Installed session.mjs:231, core env logger, errors.js corroborate the trace.
- **Consequence:** anyone reading retained logs receives bearer authentication
  material; outer generic responses/fixed logout logging do not contain it.
- **Smallest direction:** supply a normalized Better Auth logger/error policy
  that emits fixed allowlisted categories and never forwards raw arguments,
  messages, stacks containing params or URL text. Retain useful errors. Verify
  session/auth/MFA failure paths without changing auth/session architecture.

### F11-02 — MEDIUM: Pino redaction does not provide recursive or text protection

- **Type:** insufficient redaction guarantee, demonstrated synthetic leaks.
- **Affected:** logger.ts and installed Pino/redact/default err serializers.
- **Data:** nested credentials, array entries, mixed-case/snake-case secret names,
  raw messages/causes/SQL params/envelopes.
- **Behavior/trigger:** arbitrary unsafe metadata or exceptions reach Pino;
  `**` is literal/nonrecursive and field masks do not examine text.
- **Evidence:** K's executed cases; installed redaction implementation. The existing
  OAuth test only proves top-level/one-level examples.
- **Consequence:** callers can believe a deeper credential object is masked when
  it is emitted. This is not proof normal MFA code dumps those objects.
- **Smallest direction:** define a safe logging contract and allowlisted error
  representation; correct supported nested/array protection where actually needed,
  document exact case/shape limits and never promise arbitrary text sanitization.

### F11-03 — MEDIUM: raw worker/framework exception sinks remain outside a safe contract

- **Type:** unsafe caller behavior / framework logging; conditional exposure.
- **Affected:** JobRuntime raw error callback, worker shutdown/start failures,
  migration/composition native failure, Next error/request-failure handlers.
- **Data:** provider/DB detail, SQL values, mail content or credential-bearing
  query strings when present in a thrown value/request URL.
- **Behavior/trigger:** raw Error/object forwarded; Next outer catch prints full
  req.url. No universal Maildock normalization occurs at these boundaries.
- **Evidence:** direct current JobRuntime event injection and installed Next
  BaseServer.logError disclosed canaries. Full Next OAuth callback/worker fatal
  production reproduction is a gap; source shows actual handlers.
- **Consequence:** bypass of Pino field redaction or unsafe serialization within
  it; potentially sensitive content in container output.
- **Smallest direction:** replace own raw-error emissions with stable categories;
  normalize application exceptions before framework/native boundaries, and
  explicitly assess the smallest supported Next outer-URL/error control. A console
  monkeypatch or blind global logging shutdown is not prescribed by discovery.

### F11-04 — MEDIUM: pg-boss failure output copies raw query diagnostics

- **Type:** confirmed dependency diagnostic persistence; application path
  supported by source, not an end-to-end failed-mail-write reproduction.
- **Affected:** discovery/recent/delta/backfill rethrows; installed manager.fail.
- **Data:** subject/address/folder/attachment metadata in query params; raw query
  failure content if other DB writes escape service cleanup.
- **Behavior/trigger:** handler throws raw error; pg-boss serializes error into job
  output even when ordinary service status text was sanitized.
- **Evidence:** real disposable PgBoss worker with synthetic DrizzleQueryError
  subject marker; persisted output contains marker, error-event count zero.
  Application rethrow sites: message-service.ts:363, delta-sync-service.ts:367,
  backfill-sync-service.ts:137, mailbox-discovery-service.ts:81.
- **Consequence:** job diagnostics become an unnecessary secondary copy of
  mailbox/private exception data; container-only redaction would miss it.
- **Smallest direction:** normalize exceptions at application job boundaries,
  preserving job failure/retry semantics and safe queue/operation/category IDs.
  Include status-write/cleanup failures in that boundary. No queue redesign.

### F11-05 — MEDIUM: Better Auth URL rejection emits arbitrary query text and log lines

- **Type:** confirmed input-text exposure and log injection.
- **Affected:** installed origin-check middleware reached by allowed username
  sign-in; Better Auth independent logger.
- **Data:** complete rejected callbackURL, including code/query values; arbitrary
  user-controlled newline/control content.
- **Behavior/trigger:** a login request with valid application Origin and a
  schema-accepted disallowed callbackURL is rejected, then prints the raw URL.
- **Evidence:** current auth.handler runtime returned 403 and printed a synthetic
  code marker followed by a separately forged physical line. Installed middleware
  line 56 directly interpolates URL. Pino mail string fields did not line-forge.
- **Consequence:** misleading operational/security log entries and private URL
  text retained in logs. No claim it steals an unknown provider token from another
  user; the tested URL was supplied by the caller.
- **Smallest direction:** dependency logging adapter categorizes URL/Origin
  rejection with fixed fields, omitting raw URL/query/control text. Preserve exact
  Origin/CSRF policy and existing endpoint allowlist.

### F11-06 — LOW: routine delta/IDLE logs retain personal account/folder metadata

- **Type:** excessive personal/mail metadata logging.
- **Affected:** delta-sync-service:299/340; idle-watchers:162/176.
- **Data:** accountName, accountEmail, mailboxPath; repeated at production info/warn.
- **Behavior/trigger:** routine sync, reconnect/disconnection events serialize
  these selected DB fields. Account display names and folder paths are user/remote
  content, not opaque IDs.
- **Evidence:** fixed call sites and context selectors; current OAuth logging test
  explicitly expects those fields to remain visible; PHASE_3F documents them.
- **Consequence:** retained container logs index identity/folder metadata. Owner
  diagnostics already offer labels, so routine external repetition is unnecessary.
- **Smallest direction:** retain local account/mailbox UUID, counters/reason/category
  in operational logs; retain deliberately scoped owner-facing labels in the
  Application Events viewer where needed. Do not silently remove useful failure
  classification along with metadata.

### F11-07 — MEDIUM: useful security state-change and admission events are absent

- **Type:** missing useful audit signal.
- **Affected:** setup, completed MFA login, recovery/management/replacement,
  application admission/invariant handling.
- **Data at risk:** no direct data disclosure; loss of operator evidence of
  suspicious/recovery/authenticator actions and repeated admission rejection.
- **Behavior/trigger:** actions complete/reject with no dedicated normalized
  event; some generic Better Auth warnings cannot identify completed MFA login,
  replacement or app admission category.
- **Evidence:** source inventory contains no logger calls in ceremonies/admission;
  Application Event definitions contain only account/mail events; runtime silence
  on exercised setup/MFA/throttle paths.
- **Consequence:** self-host operator cannot reliably distinguish important
  security actions and failures using production logs.
- **Smallest direction:** implement L's small bounded event set using fixed
  names/outcomes, rate-limit/coalesce repetitive public failures, and emit outcomes
  in accordance with transaction completion. No per-code logging or auth redesign.

### F11-08 — LOW: malformed APP_ORIGIN escapes configuration normalization

- **Type:** startup exception/input logging concern.
- **Affected:** config.ts:139 superRefine; uncaught composition/migration startup.
- **Data:** submitted APP_ORIGIN text; normally public, possibly miscopied private
  URL/secret. Other tested secret configuration values were not exposed.
- **Behavior/trigger:** malformed origin throws native Invalid URL with input
  property rather than sanitized ConfigurationError.
- **Evidence:** runtime parseConfig plus Node inspection in canary matrix.
- **Consequence:** native startup stderr can echo that input and loses useful
  variable-only validation format.
- **Smallest direction:** keep URL parse failure within sanitized variable-name
  configuration validation. Do not log the failing value.

### F11-09 — INFORMATIONAL: F9 warning and retention requirements need precise documentation

- **Type:** documentation/operator concern, no demonstrated credential disclosure.
- **Affected:** dependency no-trusted-ip warning; architecture/log-retention docs.
- **Behavior/trigger:** once-per-module warning advises trusting forwarded IPs,
  contrary to intentional F9 design; Application Events retention could be confused
  with container output if summarized without its separate boundary.
- **Evidence:** installed module flag/message; PHASE_3F distinguishes stores;
  Docker children inherit output and own no operational files/rotation.
- **Consequence:** misleading operational advice; operators need accurate scope.
- **Smallest direction:** document expected F9 fallback and normalize its diagnostic
  if inexpensive; explicitly state operator-owned stdout/stderr retention. Leave
  platform rotation/daemon configuration to F12.

## N. Controls already correct — do not rewrite

- F1 bootstrap authorization and bounded setup remain intact.
- F2 mandatory MFA, pending/replacement readiness and session issuance boundaries
  remain intact; never treat a logging event as an authorization result.
- F3 Argon2 setup admission and F8 PostgreSQL password/MFA/management admission,
  delay/attempt persistence and shared keys remain intact.
- F4 exact Origin/CSRF and route allowlists remain intact, including provider
  callback protocol protections. Do not disable checks to avoid log messages.
- F5 lifetime/revocation and F10 immutable owner binding remain intact.
- F6 logout fixed-error events, precise deletion confirmation and cookie cleanup
  remain; address the upstream dependency logger without weakening these controls.
- F7 username grammar/normalization remains intact.
- F9 no-authoritative-client-IP and shared-path fallback remain intentional.
- Encryption context/key/envelope architecture, encrypted OAuth cache, state
  hashing/session binding/expiry/consumption and PKCE remain intact.
- IMAP logger false, SMTP logger/debug false, TLS validation, MSAL no-op logging,
  fixed provider failure categories and Google response/fetch normalization remain.
- Existing pg-boss job IDs/payload architecture, retries, mailbox locks, attachment
  bounds and MIME/content sanitization remain; only diagnostics require changes.
- Application Events fixed definitions/allowlisted details and best-effort safe
  persistence warnings remain a useful model. Their retention is not global logs.
- Pino JSON escaping prevents line forging at current fixed-key mail sites.

## O. Proposed F11 implementation scope

### MUST FIX for V1

1. Close confirmed Better Auth session-token/error logging and raw rejected-URL
   logging using a narrow normalized dependency logging boundary. Keep useful
   security/operational categories and exact auth/CSRF semantics.
2. Establish safe application error serialization/caller contract; eliminate raw
   exception forwarding at own worker/job/startup boundaries. Correct shallow
   redaction assumptions; do not treat regex scrubbing as proof arbitrary strings
   are safe. Explicitly resolve supported Next outer-error/full-query handling.
3. Prevent raw application job errors/SQL params from becoming pg-boss failure
   output while preserving failure, retry, lock and settlement semantics.
4. Provide the minimal normalized audit signal for completed security state
   changes, completed MFA login and bounded admission/proof failures, revocation
   failures/invariant rejection. Best-effort output must not alter authorization.
5. Minimize routine account email/display/folder metadata in stdout diagnostics.

### SHOULD FIX if inexpensive

- Keep malformed APP_ORIGIN parse errors within sanitized configuration errors.
- Add useful fixed provider/link/refresh/readiness component categories and
  operation/retry/duration context where already available, rather than raw errors.
- Normalize expected F9 fallback diagnostics without requesting proxy trust.
- Reserve logging keys; prohibit arbitrary-key/context/error/config dumps. A
  URL object currently can crash logging, reinforcing that caller restriction.
- Reduce routine reconnect/completion noise; retain meaningful failure summaries.

### DOCUMENT

- Supported redaction case/path/depth/array and Error limitations; forbidden
  plaintext/object/string inputs; installed-version behavior.
- Distinct operational stdout/stderr, Application Events and pg-boss error-output
  boundaries; opacity is not sanitization, encryption is not permission to log.
- Platform-owned retention/access controls; current architecture assertions are
  requirements and cannot yet be advertised as achieved security guarantees.
- Runtime gaps: real provider sockets/production Next failure, other MFA error
  injection and migration failure. Future verification should remain synthetic.

### DEFER TO F12

Container capabilities/filesystem/image/package hardening, resource limits,
generic HTTP headers, secret injection/storage deployment mechanism, platform log
rotation/retention/access policy and Docker daemon configuration. No F12 fixes or
new deployment design were performed here.

## P. Validation and repository hygiene

- HEAD: `7b44680fc986dbfe03f9d628cdd0cab99ba3867b`, unchanged.
- Initial `git status --short`: empty.
- Shell default Node was v22.22.3, below repository requirement. All executed
  validation harnesses and Vitest used bundled **Node v24.19.0** at
  `C:\Users\mateu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`,
  satisfying `>=24.15.0 <25`; no runtime install/change was performed.
- Shell pnpm reports 11.19.0; repository declares pnpm 12.6.0. Validation invoked
  installed `node_modules/tsx/dist/cli.mjs` and `node_modules/vitest/vitest.mjs`
  directly under Node 24, without pnpm install or lockfile mutation.
- Relevant resolved dependencies: Better Auth/core/Drizzle adapter 1.7.5, Pino
  10.3.1, @pinojs/redact 0.4.0, pino-std-serializers 7.1.0, ImapFlow 2.0.6
  (patched), Nodemailer 10.0.10, pg-boss 12.33.7 (patched), pg 8.23.0,
  postgres.js 3.4.9, Drizzle 0.45.3, Next 16.3.6, mailparser 3.9.28,
  msal-node 7.0.0 / msal-common 16.14.1, Zod 4.6.5, Vitest 5.0.1,
  tsx 4.23.15. Existing repository patches were read/preserved.
- Docker engine available: 28.5.1. Disposable `postgres:18.6-bookworm` containers
  used only synthetic credentials and were stopped by harness/test cleanup.
- Temporary external scripts: `canary.mts`, `auth-canary.mts`,
  `framework-canary.mts`, `job-canary.mts`. Runtime captures/results and logs
  remain only in the external temporary directory named in J. No harness/test
  source was added to the repository; no automatic/unit tests were created or
  modified there.
- First 10-file existing-test run passed 203 tests. Following redactor/auth/
  framework temporary validation, the same 10 files were rerun: **203 passed**:
  `oauth-logging.test.ts`, `config.test.ts`, `mail-provider.test.ts`,
  `google-oauth-routes.test.ts`, `google-oauth.integration.test.ts`, and
  security `logout.integration.test.ts`, `bootstrap.integration.test.ts`,
  `initial-mfa.integration.test.ts`, `mfa-management.integration.test.ts`,
  `f8-admission.integration.test.ts`. Post-validation capture:
  `post-validation-tests.log` (43.28 seconds). Existing MFA logging test includes
  successful recovery login/cancellation; this is existing-test evidence.
- After the real pg-boss canary, 6 relevant existing files passed **25 tests**:
  `runtime-jobs.integration.test.ts`, `recent-sync-jobs.test.ts`,
  `phase1e-jobs-watchers.test.ts`, `phase1g-jobs.test.ts`, `outgoing-jobs.test.ts`,
  `sent-copy-jobs.test.ts`; capture `job-tests.log` (5.37 seconds).
- Total distinct existing tests validated: **228 in 16 files**. No full suite,
  build, deployment, application typecheck or migration against an existing
  installation was needed/performed for this report-only discovery.
- Report formatting checked with installed Prettier. No repository files beyond
  this report were changed. F1–F10 controls and architecture were preserved.

Exact final `git status --short`:

```text
?? docs/SECURITY_F11_DISCOVERY.md
```

**F11 LOGGING DISCOVERY: IMPLEMENTATION REQUIRED**
