# F9 discovery: proxy trust, client address and production ingress

Review date: 2026-10-06. Repository baseline: `d6b21273471eb046df5ed418e0cba6fff1fb96da` (`security: harden authentication throttling`). This is discovery only. No fixes, dependency changes, deployment, commits or pushes were performed. F8 was reviewed as an existing control, not redesigned.

Evidence is the current repository, resolved installed dependency source and disposable local runtime observations. There was no Internet scanning, external-host testing or provider OAuth traffic. This report does not certify an existing VPS: no deployed proxy, routing policy or firewall configuration was supplied.

## A. Current deployment topology

The base configuration actually supplies:

```text
Internet/browser
    |
    | no public listener/TLS proxy supplied by this repository
    X

VPS/Docker host
    |
    | implicit Compose default bridge network (not internal: true)
    +-- app container
    |     entrypoint -> migrations -> node server.js (Next HTTP)
    |                              -> worker-process.js (no HTTP listener)
    |     HTTP: 0.0.0.0:3000 within container
    |     attachment volume
    |
    +-- postgres container: PostgreSQL TCP 5432
          database volume

Development override only:
host 127.0.0.1:3000 -> app:3000
host 127.0.0.1:5432 -> postgres:5432
```

Evidence:

- `Dockerfile:28` sets production runtime, `PORT=3000`, `HOSTNAME=0.0.0.0`, `MAILDOCK_ROLE=all`; line 46 is `EXPOSE 3000`, line 47 invokes the Node entrypoint. The Docker build produces Next standalone output and worker output.
- `scripts/container-entrypoint.mjs` runs migrations, then starts `node server.js` and `node dist-worker/composition/worker-process.js`; optional web/worker roles are supported. It does not start a reverse proxy or TLS listener.
- `next.config.ts` uses `output: "standalone"`. Installed Next `dist/build/utils.js:1124` generates a standalone server with environment-selected hostname and port. `dist/server/lib/start-server.js:244` uses plain HTTP unless a self-signed-certificate option is supplied; Maildock supplies none. `server.listen(port, hostname)` binds the configured address. `0.0.0.0` is all container IPv4 interfaces, not the host publication setting.
- `docker-compose.yml:1` has exactly `app` and `postgres`. App `expose: ["3000"]` at line 27; neither service has `ports`. Neither has explicit network membership, so both join the implicit default network. App uses `postgres:5432` in `DATABASE_URL`; no host localhost dependency exists in this path.
- `docker-compose.dev.yml:5` publishes app on `127.0.0.1:3000:3000`, and line 9 publishes database on `127.0.0.1:5432:5432`. It also sets `MAILDOCK_ENV=development`, while the container still has `NODE_ENV=production`.
- `README.md`, Docker section, describes an external reverse proxy. `docs/ARCHITECTURE.md:78` draws one; line 108 requires private app ingress and TLS termination at the proxy. ADR 0001 leaves proxy trust subject to later review. These are architecture requirements, not an executable proxy configuration.
- `.env.example` declares canonical HTTPS `APP_ORIGIN` and says to run production behind HTTPS. Config parsing rejects a non-HTTPS production origin. This does not enable TLS on Next.
- `package.json` has local `next dev`, `next build` and `next start` scripts. A directly launched Next process is outside Compose's nonpublication protection; the installed CLI/server defaults do not guarantee a loopback-only listener. Container production uses the generated standalone server instead.
- No reverse-proxy service, Caddy/Nginx/Traefik configuration, production ingress override, CI deployment configuration or `.github` workflow was found among current repository artifacts. `src/proxy.ts` is Next's request middleware, not a network reverse proxy or a trusted-peer validator.

Base Compose prevents ordinary host-port publication; it does not itself provide the complete public HTTPS deployment. A container proxy needs deliberate network attachment; a host proxy needs a private connection, typically an explicitly loopback-bound app publication. Neither attachment is supplied. TLS must terminate in operator-owned deployment infrastructure. Maildock has no socket-peer/CIDR trust check or environment-level proxy contract.

## B. Network exposure matrix

| Service / configuration          | Container port                   | Host publication | Current expected peer                                                | Public reachability under supplied defaults                   | Intended V1 reachability                                          |
| -------------------------------- | -------------------------------- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| App, base Compose                | TCP 3000, IPv4 wildcard listener | None             | External proxy after operator connects it; app-local readiness probe | No published host ingress under normal Docker bridge defaults | Only the designated proxy; never Internet-direct                  |
| PostgreSQL, base Compose         | TCP 5432                         | None             | App via `postgres:5432`; local database health check                 | No published host ingress under normal bridge defaults        | App/private database network only                                 |
| App, development override        | TCP 3000                         | `127.0.0.1:3000` | Local developer/browser                                              | Loopback publication, not a public-address publication        | Development only; production must retain production security mode |
| PostgreSQL, development override | TCP 5432                         | `127.0.0.1:5432` | Local developer tools                                                | Loopback publication                                          | Development only; no production host publication needed           |
| Worker within app                | No HTTP port                     | None             | PostgreSQL and outgoing mail/provider services                       | No worker HTTP ingress                                        | No public worker listener                                         |
| Reverse proxy/TLS                | Not supplied                     | Not supplied     | Public browser                                                       | Not established                                               | Public HTTPS 443; optional 80 solely for HTTPS redirect/ACME      |

Distinctions that matter:

