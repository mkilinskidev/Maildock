import { tmpdir } from "node:os";
import { setReadyFixture } from "./mfa-fixture";
import { betterAuth } from "better-auth";
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
import { initializeOwner } from "@/modules/auth/application/instance-auth";
import { getValidSession } from "@/modules/auth/application/session-validation";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { parseConfig } from "@/shared/infrastructure/config/config";
import {
  session,
  rateLimit,
  authAdmission,
  loginThrottle,
} from "@/shared/infrastructure/database/schema";

// Substitute request context and composition singletons, never Better Auth,
// cookies, lifetime validation, the adapter or PostgreSQL session behavior.
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
  accountsService: { requestMailboxDiscovery: vi.fn() },
}));

import { proxy } from "@/proxy";
import {
  GET as settingsRead,
  PUT as settingsWrite,
} from "@/app/api/settings/auto-read/route";
import { GET as googleStart } from "@/app/api/oauth/google/start/route";
import { GET as googleCallback } from "@/app/api/oauth/google/callback/route";
import { GET as microsoftStart } from "@/app/api/oauth/microsoft/start/route";
import { GET as microsoftCallback } from "@/app/api/oauth/microsoft/callback/route";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
const start = new Date("2026-10-05T10:00:00.000Z").getTime();
const hour = 60 * 60 * 1_000;
const day = 24 * hour;

