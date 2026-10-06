# F6 confirmed current-session logout

Reviewed 2026-10-06 against clean HEAD
`1ac8b52cef22271c59ecbfc38073d7abec7e56ce` and installed Better Auth **1.7.5**.
All five supplied baseline commits are present. Scope is F6 only; no commits,
amends, pushes, dependency changes or migrations.

## Installed source and root cause

Inspection used local source/types, not online documentation.

- `better-auth/dist/api/routes/sign-out.mjs`: reads the configured session-token
  cookie using `ctx.getSignedCookie(name, secret)`. It tries `findSession(token)`
  and `deleteSession(token)` separately, catches/logs both failures, then calls
  `deleteSessionCookie(ctx)` regardless. With Maildock's username/credential
  authentication and no social logout provider, returns HTTP 200 `{success:true}`.
  There is no deletion result check or post-delete verification.
- `better-auth/dist/db/internal-adapter.mjs`: `deleteSession(token)` delegates
  to `deleteWithHooks` scoped to token. Its declared return type in installed
  `@better-auth/core/dist/types/context.d.mts` is `Promise<void>`; callers cannot
  observe affected rows.
- `better-auth/dist/db/with-hooks.mjs`: pre-delete lookup catches errors and
  substitutes null. Null means no deletion. A before hook returning false also
  suppresses deletion; thrown hook errors are caught by sign-out. Therefore a
  database hook cannot make unmodified sign-out reliably report revocation.
- Installed `@better-auth/drizzle-adapter/dist/index.mjs`: single `delete` awaits
  Drizzle's database delete and propagates errors, but the generic adapter's
  single-delete contract is void. `deleteMany` has affected-row handling, which
  is unnecessary for current-session logout. Direct Maildock Drizzle operations
  expose database errors without Better Auth's deletion wrapper.
- `better-auth/dist/api/routes/session.mjs`: supported `getSession`,
  `listSessions`, `revokeSession`, `revokeSessions`, `revokeOtherSessions` APIs
  exist. `revokeSession` takes a token, checks its user, and converts a thrown
  delete into an error, but still returns `{status:true}` when no matching row
  exists or the internal deletion silently does nothing. It does not confirm
  absence. Neither public deletion API by itself satisfies F6.
- `better-auth/api` exports `createAuthEndpoint.serverOnly`; installed core
  source/types implement pathless, server-only endpoints. This supported plugin
  extension allows cookie cleanup through the server API without exposing an
  HTTP endpoint or performing another session deletion.
- `better-auth/cookies` exports `deleteSessionCookie`. It expires session token,
  session data and its chunks, dont_remember, account data/chunks when account
  cookie storage is enabled, and OAuth state for the cookie state strategy.
  It preserves configured attributes and uses Max-Age=0.

Root cause: Better Auth treats browser-cookie removal as successful sign-out
even when the server session remains usable. Maildock trusted that HTTP 200.
The new regression reproduces this exact behavior using the installed package
and a real PostgreSQL trigger throwing during session DELETE.

## Original Maildock inventory

- `src/components/logout-button.tsx` is the application logout UI. It posts JSON
  `{}` to `/api/auth/sign-out`, checks `response.ok`, and only on 2xx calls
  `router.replace('/login')` and `router.refresh()`. It does not inspect the body.
  Non-2xx/network errors previously displayed a generic retry message.
- `src/app/api/auth/[...all]/route.ts` allows GET get-session and POST username
  sign-in/sign-out. Sign-out previously delegated to `toNextJsHandler(auth)`.
  Other session-revocation, signup and cookie-cleanup HTTP paths are unavailable.
- `auth-factory.ts` uses PostgreSQL/Drizzle, `maildock` cookie prefix, HttpOnly,
  SameSite=Lax, Path=/, production Secure cookies and `__Secure-` prefixes.
  Cookie cache is disabled; there is no secondary session storage.
- `schema.ts` stores one row per session, unique id and token, owner userId and
  F5 timestamps. Multiple sessions for one owner are possible.