1. Dockerfile `EXPOSE` is image metadata; it does not publish a host port. An operator's separate `docker run -P` could use that metadata, but the supplied Compose does not.
2. Compose `expose` advertises an internal port. It is not an access-control list; peers on the network can reach other listening ports too.
3. Compose `ports` creates host publication. A future `3000:3000` or `5432:5432` without a host IP would introduce wildcard host publication. Neither is present now.
4. Host firewall rules were not supplied or inspected. They must not be silently assumed to repair such publication.
5. Actual Internet reachability also depends on host routes, Docker daemon bridge/direct-routing options, IPv6 and upstream firewall policy. Those external facts were not tested. Standard nonpublished bridge behavior is the scope of the defaults conclusion, not a universal guarantee across arbitrary daemon configurations.

The host and authorized Docker-network peers may reach nonpublished container addresses, particularly on native Linux. Docker Desktop has a VM boundary. Neither case means the app accepts only a particular proxy. The default bridge is not marked `internal`; app outbound access is required for mail and provider integrations. Network separation should not accidentally remove that egress.

App readiness fetches `http://127.0.0.1:3000/api/health/ready` **inside the app container**. PostgreSQL uses `pg_isready` inside its container. Neither requires a published port. `/api/health/live` and `/api/health/ready` are middleware-public; they return limited status and no-store responses. Readiness verifies database/migration foundation/attachment storage without calling mail providers. Health status does not validate TLS, header sanitization or absence of alternate ingress.

## C. Forwarded-header consumer matrix

Installed-source paths below are package-relative. `@better-auth/core` was resolved from Better Auth's own dependency graph, not assumed to be a top-level package. Its installed version is 1.7.5.

