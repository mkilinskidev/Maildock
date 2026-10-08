import { initializeOwnerFixture } from "./mfa-fixture";
import { setReadyFixture } from "./mfa-fixture";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { hashPassword } from "@/modules/auth/infrastructure/password";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { getValidSession } from "@/modules/auth/application/session-validation";
import { isSessionWithinLifetime } from "@/modules/auth/domain/session-policy";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  account,
  instanceState,
  user,
  session,
  rateLimit,
  authAdmission,
  loginThrottle,
} from "@/shared/infrastructure/database/schema";

// Only substitute composition singletons and Next's request context. Identity,
// credentials, cookies, Better Auth, guards and PostgreSQL are real.
const runtime = vi.hoisted(() => ({
  db: undefined as unknown,
  config: undefined as unknown,
  auth: undefined as unknown,
  headers: new Headers(),
  oauth: vi.fn(),
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  get db() {
    return runtime.db;
  },
}));
vi.mock("@/shared/infrastructure/config/config", async (original) => ({
  ...(await original<typeof import("@/shared/infrastructure/config/config")>()),
  getConfig: () => runtime.config,
}));
vi.mock("@/modules/auth/infrastructure/auth", () => ({
  get auth() {
    return runtime.auth;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => runtime.headers }));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  oauthProviders: { get: runtime.oauth },
  get microsoftOAuth() {
    return runtime.oauth("microsoft");
  },
  accountsService: { requestMailboxDiscovery: vi.fn() },
}));
import { proxy } from "@/proxy";
import {
  GET as settingsRead,
  PUT as settingsWrite,
} from "@/app/api/settings/auto-read/route";
import { GET as setupRead, POST as setup } from "@/app/api/setup/route";
import { GET as googleStart } from "@/app/api/oauth/google/start/route";
import { GET as googleCallback } from "@/app/api/oauth/google/callback/route";
import { GET as microsoftStart } from "@/app/api/oauth/microsoft/start/route";
import { GET as microsoftCallback } from "@/app/api/oauth/microsoft/callback/route";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const credentials = { bootstrapSecret, username: "Owner-01", password };

