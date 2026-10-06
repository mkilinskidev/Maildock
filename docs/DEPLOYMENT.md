# Production ingress contract

Maildock V1 is self-hosted and proxy-independent. The base Compose file requires exactly two services, `app` and `postgres`. HTTPS ingress is operator-owned infrastructure: Coolify / Traefik, Caddy, Nginx Proxy Manager, nginx, another equivalent ingress, or private network/VPN infrastructure may satisfy the same contract. None is a Maildock dependency. No proxy, certificates or ACME configuration are bundled.

For Internet-facing production, the supported path is:

```text
untrusted browser -> operator-controlled HTTPS ingress -> Maildock -> PostgreSQL
```

## Required security properties

- Browser-facing production access uses HTTPS. Set `MAILDOCK_ENV=production` and `APP_ORIGIN` to the exact canonical public HTTPS origin, without credentials, path, query or fragment.
- Untrusted clients must have no alternate route to Maildock's raw HTTP listener that bypasses the intended ingress boundary. PostgreSQL must be unreachable from the untrusted/client network.
- The ingress routes only the intended Maildock hostname/origin and controls its forwarding-header policy. Use the ingress product's secure behavior for removing/replacing untrusted forwarding headers. Keep the browser's `Origin` intact; do not fabricate an accepted Origin for rejected clients.
- Maildock does not authenticate a proxy using forwarding headers and does not use caller-selected client-address headers as authoritative identity. Headers are not proof that a request traversed the intended ingress. Syntactically valid chains do not automatically establish trust in a multi-hop proxy/CDN topology.
- `APP_ORIGIN`, exact Origin protection, owner/session validation, MFA and PostgreSQL-backed F8 authentication admission do not depend on original client IP. Maildock does not infer network topology or implement proxy CIDR/socket-peer/XFF-chain trust.
- Production cookies remain `Secure`, `HttpOnly`, `SameSite=Lax` when public TLS terminates at ingress and ingress reaches Maildock over private HTTP. Their settings derive from production configuration, not `X-Forwarded-Proto`. Production still requires HTTPS in private/LAN/VPN deployments; plain HTTP convenience using development mode or modified software is outside this supported production profile.
- Native setup navigates to `<APP_ORIGIN>/login`; JSON setup retains its existing response/client navigation. Do not enable application forwarded-host/proto trust to repair redirects. Canonical origin remains configured regardless of internal Host/port.
- Development Compose overrides are development configuration, not a production template.

## Network topology examples

**A. Platform/container ingress:** `Internet -> Coolify-managed Traefik -> private Docker/network path -> Maildock:3000`. A platform can attach its existing ingress directly to the app network/container; no app host-port publication is necessary. This is the project author's intended VPS model. The operator configures network attachment, public HTTPS routing and backend port 3000. Base Compose does not attach an external proxy automatically.

**B. Host reverse proxy:** `Internet -> host Caddy/nginx/etc. -> loopback/private app publication -> Maildock:3000`. A production app publication bound to `127.0.0.1` may suit this model. Choose and review the actual private path; do not use the development override to obtain it, since that also selects development security mode.

**C. Private/LAN/VPN:** Direct host/container reachability may be controlled by externally managed network boundaries. Non-loopback publication is not automatically a defect: it may be appropriate within a private VLAN/VPN. It is not by itself a safe Internet-facing deployment if untrusted clients can bypass the intended ingress. Review publications in the actual topology while retaining HTTPS `APP_ORIGIN` and production cookie requirements.

These are conceptual examples, not required proxy-specific Compose variants. A multi-hop/CDN setup needs an operator review of the same invariants; Maildock does not certify it from its headers.

Base Compose publishes neither app nor PostgreSQL. `expose: ["3000"]` and image `EXPOSE 3000` identify the internal app port; neither is a host publication or access-control list. The image listens on `0.0.0.0:3000` inside its container. Docker networking alone does not prove Internet isolation. Maildock cannot determine a VPS/cloud firewall, VLAN/VPN, Docker daemon routing, platform routing or external load-balancer policy. No host firewall is presumed. The operator must verify all relevant IPv4/IPv6 paths and authorized network peers.

Keep the app's required outbound mail/provider connectivity when designing network restrictions. App readiness uses loopback inside the container and checks database/storage readiness; it does not certify ingress security.

## Client-address policy

Better Auth 1.7.5 is configured with `advanced.ipAddress.ipAddressHeaders: []`. No address forwarding header is consulted, including `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP` or `True-Client-IP`. Next may preserve or synthesize forwarding headers, but Better Auth ignores them for address selection. `disableIpTracking` is deliberately not enabled, because it would bypass HTTP limiting when no IP resolves.

In a production Node runtime Better Auth resolves no client IP, writes empty session IP metadata, and uses a shared per-path database HTTP limiter key such as `no-trusted-ip|/get-session`. Its ordinary development/test fallback is `127.0.0.1|<path>` with shared loopback metadata. Neither is an invented original-client address. Existing limits remain 100 requests per 60 seconds generally and 10 per 60 seconds for username sign-in; the atomic patched database adapter remains in use. These supplemental shared limits can cause contention among legitimate clients. F8 global/account/factor/challenge/ceremony admission remains authoritative and IP-independent; changing address headers cannot refresh its budgets.

Better Auth may emit its existing warning recommending IP forwarding when it first selects the shared production bucket. The shared bucket is intentional in Maildock V1; that generic dependency warning is not an instruction to enable IP or forwarded-host trust. Session IP metadata cannot be used as authentication/authorization evidence. Logging policy is deferred to F11.

## Operator acceptance checklist

- [ ] Browser-facing URL is HTTPS.
- [ ] `APP_ORIGIN` exactly matches that public HTTPS origin.
- [ ] `MAILDOCK_ENV=production`.
- [ ] PostgreSQL is not reachable from the untrusted/client network.
- [ ] Maildock's raw HTTP endpoint has no alternate untrusted path bypassing ingress.
- [ ] Ingress routes only the intended Maildock hostname/origin.
- [ ] Ingress has a defined policy for removing/replacing client-supplied forwarding headers.
- [ ] Development Compose overrides are not used for production.
- [ ] Custom Docker/network/host publications have been reviewed against actual topology, including IPv4/IPv6 routing and applicable operator-controlled firewall/VPN policies.

Validate reachability from the relevant networks using your own authorized infrastructure checks. Repository tests verify resolved Compose defaults and application behavior; they cannot certify those operator-owned boundaries or a hypothetical custom override.

## Coolify / Traefik compatibility

The repository supports an external ingress connected to the app container/network, routing to port 3000, terminating TLS externally, without host publication and with platform-supplied forwarding headers. Set the canonical public HTTPS `APP_ORIGIN`, production environment and independent deployment secrets; preserve persistent database/attachment storage and configure ingress attachment/routing without exposing PostgreSQL or alternate raw app ingress. The image's internal wildcard listener, standalone Next output, configured canonical auth URL and explicit Secure cookies fit this topology; address headers are unnecessary for authentication correctness.

This is a repository/configuration compatibility assessment, not certification of a particular Coolify/Traefik version or live installation. No live instance or version-specific routing/firewall configuration was supplied or contacted. The operator must configure and verify their platform against the checklist. No Coolify/Traefik runtime dependency is added.
