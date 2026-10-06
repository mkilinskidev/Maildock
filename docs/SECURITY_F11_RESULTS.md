# F11 security logging implementation results

Review date: 2026-10-06. Result: **PASS** for the implemented and tested V1
application boundaries. No confirmed sensitive disclosure remains in those
reachable operational or pg-boss diagnostic paths. The framework and redaction
limitations below are part of this result, not claims of universal sanitization.

## A. Baseline and working tree

Baseline HEAD: `7b44680fc986dbfe03f9d628cdd0cab99ba3867b`,
`security: establish proxy-independent ingress boundary`. HEAD is unchanged.
The starting tree had only the untracked authoritative
`docs/SECURITY_F11_DISCOVERY.md`; it was read and left unchanged. Implementation,
regression tests and this report remain uncommitted. No commit, push or deployment
was performed. Only synthetic secrets and local/disposable infrastructure were used.

## B. Final diagnostic architecture

Logs receive Maildock-owned allowlisted diagnostics. Arbitrary Error, message,
stack, cause, SQL/params, request/response, headers, query URL, configuration,
provider payload and job objects are not diagnostic inputs.

- Better Auth's supported logger and API-error callback discard dependency
  content and emit fixed structured dependency events through Pino.
- `diagnostics.ts` produces finite component/operation/category fields; logging
  exceptions are best effort and have no authority over application state.
- All nine registered mail handlers replace thrown failures with a fresh bounded
  `SafeJobFailure` before pg-boss serializes them.
- API handlers, async server pages and proxy session lookup contain application
  exceptions before the outer Next sinks. Existing authorization and response
  branches remain inside the boundaries.
- A finite security-event function accepts an event name only. Success follows
  transaction completion; repeated failure events coalesce per process.
- Pino key redaction is fallback protection for documented shapes only.

Operational stdout/stderr, deliberately scoped owner-facing Application Events,
and pg-boss durable job output remain distinct stores. No audit database or new
queue/authentication architecture was introduced.

## C. Discovery findings

| Finding                                              | Resolution and evidence                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F11-01: bearer token in Better Auth session DB error | Closed. Real generated session plus hidden session table still fails with HTTP 500; actual child stdout/stderr contain fixed dependency diagnostics and no token/SQL params.                                                                                    |
| F11-02: unsupported recursive/text redaction         | Closed by an explicit limited contract, removal of `**`, supported key variants and deterministic positive/negative tests. Arbitrary text/deep objects remain forbidden inputs.                                                                                 |
| F11-03: raw worker/framework error sinks             | Application-owned sinks closed: worker composition/start/readiness/shutdown, migration, JobRuntime, web producers, API/proxy/pages. Production Next canary confirms contained application failures; conditional framework-internal residual is documented in H. |
| F11-04: raw pg-boss failure output                   | Closed. Every registered handler is wrapped. Real discovery retry and outgoing terminal failure persist only fresh bounded failure fields.                                                                                                                      |
| F11-05: rejected URL/query and log injection         | Closed. Supported dependency callback discards arguments; invalid callbackURL with query/newline/control markers remains rejected with HTTP 403. No marker or forged physical log line in captured stdout/stderr.                                               |
| F11-06: routine personal mail metadata               | Closed. Delta/IDLE operational output uses local account/mailbox IDs and bounded reasons/counts/checkpoints; account display name, email and remote folder path removed.                                                                                        |
| F11-07: missing security signal                      | Closed for operations actually supported by V1. Finite events, commit-aware success and bounded failures tested. Replacement cancellation is absent from V1, as clarified by the user; see I.                                                                   |
| F11-08: malformed APP_ORIGIN                         | Closed. URL construction becomes fixed ConfigurationError issues. Compiled worker/migration emit fixed fatal diagnostics identifying APP_ORIGIN, exclude its value and exit 1.                                                                                  |
| F11-09: misleading F9 warning/retention              | Closed. Exact installed static warning becomes an informational shared-path policy event. No proxy/IP trust change. Retention responsibilities documented in M/N.                                                                                               |

## D. Better Auth and installed source