| Input                                       | Relevant consumer and behavior                                                                                                                                                                                                                         | Purpose / fallback / hops                                                                                                                         | Trust assumption and current safety                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Forwarded-For`                           | Next `dist/server/base-server.js:605` preserves existing value with `??=`; if absent fills socket `remoteAddress`. Core `dist/utils/ip.mjs:196` uses this as its only default IP header.                                                               | Better Auth HTTP rate-limit key and session `ipAddress`. Core accepts one valid nonempty token; rejects an ordinary multi-address chain.          | No peer authentication. Any client reaching Next can assert a single address. Unsafe as an authoritative original-client identity; F8 is independent.                                                                          |
| Socket peer address                         | Next inserts it as missing XFF. Better Auth does not read the socket itself.                                                                                                                                                                           | No-header direct request becomes the direct peer; proxied request without XFF becomes the proxy peer.                                             | Legitimate immediate-peer observation only when client XFF has been stripped. No configured trusted ranges.                                                                                                                    |
| `X-Real-IP`                                 | No current Maildock/Next relevant address consumer or default Better Auth consumer found. Core could consume it if `ipAddressHeaders` were configured.                                                                                                 | No current IP effect; absent XFF still receives Next's peer fallback.                                                                             | Client can send it; ignored by current auth/address path. Strip at ingress to keep contract explicit.                                                                                                                          |
| `CF-Connecting-IP`, `True-Client-IP`        | Same configuration possibility, no current consumer in relevant paths.                                                                                                                                                                                 | No current CDN support or fallback selection.                                                                                                     | Ignored now; not an implicitly trusted CDN channel.                                                                                                                                                                            |
| RFC `Forwarded`                             | No current relevant parsing found in Maildock, installed core/auth or inspected Next request-boundary paths.                                                                                                                                           | No `for`, `host` or `proto` influence demonstrated.                                                                                               | Client can send it; ignored in this design. Do not claim generic RFC-chain support.                                                                                                                                            |
| `Host`                                      | Next preserves the header and derives missing forwarded host from it. Current Next request URL construction uses startup hostname/port when `trustHostHeader` is false. NextURL also uses Host for domain-locale analysis; no i18n configuration here. | Host routing and framework metadata. Not Maildock's configured auth origin.                                                                       | No Maildock Host allowlist. Different Host was accepted locally, without changing auth context or producing an off-host middleware redirect. Public proxy must enforce the canonical virtual host.                             |
| `X-Forwarded-Host`                          | Next preserves/synthesizes it. Better Auth URL helpers use it only on opted-in inferred/dynamic URL paths; Maildock supplies static `baseURL`. Next Server Actions parser favors the first comma token over Host.                                      | Potential framework action CSRF host comparison; not the current auth base URL.                                                                   | No Next trusted-peer check. No `use server` action definitions or custom action allowed origins were found in current source; action behavior is latent, not a demonstrated Maildock action bypass. Strip/replace canonically. |
| `X-Forwarded-Proto`                         | Next preserves it, and router request metadata uses `.includes('https')` to select URL scheme. Base-server's missing-header inference separately compares exactly `https` or uses socket encryption.                                                   | Request URL scheme, including setup's absolute redirect. Better Auth cookies/base URL are explicitly configured and do not need it.               | No peer authentication and no strict single-token validation in Next's metadata path. A client can supply it on raw ingress; sanitize to one exact value.                                                                      |
| `X-Forwarded-Port`                          | Next preserves it; otherwise fills configured server port (3000 in image) before a scheme default.                                                                                                                                                     | Ancillary framework metadata. No current application security consumer found.                                                                     | Not an auth-origin authority. Strip or replace with public port; do not treat port lists as supported.                                                                                                                         |
| Forwarded header family in framework caches | Next `dist/server/use-cache/use-cache-wrapper.js:248` excludes XFF/XFH/XFP/forwarded-port from its development private-cache request suffix.                                                                                                           | Cache bookkeeping, not address extraction. Current source has no `use cache` directives.                                                          | Not another client identity/authorization channel.                                                                                                                                                                             |
| Host in Next outbound rewrite proxy         | Next `dist/server/lib/router-utils/proxy-request.js:39` writes outbound XFH from inbound Host when proxying an external rewrite.                                                                                                                       | Forwarding to configured rewrite target, not trusted client identification. Maildock defines no external rewrites.                                | Latent framework behavior; no active rewrite-based host authority in this deployment.                                                                                                                                          |
| `Origin`                                    | Maildock `hasValidOrigin` compares the entire string with `config.appOrigin`; Better Auth has its own origin/CSRF middleware.                                                                                                                          | Application unsafe-method CSRF boundary; login/MFA/logout wrappers also use exact origin. No Host, Referer or IP substitute in Maildock's helper. | Browser Origin is the CSRF signal, not a client authenticator. Nonbrowser clients can assert it; authentication remains required. Independent of address headers.                                                              |
| `Referer`, Fetch Metadata                   | Better Auth origin/form-CSRF middleware; Referer can substitute for Origin in its protocol, and Fetch Metadata controls first-login checks.                                                                                                            | Better Auth protocol protection; not a Maildock-wide exact-Origin fallback.                                                                       | Preserve existing F4 policy. Local password wrapper rejects missing/noncanonical Origin before entering Better Auth.                                                                                                           |
| Request URL                                 | Next adapter constructs Web Request URL from absolute incoming URL or `initURL` metadata. Maildock middleware and setup form construct `/login` from it; OAuth reads query parameters but obtains redirect origin from config.                         | Middleware redirects are relativized by Next; setup's ordinary Response redirect remains absolute.                                                | Internal URL is not necessarily public `APP_ORIGIN`. Scheme can reflect forwarded proto; static auth/OAuth origin remains canonical. See F9-03.                                                                                |

Evidence: Next `dist/server/lib/router-utils/resolve-routes.js:115`, `dist/server/next-server.js:1137,1278`, `dist/server/route-modules/route-module.js:381` (scheme and fallback URL metadata), `dist/server/web/spec-extension/adapters/next-request.js:81`, `dist/server/web/adapter.js` redirect relativization; Next `dist/server/app-render/action-handler.js:351,430`; Better Auth `dist/utils/url.mjs:67,139,160`, `dist/context/helpers.mjs`, `dist/api/middlewares/origin-check.mjs`. Maildock consumers: `src/proxy.ts`, `src/app/api/setup/route.ts`, auth factory, origin helper and OAuth routes/providers.

All these request headers are syntactically client-suppliable on direct ingress. Base Compose currently offers no ordinary Internet host-port path; a future public proxy's behavior is unspecified. A header's valid address syntax does not establish that a trusted peer generated it.

## D. Better Auth 1.7.5 findings

### Exact IP resolution

Resolved file: `node_modules/.pnpm/@better-auth+core@1.7.5_@be_d0861dc1c5e560036ddf567d6e572604/node_modules/@better-auth/core/dist/utils/ip.mjs`.

`getIP(req, options)` reads Headers or `req.headers`; it has no socket-peer input. Maildock does not set `advanced.ipAddress`, so the default header list is exactly `["x-forwarded-for"]`. `advanced.trustedProxyHeaders` is a separate URL-origin option; it is not an IP trust switch.

`getIPFromHeader` (line 174) splits on commas, trims tokens and discards empty tokens. With no configured valid trusted proxies, exactly **one nonempty valid IPv4/IPv6 token** is accepted. It does not select the first or last address from an ordinary multi-address chain. Consequently `, 192.0.2.10, ` resolves while `192.0.2.10, 10.0.0.2` does not. Invalid addresses, quoted/port-decorated values and unresolved chains cannot become a valid selected IP through this parser. IPv4-mapped IPv6 normalizes to IPv4; IPv6 is canonically expanded and defaults to a /64 bucket, including session metadata.

With `trustedProxies`, IP/CIDR entries are parsed, invalid entries ignored (context initialization warns), and the list is scanned right-to-left. Valid trusted tokens are skipped; the first untrusted valid token is returned. A malformed encountered token or all-trusted chain returns null. This is **header-chain filtering**, not authentication of the actual connection peer. It cannot make raw app ingress safe by itself: the supplied Request still has no authenticated transport address for comparison.

If no header resolves, core returns `127.0.0.1` in development/test (`NODE_ENV`/test detection), otherwise null. This differs from Next's earlier peer-header synthesis. Production direct HTTP without XFF therefore resolved to `127.0.0.1` in our loopback HTTP test, while an unadapted production Web Request without XFF returned null. `MAILDOCK_ENV` alone does not select the dependency's development fallback.

Available options are ordered `ipAddressHeaders`, `ipv6Subnet`, `trustedProxies` and `disableIpTracking`; supported rate-limit configuration also permits custom storage/rules. Setting `ipAddressHeaders: []` can remove forwarded-address consumption in production while retaining shared fallback limiting. **Do not casually set `disableIpTracking: true`: the installed rate limiter returns without limiting when no IP exists and that flag is enabled.** None of these changes was made.

### Actual Maildock HTTP path

```text
Next HTTP boundary (preserve supplied XFF / synthesize peer XFF)
  -> Web Request headers
  -> /api/auth catch-all GET get-session or permitted POST
  -> Maildock auth wrapper
  -> Better Auth router onRequestRateLimit
  -> core.getIP -> createRateLimitKey(address, normalized path)
  -> configured database storage / PostgreSQL rate_limit
