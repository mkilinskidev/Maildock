import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { request, createServer as httpServer } from "node:http";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import type { ImapFlow } from "imapflow";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { mailAccounts } from "@/shared/infrastructure/database/schema";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { createOAuthComposition } from "@/modules/accounts/infrastructure/oauth-composition";
import { receivingCredentialBindings } from "@/modules/accounts/infrastructure/receiving-credentials";
import { accountCredentialContext } from "@/modules/accounts/domain/account";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import {
  DiagnosticCodec,
  ReceivingDiagnosticClient,
  ReceivingDiagnosticServer,
} from "@/modules/mail/infrastructure/receiving-diagnostic-rpc";
import { metadataPeer } from "./fixtures/imap-metadata-peer";
import { setTimeout as delay } from "node:timers/promises";

const routing = vi.hoisted(() => ({
  service: undefined as AccountsService | undefined,
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: async () => null,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  accountsService: {
    testExisting: (...args: Parameters<AccountsService["testExisting"]>) =>
      routing.service!.testExisting(...args),
    testUnsaved: (...args: Parameters<AccountsService["testUnsaved"]>) =>
      routing.service!.testUnsaved(...args),
  },
}));
import { POST as savedTestRoute } from "@/app/api/accounts/[id]/test/route";
import { POST as unsavedTestRoute } from "@/app/api/accounts/test/route";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > end) throw new Error("R09 barrier timed out");
    await delay(5);
  }
}
async function freeEndpoint() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
const submitted = () => ({
  id: randomUUID(),
  displayName: "R09",
  email: "fixture@example.test",
  enabled: true,
  providerType: "imap_smtp" as const,
  imap: {
    host: "fixture.invalid",
    port: 993,
    security: "tls" as const,
    username: "fixture",
    password: "private-password-r09",
  },
  smtp: {
    host: "fixture.invalid",
    port: 465,
    security: "tls" as const,
    useImapCredentials: true,
  },
});