describe("F10 immutable instance owner with real Better Auth and PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let config: AppConfig;
  let auth: ReturnType<typeof createAuth>;
  let authPost: typeof import("@/app/api/auth/[...all]/route").POST;
  let passwordHash: string;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "f10",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: origin,
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/f10`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: tmpdir(),
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    auth = createAuth(config, database.db);
    runtime.db = database.db;
    runtime.config = config;
    runtime.auth = auth;
    authPost = (await import("@/app/api/auth/[...all]/route")).POST;
    passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await database.db.update(instanceState).set({
      bootstrapSecretDigest: null,
      bootstrapExpiresAt: null,
      initializedAt: null,
      ownerUserId: null,
    });
    await database.db.delete(user);
    await database.db.delete(rateLimit);
    await database.db.delete(authAdmission);
    await database.db.delete(loginThrottle);
    await initializeOwnerFixture(database.db, credentials);
    runtime.oauth.mockReset();
    runtime.headers = new Headers();
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });

  function request(
    path: string,
    cookie = "",
    body?: unknown,
    requestOrigin = origin,
  ) {
    return new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        Origin: requestOrigin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(username = "OWNER-01") {
    const response = await authPost(
      request("/api/auth/sign-in/username", "", {
        username,
        password,
        rememberMe: false,
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  async function secondUser() {
    const id = randomUUID();
    await database.db.insert(user).values({
      id,
      name: "Second",
      username: "second",
      displayUsername: "Second",
      email: "second@example.test",
      emailVerified: true,
    });
    await database.db.insert(account).values({
      id: randomUUID(),
      userId: id,
      accountId: id,
      providerId: "credential",
      password: passwordHash,
    });
    const cookie = await login("SECOND");
    expect(
      (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
        .id,
    ).toBe(id);
    return { id, cookie };
  }
  async function state() {
    return (await database.db.select().from(instanceState))[0];
  }

  async function expectBusinessDenied(cookie: string) {
    runtime.headers = new Headers({ cookie });
    expect(await getValidSession(auth, runtime.headers)).toBeNull();
    const apiRequest = request("/api/settings/auto-read", cookie);
    expect((await settingsRead(apiRequest)).status).toBe(401);
    expect((await proxy(new NextRequest(apiRequest))).status).toBe(401);
    for (const path of [
      "/",
      "/accounts",
      "/settings",
      "/accounts/new",
      "/accounts/example/edit",
    ]) {
      expect(
        (await proxy(new NextRequest(request(path, cookie)))).headers.get(
          "location",
        ),
      ).toBe(`${origin}/login`);
    }
    for (const [path, handler] of [
      ["/api/oauth/google/start", googleStart],
      [
        "/api/oauth/google/callback?state=owner-state&code=valid-code",
        googleCallback,
      ],
      ["/api/oauth/microsoft/start", microsoftStart],
      [
        "/api/oauth/microsoft/callback?state=owner-state&code=valid-code",
        microsoftCallback,
      ],
    ] as const) {
      expect(
        (await handler(request(path, cookie))).headers.get("location"),
      ).toBe(`${origin}/login`);
    }
    expect(runtime.oauth).not.toHaveBeenCalled();
  }

  it("atomically stores the exact created user ID and keeps one canonical singleton", async () => {
    const users = await database.db.select().from(user);
    const accounts = await database.db.select().from(account);
    expect(users).toHaveLength(1);
    expect(accounts).toHaveLength(1);
    expect(await database.db.select().from(instanceState)).toHaveLength(1);
    expect(await state()).toMatchObject({
      id: 1,
      ownerUserId: users[0].id,
      initializedAt: users[0].createdAt,
    });
    expect(accounts[0].userId).toBe(users[0].id);
    await expect(
      database.db.insert(instanceState).values({ id: 2 }),
    ).rejects.toThrow();
  });

  it("rolls back user, credential and binding together when initialization fails", async () => {
    await database.db.update(instanceState).set({
      bootstrapSecretDigest: null,
      bootstrapExpiresAt: null,
      initializedAt: null,
      ownerUserId: null,
    });
    await database.db.delete(user);
    await database.db.delete(rateLimit);
    await database.db.delete(authAdmission);
    // Inject a DB failure at the last provisioning write, after both inserts.
    await database.client`ALTER TABLE instance_state ADD CONSTRAINT f10_test_failure CHECK (initialized_at IS NULL)`;
    try {
      await expect(
        initializeOwnerFixture(database.db, credentials),
      ).rejects.toThrow();
      expect(await database.db.select().from(user)).toHaveLength(0);
      expect(await database.db.select().from(account)).toHaveLength(0);
      expect(await state()).toMatchObject({
        initializedAt: null,
        ownerUserId: null,
      });
    } finally {
      await database.client`ALTER TABLE instance_state DROP CONSTRAINT f10_test_failure`;
    }
  });

  it("allows the owner through real API, proxy and both OAuth start/callback guards", async () => {
    const cookie = await login();
    await setReadyFixture(database.db);
    runtime.headers = new Headers({ cookie });
    expect((await getValidSession(auth, runtime.headers))?.user.id).toBe(
      (await state()).ownerUserId,
    );
    expect(
      (await settingsRead(request("/api/settings/auto-read", cookie))).status,
    ).toBe(200);
    expect(
      (await proxy(new NextRequest(request("/accounts", cookie)))).headers.get(
        "x-middleware-next",
      ),
    ).toBe("1");
    const begin = vi.fn(async () => `${origin}/provider`);
    const complete = vi.fn(async () => "account-id");
    runtime.oauth.mockReturnValue({
      isConfigured: async () => true,
      begin,
      complete,
    });
    for (const handler of [googleStart, microsoftStart])
      expect(
        (await handler(request("/oauth", cookie))).headers.get("location"),
      ).toBe(`${origin}/provider`);
    for (const handler of [googleCallback, microsoftCallback])
      expect(
        (
          await handler(request("/oauth?state=state&code=code", cookie))
        ).headers.get("location"),
      ).toContain("oauth=connected");
    expect(begin).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rejects a legitimate second Better Auth session at API, page/proxy and all four OAuth boundaries", async () => {
    const ownerId = (await state()).ownerUserId;
    const { cookie } = await secondUser();
    await expectBusinessDenied(cookie);
    expect((await state()).ownerUserId).toBe(ownerId);
    // The same database still authorizes its actual owner.
    const ownerCookie = await login();
    await setReadyFixture(database.db);
    expect(
      (await settingsRead(request("/api/settings/auto-read", ownerCookie)))
        .status,
    ).toBe(200);
  });

  it("never replaces the binding via setup even with additional users", async () => {
    const before = await state();
    await secondUser();
    expect(
      (
        await setup(
          request("/api/setup", "", { ...credentials, username: "second" }),
        )
      ).status,
    ).toBe(409);
    await expect(
      initializeOwnerFixture(database.db, {
        ...credentials,
        username: "replacement",
      }),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(await (await setupRead()).json()).toEqual({ initialized: true });
  });

  it("uses the immutable user ID even if owner profile fields change", async () => {
    const cookie = await login();
    await setReadyFixture(database.db);
    const ownerId = (await state()).ownerUserId!;
    await database.db
      .update(user)
      .set({ username: "renamed", email: "changed@example.test" })
      .where(eq(user.id, ownerId));
    expect(
      (await getValidSession(auth, new Headers({ cookie })))?.user.id,
    ).toBe(ownerId);
    expect(
      (await settingsRead(request("/api/settings/auto-read", cookie))).status,
    ).toBe(200);
    expect((await state()).ownerUserId).toBe(ownerId);
  });

  it("does not enter the refresh path for a non-owner session", async () => {
    const { cookie, id } = await secondUser();
    const updatedAt = new Date(Date.now() - 20 * 60 * 1000);
    await database.db
      .update(session)
      .set({
        createdAt: new Date(updatedAt.getTime() - 5 * 60 * 1000),
        updatedAt,
      })
      .where(eq(session.userId, id));
    const before = await database.db
      .select()
      .from(session)
      .where(eq(session.userId, id));
    expect(isSessionWithinLifetime(before[0])).toBe(true);
    expect(await getValidSession(auth, new Headers({ cookie }))).toBeNull();
    expect(
      await database.db.select().from(session).where(eq(session.userId, id)),
    ).toEqual(before);
  });

  it("restricts owner deletion and ID updates without reopening setup or losing sessions", async () => {
    const cookie = await login();
    const ownerId = (await state()).ownerUserId!;
    await expect(
      database.db.delete(user).where(eq(user.id, ownerId)),
    ).rejects.toThrow();
    await expect(
      database.db
        .update(user)
        .set({ id: randomUUID() })
        .where(eq(user.id, ownerId)),
    ).rejects.toThrow();
    expect(await isInstanceInitialized(database.db)).toBe(true);
    expect(
      (await getValidSession(auth, new Headers({ cookie })))?.user.id,
    ).toBe(ownerId);
    const { id } = await secondUser();
    await database.db.delete(user).where(eq(user.id, id));
    expect((await state()).ownerUserId).toBe(ownerId);
  });

  it("enforces state consistency and referential integrity in PostgreSQL", async () => {
    for (const patch of [
      { ownerUserId: null },
      { initializedAt: null },
      { ownerUserId: "" },
      { ownerUserId: " invalid " },
      { ownerUserId: randomUUID() },
    ]) {
      await expect(
        database.db.update(instanceState).set(patch),
      ).rejects.toThrow();
    }
  });

  it.each([
    "missing",
    "dangling",
    "malformed",
    "uninitialized",
    "missing-row",
    "missing-user",
  ])(
    "fails closed if an operator bypasses constraints: %s",
    async (corruption) => {
      const cookie = await login();
      const ownerId = (await state()).ownerUserId!;
      // Deliberately bypass DB integrity only in this disposable test database.
      const [bootstrapConstraint] = await database.client<
        { definition: string }[]
      >`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='instance_state'::regclass and conname='instance_state_bootstrap'`;
      await database.client.begin(async (tx) => {
        await tx`ALTER TABLE instance_state DROP CONSTRAINT instance_state_bootstrap`;
        await tx`ALTER TABLE instance_state DROP CONSTRAINT instance_state_owner_binding`;
        await tx`ALTER TABLE instance_state DROP CONSTRAINT instance_state_owner_user_id_user_id_fk`;
        if (corruption === "missing")
          await tx`UPDATE instance_state SET owner_user_id = NULL`;
        if (corruption === "dangling")
          await tx`UPDATE instance_state SET owner_user_id = ${randomUUID()}`;
        if (corruption === "malformed")
          await tx`UPDATE instance_state SET owner_user_id = ' invalid '`;
        if (corruption === "uninitialized")
          await tx`UPDATE instance_state SET initialized_at = NULL`;
        if (corruption === "missing-row") await tx`DELETE FROM instance_state`;
        if (corruption === "missing-user")
          await tx`DELETE FROM "user" WHERE id = ${ownerId}`;
      });
      try {
        await expectBusinessDenied(cookie);
        expect(await isInstanceInitialized(database.db)).toBe(true);
        expect(
          (await setup(request("/api/setup", "", credentials))).status,
        ).toBe(409);
      } finally {
        await database.db.delete(instanceState);
        await database.db.insert(instanceState).values({ id: 1 });
        await database.client.unsafe(
          `ALTER TABLE instance_state ADD CONSTRAINT instance_state_bootstrap ${bootstrapConstraint.definition}`,
        );
        await database.client`ALTER TABLE instance_state ADD CONSTRAINT instance_state_owner_user_id_user_id_fk FOREIGN KEY (owner_user_id) REFERENCES "user"(id) ON DELETE RESTRICT ON UPDATE RESTRICT`;
        await database.client`ALTER TABLE instance_state ADD CONSTRAINT instance_state_owner_binding CHECK ((initialized_at IS NULL AND owner_user_id IS NULL) OR (initialized_at IS NOT NULL AND owner_user_id IS NOT NULL AND length(trim(owner_user_id)) > 0 AND owner_user_id = trim(owner_user_id)))`;
      }
    },
  );

  it("closes setup for an uninitialized instance containing unknown auth users", async () => {
    await database.db.update(instanceState).set({
      bootstrapSecretDigest: null,
      bootstrapExpiresAt: null,
      initializedAt: null,
      ownerUserId: null,
    });
    const cookie = await login();
    await expectBusinessDenied(cookie);
    expect((await setup(request("/api/setup", "", credentials))).status).toBe(
      409,
    );
    expect((await state()).ownerUserId).toBeNull();
  });

  it("preserves F6 exact-session logout and rejects non-owner logout without touching owner sessions", async () => {
    const first = await login();
    const second = await login();
    const firstSession = (await getValidSession(
      auth,
      new Headers({ cookie: first }),
    ))!.session.id;
    const secondSession = (await getValidSession(
      auth,
      new Headers({ cookie: second }),
    ))!.session.id;
    const { cookie } = await secondUser();
    expect(
      (await authPost(request("/api/auth/sign-out", cookie, {}))).status,
    ).toBe(401);
    expect(
      (await database.db.select().from(session)).map((row) => row.id),
    ).toEqual(expect.arrayContaining([firstSession, secondSession]));
    expect(
      (await authPost(request("/api/auth/sign-out", first, {}))).status,
    ).toBe(200);
    expect(
      await getValidSession(auth, new Headers({ cookie: first })),
    ).toBeNull();
    expect(
      (await getValidSession(auth, new Headers({ cookie: second })))?.session
        .id,
    ).toBe(secondSession);
  });

  it("preserves F5 lifetime, F4 mutation Origin policy and disabled signup", async () => {
    const cookie = await login();
    await setReadyFixture(database.db);
    const headers = new Headers({
      cookie,
      "Content-Type": "application/json",
      Origin: "http://evil.test",
    });
    expect(
      (
        await settingsWrite(
          new Request(`${origin}/api/settings/auto-read`, {
            method: "PUT",
            headers,
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await authPost(
          request("/api/auth/sign-up/email", "", {
            name: "Other",
            email: "other@example.test",
            password,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await auth.handler(
          request("/api/auth/sign-up/email", "", {
            name: "Other",
            email: "other@example.test",
            password,
          }),
        )
      ).ok,
    ).toBe(false);
    const current = (await getValidSession(auth, new Headers({ cookie })))!;
    await database.db
      .update(session)
      .set({ absoluteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.id, current.session.id));
    await expectBusinessDenied(cookie);
  });
});