```

`src/modules/auth/infrastructure/auth-factory.ts:259` enables database rate limiting: 60 seconds / 100 requests generally, `/sign-in/username` custom rule 60 / 10. Installed `better-auth/dist/api/index.mjs:172` invokes the limiter before endpoint execution. `dist/api/rate-limiter/index.mjs:232` normalizes the path against the configured base path. Missing production IP uses literal `no-trusted-ip`, yielding `no-trusted-ip|/get-session`, rather than disabling the limiter. Resolved IP yields e.g. `192.0.2.10|/get-session`. Storage uses the current adapter's guarded atomic increments; preserve the installed Drizzle patch and F8 correctness.

Password login additionally passes exact Origin, bounded input, global PostgreSQL work admission and transaction-bound owner password delay before scoped Better Auth handler execution. Direct server `auth.api` calls do not pass through HTTP rate limiting. MFA wrappers have their own F8 PostgreSQL admission/attempt controls and use direct auth API calls where applicable. `withoutTrustedDevice` and `challengeHeaders` restrict cookies/authorization, not forwarding headers. Thus dependency metadata can still receive those headers, but important auth admission is not selected by IP.

`better-auth/dist/db/internal-adapter.mjs:263` stores session `ipAddress = getIP(headers, options) || ""` and user-agent metadata when creating sessions. Current Maildock stores `ip_address` in its auth session schema; no IP-based owner authorization, session binding or MFA decision was found. No other active IP-dependent plugin was found: the installed captcha IP consumer is unused. Session IP is unverified/normalized metadata, not proof of who connected. Event policy belongs to F11.

## E. Origin, host and scheme findings

`src/shared/infrastructure/config/config.ts:139` rejects credentials, nonroot path, query and fragment in `APP_ORIGIN`, requires HTTPS in production, and returns URL-normalized `.origin`. Maildock sets Better Auth `baseURL` to this value and `trustedOrigins` to its one canonical entry. The auth context observed `https://maildock.example.test/api/auth`; the resolved trusted list contains the canonical origin twice because core adds baseURL as well as the supplied array, not a second trusted host. Core has an additional environment trusted-origins hook, but Maildock's current explicit array is used by its origin middleware and Compose supplies no such override. Deployment should not invent additional auth-origin environment settings.

Supplied Host, forwarded host and proto did not change Better Auth's static base URL, trusted origin or cookie configuration. The factory explicitly enables both Origin and CSRF checking in every runtime. Application Origin validation remains exact and independent of address headers; it does not compare Origin with caller-controlled Host. OAuth provider redirect URIs (`microsoft-oauth.ts:86`, `google-oauth.ts:93`, provider-config repository line 81) and OAuth route redirects use configured `appOrigin`. Existing OAuth state/session binding and consumption are outside remediation scope and remain intact.

Production cookies explicitly use `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, with the `__Secure-maildock` prefix and no configured Domain. These attributes are correct when public TLS terminates at a proxy and its backend connection is HTTP. Browser cookie security is evaluated on the public connection; Maildock does not need forwarded proto to choose Secure. Different Host cannot select a cookie Domain in current auth configuration. A publicly accessible raw HTTP app port is nevertheless an alternate transport path; Secure cookies and CSRF do not enforce a network-only-proxy rule. A nonbrowser client can send configured Origin and credentials over raw HTTP if that port is published.

Current Next defaults have `experimental.trustHostHeader=false`; Maildock does not override it. Request/proxy URL uses the startup hostname/port, with scheme influenced by forwarded proto, rather than replacing its authority with the public Host/XFH. Next middleware's same-origin redirect processing converts `/login` to a relative Location; every tested Host/proto combination returned `307 Location: /login`. There is no demonstrated current middleware open redirect from these headers.

There is one concrete exception to fully configured-origin navigation: `src/app/api/setup/route.ts:107` returns `Response.redirect(new URL("/login", request.url), 303)` after native form setup. Unlike the middleware redirect, it remained absolute. With correct public Origin, public Host, conflicting XFH and XFP=https, the standalone loopback test returned `https://localhost:60082/login`, not `https://maildock.example.test/login`. Next normalized the loopback address to localhost. Under the image's `HOSTNAME=0.0.0.0`, installed-source construction predicts the container startup authority/port rather than the public origin; that exact Docker-image redirect was not runtime-tested. The normal JavaScript setup path uses JSON and relative client navigation, so the observation affects native form fallback. No credential/token appeared in the redirect. Minimal direction: a relative redirect or configured canonical origin, not additional forwarded-host trust.

Forwarded proto is unnecessary for current auth origin/cookie correctness. It does affect ancillary framework URL construction. The installed router treats even `http, https` and `nothttps` as containing `https`; a V1 edge must overwrite the value with an exact single scheme. HTTP `APP_ORIGIN` in production is rejected before normal operation; changing to development mode to silence that error weakens production cookie behavior and is not a supported production workaround.

## F. Local validation results

Temporary harness used a newly built application, production Node/auth runtime, synthetic independent secrets and a disposable PostgreSQL 18.6 container published **only to 127.0.0.1 on a random port**. App listeners were loopback on random ports. No real `.env` secret was printed or used as a database credential; process-only overrides selected the disposable database and attachment directory. The harness migrated that database, inspected `rate_limit` keys after requests and exercised native form setup in that disposable database only. It removed its container/storage and stopped its child server.

First characterization used `next start`; a repeated run checked the form path. Final characterization used fresh `.next/standalone/server.js`, the same startup mode as the image, with hostname/port overridden solely to confine validation to loopback. Results agreed. The image's wildcard container listener and complete TLS/network deployment remain source/config evidence, not public deployment observations.

All 14 HTTP address/header scenarios returned `200 null` from unauthenticated `/api/auth/get-session` and a database rate row with count 1; protected `/` returned `307 /login`. Rows were cleared between scenarios in the disposable database, so these were behavior probes, not load tests.

