import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
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
import { initializeOwner } from "@/modules/auth/application/instance-auth";
import { checkOwnerApiAccess } from "@/modules/auth/application/api-access-check";
import { logoutCurrentSession } from "@/modules/auth/application/logout";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  session,
  rateLimit,
  loginThrottle,
} from "@/shared/infrastructure/database/schema";

const runtime = vi.hoisted(() => ({
  db: undefined as unknown,
  config: undefined as unknown,
  auth: undefined as unknown,
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
import { GET as protectedRead } from "@/app/api/settings/auto-read/route";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
describe("F6 current-session logout with Better Auth 1.7.5 and PostgreSQL", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let auth: ReturnType<typeof createAuth>;
  let config: AppConfig;
  let post: typeof import("@/app/api/auth/[...all]/route").POST;
  const logger = { error: vi.fn() };
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "logout",
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
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/logout`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      MAILDOCK_BOOTSTRAP_SECRET: Buffer.alloc(32, 7).toString("base64"),
      ATTACHMENTS_PATH: tmpdir(),
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await initializeOwner(
      database.db,
      {
        bootstrapSecret: Buffer.alloc(32, 7).toString("base64"),
        username: "Owner-01",
        password,
      },
      config,
    );
    auth = createAuth(config, database.db);
    runtime.db = database.db;
    runtime.config = config;
    runtime.auth = auth;
    post = (await import("@/app/api/auth/[...all]/route")).POST;
  });
  beforeEach(async () => {
    await database.client`DROP TRIGGER IF EXISTS f6_delete_fault ON "session"`;
    await database.db.delete(session);
    await database.db.delete(rateLimit);
    await database.db.delete(loginThrottle);
    logger.error.mockClear();
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });
  async function login(instance = auth) {
    const response = await instance.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "OWNER-01",
          password,
          rememberMe: false,
        }),
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  function request(
    cookie: string,
    requestOrigin: string | null = origin,
    path = "/sign-out",
  ) {
    const headers = new Headers({ cookie });
    if (requestOrigin !== null) headers.set("Origin", requestOrigin);
    return new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers,
    });
  }
  async function rows() {
    return database.db.select().from(session);
  }
  function expectCleared(response: Response, secure = false) {
    const cookies = response.headers.getSetCookie();
    for (const name of ["session_token", "session_data", "dont_remember"]) {
      const cookie = cookies.find((value) =>
        value.startsWith(`${secure ? "__Secure-" : ""}maildock.${name}=`),
      );
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      if (secure) expect(cookie).toContain("Secure");
    }
  }
  async function fault(mode: "raise" | "skip" | "confirm") {
    // Fault the actual PostgreSQL DELETE used by the application. No fake store.
    const body =
      mode === "raise"
        ? "RAISE EXCEPTION 'F6 injected deletion failure';"
        : mode === "skip"
          ? "RETURN NULL;"
          : "ALTER TABLE session RENAME TO f6_hidden_session; RETURN OLD;";
    await database.client.unsafe(
      `CREATE OR REPLACE FUNCTION f6_delete_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`,
    );
    await database.client.unsafe(
      `CREATE TRIGGER f6_delete_fault ${mode === "confirm" ? "AFTER" : "BEFORE"} DELETE ON session FOR EACH ROW EXECUTE FUNCTION f6_delete_fault()`,
    );
  }
  it("confirms absence of only the current session and rejects its copied cookie at a protected API", async () => {
    const copied = await login();
    const current = (await rows())[0];
    const independent = await login();
    expect(
      (
        await protectedRead(
          new Request(`${origin}/api/settings/auto-read`, {
            headers: { cookie: copied },
          }),
        )
      ).status,
    ).toBe(200);
    const response = await post(request(copied));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expectCleared(response);
    expect((await rows()).map((row) => row.id)).not.toContain(current.id);
    expect(await rows()).toHaveLength(1);
    expect(
      (
        await protectedRead(
          new Request(`${origin}/api/settings/auto-read`, {
            headers: { cookie: copied },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      await checkOwnerApiAccess(
        auth,
        config,
        new Request(`${origin}/api/settings/auto-read`, {
          headers: { cookie: independent },
        }),
      ),
    ).toBeNull();
  });
  it.each(["raise", "skip"] as const)(
    "fails closed when PostgreSQL deletion %s leaves the copied token valid",
    async (mode) => {
      const copied = await login();
      const before = await rows();
      await fault(mode);
      const response = await logoutCurrentSession(
        request(copied),
        auth,
        database.db,
        config,
        logger,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty("success");
      expectCleared(response);
      expect(await rows()).toEqual(before);
      expect(
        (
          await protectedRead(
            new Request(`${origin}/api/settings/auto-read`, {
              headers: { cookie: copied },
            }),
          )
        ).status,
      ).toBe(200);
      expect(logger.error).toHaveBeenCalledWith(
        { event: "logout_revocation_failed" },
        "Logout could not be confirmed.",
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        before[0].token,
      );
      // Also prove the public handler does not delegate to Better Auth's false success.
      const routed = await post(request(copied));
      expect(routed.status).toBe(500);
      expectCleared(routed);
    },
  );
  it("does not claim success when deletion commits but the confirmation SELECT fails", async () => {
    const copied = await login();
    await fault("confirm");
    try {
      const response = await post(request(copied));
      expect(response.status).toBe(500);
      expectCleared(response);
    } finally {
      await database.client`ALTER TABLE f6_hidden_session RENAME TO session`;
    }
    expect(await rows()).toHaveLength(0);
  });
  it("reproduces Better Auth's false success with the same real database deletion fault", async () => {
    const copied = await login();
    await fault("raise");
    const response = await auth.handler(request(copied));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expectCleared(response);
    expect(await rows()).toHaveLength(1);
    expect(
      (
        await protectedRead(
          new Request(`${origin}/api/settings/auto-read`, {
            headers: { cookie: copied },
          }),
        )
      ).status,
    ).toBe(200);
  });
  it("keeps copied-token revocation authoritative across concurrent logout requests", async () => {
    const copied = await login();
    const independent = await login();
    const responses = await Promise.all([
      post(request(copied)),
      post(request(copied)),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(
      responses.every((response) => [200, 401].includes(response.status)),
    ).toBe(true);
    expect(await rows()).toHaveLength(1);
    expect(
      (
        await protectedRead(
          new Request(`${origin}/api/settings/auto-read`, {
            headers: { cookie: copied },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      await checkOwnerApiAccess(
        auth,
        config,
        new Request(`${origin}/api/settings/auto-read`, {
          headers: { cookie: independent },
        }),
      ),
    ).toBeNull();
  });
  it.each(["", "maildock.session_token=malformed"])(
    "cannot delete another session with missing/malformed authentication (%s)",
    async (cookie) => {
      await login();
      const before = await rows();
      const response = await post(request(cookie));
      expect(response.status).toBe(401);
      expectCleared(response);
      expect(await rows()).toEqual(before);
    },
  );
  it.each([
    null,
    "null",
    "http://sibling.localhost:3000",
    "https://evil.example",
  ])("rejects Origin %s before deletion or cookie cleanup", async (value) => {
    const copied = await login();
    const before = await rows();
    const response = await post(request(copied, value));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await rows()).toEqual(before);
  });
  it("does not expose the cleanup API or bypass signup restrictions", async () => {
    const copied = await login();
    expect(
      (await post(request(copied, origin, "/maildock-clear-logout-cookies")))
        .status,
    ).toBe(404);
    expect((await post(request(copied, origin, "/sign-up/email"))).status).toBe(
      404,
    );
    expect(await rows()).toHaveLength(1);
  });
  it("preserves F5: an inactive session cannot authenticate for logout or revoke a different session", async () => {
    const copied = await login();
    const row = (await rows())[0];
    await login();
    await database.db
      .update(session)
      .set({ updatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) })
      .where(eq(session.id, row.id));
    expect((await post(request(copied))).status).toBe(401);
    expect(await rows()).toHaveLength(2);
  });
  it("uses Better Auth production prefixes and clears cached cookie chunks on failure", async () => {
    const production = createAuth(
      { ...config, environment: "production" },
      database.db,
    );
    const copied = await login(production);
    await fault("raise");
    const response = await logoutCurrentSession(
      request(`${copied}; __Secure-maildock.session_data.0=old`),
      production,
      database.db,
      config,
      logger,
    );
    expect(response.status).toBe(500);
    expectCleared(response, true);
    expect(
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Secure-maildock.session_data.0=")),
    ).toContain("Max-Age=0");
    expect(await rows()).toHaveLength(1);
  });
});