- `session-validation.ts` authenticates with Better Auth, disables refresh for
  initial F5 validation, then permits ordinary refresh only for valid sessions.
- `proxy.ts` treats auth/login/setup as public protocol paths. Protected APIs
  reject unauthenticated requests; protected pages redirect to login. Application
  routes also run the owner access guard. No proxy/page changes are necessary.
- Existing phase0 tests exercise the raw library handler's normal sign-out;
  F4 tests exercise application sign-out Origin/media-type protection. F5 tests
  cover all application authorization paths. No other application logout entry
  point was found. IMAP client `logout()` calls are unrelated connection cleanup.

## Chosen boundary

The existing `/api/auth/sign-out` URL now invokes Maildock's
`logoutCurrentSession` rather than the library's sign-out implementation.

1. Require exact APP_ORIGIN before authentication, deletion or cleanup. Preserve
   JSON media-type validation when a body is sent; bodyless requests are accepted.
2. Resolve the request's authenticated session with the existing F5 validator.
   Neither a supplied userId/token/body nor private cookie parsing selects rows.
3. Delete only `session.id` returned by that authentication.
4. After the awaited autocommitted DELETE, SELECT that same id. A remaining row
   or database exception means revocation is unconfirmed.
5. Invoke the supported, pathless `clearLogoutCookies` plugin server API, which
   only calls Better Auth's exported cookie cleanup helper. No deletion retry,
   social logout processing, cookie-signature parsing or package patch occurs.
6. Return 200 `{success:true}` only for confirmed absence. Use no-store responses.

This retains Better Auth authentication/cookie ownership while using Maildock's
supported database layer to avoid swallowed deletion errors. The small plugin
exists solely to supply the correctly initialized cookie-helper context; it
does not introduce an unauthenticated HTTP cookie-clearing endpoint.

## Failure, cookies and UI

Database/confirmation failures return 500 with the generic message:
“Sign out could not be confirmed. Your session may still be active.” Missing,
malformed or F5-invalid authentication returns 401 without selecting another
session for deletion. Both same-origin failure paths attempt local cleanup.
Invalid/missing Origin returns 403 without touching sessions or cookies.

UI displays the uncertainty message on non-2xx and network errors, stays on the
current page and does not refresh/redirect. Confirmed logout follows the original
login redirect. A later explicit navigation can naturally redirect after local
cookies have been cleared; the logout action itself does not hide the failure.

Operational events are `logout_revocation_failed` and
`logout_cookie_cleanup_failed`. Maildock logs only fixed event/message values,
not raw exceptions, ids, tokens, cookies, headers or connection details. If the
cleanup helper itself fails, the event is logged; confirmed server revocation
still permits success because the retained cookie can no longer authenticate.
On uncertain revocation, cleanup failure never changes the failure status.

The installed helper handles `maildock.session_token`, `maildock.session_data`,
`maildock.dont_remember`, configured auxiliary cookies and cached chunks. In
production these use `__Secure-maildock.*`, Secure, HttpOnly, SameSite=Lax and
Path=/. No JavaScript-readable auth cookies are introduced.

## Exact session, races and F5

Only the authenticated session id is deleted. Another session for the same owner
continues to authenticate. Concurrent logout can confirm absence after another
request deleted the same row, or return unauthorized if authentication observes
its absence. Either outcome cannot revive it.

An already-authenticated request may finish. After confirmed deletion a fresh
copied-token request reads PostgreSQL and fails. The installed refresh operation
is UPDATE by token, not an upsert; a concurrent deletion causes refresh to return
no updated session and get-session to fail unauthorized. No locks/ledger needed.

F5's 12h inactivity, 30d absolute bound, pre-refresh validation, create/update
hooks and absoluteExpiresAt preservation are unchanged. Logout uses that existing
validator and does not edit timestamps to manufacture revocation. On failure F5
still bounds the potentially active copied token, but does not justify success.

## Regression coverage