| Scenario                                                             | Observed behavior                                                                                                                                 | Security relevance                                                                           | Result                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Direct request, no forwarding headers                                | HTTP key `127.0.0.1                                                                                                                               | /get-session`; direct core production Web Request IP null                                    | Next synthesizes peer XFF; dependency alone has no transport fallback         | OBSERVATION |
| Client XFF `192.0.2.10`                                              | Key `192.0.2.10                                                                                                                                   | /get-session`                                                                                | Client selects supplemental limiter identity on raw ingress                   | OBSERVATION |
| XFF `192.0.2.10, 10.0.0.2`                                           | Key `no-trusted-ip                                                                                                                                | /get-session`; core null                                                                     | Neither first nor last selected by current defaults; shared fallback persists | OBSERVATION |
| X-Real-IP `192.0.2.20` only                                          | Peer key; core null                                                                                                                               | Header does not select address                                                               | PASS                                                                          |
| `Forwarded: for=192.0.2.30;host=other.example.test;proto=https` only | Peer key and relative `/login`; core null                                                                                                         | RFC header is not current IP/origin authority                                                | PASS                                                                          |
| Conflicting XFF/X-Real-IP/CF/True-Client                             | XFF `192.0.2.10` wins, alternatives ignored                                                                                                       | No implicit CDN-header precedence                                                            | OBSERVATION                                                                   |
| Host `other.example.test`                                            | Accepted GET, unchanged key and `/login`                                                                                                          | No Host allowlist at app; no auth-context change                                             | OBSERVATION                                                                   |
| Host public, XFH other                                               | Accepted GET, unchanged key and `/login`                                                                                                          | No demonstrated forwarded-host auth/redirect poisoning                                       | PASS                                                                          |
| XFP=https over real internal HTTP                                    | Same key, relative `/login`                                                                                                                       | Does not switch cookie configuration or trusted origin                                       | OBSERVATION                                                                   |
| XFP=http over internal HTTP                                          | Same key and redirect                                                                                                                             | Does not remove production Secure attribute                                                  | PASS                                                                          |
| Logical reverse-proxy headers                                        | Key `192.0.2.60                                                                                                                                   | /get-session`, `/login`                                                                      | Direct client can imitate all asserted proxy headers; no peer distinction     | OBSERVATION |
| XFP `http, https`                                                    | Same key and middleware redirect                                                                                                                  | Not rejected as a chain; metadata's substring behavior established from installed source     | OBSERVATION                                                                   |
| XFP `nothttps`                                                       | Same key and middleware redirect                                                                                                                  | No strict validation at this boundary; source predicts HTTPS metadata                        | OBSERVATION                                                                   |
| Empty supplied XFF                                                   | `no-trusted-ip                                                                                                                                    | /get-session`                                                                                | Present empty value survives `??=`; no socket fallback in core                | OBSERVATION |
| Missing, other, literal-null Origin with conflicting Host/XFH/XFP/IP | Password route 403; exact helper false                                                                                                            | Forwarding headers cannot substitute for canonical Origin                                    | PASS                                                                          |
| Exact configured Origin with same conflicting headers                | 400 for deliberately empty credentials body; exact helper true                                                                                    | Passes Origin but still fails bounded credential validation; no authenticated access granted | PASS                                                                          |
| Production auth context                                              | Canonical base URL; session cookie `__Secure-maildock.session_token`, Secure/HttpOnly/Lax, no Domain                                              | Internal HTTP does not weaken production cookies                                             | PASS                                                                          |
| Production HTTP APP_ORIGIN                                           | Config rejected                                                                                                                                   | Fail-safe scheme validation                                                                  | PASS                                                                          |
| Native form setup, correct Origin, XFP=https                         | 303 to `https://localhost:60082/login` in final standalone run                                                                                    | Absolute navigation uses internal request authority                                          | OBSERVATION                                                                   |
| Parser edge cases                                                    | Empty-token single IP accepted; invalid IP null; mapped IPv6 -> IPv4; IPv6 -> /64; configured trusted chain strips right hop; all-trusted -> null | Establishes precise installed parser behavior without changing Maildock settings             | PASS                                                                          |
| Base and development Compose resolution                              | Base has no publications; dev both host_ip=127.0.0.1; implicit default network                                                                    | Current repository does not ship wildcard port publication                                   | PASS                                                                          |
| Real TLS edge, VPS routing/firewall, exact Docker-image listener     | Not deployed or externally tested                                                                                                                 | Cannot certify actual public reachability/sanitization from local header simulation          | GAP                                                                           |

Logical reverse-proxy probes simply supplied proxy-shaped headers over local HTTP. They establish app beliefs; they are not proof of an edge sanitizing client requests. A temporary CommonJS request-observer preload was also attempted; it did not capture the compiled runtime's adapter calls and was not used as evidence. Scheme/authority conclusions are based on inspected installed source plus the actual form redirect.

## G. Required V1 trust model and failure modes

The smallest supported contract is one public TLS reverse proxy and no arbitrary CDN/multiple-proxy chains. The edge owns public virtual-host selection, TLS and transport request/connection limits. Maildock retains owner/session/CSRF/F8 admission checks. Original client IP is optional; Maildock does not need it for important authentication correctness.

### Two deployment styles

