# F9 implementation results: proxy trust / public ingress

Date: 2026-10-06. Baseline: `d6b21273471eb046df5ed418e0cba6fff1fb96da` (`security: harden authentication throttling`). Authoritative discovery: [SECURITY_F9_DISCOVERY.md](SECURITY_F9_DISCOVERY.md). This report records implementation; discovery remains an unchanged historical characterization. The implementation request's proxy-independent deployment model supersedes discovery's suggested narrower one-proxy examples.

**F9 PROXY TRUST / PUBLIC INGRESS: PASS.** Application behavior, resolved repository Compose defaults, regression tests and the operator-owned deployment contract agree. This is repository F9 closure, not certification of a live operator deployment.

## A. Repository state and scope

The initial tree had only untracked `docs/SECURITY_F9_DISCOVERY.md`. That document was preserved. HEAD remains the baseline; no commit, push, deployment or external-host test was performed. Changes are limited to auth IP configuration, canonical setup redirect, F9 regressions and deployment/security documentation. Compose, Dockerfile, package/dependency declarations, dependency patches, migrations and F8 implementation remain unchanged.

Validation used Node 24.19.0 (satisfies `>=24.15.0 <25`), pnpm 12.6.0, installed Better Auth/core 1.7.5 and Next.js 16.3.6. The shell's default Node 22.22.3 was not used for application validation. The bundled Node/pnpm runtime was selected explicitly. pnpm bootstrapped its configured package-manager metadata and temporarily added a manager entry to `pnpm-lock.yaml`; that tool-generated change was restored to the known initially clean baseline. No dependency change is retained.

Ignored `.next`/worker output and local `.security-results/f9-*.log` validation evidence remain outside the review diff. Runtime containers, child servers and temporary attachment storage were cleaned up. The disposable standalone harness is retained under ignored `.security-results/f9-runtime.ts` for local evidence; durable regressions live under `tests/security`.

## B. Final V1 security model

```text
untrusted client -> operator-controlled HTTPS ingress -> Maildock -> PostgreSQL
```

The [production ingress contract](DEPLOYMENT.md) defines security properties rather than a product dependency. Coolify / Traefik, Caddy, Nginx Proxy Manager, nginx, equivalent ingress platforms and private/VPN environments are examples. No reverse proxy, certificates, ACME, production proxy variant or mandatory third Compose service was added.

The browser uses HTTPS, `APP_ORIGIN` is its exact canonical public HTTPS origin, and `MAILDOCK_ENV=production`. Untrusted clients cannot reach PostgreSQL or bypass ingress via alternate raw app HTTP. Network reachability and header policy are operator-owned. Secure cookies work with public HTTPS and private proxy-to-app HTTP. Production HTTPS requirements also apply to LAN/VPN use; development mode is not a supported production workaround.

Maildock does not authenticate a proxy from headers, infer network topology, parse XFF chains or require original client IP. Valid-looking multi-hop/CDN headers do not establish trust. The operator routes only the intended public host and applies their ingress's secure removal/replacement policy for untrusted forwarding headers. No forwarded-host/proto trust was enabled in the application.

## C–E. Application changes and discovery resolutions

| Finding      | Resolution                                                                                                                                                                                            | Evidence                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| F9-01 MEDIUM | `advanced.ipAddress.ipAddressHeaders: []` makes the no-authoritative-client-IP policy explicit. `disableIpTracking` is absent; database HTTP rate limiting and patched atomic adapter remain enabled. | `auth-factory.ts`, production child regression and standalone HTTP probes below                 |
| F9-02 MEDIUM | Added proxy-independent contract, three conceptual network topologies, operator checklist and qualified platform compatibility review; linked README/architecture/environment guidance.               | `docs/DEPLOYMENT.md`, resolved Compose regressions                                              |
| F9-03 LOW    | Native setup uses `new URL("/login", config.appOrigin)` with status 303 instead of `request.url`.                                                                                                     | Four successful form regressions with conflicting Host/XFH/XFP and actual standalone HTTP setup |

Normal JSON setup still returns HTTP 201 `{ "initialized": true }`. No F8 limiter, owner/session/MFA policy or setup bootstrap admission implementation was edited.

### Installed dependency semantics rechecked

Reviewed the installed core `dist/utils/ip.mjs:196–219`, `dist/env/env-impl.mjs`, Better Auth `dist/api/rate-limiter/index.mjs:232–307` and `dist/db/internal-adapter.mjs:263`. Core was resolved within Better Auth's installed dependency graph. The empty array is truthy and therefore does not trigger `DEFAULT_IP_HEADERS`; its loop reads no headers. In production core returns null. In development/test it returns `127.0.0.1`; `TEST` also selects this fallback independently of `NODE_ENV`.