Inspected installed Better Auth/core **1.7.5** logger implementation/types,
session endpoint, origin middleware, rate limiter and API router. The supported
custom `logger.log` replaces the console sink at the configured threshold. The
router has an additional global-logger fallback outside endpoint context:
`onAPIError.onError` now supplies a fixed diagnostic instead of that fallback.

`auth-logger.ts` accepts calls at warn/error, ignores arbitrary extra arguments
and does not inspect Error getters. Output is `auth.dependency_error` or
`auth.dependency_warning`, component `better_auth`, category `dependency`, with a
fixed message. Only exact equality against the installed static missing-IP warning
selects `auth.shared_path_limiter`: “V1 intentionally uses shared path limiting
without trusted client IP”. It does not parse arbitrary strings for secrets.

The patched Drizzle adapter, database rate limiting, trusted origins, endpoint
allowlist, Origin/CSRF validation, F8 admission and empty trusted client IP header
list remain intact. No global console monkeypatch or dependency patch was added.

## E. Application failure contract

`failureDiagnostic` contains fixed event, component and operation plus
`internal_error` or `configuration`. Trusted ConfigurationError conditions may
add only `configurationField: APP_ORIGIN | environment`. It copies no original
message, stack, cause, SQL, params or arbitrary dependency codes. Worker and
migration failures retain nonzero exit behavior. Logging exceptions do not alter
authorization, revocation, cookie cleanup or transaction results.

Session validation still throws on infrastructure failure, but its outgoing Error
is fixed and has no original cause. Owner/session invariant rejection remains a
rejection. Synchronous database construction, which can occur before route code
runs, throws only a fixed configuration initialization failure. Async DB failures
follow the request/job/process boundaries.

Final repository search found no remaining Maildock-owned raw Error-to-Pino
sink. Remaining direct auth error calls are the existing fixed logout events;
the migration console message is fixed success text. Existing provider/service
diagnostics and Application Events remain bounded.

## F. Pino fallback contract

Installed Pino **10.3.1** / `@pinojs/redact` **0.4.0** source was inspected.
There is no recursive `**` guarantee. Supported paths are root and one object
level for the exact listed keys, `auth.pass` / `*.auth.pass`, and explicit
`req.headers` authorization/cookie case variants. Censor is `[REDACTED]`.
Variants include access/refresh/client secrets in camel/snake case, IMAP/SMTP
password, session/bootstrap/encryption fields and Authorization/Cookie.

Tests deliberately show that deeper objects, arrays, unknown key case variants,
Error.message/cause/stack, SQL, URL, JSON and free-form strings retain canaries.
These test-only prohibited inputs are evidence of the contract's limits, not
production-safe inputs. Request/Headers-like objects sometimes serialize as `{}`;
that is not a confidentiality guarantee. URL objects can even throw during
redaction. Arbitrary objects can override structured fields. Consequently no
application boundary relies on redaction to make arbitrary objects/text safe.

## G. pg-boss durable output

Inspected installed pg-boss **12.33.7** manager/serialization behavior: thrown
handler errors become job output independently of runtime error events.
`safeJobHandler` wraps schema validation, lock work, service calls and continuation
work for discovery, recent, delta, backfill, content, attachment, message-command,
outgoing and sent-copy. It rethrows a fresh Error with fixed name/message,
operation and `internal_error`, no stack and no original properties/cause.

Real disposable PostgreSQL/pg-boss tests injected a DrizzleQueryError containing
synthetic SQL/mail/credential markers through registered handlers. Discovery with
retry limit 4 reached `retry`; outgoing with retry limit 0 reached `failed`.
Both outputs contained exactly `name`, `message`, `category`, `operation`; no
canary. Queue names/options, IDs/payloads, settlement/retry behavior, locking and
coalescing were preserved. Failures were not converted into successes.

## H. Next/framework boundaries and residual

Inspected installed Next **16.3.6** request/error handling. Each exported async
API handler is contained by `routeBoundary`, including preauthorization work.
Unexpected failures become a fixed no-store 503 response. Async server pages
preserve actual Next redirect/notFound/dynamic control flow using
`unstable_rethrow`; ordinary failures emit a fixed diagnostic and throw a fresh
fixed Error. Proxy lookup failures receive a fixed 503 with existing CSP behavior.
OAuth callback code/state/request URLs never become diagnostic fields.