| Requirement                    | A: proxy on VPS host                                                                        | B: proxy in another container                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Public security boundary       | Host proxy on HTTPS 443                                                                     | Proxy container with public HTTPS 443                                                                   |
| App connection                 | Explicit production-only `127.0.0.1:3000:3000` publication; host proxy connects to loopback | No app host ports; proxy explicitly attached to private ingress network and connects to `app:3000`      |
| PostgreSQL                     | No host publication; app/private backend network                                            | No host publication; preferably separate backend network with app, so proxy does not need DB membership |
| Allowed immediate peer         | Designated local proxy; host/local administrator remains trusted infrastructure             | Designated proxy container; control network membership, avoid unrelated peers                           |
| Alternative ingress prevention | No wildcard or IPv6 host publication, no externally routed container ingress                | No app/DB publications or externally routed bridge ingress; no unrelated ingress peers                  |
| Production config              | `MAILDOCK_ENV=production`, canonical public HTTPS APP_ORIGIN                                | Same                                                                                                    |

Do not obtain style A by reusing the dev override: it also publishes PostgreSQL and changes the app security environment. The base file's two mandatory services remain sufficient; optional edge infrastructure/overrides can provide these connections without making a third application dependency mandatory. Network split is a least-trust improvement, not evidence that the current two-service network has a public leak. Ensure mail/OAuth outbound egress continues to work.

### Header contract

For the preferred no-original-IP model, strip incoming `Forwarded`, XFF, X-Real-IP, CF-Connecting-IP and True-Client-IP. Do not append the caller's chain. If XFF is omitted upstream, Next synthesizes the actual **proxy peer**, producing a stable per-peer/per-path supplemental limiter; accept that this is not original-client identity. Preserve rate limiting and the F8 global/account/challenge controls. Client observability can stay at the edge. Optionally set an empty IP-header list in auth configuration to make the lack of address trust explicit; that is configuration, not trusted-proxy parsing.

If original IP is retained for supplemental limiting/observability, only the single designated immediate proxy may assert it. That proxy must **overwrite XFF with exactly one socket-derived original client address**, discarding caller input and all alternate IP headers. Network isolation, not merely IP syntax or a header-chain `trustedProxies` list, establishes the right to assert it. Neither supported style requires parsing multi-hop chains. Reject unplanned intermediary/CDN topologies until separately reviewed.

At the edge, accept only the configured public virtual host; forward canonical Host and either omit XFH or replace it canonically. Strip client XFP and replace with exactly `https` for public HTTPS requests; omit/replace forwarded port with public 443. Leave actual browser Origin intact. Canonical Host/XFP handling is framework hygiene and navigation correctness, not a replacement for APP_ORIGIN validation. Never expose the raw app port as an alternate public path; app logic cannot identify a proxy from this header set alone.

Application-level socket/CIDR trust logic would require a reliable transport-peer interface before Next converts the request, address-range maintenance, independent IPv4/IPv6 checks and direct-ingress rejection. The installed Better Auth options alone do not provide that entire boundary. None of this complexity is justified by current V1 needs. Prefer private ingress plus overwritten/removed headers, retain APP_ORIGIN, and keep F8 unchanged.

### Realistic operator mistakes

| Mistake                                                   | Current behavior / classification                                                                                                                 | Required contract                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Add wildcard app `3000:3000`                              | Exposes alternate ingress and weakens assumed proxy/header/transport controls; app still authenticates but accepts asserted headers               | Prohibit; loopback only for host proxy, none for container proxy                      |
| Publish PostgreSQL publicly                               | Alternate direct database ingress, outside web auth; PostgreSQL password is a separate control                                                    | No production DB publication                                                          |
| Pass through existing single XFF                          | Weakens supplemental limiter identity; misleading session IP                                                                                      | Remove or overwrite from proxy's connection peer                                      |
| Append to client XFF                                      | Multi-token chain goes to shared no-trusted-ip bucket; loses precision, can create shared availability contention                                 | One hop only; overwrite, not append                                                   |
| Add second proxy/CDN                                      | Current parser does not reliably recover original address; spoof/provenance assumptions unsupported                                               | Explicitly unsupported until reviewed                                                 |
| Correct TLS but raw HTTP app port reachable               | Alternate ingress remains; Secure cookie mode is not transport enforcement                                                                        | Close app port independently of app logic                                             |
| Incorrect HTTPS APP_ORIGIN                                | Origin-dependent writes/login fail for real browser; OAuth uses wrong callback; configured canonical host still authoritative                     | Exact public origin and provider registration; never derive it from arbitrary headers |
| HTTP APP_ORIGIN in production                             | Fails safely at configuration validation                                                                                                          | Keep production HTTPS requirement                                                     |
| Public HTTP while APP_ORIGIN is HTTPS                     | Raw HTTP endpoints still accept requests; ordinary browser writes fail exact Origin and Secure cookies cannot support normal public HTTP sessions | Edge redirects HTTP before app; no raw HTTP bypass                                    |
| Use development mode on public VPS                        | Removes production Secure-cookie choice and HTTPS-origin requirement; weakens transport/session protection                                        | Production environment mandatory                                                      |
| Proxy/network joined by unrelated services                | Those peers can assert headers and reach app; backend reachability may expand                                                                     | Dedicated ingress membership; separate DB network if inexpensive                      |
| Assume an undocumented firewall fixes publications        | Reachability unverified; unsafe assurance, possible alternate ingress                                                                             | Prefer no publication; verify resolved deployment and actual local listeners/routing  |
| Treat syntactically correct proxy header as authenticated | Headers indistinguishable from client assertions on direct ingress                                                                                | Header provenance comes from edge sanitization plus private path                      |
| Native setup behind TLS edge without Location rewrite     | Internal absolute 303 target; navigation failure after successful setup                                                                           | Canonical/relative app redirect or explicit edge rewrite; see F9-03                   |

No mistake in this table is asserted to exist on a real VPS. It distinguishes failure consequences from demonstrated repository defaults.

