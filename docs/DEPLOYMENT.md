# Production ingress contract

## PostgreSQL authority (F12-03)

Fresh bundled `docker compose up` runs the read-only
`scripts/postgres/99-maildock-authority.sql` as the **last** initdb step. Keep it
last: it disables the original bootstrap login. The normal TCP server, existing
PostgreSQL health dependency and application authority guard gate migrations and
web/worker startup. Base services remain exactly `app` and private `postgres`,
with the existing persistent PostgreSQL volume and one application `DATABASE_URL`.

The runtime `maildock` is an ordinary login with `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION NOBYPASSRLS`. It owns the Maildock database and
application objects, including Drizzle and pg-boss objects. Database ownership
deliberately allows migration and queue DDL and does not contain SQL injection
within Maildock's own data. The original OID-10 role is `maildock_bootstrap`,
`SUPERUSER NOLOGIN PASSWORD NULL`, retaining system/bootstrap ownership. No
membership connects the application to it. The temporary passwordless NOLOGIN
bridge is dropped before commit; no extra admin/migration credential remains.
The application username, database name and existing password are preserved.
The privileged transition explicitly verifies bootstrap `PASSWORD NULL` before
commit. On subsequent ordinary-login no-ops PostgreSQL hides `pg_authid`, so
verification covers NOLOGIN, catalog attributes, memberships and ownership;
it cannot independently reread the bootstrap verifier. This accepted boundary
does not add a persistent privileged verifier function or credential.

### Existing bundled volume: explicit offline transition

Installations created before F12-03 need an explicit maintenance operation. Do
not run the helper against an external/shared/custom cluster. Use your existing
Compose project name and **the same volumes and credentials** throughout:

1. Stop all writers: `docker compose stop app`, plus any independently launched
   web, worker, migrator or other client writing this database. Keep them stopped
   until every subsequent step succeeds.
2. Take and verify a consistent database/attachment backup, preserving the auth
   secret and every required credential-encryption key. Store backups and keys
   confidentially. Verify against disposable recovery storage using your
   established procedure before changing authority. F12-05 still owns the
   complete recovery procedure and the known restore/search-path issue; this
   transition does not certify unmodified `pg_restore`.
3. Install this version's Compose file and both `scripts/postgres` helpers, then
   run `docker compose up -d --no-deps --force-recreate postgres`. Recreating the
   container retains `postgres_data`; **never use `down -v` or delete the volume**.
   Wait for PostgreSQL to become healthy. Existing PG_VERSION skips initdb
   scripts; changing `POSTGRES_*` variables never upgrades an existing cluster.
4. Run the supported maintenance invocation (the flag confirms steps 1–2):

   ```sh
   docker compose exec -T postgres sh /usr/local/bin/maildock-authority-maintenance --writers-stopped-backup-verified
   ```

   It runs `psql -X -v ON_ERROR_STOP=1` on the local socket, closes that session,
   then opens a **new password-authenticated TCP connection** as `maildock` with
   the existing `POSTGRES_PASSWORD` and verifies the hardened model again. A
   deliberately incorrect password must fail too. The helper uses the private
   `postgres` service address, because initdb's loopback HBA rules may use trust;
   custom passwordless authentication is refused.
   A password mismatch fails this second step without undoing the committed
   hardening. Correct operator configuration, retry verification and keep the
   application stopped until successful.

5. Only after successful verification, run `docker compose up -d --no-deps
--build app`. Normal startup validates authority, runs ordinary migrations,
   then starts web/worker. Direct migration/web/worker process roots also check
   authority before becoming operational.

The helper acquires a dedicated transaction advisory lock and accepts only the
reviewed fresh/legacy bootstrap state or a verified hardened no-op. It refuses
remaining legacy client sessions, collisions, custom roles/schemas/objects,
ownership, grants/default privileges and role settings rather than repairing
them. Known public application objects and optional Drizzle/pg-boss namespaces
transfer explicitly, including sequences/functions/enum and queue partitions;
system objects, `plpgsql`, templates and `postgres` remain with OID 10. User rows
and definitions are not rebuilt. Failures before commit roll back role and
ownership changes together, removing the bridge. A later application migration
failure cannot restore excessive privileges.

Refusal uses a fixed diagnostic: stop writers, verify backup and obtain DBA
review. Never automatically elevate or repair on guard failure. An interrupted
fresh init may leave PG_VERSION and skip scripts on restart; the application
guard rejects the unsafe role. Classify the state and use the explicit supported
operation while offline; do not delete storage. Administrative recovery for the
locked bootstrap requires operator-controlled offline PostgreSQL maintenance,
not a retained application credential. Server audit/query logging and DBA
surfaces must protect password verifiers during provisioning.

### External PostgreSQL

Provide one `DATABASE_URL` for an ordinary **non-bootstrap** login with all five
forbidden flags disabled and no privileged role membership/SET ROLE path.
Ownership is the simplest supported contract. Equivalent scoped authority must
include database CONNECT/CREATE, public USAGE/CREATE, SQL/plpgsql USAGE, ownership
(or inherited ordinary owner authority) over existing application objects and
the optional Drizzle/pg-boss schemas. This permits normal migrations, pg-boss
installation/upgrades and queue partition DDL. Provider-only objects in these
application namespaces may require DBA review. Keep transport private and use
TLS according to the provider/operator environment.

The guard reads actual `pg_roles` identity/attributes and recursive membership,
not the potentially stale `is_superuser` setting. It rejects privileged predefined
roles conservatively, insufficient schema/DDL authority and incompatible object
ownership. It never alters roles, guesses bundled status from a hostname/name or
requests an admin URL/password. It runs once at each process root; request/job
loops do not repeat catalog validation. Connection failures and unsafe authority
produce fixed categories without URL, password, raw SQL error or catalog dump.
No automatic external provisioning or transition occurs.

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