Actual optimized standalone Next runtime was started on loopback with a disposable
database. Session DB failures on Google/Microsoft callbacks returned 503, account
DB failure on an API returned 503, and a page DB failure returned 500. Captured
stdout/stderr contained normalized auth/request/render events and only the fresh
generic page Error at the framework sink. Bearer, OAuth query and mail metadata
markers were absent. Its generated framework stack/digest were not original SQL
or Error properties.

Residual: installed `next/dist/server/lib/start-server.js` request/upgrade catches
(lines 229/230 and 256/257 in the inspected installation) can print complete
`req.url` and an internal raw error if framework routing/module/transport work
fails outside Maildock control, including before a Maildock callback is invoked.
Those framework-internal paths are not universally eliminated. No sensitive
reachable V1 disclosure was reproduced after the application boundaries; no Next
fork, dependency patch, global console replacement or F12 deployment work was done.

## I. Security events and transaction semantics

All events have prefix `security.`, component `auth`, category `security`, a fixed
message and outcome `completed` or `rejected`; there is no caller payload argument.

| Event suffix                        | Trigger                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| setup_completed                     | Owner setup transaction completes.                                     |
| mfa_enrollment_completed            | Initial enrollment transaction completes.                              |
| mfa_login_completed                 | MFA login succeeds after transaction completion.                       |
| recovery_code_consumed              | Successful committed recovery proof consumption, including management. |
| authenticator_replacement_started   | Replacement authority transaction completes.                           |
| authenticator_replacement_completed | Replacement completion succeeds after transaction completion.          |
| recovery_codes_regenerated          | Regeneration transaction completes.                                    |
| admission_rejected                  | Auth/setup admission rejects work.                                     |
| proof_rejected                      | Relevant MFA/bootstrap proof rejects.                                  |
| session_failed                      | Session lookup/revocation/cookie cleanup fails.                        |
| invariant_rejected                  | Non-owner/session invariant rejection is observed.                     |

**Authenticator replacement cancelled does not exist as a V1 operation. Therefore
there is no corresponding audit event.** Cancelling a login challenge is a
different existing operation. Per the user's clarification, this is neither a
missing F11 event nor a blocker; MFA/F2.4 protocol scope was not expanded.

Successes are INFO; failures WARN. Four finite process-wide failure slots emit at
most once per event per minute, without caller-controlled map keys or new admission
decisions. This may coalesce distinct failures and is not a durable audit ledger.
Audit output uses a lazy INFO logger independently of operational LOG_LEVEL/config
parsing, so those events remain observable without reading configuration during
failure. All logging is best effort.

Real deferred-COMMIT failure tests prove success events are absent after failed
setup/enrollment/login/regeneration/replacement state changes, and present after
successful commits. Real stdout/stderr assertions exclude passwords, TOTP/URI,
recovery codes/lists, bearer/cookies, bootstrap, replacement authority and OAuth
input. No username/client IP/body/query/challenge payload is accepted. Pino buffers
can reorder physical writes from independent destinations; the test correlates
emission timestamps with disjoint scenario intervals, not write ordering.

## J. Metadata and dependency controls

Delta/IDLE logs retain local accountId/mailboxId, bounded failure reasons, counts
and numeric checkpoints. Routine accountName/accountEmail/mailboxPath fields and
unneeded label selection were removed. Real protocol folder selection still uses
the folder path; deliberately scoped owner-facing Application Events retain their
existing labels. Updated fixtures assert synthetic labels are absent from Pino.

ImapFlow `logger: false`, absence of logRaw/emitLogs, Nodemailer `logger: false`
and `debug: false`, MSAL `piiLoggingEnabled: false` with no-op callback, and
postgres.js disabled debug remain unchanged. No provider option/protocol logging
was enabled. No package, lockfile or dependency patch was changed.

## K. Runtime before/after evidence