## H. F9 findings

No demonstrated BLOCKER or HIGH application authentication bypass was found. Severity below accounts for F8 and the current nonpublished production ports.

### F9-01 — MEDIUM: forwarded single IP is accepted without authenticated proxy provenance

- **Category/component:** Better Auth behavior requiring configuration/ingress contract; Next preserves client forwarding headers.
- **Current behavior:** A raw request's single valid XFF selects the database limiter key and can supply session IP metadata; an ordinary chain selects shared fallback. The core helper does not compare a transport peer.
- **Required trust assumption:** Every request reaching the app has passed the designated sanitizing edge, or these values are explicitly treated as untrusted optional metadata.
- **Consequence:** Supplemental per-address limiting can be partitioned by caller-chosen IPs; metadata can be false and malformed chains collapse users into a common bucket. This does not bypass owner/session checks or F8 global/account/challenge admission. No volume/resource-exhaustion claim was load-tested.
- **Evidence:** core IP source lines 174–219; Next base-server lines 605–612; auth factory rate-limit/advanced options; observed `192.0.2.10|/get-session` versus `no-trusted-ip|/get-session` rows.
- **Smallest direction:** Private raw ingress and remove client IP headers at the edge, or overwrite one XFF from the immediate public connection. Empty auth IP-header list is an optional explicit no-IP setting. Do not add arbitrary proxy-chain support or disable tracking without understanding limiter effects.

### F9-02 — MEDIUM: public ingress integration is not concretely specified

- **Category/component:** Missing deployment contract/examples, not an unsafe base Compose `ports` default.
- **Current behavior:** Architecture mandates private backend/TLS proxy, but no proxy attachment, host-proxy production-only loopback override, virtual-host/header rule or direct-port acceptance check is supplied. Dev override changes security mode and cannot serve as the production host-proxy solution.
- **Required trust assumption:** Operator correctly fills all these gaps before exposure.
- **Consequence:** Public deployment cannot be verified from shipped artifacts; adding a wildcard app port or pass-through headers would introduce a concrete alternate ingress/false-IP path. Base Compose itself has no ordinary published public path.
- **Evidence:** A/B inventory, resolved Compose, README and architecture requirements; absence of current edge/deployment config.
- **Smallest direction:** Provide a strict one-proxy contract and reviewable production examples for both supported styles; keep existing safe nonpublication defaults and verify the merged configuration. Public readiness is contingent on that deployment work.

### F9-03 — LOW: native setup redirect derives absolute authority from internal request URL

- **Category/component:** Application deployment correctness defect, `src/app/api/setup/route.ts:107`.
- **Current behavior:** Native form setup returns internal absolute `/login`; forwarded proto changes the scheme while Host/XFH do not make the target canonical in current runtime.
- **Required trust assumption:** Request URL represents the public origin, or edge rewrites this Location. Neither assumption is guaranteed by shipped Next/Compose settings.
- **Consequence:** Successful setup can navigate the browser to a wrong/private host/port. Normal JSON/JavaScript flow is unaffected. No auth bypass, arbitrary-host redirect or secret disclosure demonstrated.
- **Evidence:** Final standalone run returned `303 Location: https://localhost:60082/login` with `APP_ORIGIN=https://maildock.example.test`; installed Next URL/adapter code.
- **Smallest direction:** Use a relative Location or configured APP_ORIGIN for the form fallback. An edge Location rewrite is possible but adds deployment coupling. Do not enable forwarded-host trust to repair this.

### F9-04 — INFORMATIONAL: nonpublication and canonical auth configuration are already appropriate

Base Compose has no app/database host publications, dev bindings are loopback, and static auth/OAuth origin plus production Secure cookies are independent of client-address assertions. Preserve these choices. There is no unsafe wildcard publication default to remove in the current base file.

## I. Controls already correct

- F8 PostgreSQL instance/work-kind admission, owner password delay, challenge/account MFA attempt limits, transaction/advisory-lock boundaries and persistence across processes. Do not replace them with IP quotas.
- Existing auth route allowlist, MFA/session-owner checks, lifetime/revocation boundaries, bootstrap authorization and bounded input handling. Header provenance is not a new authentication method.
- Exact application Origin policy and explicit Better Auth CSRF/Origin enablement, configured static baseURL/trustedOrigins, OAuth canonical callbacks and session-bound state handling.
- Production Secure/HttpOnly/Lax cookies without client-selected Domain; no forwarded-proto toggle is needed for TLS termination at the edge.
- Safe base port nonpublication, development loopback bindings, internal database addressing and container-local health probes.
- Existing guarded atomic rate-limit adapter patch; no dependency upgrade or F8 redesign is indicated by F9 discovery.

## J. Proposed F9 implementation scope

### MUST FIX for V1

- Establish and enforce one designated public TLS ingress with no alternate Internet path to app/PostgreSQL; do not publicly expose V1 until this concrete deployment is reviewed.
- Define and apply edge header sanitization: remove or overwrite caller IP assertions, canonical host, exact single scheme; explicitly decide no-original-IP versus optional edge-supplied single IP. Preserve F8 regardless of this choice.
- Supply a production host-proxy connection distinct from the development override, or a deliberate container-proxy network attachment. Validate final merged port/network configuration; do not assume the base already includes a reachable proxy.

### SHOULD FIX if inexpensive

- Repair native setup redirect to relative/canonical navigation (F9-03), retaining request-independent auth origin. This is the only demonstrated application edit suggested here.
- Make no-IP preference explicit through supported auth header-list configuration if chosen; do not accidentally switch off the remaining limiter via disableIpTracking.
- Separate proxy ingress and PostgreSQL backend networks, without removing required application outbound mail/OAuth access.