describe("F5 lifetime with real Better Auth 1.7.5 and PostgreSQL", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let auth: ReturnType<typeof createAuth>;
  let loginPost: typeof import("@/app/api/auth/[...all]/route").POST;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "sessions",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: origin,
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/sessions`,
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
    loginPost = (await import("@/app/api/auth/[...all]/route")).POST;
  });
  beforeEach(async () => {
    vi.useRealTimers();
    await database.db.delete(session);
    await database.client`UPDATE "user" SET two_factor_enabled = false`;
    await database.db.delete(rateLimit);
    await database.db.delete(authAdmission);
    await database.db.delete(loginThrottle);
    runtime.oauth.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await database?.client.end();
    await container?.stop();
  });

  async function login(rememberMe: boolean | "omitted" = false) {
    const response = await loginPost(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "OWNER-01",
          password,
          rememberMe: rememberMe === "omitted" ? undefined : rememberMe,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const tokenCookie = cookies.find((value) =>
      value.startsWith("maildock.session_token="),
    )!;
    const [row] = await database.db.select().from(session);
    return { cookie, tokenCookie, cookies, row, response };
  }
  function headers(cookie: string) {
    return new Headers({ cookie });
  }
  async function store(
    id: string,
    values: Partial<typeof session.$inferInsert>,
  ) {
    await database.db.update(session).set(values).where(eq(session.id, id));
  }
  async function stored() {
    return (await database.db.select().from(session))[0];
  }

  it("reproduces the installed package's 24h discrepancy without the F5 creation hook", async () => {
    const baseline = betterAuth({
      ...auth.options,
      databaseHooks: {
        session: {
          create: {
            before: async (row) => ({
              data: {
                ...row,
                absoluteExpiresAt: new Date(row.createdAt.getTime() + 30 * day),
              },
            }),
          },
        },
      },
    });
    const response = await baseline.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "owner-01",
          password,
          rememberMe: false,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await stored()).expiresAt.getTime()).toBe(start + 24 * hour);
    expect(
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith("maildock.session_token=")),
    ).not.toMatch(/Max-Age=|Expires=/i);
  });

  it.each([false, true, "omitted"] as const)(
    "creates a 12h database session for rememberMe=%s",
    async (remember) => {
      const result = await login(remember);
      expect(result.row.expiresAt.getTime()).toBe(start + 12 * hour);
      expect(result.row.absoluteExpiresAt.getTime()).toBe(start + 30 * day);
      expect((await result.response.json()).user.username).toBe("owner-01");
      if (remember === false) {
        expect(result.tokenCookie).not.toMatch(/Max-Age=|Expires=/i);
        expect(
          result.cookies.some((value) =>
            value.startsWith("maildock.dont_remember="),
          ),
        ).toBe(true);
        expect(result.cookies.join("; ")).not.toContain("session_data=");
      } else expect(result.tokenCookie).toContain("Max-Age=43200");
      expect(result.tokenCookie).toContain("HttpOnly");
      expect(result.tokenCookie).toContain("SameSite=Lax");
    },
  );

  it("accepts before and rejects exactly at 12h, including a copied token", async () => {
    const { cookie, tokenCookie } = await login();
    vi.setSystemTime(start + 12 * hour - 1);
    expect(await getValidSession(auth, headers(cookie))).not.toBeNull();
    vi.setSystemTime(start + 12 * hour);
    expect(await getValidSession(auth, headers(cookie))).toBeNull();
    expect(
      await getValidSession(auth, headers(tokenCookie.split(";")[0])),
    ).toBeNull();
    vi.setSystemTime(start + 12 * hour + 1);
    expect(await auth.api.getSession({ headers: headers(cookie) })).toBeNull();
  });

  it("does not refresh a normal rememberMe:false browser session", async () => {
    const { cookie, row } = await login();
    vi.setSystemTime(start + hour);
    expect(await getValidSession(auth, headers(cookie))).not.toBeNull();
    const protocol = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: headers(cookie),
      }),
    );
    expect(protocol.status).toBe(200);
    expect(protocol.headers.getSetCookie().join("; ")).not.toContain(
      "maildock.session_token=",
    );
    expect(await stored()).toEqual(row);
  });

  it("honors a shorter database expiry at Better Auth's own boundary", async () => {
    const { cookie, row } = await login();
    await store(row.id, { expiresAt: new Date(start + hour) });
    vi.setSystemTime(start + hour + 1);
    expect(await getValidSession(auth, headers(cookie))).toBeNull();
    expect(await stored()).toBeUndefined();
  });

  it("allows Better Auth refresh of a still-valid copied token without the browser marker", async () => {
    const { tokenCookie, row } = await login();
    const copied = headers(tokenCookie.split(";")[0]);
    vi.setSystemTime(start + hour);
    expect(await getValidSession(auth, copied)).not.toBeNull();
    const refreshed = await stored();
    expect(refreshed.expiresAt.getTime()).toBe(Date.now() + 12 * hour);
    expect(refreshed.token).toBe(row.token);
    expect(refreshed.absoluteExpiresAt).toEqual(row.absoluteExpiresAt);
    vi.setSystemTime(refreshed.expiresAt.getTime());
    expect(await getValidSession(auth, copied)).toBeNull();
  });

  it.each(["full", "token-only"])(
    "bounds existing 24h rows with %s cookies and blocks protocol revival",
    async (mode) => {
      const { cookie, tokenCookie, row } = await login();
      const copied = mode === "full" ? cookie : tokenCookie.split(";")[0];
      await store(row.id, { expiresAt: new Date(start + 24 * hour) });
      vi.setSystemTime(start + 12 * hour - 1);
      expect(await getValidSession(auth, headers(copied))).not.toBeNull();
      vi.setSystemTime(start + 12 * hour);
      expect(await getValidSession(auth, headers(copied))).toBeNull();
      // Original 24h expiry makes Better Auth's update threshold 12h15m.
      vi.setSystemTime(start + 13 * hour);
      const protocol = await auth.handler(
        new Request(`${origin}/api/auth/get-session`, {
          headers: headers(copied),
        }),
      );
      expect(
        mode === "full" ? protocol.status === 200 : protocol.status === 401,
      ).toBe(true);
      expect((await stored()).updatedAt).toEqual(row.updatedAt);
      expect(await getValidSession(auth, headers(copied))).toBeNull();
    },
  );

  it("refreshes at updateAge, extends 12h, preserves token and absolute deadline", async () => {
    const { cookie, row } = await login(true);
    vi.setSystemTime(start + 15 * 60 * 1_000 - 1);
    expect(await getValidSession(auth, headers(cookie))).not.toBeNull();
    expect((await stored()).updatedAt).toEqual(row.updatedAt);
    vi.setSystemTime(start + 15 * 60 * 1_000);
    expect(await getValidSession(auth, headers(cookie))).not.toBeNull();
    const refreshed = await stored();
    expect(refreshed.expiresAt.getTime()).toBe(Date.now() + 12 * hour);
    expect(refreshed.updatedAt.getTime()).toBe(Date.now());
    expect(refreshed.token).toBe(row.token);
    expect(refreshed.absoluteExpiresAt).toEqual(row.absoluteExpiresAt);
    vi.setSystemTime(refreshed.expiresAt.getTime());
    expect(await getValidSession(auth, headers(cookie))).toBeNull();
  });

  it.each(["stored-absolute", "creation-cap"])(
    "rejects the %s deadline despite overlong database expiry",
    async (mode) => {
      const { cookie, row } = await login(true);
      const deadline =
        mode === "stored-absolute" ? start + day : start + 30 * day;
      await store(row.id, {
        absoluteExpiresAt: new Date(
          mode === "stored-absolute" ? deadline : start + 40 * day,
        ),
        updatedAt: new Date(deadline - hour),
        expiresAt: new Date(deadline + day),
      });
      vi.setSystemTime(deadline - 1);
      expect(await getValidSession(auth, headers(cookie))).not.toBeNull();
      vi.setSystemTime(deadline);
      expect(await getValidSession(auth, headers(cookie))).toBeNull();
      expect(await stored()).toMatchObject({
        updatedAt: new Date(deadline - hour),
      });
    },
  );

  it("caps a legitimate refresh at the unchanged absolute deadline", async () => {
    const { cookie, row } = await login(true);
    vi.setSystemTime(start + 30 * day - hour);
    await store(row.id, {
      updatedAt: new Date(Date.now() - hour),
      expiresAt: new Date(Date.now() + 11 * hour),
    });
    expect(await getValidSession(auth, headers(cookie))).not.toBeNull();
    expect((await stored()).expiresAt).toEqual(row.absoluteExpiresAt);
    expect((await stored()).absoluteExpiresAt).toEqual(row.absoluteExpiresAt);
  });

  it.each(["createdAt", "updatedAt"] as const)(
    "fails closed for a future %s timestamp",
    async (field) => {
      const { cookie, row } = await login();
      await store(row.id, { [field]: new Date(start + 1) });
      expect(await getValidSession(auth, headers(cookie))).toBeNull();
    },
  );

  it("rejects stale sessions at API, page/proxy and all OAuth owner checks", async () => {
    const { cookie, row } = await login();
    await setReadyFixture(database.db);
    await store(row.id, { expiresAt: new Date(start + day) });
    vi.setSystemTime(start + 12 * hour);
    runtime.headers = headers(cookie);
    const request = new Request(`${origin}/api/settings/auto-read`, {
      headers: headers(cookie),
    });
    expect((await settingsRead(request)).status).toBe(401);
    expect(
      (
        await settingsWrite(
          new Request(request.url, {
            method: "PUT",
            headers: headers(cookie),
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);
    const apiProxy = await proxy(new NextRequest(request));
    expect(apiProxy.status).toBe(401);
    for (const path of ["/", "/accounts", "/settings", "/accounts/new"]) {
      const response = await proxy(
        new NextRequest(`${origin}${path}`, { headers: headers(cookie) }),
      );
      expect(response.headers.get("location")).toBe(`${origin}/login`);
    }
    for (const handler of [
      googleStart,
      googleCallback,
      microsoftStart,
      microsoftCallback,
    ]) {
      expect((await handler(request)).headers.get("location")).toBe(
        `${origin}/login`,
      );
    }
    expect(runtime.oauth).not.toHaveBeenCalled();
  });

  it("preserves F4 mutation Origin checks for a valid session", async () => {
    const { cookie } = await login();
    await setReadyFixture(database.db);
    expect(
      (
        await settingsRead(
          new Request(`${origin}/api/settings/auto-read`, {
            headers: headers(cookie),
          }),
        )
      ).status,
    ).toBe(200);
    for (const requestOrigin of [null, "null", "http://evil.test"]) {
      const requestHeaders = headers(cookie);
      requestHeaders.set("Content-Type", "application/json");
      if (requestOrigin !== null) requestHeaders.set("Origin", requestOrigin);
      expect(
        (
          await settingsWrite(
            new Request(`${origin}/api/settings/auto-read`, {
              method: "PUT",
              headers: requestHeaders,
              body: "{}",
            }),
          )
        ).status,
      ).toBe(403);
    }
  });
});