Local captures are outside the repository at
`C:\Users\mateu\AppData\Local\Temp\maildock-f11-implementation-20261006`.
The authoritative before state is `SECURITY_F11_DISCOVERY.md`; its captures are
under the separate `maildock-f11-20261006` temporary directory.

| Canary                                     | Discovery before                                 | Implementation after / capture                                                                                                 |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Real session DB failure                    | Bearer in dependency SQL error                   | Fixed auth diagnostic, failed request, bearer/SQL absent; `auth-stdout.log`, `auth-stderr.log`.                                |
| Rejected callbackURL query/newline/control | Query disclosure / injected physical line        | Still 403; no markers; each captured diagnostic line parses as JSON; same auth capture.                                        |
| Pino adversarial matrix                    | Unsupported recursive/text protection            | Known variants censored; unsupported deep/text probes intentionally retain markers; `canary-results.json`, `pino-capture.log`. |
| JobRuntime raw error                       | Raw Error/token SQL                              | Fixed `jobs.runtime_failed`, no marker; matrix capture and regression test.                                                    |
| Registered real failed jobs                | Raw SQL subject persisted                        | Safe discovery retry/outgoing failed output; `mailbox-discovery-job-output.json`, `outgoing-job-output.json`.                  |
| Worker composition/readiness/shutdown      | Raw owned failures could escape                  | Actual process-module tests capture fixed events and exit 1; `f11-worker.test.ts`.                                             |
| Malformed APP_ORIGIN                       | Native URL input could escape                    | Fixed config issues; compiled worker/migration exit 1 without marker; `worker-config.log`, `migration-config.log`.             |
| Setup/MFA/management state changes         | Missing signal                                   | Commit-aware events, rollback/rejection/coalescing assertions; auth captures and process harness.                              |
| Injected IMAP/SMTP EAUTH                   | Existing safe provider categories                | Still fixed authentication_rejected messages, no injected response/password/body markers; `canary-results.json`.               |
| Production Next application DB failures    | Framework raw sink / conditional req.url concern | Callback/API 503, page 500, no sensitive markers; `next-results.json`, `next-stdout.log`, `next-stderr.log`.                   |

The matrix is a diagnostic experiment intentionally passing forbidden data to a
test logger. Its retained markers must not be confused with the secured production
paths. No real provider or mailbox connection was used. Local Next child and
disposable PostgreSQL containers were stopped after canaries/tests.

## L. Exact validation and tooling

Used Node **v24.19.0** from
`C:\Users\mateu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`,
with that bin first on PATH. The shell's other Node/pnpm versions were not used
for validation. Every pnpm command below ran via `pnpm dlx pnpm@12.6.0` (supported
pnpm **12.6.0**). Integration infrastructure: disposable `postgres:18.6-bookworm`.

| Command                                                                | Final result / capture                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dlx pnpm@12.6.0 test --maxWorkers 3`                             | Exit 0; **97 files / 1173 tests passed**, 221.87s; `repository-suite-complete.log`.                                                                                      |
| `pnpm dlx pnpm@12.6.0 test:security --maxWorkers 3`                    | Exit 0; **24 files / 347 tests passed**, 188.72s; `security-suite-complete.log`.                                                                                         |
| `pnpm dlx pnpm@12.6.0 typecheck`                                       | Exit 0; web and worker TS checks; `typecheck-final.log`.                                                                                                                 |
| `pnpm dlx pnpm@12.6.0 lint`                                            | Exit 0; 0 errors, 13 pre-existing warnings in ignored .security-results scripts (12 in f8-discovery.local.test.ts, 1 in signature-settings-preview.mjs); lint-final.log. |
| `APP_ORIGIN=https://maildock.example.test pnpm dlx pnpm@12.6.0 build`  | Exit 0; optimized Next build, worker compilation and import rewriting; `build-passing.log`.                                                                              |
| `pnpm dlx pnpm@12.6.0 exec prettier --check <changed supported files>` | Exit 0; all changed supported TS/TSX/Markdown files formatted; prettier-final.log.                                                                                       |
| `git diff --check`                                                     | Exit 0; no whitespace errors.                                                                                                                                            |