The HTTP limiter uses `createRateLimitKey(ip ?? "no-trusted-ip", normalizedPath)`. It bypasses limiting on missing IP only if `disableIpTracking` is enabled, which Maildock deliberately does not set. The existing database consume/increment adapter and limits (general 100/60 seconds, username sign-in 10/60 seconds) are preserved. Server-side `auth.api` calls do not acquire this HTTP limiter; their Maildock F8 admission remains independent.

Session creation persists `getIP(headers, options) || ""`. Production session IP is thus empty; development/test loopback metadata is a shared fallback, not original-client identity. No address was invented.

Also rechecked Next `dist/server/base-server.js:605–612` and `dist/server/lib/router-utils/resolve-routes.js:115–123`: Next preserves supplied XFF or synthesizes peer XFF, and can derive request scheme from XFP. Maildock's new auth policy ignores that address header and setup navigation no longer consumes the request authority. Existing static auth base URL, exact Origin and explicit Secure cookies remain configured independently.

| Behavior                     | Before F9 (discovery)                                        | After F9 (production validation)                            |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Single supplied valid XFF    | Caller-selected address HTTP bucket/session metadata         | Shared `no-trusted-ip` bucket; empty session IP             |
| Missing XFF through Next     | Next peer header could select HTTP identity                  | Synthesized XFF ignored                                     |
| Empty/chained XFF            | Shared fallback when parser cannot resolve one address       | Same shared fallback as every other variant                 |
| Other client-address headers | Not selected by default                                      | No configured address header is selected                    |
| Native setup redirect        | Internal request authority could appear in absolute Location | Canonical `https://maildock.example.test/login` in fixtures |

## F. Repository-owned deployment validation

`f9-compose.test.ts` invokes Docker Compose resolution with synthetic process-only required-variable placeholders, without starting the deployment:

```text
docker compose -f docker-compose.yml config --format json
docker compose -f docker-compose.yml -f docker-compose.dev.yml config --format json
```

| Guarantee                               | Result                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Base service set                        | Exactly `app`, `postgres`                                                                                |
| Base app / PostgreSQL host publications | Both absent                                                                                              |
| Internal app reachability               | `expose: ["3000"]`; image listens at `0.0.0.0:3000` inside container                                     |
| Base environment                        | `MAILDOCK_ENV=production`, `NODE_ENV=production`                                                         |
| Database addressing                     | App uses `postgres:5432`                                                                                 |
| Development app publication             | Exactly `127.0.0.1:3000:3000`                                                                            |
| Development PostgreSQL publication      | Exactly `127.0.0.1:5432:5432`                                                                            |
| Development environment                 | Explicit `MAILDOCK_ENV=development`                                                                      |
| Production config                       | HTTP `APP_ORIGIN` rejected by existing config test                                                       |
| Production cookie/address policy        | Secure cookie, empty IP-header list, enabled DB limiter verified in production child and standalone HTTP |

Compose files and Dockerfile were not modified. `EXPOSE`/`expose` are not host publication or access-control lists. Tests certify repository defaults, not Internet isolation or arbitrary operator overrides.

## G–H. Operator responsibility and Coolify compatibility

The deployment guide distinguishes:

1. Platform/container ingress, including the author's intended VPS -> Coolify-managed Traefik -> app network/container port 3000: no host publication necessary.
2. Host reverse proxy: operator-selected loopback/private app publication may be appropriate; the development override must not supply production configuration.
3. Private/LAN/VPN: non-loopback publication can be valid if externally controlled topology prevents untrusted ingress bypass, while production HTTPS/cookie requirements remain intact.

Maildock cannot inspect VPS/cloud firewalls, VLAN/VPN boundaries, Docker daemon routing, Coolify policies or external load balancers. Docker networking alone proves no universal Internet isolation and no host firewall is presumed. The checklist explicitly assigns public HTTPS, canonical origin, production mode, intended host routing, forwarding-header policy, PostgreSQL isolation, alternate raw HTTP path review and custom publication review to the operator.

Repository/configuration compatibility with an externally TLS-terminating platform ingress is **PASS, conditional on those operator checks**. The image uses Next standalone, listens on container port 3000, and needs no host publication or trusted address headers. The operator must attach ingress to a suitable app network/container, route the intended host to port 3000, configure public HTTPS `APP_ORIGIN` and production secrets/mode, retain persistent storage and prevent app/database bypass. Required outgoing mail/provider access must remain possible.

This does not certify a particular Coolify/Traefik version or deployed instance: no platform version, live routing or firewall evidence was supplied. No live Coolify was deployed or contacted; no platform dependency was introduced.

## I. Forwarding-header validation evidence

`f9-headers.ts` defines ten request variants: missing XFF, empty XFF, two distinct valid XFF addresses, a comma chain, X-Real-IP, RFC Forwarded, CF-Connecting-IP, True-Client-IP, and conflicting combinations. Synthetic addresses are data only; no external host is contacted.