`tests/security/logout.integration.test.ts` uses real Better Auth and an isolated
PostgreSQL 18.6 container with real migrations and owner initialization. Runtime
singleton substitutions provide the test database/auth/config; authentication,
signed cookies, routes and adapter behavior are not mocked.

- Exact current-session removal and absence; copied cookie denied by the real
  protected settings API; independent owner session survives.
- Actual PostgreSQL BEFORE DELETE trigger raising an exception: row remains,
  copied cookie still authenticates, helper and public handler return 500 and
  clear cookies. Fixed operational logging is checked for token omission.
- BEFORE DELETE trigger returning NULL: successful SQL call with zero deletion
  still returns 500 because the row remains.
- AFTER DELETE trigger renaming the session table: DELETE commits, confirmation
  SELECT fails, response remains 500; restored table proves the row was removed.
- Raw Better Auth sign-out with the same real deletion fault reproduces HTTP
  200 and cookies cleared while the copied token remains accepted.
- Concurrent logout requests; malformed/no-session input; exact Origin failures;
  cleanup HTTP allowlist rejection; signup remains unavailable; F5-expired
  authentication cannot delete another row; production prefixes/attributes and
  cache-chunk cleanup on deletion failure.
- `tests/logout-button.test.tsx`: confirmed success redirects; server failure
  and network failure show uncertainty without refresh or redirect.
- F4 route-policy inventory wording updated to describe the mixed login/logout
  boundary. Existing F4, F5 and F7 integration coverage retained.

## Validation

- Focused F6 integration/UI run: **18/18 passed** (15 PostgreSQL tests, 3 UI tests).
- Security suite: **144/144 passed in 8 files**, including existing F4, F5
  lifetime (18 tests), F7 username, bootstrap, authorization and adversarial tests.
- Full suite: **970/970 passed in 81 files**; repeated after the final runtime
  import adjustment.
- Typecheck: application and worker passed.
- Lint: zero errors; one pre-existing unused `writeFile` warning in the untouched,
  ignored `.security-results/signature-settings-preview.mjs`.
- Production build: Next/Turbopack, worker TypeScript and worker import processing
  passed with Node 24.19.0 and process-only `APP_ORIGIN=https://localhost:3000`.
  `.env` was not changed. The first attempt exposed `.js` imports in the existing
  web composition helper when newly imported by the route; the route now imports
  config/logger directly without altering that helper.
- Changed-file Prettier and `git diff --check`: passed.

Final diff review found no logout-all behavior, accepted copied token after
confirmed success, fake success on database errors, guessed cookie/signature
parsing, weakened Origin checks, duplicated authentication, F5 policy changes,
MFA work or session-management UI.

## Remaining assumptions and scope

Current PostgreSQL is the authoritative session store, with cookie cache disabled
and no secondary session storage. Adding a different authentication store/cache
requires revisiting revocation. New session-delete hooks also require review;
current factory has only F5 creation/update hooks and no deletion hooks to bypass.
The supported Better Auth cookie/plugin API is integration-tested, including
production naming; run these regressions for dependency upgrades.

No new issue outside F6 was established. The existing F5 audit's observation
about public get-session describing a Maildock-expired row is retained; protected
application access still enforces F5. MFA, throttling, owner binding, other-session
management and other findings were not changed.

**F6 can be considered CLOSED for the scoped implementation**, subject to review
of these uncommitted changes and the store assumptions above.

Concise diff stat (plain `git diff --stat` omits the five untracked new files):

```text
src/app/api/auth/[...all]/route.ts                  +20 -2
src/components/logout-button.tsx                    +6 -2
src/modules/auth/infrastructure/auth-factory.ts      +2
tests/security/route-policy.test.ts                  +4 -1
src/modules/auth/application/logout.ts              +71 (new)
src/modules/auth/infrastructure/logout-cookies.ts   +17 (new)
tests/logout-button.test.tsx                        +55 (new)
tests/security/logout.integration.test.ts         +380 (new)
docs/SECURITY_F6_LOGOUT_AUDIT.md                         (new audit)
9 files: 4 modified, 5 new; tracked diff +32 -5
```