For the build, APP_ORIGIN was set as the PowerShell environment variable; all
secret/config overrides were synthetic (DB loopback placeholder, synthetic
base64 keys/bootstrap, empty optional Microsoft credentials, attachments in the
capture directory). No production environment was used.

The complete suite covers logging, auth/session, bootstrap/setup, initial MFA,
login/management/logout, F8/F9, OAuth, providers/mail, jobs/runtime and config.
New F11 regression files contain **20 tests** (16 logging/registered-handler,
2 actual worker process-module, 2 real PostgreSQL/child-output integration tests).
The route-policy AST test now verifies the single outer boundary and preserves
the existing guards inside it; account-provider redirect fixtures use actual Next
control-flow shape. Updated delta/IDLE tests assert metadata omission.

Earlier validation failures were resolved: Turbopack resolution for newly added
runtime imports, a worker-test listener type, old boundary/redirect fixture
assumptions, and the Pino buffered-write ordering assumption in the child harness.
Final repeated complete/security runs above passed after those corrections.
External matrix and standalone Next runtime canaries were also rerun successfully.

## M. Final review answers and remaining limitations

1. **Can session DB failure put a bearer token in stdout/stderr?** No in the
   tested V1 path: supported dependency callbacks discard the underlying error.
2. **Can rejection logs print a caller callbackURL/query or forge a line?** No
   through the installed normalized Better Auth boundary; request remains rejected.
3. **Does Maildock rely on Pino for arbitrary Error/text sanitization?** No.
4. **Can owned worker/runtime raw errors reach logs?** No through the normalized
   owned sinks; injected and actual process-module tests confirm bounded output.
5. **Can failed handlers put sensitive raw data in job.output?** No through the
   nine registered handlers; fresh safe failures retain retry/failed semantics.
6. **Do routine delta/IDLE logs contain email/display name/path?** No; opaque
   local IDs and bounded operational fields remain.
7. **Are important state changes observable?** Yes for supported V1 operations;
   post-commit finite events, with no nonexistent replacement-cancel operation.
8. **Can audit events contain ceremony/credential secrets?** Their interface
   accepts only the finite event name; runtime capture confirms no secret input.
9. **Does logging change authorization/MFA/commit/F8 decisions?** No. Emission
   is best effort, post-commit success; the coalescer only controls log output.
10. **Are verbose/PII dependency controls disabled?** Yes; unchanged as in J.
11. **Is F9 unchanged?** Yes; no trusted client IP headers, same Origin/proxy
    policy and database shared-path limiter; only warning wording is normalized.
12. **Who owns stdout/stderr retention?** Operator/platform. Application Events
    cleanup is not stdout/stderr cleanup. pg-boss diagnostic retention is separate.

Remaining limits: exact-key redaction is not recursive/text sanitization; future
callers must keep the allowlist contract. Security events are best-effort,
process-local output with one-minute failure coalescing, not guaranteed delivery
or a durable ledger. Conditional Next internal request/upgrade sinks remain as
specified in H. No confirmed bearer/MFA/OAuth credential, mail body or sensitive
SQL parameter remains disclosed in the reproduced reachable V1 paths.

## N. Deferred F12 observations

Operator/platform must define stdout/stderr collection, access, retention and
rotation; pg-boss retention also needs explicit operational ownership. Docker
rotation/Coolify, capabilities, read-only filesystem, images/packages, resource
limits, daemon policy and deployment secret-store changes remain F12. None were
implemented as part of F11.

## O. Exact working-tree snapshots

`git diff --stat` is tracked-files-only; untracked new source/tests/report are
listed by `git status --short` below. No staging was done just to include them in
the diff statistic.

### git diff --stat

