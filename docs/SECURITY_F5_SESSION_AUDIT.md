# F5 session lifetime enforcement

Reviewed 2026-10-05 against clean HEAD `c9196ba03d8eaac0c0b3c90e612c93ede175f30d`
and the installed `better-auth` package version **1.7.5**. The preceding F1/F3,
provisioning cleanup, F4 and F7 commits are present. No commits or pushes made.

## Installed implementation and root cause

All paths below refer to installed source, not online documentation.

| Source                                                                          | Observed behavior                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_modules/better-auth/dist/context/create-context.mjs:146`                  | `expiresIn` and `updateAge` populate session configuration (Maildock sets 43,200 seconds and 900 seconds).                                                                                                                             |
| `node_modules/better-auth/dist/plugins/username/index.mjs:208`                  | Username login passes `rememberMe === false` to both session creation and cookie writing. Omitted and true both mean remembered.                                                                                                       |
| `node_modules/better-auth/dist/api/routes/sign-in.mjs:350`                      | Email/password login uses the same creation/cookie mechanism; Maildock does not expose this endpoint.                                                                                                                                  |
| `node_modules/better-auth/dist/db/internal-adapter.mjs:247`                     | Creation **hardcodes 86,400 seconds when dontRememberMe is true**, overriding configured expiresIn. Otherwise uses configured expiry. Generates token and creation/update timestamps.                                                  |
| `node_modules/better-auth/dist/db/internal-adapter.mjs:321`                     | Session lookup joins the user by token through the database adapter. Maildock has no secondary session storage.                                                                                                                        |
| `node_modules/better-auth/dist/cookies/index.mjs:165`                           | `setSessionCookie` omits Max-Age when not remembered and sets a signed `dont_remember` browser-session cookie. True/omitted produce Max-Age=43,200 in Maildock. No normal false-login Expires attribute is emitted.                    |
| `node_modules/better-auth/dist/api/routes/session.mjs:151`                      | get-session reads the database when cache is disabled. Expired database sessions return null; normally deletes the row and clears cookies. Its comparison is strictly less-than; Maildock also rejects equality.                       |
| `node_modules/better-auth/dist/api/routes/session.mjs:170`                      | A signed dont_remember cookie or disableRefresh prevents database refresh. With the normal false-login cookie pair, activity does not refresh the session.                                                                             |
| `node_modules/better-auth/dist/api/routes/session.mjs:178`                      | Otherwise refresh is due when expiresAt - expiresIn + updateAge <= now. A get-session GET can write a refresh (deferSessionRefresh is not enabled).                                                                                    |
| `node_modules/better-auth/dist/api/routes/session.mjs:199`                      | Refresh updates expiresAt to now + expiresIn and updatedAt to now; **does not rotate the token**. It reissues the same signed token with configured Max-Age.                                                                           |
| `node_modules/better-auth/dist/db/with-hooks.mjs`                               | Supported creation/update before hooks can replace data or return false to prevent a write. A refused refresh becomes an unauthorized response from get-session.                                                                       |
| `@better-auth/core/dist/types/init-options.d.mts` in the installed pnpm package | Session options include expiresIn, updateAge, disableSessionRefresh, deferSessionRefresh and cookieCache; none separately configure the hardcoded false-login database expiry. Typed database hooks are the supported extension point. |
| `node_modules/better-auth/dist/integrations/next-js.mjs`                        | toNextJsHandler forwards to auth.handler. The separate nextCookies plugin can suppress RSC refresh; Maildock does not install it.                                                                                                      |

Cookie cache is disabled: there is no cached session used for authorization or
session_data cookie at login. With no marker, ordinary get-session refresh remains
enabled. The discrepancy is independently reproduced in a regression test using
the real installed package, real PostgreSQL and the pre-F5 creation hook: false
login has 24-hour database expiry and a browser-session cookie simultaneously.

## Maildock flow and boundary inventory

There are 49 API route files and 68 exported HTTP handlers at this HEAD.
The existing AST route-policy test inventories every handler and verifies that
business API guards run before application work. All source getSession usages
are now confined to session-validation.ts. No business authorization bypass
using a raw Better Auth session was found.

| Flow               | Boundary                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner provisioning | `instance-auth.ts` creates user/credential rows transactionally, no authenticated session.                                                                                                                                                                                                   |
| Browser login      | `login-form.tsx` intentionally submits rememberMe:false; unchanged.                                                                                                                                                                                                                          |
| Auth protocol      | `api/auth/[...all]/route.ts` exposes GET get-session, POST username sign-in/sign-out. Better Auth owns Origin/CSRF and cookies. Login throttle and passwords unchanged.                                                                                                                      |
| Session creation   | `auth-factory.ts` configures Better Auth, Drizzle, additional absoluteExpiresAt and database hooks.                                                                                                                                                                                          |
| Session storage    | `schema.ts` session fields: token, expiresAt, absoluteExpiresAt, createdAt, updatedAt, userId, IP/user agent; no migration or new timestamps.                                                                                                                                                |
| Business API guard | `api-access.ts` -> `checkOwnerApiAccess` -> `getValidSession`; then Origin validation for mutations.                                                                                                                                                                                         |
| API coverage       | Accounts/settings/order/enabled/test/signatures; mailbox discovery/roles/messages/refresh/actions/content/rendering; conversations/search/all-inboxes; drafts/send/outgoing; attachments/staging/download; signatures; notifications/preferences; application events all use the same guard. |
| Request proxy      | `proxy.ts` calls getValidSession for protected pages and APIs, returns login redirect or 401. Public exceptions: setup, login, auth, health. CSP unchanged.                                                                                                                                  |
| Server pages       | `/`, `/accounts`, `/accounts/new`, `/accounts/[id]/edit` call getCurrentSession -> getValidSession before business data. `/login` uses the same abstraction for its redirect. `/setup` is the separate bootstrap boundary; root layout has no business data authorization.                   |
| OAuth              | Google and Microsoft start/callback each call getCurrentSession before provider work; preserved session ID binding and state/PKCE behavior.                                                                                                                                                  |
| Logout             | `logout-button.tsx` calls the Better Auth sign-out protocol. Its deletion/cookie/failure handling is unchanged.                                                                                                                                                                              |

The public auth get-session response can still describe a database-valid but
Maildock-expired row when refresh is suppressed. This is the explicitly retained
Better Auth protocol boundary, **not** business authorization. If it attempts a
refresh after the Maildock deadline, the update hook rejects it before writing.

## Final policy and implementation

Acceptance requires valid, finite Date timestamps, createdAt <= updatedAt <= now,
and now strictly before **all** of:

- stored expiresAt;
- updatedAt + 12 hours;
- stored absoluteExpiresAt;
- createdAt + 30 days.

Future timestamps fail closed, including small positive clock skew; no grace
period extends access. Application time governs checks and Better Auth timestamps;
existing database timestamps remain authoritative inputs. Operators should keep
application clocks synchronized. The code adds no broad clock abstraction.

`session-policy.ts` supplies the shared predicate/constants. The supported create
hook corrects expiresAt to createdAt + 12 hours and sets absoluteExpiresAt from
that same createdAt + 30 days. This applies to false, true and omitted rememberMe.

getValidSession first reads with disableRefresh and disableCookieCache, validates
before permitting refresh, then calls Better Auth normally with cache bypassed
and validates its result. This adds a second database session read on accepted
requests. The update hook validates the authoritative pre-refresh row supplied
by get-session, preserves createdAt/absoluteExpiresAt and clips renewed expiry
to both absolute bounds. An update without the required prior context fails
closed. This assumption about the installed refresh path is integration-tested
and should be rechecked on a Better Auth upgrade.

Existing overlong rows are not grandfathered: their usable lifetime is capped by
the existing updatedAt + 12 hours and both absolute bounds, without migration,
bulk deletion or schema changes. A still-valid existing row may use Better Auth's
ordinary refresh, but an expired row cannot be revived through public get-session.

Normal false-login cookies remain browser-session cookies, normally discarded on
browser closure. Browser session restoration can preserve them; server deadlines
remain decisive. With the signed dont_remember marker, Better Auth does not refresh,
so normal UI sessions expire 12 hours after login. If a token is copied without
that marker, Better Auth may refresh it **while still valid**, with 12-hour renewed
expiry and the same hard absolute deadline. True/omitted rememberMe retain Better
Auth's persistent-cookie semantics; the UI continues submitting false. Token
rotation has not been invented or modified. Capping expiry near the absolute
deadline can make Better Auth's expiry-derived refresh threshold occur more often;
it never moves the absolute deadline.

## Tests and validation

`tests/security/session-lifetime.integration.test.ts` adds 18 deterministic tests
using real Better Auth 1.7.5 and migrated PostgreSQL 18.6. Only composition
singletons and Next request headers are substituted. Date alone is faked; database,
adapter, credentials, password verification, cookies and session behavior are real.

Coverage includes the baseline 24-hour bug; all rememberMe cases; browser-session
cookie attributes/cache absence; exact inactivity boundaries; shorter DB expiry;
old overlong rows with full/copied cookie paths; public-protocol revival prevention;
refresh threshold/expiry/token/absolute preservation; copied-token refresh; both
absolute caps; clipped refresh; future timestamps; API/proxy and all four OAuth
owner checks; normal uppercase username login; preserved mutation Origin checks.

Validation logs are in ignored `.security-results/f5-*.log`.

- Focused final F5 run: 18/18 passed, also passed within security/full runs.
- Security suite including existing authorization/bootstrap/adversarial, F4 mutation/route policy and F7 username: 7 files, 129 tests passed.
- Complete suite: 79 files, 952 tests passed.
- Typecheck: passed for application and worker.
- Lint: passed, one existing unused writeFile warning in ignored signature-settings-preview.mjs.
- Global formatting: fails on 21 untouched pre-existing files (17 migration snapshots, IMAP_CONDITIONAL_STORE.md, PHASE_2K.md, SECURITY_F4_ROUTE_AUDIT.md, account-connection-fields.tsx). These are outside F5 and were not reformatted.
- Production build: passed including Next build, worker compilation and worker import processing. Initial local HTTP APP_ORIGIN fails the existing production HTTPS validation; successful retry uses process-only APP_ORIGIN=https://localhost:3000, without changing .env.
- Changed-file formatting and git diff --check: passed.

## Outside F5 and residual assumptions

Confirmed the known F6 interaction in installed sign-out.mjs: deletion errors are
caught/logged, cookies cleared and success returned. A copied token whose database
row survives remains governed by inactivity/absolute deadlines; activity through
supported refresh can keep it valid up to the 30-day bound. F5 does not repair
logout revocation failure. No additional issue outside F5 was found in this scoped
inspection. MFA, owner binding, concurrent session management, proxy/XFF and
throttling were not changed or re-audited.

The model assumes trusted database timestamps and controlled server clocks; changing
updatedAt or createdAt maliciously along with expiry is outside an expiresAt-only
corruption scenario. No policy based solely on these existing fields can recover
original timestamps after arbitrary database tampering. The tests are server-side,
not an assertion about every browser's session-restore behavior. Read/refresh races
or database failures can fail closed with an error instead of a friendly 401; no
new error-handling or session-revocation framework was introduced.

Final diff review: no duplicated authentication system, password/username/login
throttle changes, normal persistent-cookie regression, extended absolute deadline,
raw business session bypass, migrations, F6 or MFA changes.

**F5 can be considered CLOSED for the scoped implementation**, subject to review
of these uncommitted changes. The unrelated existing global formatting failures
remain reported, and F6 remains open. No commit, amend or push was performed.

Concise diff stat (including the three untracked new files, which plain
git diff --stat omits):

```text
src/modules/auth/application/session-validation.ts      +11 -3
src/modules/auth/infrastructure/auth-factory.ts         +40 -5
src/modules/auth/domain/session-policy.ts               +43 (new)
tests/security/session-lifetime.integration.test.ts    +430 (new)
docs/SECURITY_F5_SESSION_AUDIT.md                            (new report)
5 files: 2 modified, 3 new
```