describe("R09 real elected HTTP routing, credential CAS and independent SQL observers", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let url: string;
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 71).toString("base64"),
  });
  const cleanup: (() => Promise<unknown>)[] = [];
  beforeAll(async () => {
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
        POSTGRES_DB: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const root = postgres(
      `postgres://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/fixture`,
    );
    await root`create role lane login password 'fixture'`;
    await root`create database r09 owner lane`;
    await root.end();
    url = `postgres://lane:fixture@${container.getHost()}:${container.getMappedPort(5432)}/r09`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 1 });
    reader = postgres(url, { max: 4 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });

  async function fixture(
    options: {
      gate?: ReturnType<typeof barrier>;
      real?: Awaited<ReturnType<typeof metadataPeer>>;
      follower?: boolean;
      workers?: number;
      connectFailure?: Error;
    } = {},
  ) {
    const endpoint = await freeEndpoint();
    const config = {
      endpoint,
      encryption,
      authSecret: "internal-test-only-auth-secret-r09",
    };
    const oauth = createOAuthComposition(database.db, encryption, {
      appOrigin: "https://fixture.test",
      microsoft: { clientId: "", clientSecret: "" },
    });
    const smtpConnections: unknown[] = [];
    const provider = new ImapSmtpMailProvider({
      createImap: () => {
        throw new Error("Web IMAP must never be constructed");
      },
      createSmtp: () => ({
        verify: async () => {
          smtpConnections.push(true);
        },
        close() {},
      }),
    });
    const client = new ReceivingDiagnosticClient(database.db, config);
    const accounts = new AccountsService(
      database.db,
      encryption,
      provider,
      undefined,
      oauth.registry,
      undefined,
      client,
      provider,
    );
    const executor = new ReceivingExecutor(url, 2);
    cleanup.push(() => executor.stop());
    let constructed = 0,
      live = 0,
      peak = 0;
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      ...receivingCredentialBindings(accounts),
      tuning: { workers: options.workers ?? 2 },
      diagnosticEndpoint: endpoint,
      createOperationClient: (opts) => {
        constructed++;
        live++;
        peak = Math.max(peak, live);
        if (options.real) return options.real.createClient(opts);
        let retired = false;
        return Object.assign(new EventEmitter(), {
          connect: async () => {
            await options.gate?.promise;
            if (options.connectFailure) throw options.connectFailure;
          },
          retireReceiving: async () => {
            if (!retired) {
              retired = true;
              live--;
            }
          },
        }) as unknown as ImapFlow;
      },
    });
    cleanup.push(() => coordinator.stop());
    const server = new ReceivingDiagnosticServer(config, () => coordinator);
    await server.start();
    cleanup.push(() => server.stop());
    if (!options.follower) expect(await coordinator.elect()).toBe(true);
    return {
      accounts,
      provider,
      client,
      coordinator,
      server,
      executor,
      config,
      oauth,
      smtpConnections,
      counts: () => ({ constructed, live, peak }),
    };
  }
  async function saved(f: Awaited<ReturnType<typeof fixture>>) {
    return f.accounts.create(submitted()); // after election; no metadata membership activation
  }
  async function identity(id: string) {
    const [row] =
      await reader`select configuration_version,receiving_lifecycle_version from mail_accounts where id=${id}`;
    return {
      account: id,
      configurationVersion: BigInt(row.configuration_version),
      receivingLifecycleVersion: BigInt(row.receiving_lifecycle_version),
    };
  }
  async function google(f: Awaited<ReturnType<typeof fixture>>) {
    await f.oauth.configurations.save("google", {
      clientId: "fixture",
      clientSecret: "private-client",
      enabled: true,
    });
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "OAuth",
      email: "fixture@example.test",
      authMethod: "oauth2",
      oauthProviderId: "google",
      oauthStatus: "connected",
      oauthCache: encryption.encrypt(
        JSON.stringify({
          version: 1,
          subject: "fixture",
          refreshToken: "private-refresh",
        }),
        accountCredentialContext(id, "oauth-cache"),
      ),
      imapUsername: "fixture",
      ...f.oauth.registry.get("google").getMailDefaults(),
    });
    return id;
  }
  const token = () =>
    Response.json({
      access_token: "private-access",
      refresh_token: "private-rotation",
      expires_in: 3600,
      token_type: "Bearer",
    });

  it("saved diagnostic authenticates through the owned TLS IMAP adapter without creating epoch/coverage", async () => {
    const peer = await metadataPeer({ greeting: "OK" });
    cleanup.push(() => peer.cleanup());
    const f = await fixture({ real: peer });
    const input = submitted();
    input.imap = {
      ...input.imap,
      ...peer.connection,
      password: "private-password-r09",
    };
    const account = await f.accounts.create(input);
    const report = await f.accounts.testExisting(account.id);
    expect(report).toEqual({
      imap: { success: true },
      smtp: { success: true },
    });
    const [row] =
      await reader`select imap_status,connection_status from mail_accounts where id=${account.id}`;
    expect(row).toMatchObject({
      imap_status: "success",
      connection_status: "verified",
    });
    expect(await reader`select * from receiving_mailboxes`).toHaveLength(0);
    expect(f.counts().constructed).toBe(1);
  });

  it("edited-saved and unsaved diagnostics share W/C while never verifying saved settings or storing ephemeral secrets", async () => {
    const gate = barrier();
    const f = await fixture({ gate, workers: 2 });
    cleanup.push(async () => gate.release());
    const account = await saved(f);
    const input = submitted();
    const edit = { ...input };
    const first = f.accounts.testExisting(account.id, edit);
    await until(() => f.counts().constructed === 1);
    const second = f.accounts.testExisting(account.id, edit);
    const unsaved = f.accounts.testUnsaved(submitted());
    await until(() => f.counts().constructed === 2);
    expect(f.coordinator.snapshot.scheduler?.active).toBe(2);
    expect(f.counts().peak).toBe(2);
    gate.release();
    expect((await first).imap.success).toBe(true);
    expect((await second).imap.success).toBe(true);
    expect((await unsaved).imap.success).toBe(true);
    const [row] =
      await reader`select imap_status,connection_status from mail_accounts where id=${account.id}`;
    expect(row).toMatchObject({
      imap_status: "untested",
      connection_status: "unverified",
    });
    expect(
      await reader`select id from mail_accounts where enabled`,
    ).toHaveLength(1);
    const dump = JSON.stringify(
      await reader`select row_to_json(a) from mail_accounts a`,
    );
    expect(dump).not.toMatch(
      /private-password-r09|private-access|private-refresh/,
    );
  });

  it.each(["disabled", "removing", "lifecycle-aba", "configuration"])(
    "rejects %s before constructing saved IMAP",
    async (change) => {
      const f = await fixture();
      const account = await saved(f);
      const captured = await identity(account.id);
      if (change === "disabled")
        await reader`update mail_accounts set enabled=false where id=${account.id}`;
      if (change === "removing") {
        await reader`insert into mailboxes (id,account_id,remote_path,name,selectable,first_discovered_at,last_discovered_at)
        select gen_random_uuid(),${account.id}::uuid,'folder-'||n,'folder-'||n,true,clock_timestamp(),clock_timestamp()
        from generate_series(1,129) n`;
        expect(await f.accounts.delete(account.id)).toEqual({
          status: "removing",
        });
      }
      if (change === "lifecycle-aba") {
        await f.accounts.setEnabled(account.id, false);
        await f.accounts.setEnabled(account.id, true);
      }
      if (change === "configuration")
        await reader`update mail_accounts set imap_host='changed.invalid' where id=${account.id}`;
      const result = await f.client.test({ identity: captured });
      expect(result).toMatchObject({ success: false, retryable: true });
      expect(f.counts().constructed).toBe(0);
    },
  );

  it("Google refresh releases all receiving SQL and app pool slots, coalesces and preserves configuration", async () => {
    const gate = barrier(),
      started = barrier();
    const f = await fixture();
    const id = await google(f);
    const captured = await identity(id);
    cleanup.push(async () => gate.release());
    const fetcher = vi.fn(async () => {
      started.release();
      await gate.promise;
      return token();
    });
    vi.stubGlobal("fetch", fetcher);
    const diagnostic = f.client.test({ identity: captured });
    await started.promise;
    expect(f.executor.snapshot.executing).toBe(0);
    expect(
      await reader`select pid from pg_stat_activity where datname='r09' and state='idle in transaction'`,
    ).toHaveLength(0);
    expect((await f.accounts.list()).some((a) => a.id === id)).toBe(true); // pool=1 remains usable
    const duplicate = f.oauth.registry.get("google").accessToken(id);
    gate.release();
    expect(await duplicate).toBe("private-access");
    expect((await diagnostic).success).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await identity(id)).toEqual(captured);
  });

  it.each(["reconnect", "disable", "remove", "cancel", "takeover"])(
    "stalled OAuth %s cannot create a late IMAP socket or overwrite a grant",
    async (change) => {
      const gate = barrier(),
        started = barrier();
      const f = await fixture();
      const id = await google(f);
      const captured = await identity(id);
      cleanup.push(async () => gate.release());
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          started.release();
          await gate.promise;
          return token();
        }),
      );
      const cancellation = new AbortController();
      const diagnostic = f.client.test({
        identity: captured,
        signal: cancellation.signal,
      });
      await started.promise;
      if (change === "reconnect")
        await reader`update mail_accounts set configuration_version=configuration_version+1,
      oauth_refresh_attempt=null,oauth_cache=${reader.json(encryption.encrypt("new-grant", accountCredentialContext(id, "oauth-cache")))} where id=${id}`;
      if (change === "disable") await f.accounts.setEnabled(id, false);
      if (change === "remove")
        expect(await f.accounts.delete(id)).toEqual({ status: "removed" });
      if (change === "cancel") {
        cancellation.abort();
        await expect(diagnostic).resolves.toMatchObject({ success: false });
      }
      if (change === "takeover") {
        await reader`update receiving_coordinator set expires_at='-infinity'`;
        await reader`select maildock_receiving_acquire(${randomUUID()}::uuid,30000)`;
      }
      gate.release();
      expect((await diagnostic).success).toBe(false);
      await until(() => f.coordinator.snapshot.scheduler?.active === 0);
      expect(f.counts().constructed).toBe(0);
      if (change === "reconnect") {
        const [row] =
          await reader`select oauth_cache from mail_accounts where id=${id}`;
        expect(
          encryption.decrypt(
            row.oauth_cache,
            accountCredentialContext(id, "oauth-cache"),
          ),
        ).toBe("new-grant");
      }
    },
  );

  it.each(["complete", "cancel", "reconnect", "takeover", "rejected"])(
    "Microsoft real MSAL refresh %s stays outside SQL and fences obsolete grants",
    async (action) => {
      const f = await fixture();
      await f.oauth.configurations.save("microsoft", {
        clientId: "fixture-msal",
        clientSecret: "private-client",
        enabled: true,
      });
      const tenant = "11111111-1111-4111-8111-111111111111";
      const principal = "22222222-2222-4222-8222-222222222222";
      const jwt = (claims: object) =>
        [
          Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
          Buffer.from(JSON.stringify(claims)).toString("base64url"),
          "fixture",
        ].join(".");
      const response = () =>
        Response.json({
          token_type: "Bearer",
          expires_in: 3600,
          ext_expires_in: 3600,
          scope:
            "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send openid profile email",
          access_token: "private-ms-access",
          refresh_token: "private-ms-refresh",
          client_info: Buffer.from(
            JSON.stringify({ uid: principal, utid: tenant }),
          ).toString("base64url"),
          id_token: jwt({
            aud: "fixture-msal",
            iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
            tid: tenant,
            oid: principal,
            sub: principal,
            preferred_username: "ms@example.test",
            name: "Fixture",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      const refreshGate = barrier();
      let refreshing = false;
      const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.includes("/token")) {
          if (String(options?.body).includes("grant_type=refresh_token")) {
            refreshing = true;
            await refreshGate.promise;
            if (action === "rejected")
              return Response.json(
                {
                  error: "invalid_client",
                  error_description: "private-client",
                },
                { status: 400 },
              );
          }
          return response();
        }
        if (url.includes("discovery/instance"))
          return Response.json({
            tenant_discovery_endpoint:
              "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
            metadata: [
              {
                preferred_network: "login.microsoftonline.com",
                preferred_cache: "login.windows.net",
                aliases: ["login.microsoftonline.com", "login.windows.net"],
              },
            ],
          });
        return Response.json({
          authorization_endpoint:
            "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
          token_endpoint:
            "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
          issuer: "https://login.microsoftonline.com/{tenant}/v2.0",
          jwks_uri:
            "https://login.microsoftonline.com/common/discovery/v2.0/keys",
          end_session_endpoint:
            "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout",
        });
      });
      vi.stubGlobal("fetch", fetcher);
      const provider = f.oauth.microsoft;
      const state = new URL(
        await provider.begin("r09-session"),
      ).searchParams.get("state")!;
      const id = await provider.complete(
        "r09-session",
        state,
        "private-ms-code",
      );
      const captured = await identity(id);
      // Expire only the fixture MSAL access-token entries, retaining the real grant/cache format.
      const [stored] =
        await reader`select oauth_cache from mail_accounts where id=${id}`;
      const cache = JSON.parse(
        encryption.decrypt(
          stored.oauth_cache,
          accountCredentialContext(id, "oauth-cache"),
        ),
      );
      for (const entry of Object.values(cache.AccessToken) as {
        expires_on: string;
        extended_expires_on: string;
      }[]) {
        entry.expires_on = "1";
        entry.extended_expires_on = "1";
      }
      await database.db
        .update(mailAccounts)
        .set({
          oauthCache: encryption.encrypt(
            JSON.stringify(cache),
            accountCredentialContext(id, "oauth-cache"),
          ),
        })
        .where(eq(mailAccounts.id, id));
      cleanup.push(async () => refreshGate.release());
      const cancellation = new AbortController();
      const diagnostic = f.client.test({
        identity: captured,
        signal: cancellation.signal,
      });
      await until(() => refreshing);
      expect(f.executor.snapshot.executing).toBe(0);
      expect(
        await reader`select pid from pg_stat_activity where datname='r09' and state='idle in transaction'`,
      ).toHaveLength(0);
      expect((await f.accounts.list()).some((a) => a.id === id)).toBe(true);
      let replaced: unknown;
      if (action === "cancel") cancellation.abort();
      if (action === "reconnect") {
        const newState = new URL(
          await provider.begin("r09-session", id),
        ).searchParams.get("state")!;
        await provider.complete("r09-session", newState, "private-new-code");
        replaced = (
          await reader`select oauth_cache from mail_accounts where id=${id}`
        )[0].oauth_cache;
      }
      if (action === "takeover") {
        await reader`update receiving_coordinator set expires_at='-infinity'`;
        await reader`select maildock_receiving_acquire(${randomUUID()}::uuid,30000)`;
      }
      refreshGate.release();
      expect((await diagnostic).success).toBe(action === "complete");
      await until(() => f.coordinator.snapshot.scheduler?.active === 0);
      if (action === "reconnect")
        expect((await identity(id)).configurationVersion).toBe(
          captured.configurationVersion + 1n,
        );
      else expect(await identity(id)).toEqual(captured);
      const [updated] =
        await reader`select oauth_cache,oauth_refresh_attempt from mail_accounts where id=${id}`;
      if (
        action === "complete" ||
        action === "reconnect" ||
        action === "rejected"
      )
        expect(updated.oauth_refresh_attempt).toBeNull();
      if (action !== "complete") expect(f.counts().constructed).toBe(0);
      if (action === "reconnect") expect(updated.oauth_cache).toEqual(replaced);
      expect(JSON.stringify(updated.oauth_cache)).not.toMatch(/private-ms/);
      expect(
        fetcher.mock.calls.filter(
          ([url, options]) =>
            url.includes("/token") &&
            String(options?.body).includes("grant_type=refresh_token"),
        ),
      ).toHaveLength(1);
    },
  );

  it("two provider instances cannot refresh a grant concurrently; uncertain results cannot be replayed", async () => {
    const gate = barrier(),
      started = barrier();
    const f = await fixture();
    const id = await google(f);
    cleanup.push(async () => gate.release());
    const fetcher = vi.fn(async () => {
      started.release();
      await gate.promise;
      throw new Error("private-refresh private-access");
    });
    vi.stubGlobal("fetch", fetcher);
    const first = f.oauth.registry
      .get("google")
      .accessToken(id)
      .catch((e: Error) => e);
    await started.promise;
    const other = createOAuthComposition(database.db, encryption, {
      appOrigin: "https://fixture.test",
      microsoft: { clientId: "", clientSecret: "" },
    });
    await expect(other.registry.get("google").accessToken(id)).rejects.toThrow(
      "uncertain",
    );
    gate.release();
    expect(String(await first)).not.toMatch(/private-refresh|private-access/);
    await expect(
      other.registry.get("google").accessToken(id),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("unauthorized, oversized and invalid HTTP envelopes are rejected before IMAP", async () => {
    const f = await fixture();
    const raw = async (body: string, authentication?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          new URL("/diagnose", f.config.endpoint),
          {
            method: "POST",
            headers: {
              "content-length": Buffer.byteLength(body),
              ...(authentication ? { "x-maildock-auth": authentication } : {}),
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.once("error", reject);
        req.end(body);
      });
    expect(await raw("{}", "0".repeat(64))).toBe(401);
    expect(await raw("{}")).toBe(401);
    expect(await raw("x".repeat(30 * 1024), "0".repeat(64))).toBe(413);
    const encoded = new DiagnosticCodec(f.config).encode(
      { unexpected: "private-password" },
      "request",
    );
    expect(await raw(encoded.body, encoded.authentication)).toBe(400);
    expect(f.counts().constructed).toBe(0);
  });

  it("followers refuse authenticated execution and SMTP remains independent with app pool size one", async () => {
    const f = await fixture({ follower: true });
    const account = await saved(f);
    // A stale route pointing at this follower cannot confer authority.
    const actor = randomUUID();
    const [row] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,30000) as term`;
    await reader`select maildock_receiving_diagnostic_endpoint(${actor}::uuid,${row.term}::bigint,${f.config.endpoint})`;
    expect(await f.accounts.testExisting(account.id)).toMatchObject({
      imap: { success: false, retryable: true },
      smtp: { success: true },
    });
    expect(f.smtpConnections).toHaveLength(1);
    expect(f.counts().constructed).toBe(0);
  });

  it("takeover clears old advertisement and stale terms cannot change the new route", async () => {
    const f = await fixture();
    const old = f.coordinator.snapshot.owner!;
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [row] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,30000) as term`;
    const [cleared] =
      await reader`select diagnostic_endpoint from receiving_coordinator`;
    expect(cleared.diagnostic_endpoint).toBeNull();
    await reader`select maildock_receiving_diagnostic_endpoint(${actor}::uuid,${row.term}::bigint,${f.config.endpoint})`;
    const [stale] =
      await reader`select maildock_receiving_diagnostic_endpoint(${old.actor}::uuid,${String(old.generation)}::bigint,null) as live`;
    expect(stale.live).toBe(false);
    expect(
      (await reader`select diagnostic_endpoint from receiving_coordinator`)[0]
        .diagnostic_endpoint,
    ).toBe(f.config.endpoint);
  });

  it("disconnect retains C/W until an unabortable handler settles and does not replay", async () => {
    const gate = barrier();
    const f = await fixture({ gate, workers: 1 });
    cleanup.push(async () => gate.release());
    const cancellation = new AbortController();
    const account = await saved(f);
    const result = f.client.test({
      identity: await identity(account.id),
      signal: cancellation.signal,
    });
    await until(() => f.counts().constructed === 1);
    cancellation.abort();
    expect((await result).success).toBe(false);
    expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
    gate.release();
    await until(() => f.coordinator.snapshot.scheduler?.active === 0);
    expect(f.counts().constructed).toBe(1);
    expect(
      (
        await reader`select imap_status from mail_accounts where id=${account.id}`
      )[0].imap_status,
    ).toBe("untested");
  });

  it("a lost HTTP response returns retryable unknown without a second request or socket", async () => {
    const f = await fixture();
    const account = await saved(f);
    let forwarded = 0;
    const proxyEndpoint = await freeEndpoint();
    const proxy = httpServer((incoming, outgoing) => {
      forwarded++;
      const upstream = request(
        new URL("/diagnose", f.config.endpoint),
        { method: "POST", headers: incoming.headers },
        (response) => {
          response.resume();
          response.once("end", () => outgoing.destroy());
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) =>
      proxy.listen(Number(new URL(proxyEndpoint).port), "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          proxy.close(() => resolve());
          proxy.closeAllConnections();
        }),
    );
    await f.coordinator.advertiseDiagnosticEndpoint(proxyEndpoint);
    const client = new ReceivingDiagnosticClient(database.db, {
      ...f.config,
      endpoint: proxyEndpoint,
    });
    expect(
      await client.test({ identity: await identity(account.id) }),
    ).toMatchObject({ success: false, retryable: true });
    expect(forwarded).toBe(1);
    expect(f.counts().constructed).toBe(1);
    expect(
      (
        await reader`select imap_status from mail_accounts where id=${account.id}`
      )[0].imap_status,
    ).toBe("success");
  });

  it("wire expiry cancels stalled OAuth and keeps its allocation through actual settlement", async () => {
    const f = await fixture();
    const id = await google(f);
    const started = barrier(),
      gate = barrier();
    cleanup.push(async () => gate.release());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        started.release();
        await gate.promise;
        return token();
      }),
    );
    const captured = await identity(id);
    const owner = f.coordinator.snapshot.owner!;
    const encoded = new DiagnosticCodec(f.config).encode(
      {
        requestId: randomUUID(),
        expectedOwner: {
          actor: owner.actor,
          generation: String(owner.generation),
        },
        identity: {
          account: id,
          configurationVersion: String(captured.configurationVersion),
          receivingLifecycleVersion: String(captured.receivingLifecycleVersion),
        },
        expiresAt: Date.now() + 500,
        budgetMs: 500,
      },
      "request",
    );
    const closed = new Promise<void>((resolve, reject) => {
      const req = request(
        new URL("/diagnose", f.config.endpoint),
        {
          method: "POST",
          headers: {
            "content-length": Buffer.byteLength(encoded.body),
            "x-maildock-auth": encoded.authentication,
          },
        },
        (res) => {
          res.resume();
          reject(new Error(`Unexpected response ${res.statusCode}`));
        },
      );
      req.once("error", () => resolve());
      req.end(encoded.body);
    });
    await started.promise;
    await closed;
    expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
    expect(f.executor.snapshot.executing).toBe(0);
    gate.release();
    await until(() => f.coordinator.snapshot.scheduler?.active === 0);
    expect(f.counts().constructed).toBe(0);
    const [row] =
      await reader`select imap_status,oauth_refresh_attempt from mail_accounts where id=${id}`;
    expect(row.imap_status).toBe("untested");
    expect(row.oauth_refresh_attempt).not.toBeNull();
  });

  it("rejects authenticated replay after settlement and sanitizes raw IMAP exceptions", async () => {
    const failures: { connectFailure?: Error } = {};
    const f = await fixture(failures);
    const owner = f.coordinator.snapshot.owner!;
    const input = submitted();
    const encoded = new DiagnosticCodec(f.config).encode(
      {
        requestId: randomUUID(),
        expectedOwner: {
          actor: owner.actor,
          generation: String(owner.generation),
        },
        identity: { ephemeral: randomUUID() },
        expiresAt: Date.now() + 9000,
        budgetMs: 9000,
        connection: {
          ...input.imap,
          password: undefined,
          credential: { kind: "password", password: input.imap.password },
        },
      },
      "request",
    );
    const send = () =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          new URL("/diagnose", f.config.endpoint),
          {
            method: "POST",
            headers: {
              "content-length": Buffer.byteLength(encoded.body),
              "x-maildock-auth": encoded.authentication,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.once("error", reject);
        req.end(encoded.body);
      });
    expect(await send()).toBe(200);
    expect(await send()).toBe(409);
    expect(f.counts().constructed).toBe(1);
    failures.connectFailure = new Error(
      "authentication password=private-password-r09 token=private-access",
    );
    const report = await f.accounts.testUnsaved(submitted());
    expect(report.imap).toMatchObject({
      success: false,
      category: "authentication_rejected",
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-password-r09|private-access|ciphertext|authTag/,
    );
  });

  it("multiple saved accounts stay within receiving W and preserve independent C slots", async () => {
    const gate = barrier();
    const f = await fixture({ gate, workers: 2 });
    cleanup.push(async () => gate.release());
    const accounts = await Promise.all(
      Array.from({ length: 5 }, () => saved(f)),
    );
    const tasks = accounts.map((account) =>
      f.accounts.testExisting(account.id),
    );
    await until(() => f.counts().constructed === 2);
    expect(f.counts().peak).toBe(2);
    expect(f.coordinator.snapshot.scheduler?.active).toBe(2);
    gate.release();
    expect(
      (await Promise.all(tasks)).every((r) => r.imap.success && r.smtp.success),
    ).toBe(true);
    expect(f.counts().peak).toBe(2);
  });

  it("public saved OAuth test routes through HTTP while separate web/worker refreshers preserve SMTP with pool one", async () => {
    const f = await fixture();
    const id = await google(f);
    const other = createOAuthComposition(database.db, encryption, {
      appOrigin: "https://fixture.test",
      microsoft: { clientId: "", clientSecret: "" },
    });
    routing.service = new AccountsService(
      database.db,
      encryption,
      f.provider,
      undefined,
      other.registry,
      undefined,
      f.client,
      f.provider,
    );
    const fetcher = vi.fn(async () => token());
    vi.stubGlobal("fetch", fetcher);
    const response = await savedTestRoute(
      new Request(`https://fixture.test/api/accounts/${id}/test`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { imap: { success: true }, smtp: { success: true } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.counts().constructed).toBe(1);
  });

  it("public unsaved route forwards caller cancellation to the owned HTTP admission", async () => {
    const gate = barrier();
    const f = await fixture({ gate });
    cleanup.push(async () => gate.release());
    routing.service = f.accounts;
    const cancellation = new AbortController();
    const response = unsavedTestRoute(
      new Request("https://fixture.test/api/accounts/test", {
        method: "POST",
        signal: cancellation.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted()),
      }),
    );
    await until(() => f.counts().constructed === 1);
    cancellation.abort();
    expect((await response).status).toBe(200);
    expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
    gate.release();
    await until(() => f.coordinator.snapshot.scheduler?.active === 0);
    expect(f.counts().constructed).toBe(1);
  });

  it("actual cancellable OAuth HTTP transport closes on caller disconnect without late admission", async () => {
    const f = await fixture();
    const id = await google(f);
    const realFetch = globalThis.fetch;
    const endpoint = await freeEndpoint();
    let started = false,
      disconnected = false;
    const upstream = httpServer((req, res) => {
      req.resume();
      started = true;
      res.once("close", () => {
        disconnected = true;
      });
      // Intentionally no token response: only a real AbortSignal can close this.
    });
    await new Promise<void>((resolve) =>
      upstream.listen(Number(new URL(endpoint).port), "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          upstream.close(() => resolve());
          upstream.closeAllConnections();
        }),
    );
    vi.stubGlobal("fetch", (_url: string, options?: RequestInit) =>
      realFetch(`${endpoint}/token`, options),
    );
    const cancellation = new AbortController();
    const result = f.client.test({
      identity: await identity(id),
      signal: cancellation.signal,
    });
    await until(() => started);
    cancellation.abort();
    expect((await result).success).toBe(false);
    await until(
      () => disconnected && f.coordinator.snapshot.scheduler?.active === 0,
    );
    expect(f.counts().constructed).toBe(0);
    const [row] =
      await reader`select oauth_status,oauth_refresh_attempt from mail_accounts where id=${id}`;
    expect(row.oauth_status).toBe("reconnect_required");
    expect(row.oauth_refresh_attempt).not.toBeNull();
  });

  it.each(["configuration", "lifecycle", "takeover"])(
    "saved diagnostic completion after %s cannot verify the old configuration",
    async (change) => {
      const gate = barrier();
      const f = await fixture({ gate });
      cleanup.push(async () => gate.release());
      const account = await saved(f);
      const diagnostic = f.client.test({
        identity: await identity(account.id),
      });
      await until(() => f.counts().constructed === 1);
      if (change === "configuration")
        await reader`update mail_accounts set imap_host='new.invalid' where id=${account.id}`;
      if (change === "lifecycle") {
        await f.accounts.setEnabled(account.id, false);
        await f.accounts.setEnabled(account.id, true);
      }
      if (change === "takeover") {
        await reader`update receiving_coordinator set expires_at='-infinity'`;
        await reader`select maildock_receiving_acquire(${randomUUID()}::uuid,30000)`;
      }
      gate.release();
      expect((await diagnostic).success).toBe(false);
      const [row] =
        await reader`select imap_status,connection_status,receiving_due_at from mail_accounts where id=${account.id}`;
      expect(row.imap_status).toBe("untested");
      expect(row.connection_status).toBe("unverified");
      expect(row.receiving_due_at).not.toBeNull();
    },
  );

  it("acquired metadata candidates revalidate lifecycle after OAuth refresh before constructing IMAP", async () => {
    const f = await fixture();
    await f.coordinator.stop();
    const id = await google(f);
    const started = barrier(),
      gate = barrier();
    cleanup.push(async () => gate.release());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        started.release();
        await gate.promise;
        return token();
      }),
    );
    let constructed = 0,
      errors = 0;
    const bindings = receivingCredentialBindings(f.accounts);
    const coordinator = new ElectedReceivingCoordinator({
      executor: f.executor,
      ...bindings,
      loadAccount: async (db, candidate) => ({
        ...(await bindings.loadAccount(db, candidate)),
        createClient: () => {
          constructed++;
          throw new Error(
            "Obsolete metadata candidate must never construct IMAP",
          );
        },
        onError: () => {
          errors++;
        },
      }),
    });
    cleanup.push(() => coordinator.stop());
    expect(await coordinator.elect()).toBe(true);
    await started.promise;
    expect(f.executor.snapshot.executing).toBe(0);
    await f.accounts.setEnabled(id, false);
    await f.accounts.setEnabled(id, true);
    gate.release();
    await until(() => errors > 0);
    expect(constructed).toBe(0);
  });

  it("credential SQL lock wait is bounded without entering OAuth or changing the grant", async () => {
    const f = await fixture();
    const id = await google(f);
    const locked = barrier(),
      gate = barrier();
    cleanup.push(async () => gate.release());
    const holding = reader.begin(async (tx) => {
      await tx`select id from mail_accounts where id=${id} for update`;
      locked.release();
      await gate.promise;
    });
    await locked.promise;
    const fetcher = vi.fn(async () => token());
    vi.stubGlobal("fetch", fetcher);
    await expect(
      f.oauth.registry.get("google").accessToken(id),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    gate.release();
    await holding;
    const [row] =
      await reader`select oauth_refresh_attempt,oauth_status from mail_accounts where id=${id}`;
    expect(row.oauth_refresh_attempt).toBeNull();
    expect(row.oauth_status).toBe("connected");
  });

  it.each(["lease", "configuration", "lifecycle"])(
    "diagnostic COMMIT refuses changed %s even within its publishing transaction",
    async (change) => {
      const f = await fixture();
      const account = await saved(f);
      const captured = await identity(account.id);
      const owner = f.coordinator.snapshot.owner!;
      await expect(
        reader.begin(async (tx) => {
          await tx`select maildock_receiving_diagnostic_result(${owner.actor}::uuid,${String(owner.generation)}::bigint,
        ${account.id}::uuid,${String(captured.configurationVersion)}::bigint,${String(captured.receivingLifecycleVersion)}::bigint,true,null)`;
          if (change === "lease")
            await tx`update receiving_coordinator set expires_at='-infinity'`;
          if (change === "configuration")
            await tx`update mail_accounts set imap_host='superseded.invalid' where id=${account.id}`;
          if (change === "lifecycle") {
            await tx`update mail_accounts set enabled=false where id=${account.id}`;
            await tx`update mail_accounts set enabled=true where id=${account.id}`;
          }
        }),
      ).rejects.toThrow("Diagnostic COMMIT");
      const [row] =
        await reader`select imap_status from mail_accounts where id=${account.id}`;
      expect(row.imap_status).toBe("untested");
      expect(await identity(account.id)).toEqual(captured);
    },
  );
});