### DOCUMENT / DEPLOYMENT CONTRACT

- Both supported one-proxy styles, allowed peers, port publication/bind rules, host allowlist, TLS termination, header overwrite rules and unsupported multi-hop/CDN chains.
- APP_ORIGIN must be the public HTTPS origin; production security mode remains production. Explain why Secure cookies work over internal HTTP and why they do not block raw ingress.
- Explain EXPOSE/expose/ports and normal bridge reachability separately from firewall assumptions. Add deployment acceptance criteria for private raw ports and edge sanitization; preserve exactly two mandatory application services.
- State that optional session IP/edge logs are normalized advisory metadata, not a session or owner authorization factor.

### DEFER TO F11

Session IP provenance/normalization and fallback diagnostics need logging/audit policy. The dependency can emit a missing-IP warning; meaningful audit identity should not be inferred from forged headers. Existing regression tests emitted expected synthetic logout-failure events. No logging rewrite or new logging defect was established in this review; sensitive-data/event policy remains F11.

### DEFER TO F12

General container/filesystem/capability/image/resource/secret hardening and generic security headers. Dockerfile already runs a nonroot user; its broader hardening was not re-audited. No demonstrated additional F12 vulnerability is claimed from this focused discovery. Ports/network/header rules necessary to enforce proxy provenance remain F9, even if applied through Compose.

### Explicit closing decision

**Maildock does not require application-level trusted-proxy/client-IP logic for V1.** F8's important correctness is already IP-independent, auth/OAuth origin is configured, and production cookie security is explicit. A strict private ingress path plus removal/overwrite of caller forwarding headers is sufficient for the F9 security boundary; original IP can remain optional edge observability or supplemental limiting.

**Can F9 be closed entirely through a deployment/ingress contract plus removal of unsafe defaults?** For proxy provenance and client-address security, yes, provided the contract is concretely implemented and verified, not merely written. There are no unsafe production port-publication defaults in this baseline to remove. For all discovery observations including native setup navigation, a deployment-only closure would additionally need an explicit Location rewrite or acceptance of the LOW fallback defect. The cleaner complete result includes a tiny canonical/relative setup redirect correction; it still needs no trusted-proxy parser. These are separate choices, so “deployment-only” versus “application trusted-proxy logic” is not a strict either/or. F9 remains open after this discovery session.

## Validation and repository hygiene

| Item                          | Result                                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit                        | `d6b21273471eb046df5ed418e0cba6fff1fb96da` throughout review                                                                                                                                   |
| Initial shell Node            | 22.22.3; below project requirement, used for initial package/source resolution and an initial report-format check, not application validation                                                  |
| Build/harness/test Node       | 24.19.0, selected from `C:/Users/mateu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`; satisfies `>=24.15.0 <25`                                                           |
| Installed versions            | Better Auth 1.7.5, resolved @better-auth/core 1.7.5, Next.js 16.3.6; no dependency install/change                                                                                              |
| Reviewed Docker               | Dockerfile node:24.21.0-bookworm-slim; base `docker-compose.yml`; merge with `docker-compose.dev.yml`; PostgreSQL image 18.6-bookworm                                                          |
| Local Docker tools            | Engine 28.5.1; Compose v2.40.3-desktop.1                                                                                                                                                       |
| Compose commands              | `docker compose -f docker-compose.yml config --format json`; same with dev override; harmless process-only required-variable placeholders, extracted only port/network metadata                |
| Fresh production web build    | `node node_modules/next/dist/bin/next build`, Node 24, process-only `APP_ORIGIN=https://maildock.example.test`: PASS, exit 0; worker build not needed for this HTTP discovery                  |
| Temporary harness             | `NODE_ENV=production node --import tsx .security-results/f9-discovery-harness.ts`, Node 24; repeated Next-start/form characterization and final standalone characterization: PASS, exit 0      |
| Existing security suite       | `node node_modules/vitest/vitest.mjs run tests/security --maxWorkers=2`: PASS, 19 files / 319 tests, exit 0, 111.29 seconds                                                                    |
| Temporary files               | `.security-results/f9-discovery-harness.ts`, `.security-results/f9-request-observer.cjs`, per-run `.security-results/f9-attachments-<pid>` directories; removed after validation               |
| Disposable infrastructure     | Per-run `maildock-f9-<pid>` PostgreSQL container, loopback-only random DB port; stopped/removed. Temporary Next child processes stopped. Existing test suite owns its own disposable fixtures. |
| Existing ignored build output | `.next` regenerated by requested runtime validation; no tracked app/config/dependency/migration/test files changed. Existing generated Next declaration content remained unchanged.            |
| Persistent result             | Only `docs/SECURITY_F9_DISCOVERY.md` added; no commit, push or deployment                                                                                                                      |

After the final standalone harness and removal of its temporary files, the relevant existing regressions were run again:

```text
node node_modules/vitest/vitest.mjs run tests/config.test.ts tests/security/route-policy.test.ts tests/security/mutation-policy.integration.test.ts tests/security/f8-admission.integration.test.ts tests/security/increment-one.integration.test.ts --maxWorkers=2
```

Result: PASS, 5 files / 51 tests, exit 0, 17.22 seconds, Node 24.19.0. This final run covers config/origin policy, route boundaries, F8 admission and the atomic dependency adapter after temporary runtime validation. Report-only formatting was normalized with the installed Prettier; final formatting and diff-whitespace checks passed.

Final `git status --short`:

```text
?? docs/SECURITY_F9_DISCOVERY.md
```