**Production regression:** `f9-ingress.integration.test.ts` starts disposable PostgreSQL and invokes `f9-process.ts` as a separate Node process with `NODE_ENV=production`, `TEST=false`. The latter is necessary because the test runner supplies a test environment flag that Better Auth otherwise recognizes as a loopback fallback. The first attempted probe exposed that fixture issue; it was corrected before the passing suite.

For all ten variants, unauthenticated get-session succeeds and successful username login succeeds. The resulting HTTP rows are exactly `no-trusted-ip|/get-session` and `no-trusted-ip|/sign-in/username`, count 10 each. All ten sessions have empty IP metadata and production Secure session cookies. Setting the existing get-session bucket to 100 rejects all ten variants with HTTP 429, proving that header changes cannot obtain a new supplemental bucket.

**Actual Next HTTP runtime:** After the fresh full build, `NODE_ENV=production TEST=false node --import tsx .security-results/f9-runtime.ts` started `.next/standalone/server.js` on a random loopback port with an isolated PostgreSQL 18.6 container published only to `127.0.0.1` on a random port. It migrated only that disposable database, used synthetic independent credentials and a temporary attachment directory, and cleaned up the container/server/storage in `finally`. No provider/OAuth traffic was invoked.

Observed output:

```json
{
  "status": "PASS",
  "runtime": "Next standalone, production, private HTTP",
  "variants": 10,
  "key": "no-trusted-ip|/get-session",
  "sessionIp": "",
  "nativeSetup": "https://maildock.example.test/login",
  "secureCookies": true,
  "sharedHttpDenied": 10,
  "f8PasswordDenied": 10
}
```

Next's missing-XFF synthesis did not create a new identity. Native form success used conflicting `Host: other.example.test:8080`, `X-Forwarded-Host: attacker.example.test`, `X-Forwarded-Proto: nothttps`, canonical Origin and internal HTTP request URL; Location remained public/canonical. The durable setup tests additionally cover XFP `http`, `https`, `http, https`, and `nothttps`, asserting persisted owner creation and the canonical 303 Location. Real TLS ingress, firewall and image wildcard reachability were not externally tested; the internal HTTP behavior plus image/config source are the scope of compatibility evidence.

## J. F8 and earlier-security regression evidence

The only auth-factory production change is the four-line address-policy addition. `auth-admission.ts`, `login-throttle.ts`, MFA application code, owner binding, lifetime policy, setup bootstrap implementation and the installed Drizzle patch are unchanged. Important keys remain fixed work/owner/factor/challenge/ceremony state, never forwarded addresses.

The new F9 admission regression primes the global password, MFA and management budgets and varies all ten header sets through password, TOTP, recovery, cancellation, replacement resume/complete/start and recovery regeneration wrappers. Every request returns 429. No hash or password verification runs; persisted work counters remain saturated at 13/31/13 rather than splitting into fresh identities. Existing canonical username-delay regression also changes XFF between independently pooled auth instances and permits only the first Argon2 attempt. The standalone HTTP probe independently rejects all ten password variants against one exhausted F8 work bucket.

The complete security suite preserves evidence for:

| Control                                        | Regression coverage                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Global password / MFA / management admission   | `f8-admission.integration.test.ts`, including max-1 PostgreSQL contention and new ten-header denial matrix |
| Canonical owner password delay                 | F8 queued case variants, owner-username integration                                                        |
| MFA challenge attempts and owner/factor budget | F8 multi-challenge tests, MFA foundation and initial-MFA integrations                                      |
| Management password/factor budgets             | F8 concurrent wrong-password and mixed TOTP/recovery tests, MFA-management integration                     |
| Replacement ceremony budget                    | F8 ceremony tests and MFA-management integration                                                           |
| Recovery-code CAS and atomic HTTP limiting     | `increment-one.integration.test.ts` against installed patched adapter                                      |
| Session idle/absolute lifetime                 | `session-lifetime.integration.test.ts`                                                                     |
| Immutable owner binding                        | Owner-binding, owner-username and owner-binding migration integration                                      |
| Exact Origin and mutation boundaries           | Config, route-policy, mutation-policy, authorization/adversarial suites                                    |
| Bootstrap controls                             | Bootstrap integration including independent-process Argon2/admission, setup races, secret/body bounds      |

F1–F8 and F10 policy implementations were not weakened or redesigned. F8 remains unchanged; only regression coverage was extended.

## K–L. Limitations and deferred observations