```text
 src/app/accounts/[id]/edit/page.tsx                |  21 +-
 src/app/accounts/new/page.tsx                      |   7 +-
 src/app/accounts/page.tsx                          |  88 ++++----
 .../[id]/conversations/[conversationId]/route.ts   |  66 +++---
 src/app/api/accounts/[id]/enabled/route.ts         |  53 ++---
 .../accounts/[id]/mailbox-roles/[role]/route.ts    |  85 ++++----
 .../messages/[messageId]/actions/route.ts          |  77 +++----
 .../messages/[messageId]/content/route.ts          |  49 ++---
 .../messages/[messageId]/prepare/route.ts          |  67 ++++---
 .../messages/[messageId]/render/route.ts           |  85 ++++----
 .../[mailboxId]/messages/[messageId]/route.ts      |  47 +++--
 .../[mailboxId]/messages/refresh/route.ts          |  47 +++--
 .../[id]/mailboxes/[mailboxId]/messages/route.ts   |  67 ++++---
 .../api/accounts/[id]/mailboxes/discover/route.ts  |  41 ++--
 src/app/api/accounts/[id]/mailboxes/route.ts       |  43 ++--
 .../api/accounts/[id]/message-commands/route.ts    |  43 ++--
 src/app/api/accounts/[id]/order/route.ts           |  59 +++---
 src/app/api/accounts/[id]/route.ts                 |  71 ++++---
 src/app/api/accounts/[id]/settings/route.ts        |  59 +++---
 src/app/api/accounts/[id]/signatures/route.ts      |  31 +--
 src/app/api/accounts/[id]/test/route.ts            |  57 +++---
 src/app/api/accounts/route.ts                      |  49 +++--
 src/app/api/accounts/test/route.ts                 |  37 ++--
 src/app/api/application-events/route.ts            |  61 +++---
 .../attachments/[attachmentId]/download/route.ts   |  63 +++---
 src/app/api/attachments/[attachmentId]/route.ts    |  99 ++++-----
 .../api/attachments/staged/[attachmentId]/route.ts |  89 +++++----
 src/app/api/attachments/staged/route.ts            |  91 +++++----
 src/app/api/auth/[...all]/route.ts                 |  59 +++---
 src/app/api/auth/initial-mfa/complete/route.ts     |  11 +-
 src/app/api/auth/initial-mfa/start/route.ts        |  11 +-
 src/app/api/auth/mfa/cancel/route.ts               |  19 +-
 .../mfa/manage/authenticator/complete/route.ts     |  26 ++-
 .../auth/mfa/manage/authenticator/resume/route.ts  |  19 +-
 .../auth/mfa/manage/authenticator/start/route.ts   |  21 +-
 .../auth/mfa/manage/recovery/regenerate/route.ts   |  19 +-
 src/app/api/auth/mfa/recovery/route.ts             |  21 +-
 src/app/api/auth/mfa/totp/route.ts                 |  20 +-
 src/app/api/drafts/[id]/route.ts                   |  79 ++++----
 src/app/api/drafts/[id]/send/route.ts              |  38 ++--
 src/app/api/drafts/route.ts                        |  47 +++--
 src/app/api/health/live/route.ts                   |  11 +-
 src/app/api/health/ready/route.ts                  |  22 +-
 src/app/api/mail/all-inboxes/route.ts              |  67 ++++---
 src/app/api/notifications/route.ts                 |  33 +--
 src/app/api/oauth/google/callback/route.ts         |  71 +++----
 src/app/api/oauth/google/start/route.ts            |  33 +--
 src/app/api/oauth/microsoft/callback/route.ts      |  69 ++++---
 src/app/api/oauth/microsoft/start/route.ts         |  33 +--
 src/app/api/outgoing/[id]/route.ts                 |  47 +++--
 src/app/api/outgoing/route.ts                      | 101 +++++-----
 src/app/api/search/route.ts                        |  45 +++--
 src/app/api/settings/auto-read/route.ts            |  37 ++--
 src/app/api/settings/conversation-view/route.ts    |  41 ++--
 src/app/api/settings/notifications/route.ts        |  39 ++--
 src/app/api/settings/oauth-providers/route.ts      | 115 ++++++-----
 .../api/settings/remote-content-senders/route.ts   |  39 ++--
 src/app/api/setup/route.ts                         | 165 +++++++--------
 src/app/api/signatures/[id]/route.ts               | 107 +++++-----
 src/app/api/signatures/[id]/snapshot/route.ts      |  41 ++--
 src/app/api/signatures/route.ts                    |  53 ++---
 src/app/initial-mfa/page.tsx                       |  43 ++--
 src/app/login/page.tsx                             |  39 ++--
 src/app/page.tsx                                   |  76 +++----
 src/app/setup/page.tsx                             |  35 ++--
 src/composition/worker-process.ts                  | 222 +++++++++++----------
 src/modules/auth/application/initial-mfa-http.ts   |   6 +-
 src/modules/auth/application/initial-mfa.ts        |  10 +
 src/modules/auth/application/instance-auth.ts      |   8 +-
 src/modules/auth/application/logout.ts             |  20 +-
 src/modules/auth/application/mfa-login.ts          |  11 +
 src/modules/auth/application/mfa-management.ts     |  32 ++-
 src/modules/auth/application/session-validation.ts |  66 +++---
 src/modules/auth/infrastructure/auth-admission.ts  |   7 +-
 src/modules/auth/infrastructure/auth-factory.ts    |  13 +-
 src/modules/jobs/infrastructure/job-runtime.ts     |   6 +-
 src/modules/mail/application/delta-sync-service.ts |   5 -
 src/modules/mail/infrastructure/attachment-jobs.ts |  18 +-
 .../mail/infrastructure/backfill-sync-jobs.ts      |   5 +-
 src/modules/mail/infrastructure/content-jobs.ts    |  10 +-
 src/modules/mail/infrastructure/delta-sync-jobs.ts |  10 +-
 src/modules/mail/infrastructure/idle-watchers.ts   |  18 +-
 .../mail/infrastructure/mailbox-discovery-jobs.ts  |  10 +-
 .../mail/infrastructure/message-command-jobs.ts    |  10 +-
 src/modules/mail/infrastructure/outgoing-jobs.ts   |  24 ++-
 .../mail/infrastructure/recent-sync-jobs.ts        |  10 +-
 src/modules/mail/infrastructure/sent-copy-jobs.ts  |  19 +-
 src/proxy.ts                                       |  16 +-
 src/shared/infrastructure/config/config.ts         |  12 +-
 src/shared/infrastructure/database/database.ts     |  16 +-
 src/shared/infrastructure/database/migrate.ts      |  46 +++--
 src/shared/infrastructure/logging/logger.ts        |  73 +++----
 tests/account-provider-flow.test.ts                |   9 +-
 tests/phase1e-jobs-watchers.test.ts                |  16 +-
 tests/phase1e.integration.test.ts                  |  15 +-
 tests/security/route-policy.test.ts                |  24 ++-
 96 files changed, 2322 insertions(+), 1849 deletions(-)
```