- Shared supplemental HTTP buckets intentionally allow contention among legitimate clients. No real-client-IP attribution is claimed. F8 is authoritative; address metadata is not an authorization factor.
- Maildock cannot enforce or certify an operator's external network reachability from request headers, application health or Compose resolution. Operators must satisfy the ingress contract; an arbitrary custom override is outside repository control.
- Multi-hop/CDN topology is not automatically trusted or certified. No proxy CIDRs, peer authenticator or address parser were added.
- Forwarded scheme can still influence framework metadata. Canonical security configuration and repaired setup navigation do not rely on it; ingress must own its header policy and intended host routing.
- F11: existing missing-IP diagnostic and empty session metadata merit later logging/audit policy review. No new security events or logging redesign were implemented.
- F12: general capability/filesystem/resource/image/secret/security-header hardening remains deferred. No unrelated container or package hardening was implemented. No additional vulnerability is asserted from these observations.

## M. Tests and tooling

All application checks use the required Node 24 line. Commands are run through the bundled pnpm 12.6.0 CLI where applicable; logs are ignored local artifacts, not committed output.

| Check                                                                            | Result                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F9/config/setup/route/mutation/F8 targeted run (`vitest run ... --maxWorkers=2`) | PASS: 7 files, 80 tests, 31.82 seconds                                                                                                   |
| `pnpm test:security --maxWorkers=2`                                              | PASS: 21 files, 327 tests, 140.61 seconds                                                                                                |
| `pnpm test --maxWorkers=2`                                                       | PASS: 94 files, 1153 tests, 226.63 seconds                                                                                               |
| `pnpm typecheck`                                                                 | PASS; initial two new test typing issues corrected before successful rerun/build                                                         |
| `pnpm lint`                                                                      | PASS: 0 errors; 13 existing warnings solely in ignored F8 discovery/signature preview files                                              |
| `APP_ORIGIN=https://maildock.example.test pnpm build`                            | PASS: Next production standalone and worker compilation/import fix                                                                       |
| Fresh standalone local HTTP harness                                              | PASS; ten address variants, shared limiter enforcement, F8 password denial, empty session IP, Secure cookie and canonical setup Location |
| Resolved base/development Compose                                                | PASS: durable two-case Compose test                                                                                                      |
| `pnpm exec prettier --check <changed supported files>`                           | PASS: all changed supported files; .env.example has no inferred Prettier parser and is covered by diff whitespace review                 |
| `git diff --check`                                                               | PASS, including final working-tree check                                                                                                 |

## Final review answers

1. **Does Maildock trust XFF as authoritative client identity?** No; the configured address header list is empty.
2. **Can header changes create a fresh important auth budget?** No; all ten variants share F8 admission and supplemental production HTTP buckets.
3. **Does important security require original IP?** No.
4. **Is a particular reverse proxy required?** No.
5. **Is a third mandatory Compose service required?** No.
6. **Does base Compose publish app port 3000?** No.
7. **Does base Compose publish PostgreSQL?** No.
8. **Can Maildock determine custom publication Internet reachability?** No.
9. **Is this limitation assigned to the operator clearly?** Yes, in the contract and acceptance checklist.
10. **Does production still require HTTPS APP_ORIGIN?** Yes; config and cookie policy are retained and validated.
11. **Is setup navigation independent of internal Host/XFH/XFP?** Yes; it uses configured canonical origin.
12. **Is intended Coolify/Traefik topology compatible?** Yes at repository/configuration level, subject to operator ingress/network setup; no version-specific or live-instance certification is claimed.
13. **Is F8 unchanged?** Yes in implementation, thresholds, storage, adapter patch and key derivation; regressions were extended and pass.

## N. Exact final working-tree snapshots

`git diff --stat` describes tracked-file changes; untracked files, including this report and the preserved discovery, are listed by `git status --short` separately.

`git diff --stat`:

```text
 .env.example                                    |  2 +
 README.md                                       |  4 +-
 docs/ARCHITECTURE.md                            |  2 +
 src/app/api/setup/route.ts                      |  2 +-
 src/modules/auth/infrastructure/auth-factory.ts |  4 ++
 tests/security/bootstrap.integration.test.ts    | 27 ++++++++++++
 tests/security/f8-admission.integration.test.ts | 55 +++++++++++++++++++++++++
 7 files changed, 94 insertions(+), 2 deletions(-)
```

`git status --short`:

```text
 M .env.example
 M README.md
 M docs/ARCHITECTURE.md
 M src/app/api/setup/route.ts
 M src/modules/auth/infrastructure/auth-factory.ts
 M tests/security/bootstrap.integration.test.ts
 M tests/security/f8-admission.integration.test.ts
?? docs/DEPLOYMENT.md
?? docs/SECURITY_F9_DISCOVERY.md
?? docs/SECURITY_F9_RESULTS.md
?? tests/security/f9-compose.test.ts
?? tests/security/f9-headers.ts
?? tests/security/f9-ingress.integration.test.ts
?? tests/security/f9-process.ts
```

F9 PROXY TRUST / PUBLIC INGRESS: PASS