### git status --short

```text
 M src/app/accounts/[id]/edit/page.tsx
 M src/app/accounts/new/page.tsx
 M src/app/accounts/page.tsx
 M src/app/api/accounts/[id]/conversations/[conversationId]/route.ts
 M src/app/api/accounts/[id]/enabled/route.ts
 M src/app/api/accounts/[id]/mailbox-roles/[role]/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/actions/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/content/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/prepare/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/render/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/refresh/route.ts
 M src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/route.ts
 M src/app/api/accounts/[id]/mailboxes/discover/route.ts
 M src/app/api/accounts/[id]/mailboxes/route.ts
 M src/app/api/accounts/[id]/message-commands/route.ts
 M src/app/api/accounts/[id]/order/route.ts
 M src/app/api/accounts/[id]/route.ts
 M src/app/api/accounts/[id]/settings/route.ts
 M src/app/api/accounts/[id]/signatures/route.ts
 M src/app/api/accounts/[id]/test/route.ts
 M src/app/api/accounts/route.ts
 M src/app/api/accounts/test/route.ts
 M src/app/api/application-events/route.ts
 M src/app/api/attachments/[attachmentId]/download/route.ts
 M src/app/api/attachments/[attachmentId]/route.ts
 M src/app/api/attachments/staged/[attachmentId]/route.ts
 M src/app/api/attachments/staged/route.ts
 M src/app/api/auth/[...all]/route.ts
 M src/app/api/auth/initial-mfa/complete/route.ts
 M src/app/api/auth/initial-mfa/start/route.ts
 M src/app/api/auth/mfa/cancel/route.ts
 M src/app/api/auth/mfa/manage/authenticator/complete/route.ts
 M src/app/api/auth/mfa/manage/authenticator/resume/route.ts
 M src/app/api/auth/mfa/manage/authenticator/start/route.ts
 M src/app/api/auth/mfa/manage/recovery/regenerate/route.ts
 M src/app/api/auth/mfa/recovery/route.ts
 M src/app/api/auth/mfa/totp/route.ts
 M src/app/api/drafts/[id]/route.ts
 M src/app/api/drafts/[id]/send/route.ts
 M src/app/api/drafts/route.ts
 M src/app/api/health/live/route.ts
 M src/app/api/health/ready/route.ts
 M src/app/api/mail/all-inboxes/route.ts
 M src/app/api/notifications/route.ts
 M src/app/api/oauth/google/callback/route.ts
 M src/app/api/oauth/google/start/route.ts
 M src/app/api/oauth/microsoft/callback/route.ts
 M src/app/api/oauth/microsoft/start/route.ts
 M src/app/api/outgoing/[id]/route.ts
 M src/app/api/outgoing/route.ts
 M src/app/api/search/route.ts
 M src/app/api/settings/auto-read/route.ts
 M src/app/api/settings/conversation-view/route.ts
 M src/app/api/settings/notifications/route.ts
 M src/app/api/settings/oauth-providers/route.ts
 M src/app/api/settings/remote-content-senders/route.ts
 M src/app/api/setup/route.ts
 M src/app/api/signatures/[id]/route.ts
 M src/app/api/signatures/[id]/snapshot/route.ts
 M src/app/api/signatures/route.ts
 M src/app/initial-mfa/page.tsx
 M src/app/login/page.tsx
 M src/app/page.tsx
 M src/app/setup/page.tsx
 M src/composition/worker-process.ts
 M src/modules/auth/application/initial-mfa-http.ts
 M src/modules/auth/application/initial-mfa.ts
 M src/modules/auth/application/instance-auth.ts
 M src/modules/auth/application/logout.ts
 M src/modules/auth/application/mfa-login.ts
 M src/modules/auth/application/mfa-management.ts
 M src/modules/auth/application/session-validation.ts
 M src/modules/auth/infrastructure/auth-admission.ts
 M src/modules/auth/infrastructure/auth-factory.ts
 M src/modules/jobs/infrastructure/job-runtime.ts
 M src/modules/mail/application/delta-sync-service.ts
 M src/modules/mail/infrastructure/attachment-jobs.ts
 M src/modules/mail/infrastructure/backfill-sync-jobs.ts
 M src/modules/mail/infrastructure/content-jobs.ts
 M src/modules/mail/infrastructure/delta-sync-jobs.ts
 M src/modules/mail/infrastructure/idle-watchers.ts
 M src/modules/mail/infrastructure/mailbox-discovery-jobs.ts
 M src/modules/mail/infrastructure/message-command-jobs.ts
 M src/modules/mail/infrastructure/outgoing-jobs.ts
 M src/modules/mail/infrastructure/recent-sync-jobs.ts
 M src/modules/mail/infrastructure/sent-copy-jobs.ts
 M src/proxy.ts
 M src/shared/infrastructure/config/config.ts
 M src/shared/infrastructure/database/database.ts
 M src/shared/infrastructure/database/migrate.ts
 M src/shared/infrastructure/logging/logger.ts
 M tests/account-provider-flow.test.ts
 M tests/phase1e-jobs-watchers.test.ts
 M tests/phase1e.integration.test.ts
 M tests/security/route-policy.test.ts
?? docs/SECURITY_F11_DISCOVERY.md
?? docs/SECURITY_F11_RESULTS.md
?? src/modules/auth/infrastructure/auth-logger.ts
?? src/shared/infrastructure/logging/diagnostics.ts
?? src/shared/infrastructure/logging/security-events.ts
?? src/shared/infrastructure/logging/web-boundary.ts
?? tests/security/f11-logging.integration.test.ts
?? tests/security/f11-logging.test.ts
?? tests/security/f11-process.ts
?? tests/security/f11-worker.test.ts
```

F11 SECURITY LOGGING: PASS
