import { initializeOwnerFixture } from "./mfa-fixture";
import { randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
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

import {
  getValidOwnerSession,
  getValidBusinessSession,
} from "@/modules/auth/application/session-validation";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { setReadyFixture } from "./mfa-fixture";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  twoFactor,
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
import { GET as setupRead } from "@/app/api/setup/route";
import { GET as googleStart } from "@/app/api/oauth/google/start/route";
import { GET as googleCallback } from "@/app/api/oauth/google/callback/route";
import { GET as microsoftStart } from "@/app/api/oauth/microsoft/start/route";
import { GET as microsoftCallback } from "@/app/api/oauth/microsoft/callback/route";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const credentials = { bootstrapSecret, username: "Owner-01", password };

describe("F2.1 MFA foundation with real Better Auth and PostgreSQL", () => {
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
  async function ownerId() {
    return (await database.db.select().from(instanceState))[0].ownerUserId!;
  }
  async function factor(verified = true, userId?: string) {
    await database.db.insert(twoFactor).values({
      id: randomUUID(),
      userId: userId ?? (await ownerId()),
      secret: "test-encrypted-secret",
      backupCodes: "test-encrypted-backups",
      verified,
    });
  }
  async function enabled(value = true) {
    await database.db
      .update(user)
      .set({ twoFactorEnabled: value })
      .where(eq(user.id, await ownerId()));
  }
  async function denied(cookie: string) {
    runtime.headers = new Headers({ cookie });
    expect(await getValidBusinessSession(auth, runtime.headers)).toBeNull();
    expect(
      (await settingsRead(request("/api/settings/auto-read", cookie))).status,
    ).toBe(401);
    expect(
      (await settingsWrite(request("/api/settings/auto-read", cookie, {})))
        .status,
    ).toBe(401);
    expect(
      (await proxy(new NextRequest(request("/api/settings/auto-read", cookie))))
        .status,
    ).toBe(401);
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
    for (const handler of [
      googleStart,
      microsoftStart,
      googleCallback,
      microsoftCallback,
    ]) {
      expect(
        (
          await handler(request("/api/oauth?state=test&code=test", cookie))
        ).headers.get("location"),
      ).toBe(`${origin}/login`);
    }
    expect(runtime.oauth).not.toHaveBeenCalled();
  }

  it("migrates a fresh PostgreSQL database with exact plugin columns, defaults, uniqueness and intentional FK semantics", async () => {
    const columns =
      await database.client`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'two_factor' ORDER BY column_name`;
    expect(columns.map((r) => r.column_name)).toEqual([
      "backup_codes",
      "failed_verification_count",
      "id",
      "locked_until",
      "secret",
      "user_id",
      "verified",
    ]);
    expect((await database.db.select().from(user))[0].twoFactorEnabled).toBe(
      false,
    );
    await factor(false);
    const [row] = await database.db.select().from(twoFactor);
    expect(row.failedVerificationCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    await expect(factor()).rejects.toThrow();
    await expect(factor(true, randomUUID())).rejects.toThrow();
    const { id } = await secondUser();
    await factor(true, id);
    await expect(
      database.db.update(user).set({ id: randomUUID() }).where(eq(user.id, id)),
    ).rejects.toThrow();
    await database.db.delete(user).where(eq(user.id, id));
    expect(await database.db.select().from(twoFactor)).toHaveLength(1);
  });

  it.each([
    "no MFA",
    "flag only",
    "unverified",
    "verified flag false",
    "verified flag true",
  ])("derives strict READY for %s", async (state) => {
    if (state !== "no MFA" && state !== "flag only")
      await factor(state !== "unverified");
    if (["flag only", "unverified", "verified flag true"].includes(state))
      await enabled();
    expect(await isInstanceReady(database.db)).toBe(
      state === "verified flag true",
    );
  });

  it("ignores another user's verified factor and rejects its legitimate Better Auth session even when the owner is READY", async () => {
    const { id, cookie } = await secondUser();
    await factor(true, id);
    await enabled();
    expect(await isInstanceReady(database.db)).toBe(false);
    await factor();
    expect(await isInstanceReady(database.db)).toBe(true);
    await database.db
      .update(user)
      .set({ twoFactorEnabled: true })
      .where(eq(user.id, id));
    expect(
      await getValidOwnerSession(auth, new Headers({ cookie })),
    ).toBeNull();
    await denied(cookie);
  });

  it("rejects duplicate factors, null flags/verification and extra instance rows when constraints are deliberately bypassed", async () => {
    await setReadyFixture(database.db);
    expect(await isInstanceReady(database.db)).toBe(true);
    await database.client`DROP INDEX two_factor_user_id_unique`;
    try {
      await factor(false);
      expect(await isInstanceReady(database.db)).toBe(false);
      await database.client`DELETE FROM two_factor WHERE verified = false`;
    } finally {
      await database.client`CREATE UNIQUE INDEX two_factor_user_id_unique ON two_factor(user_id)`;
    }
    await database.client`ALTER TABLE two_factor ALTER COLUMN verified DROP NOT NULL`;
    try {
      await database.client`UPDATE two_factor SET verified = NULL`;
      expect(await isInstanceReady(database.db)).toBe(false);
    } finally {
      await database.client`UPDATE two_factor SET verified = true`;
      await database.client`ALTER TABLE two_factor ALTER COLUMN verified SET NOT NULL`;
    }
    await database.client`ALTER TABLE "user" ALTER COLUMN two_factor_enabled DROP NOT NULL`;
    try {
      await database.client`UPDATE "user" SET two_factor_enabled = NULL`;
      expect(await isInstanceReady(database.db)).toBe(false);
    } finally {
      await enabled();
      await database.client`ALTER TABLE "user" ALTER COLUMN two_factor_enabled SET NOT NULL`;
    }
    await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_singleton`;
    try {
      await database.db.insert(instanceState).values({ id: 2 });
      expect(await isInstanceReady(database.db)).toBe(false);
    } finally {
      await database.client`DELETE FROM instance_state WHERE id = 2`;
      await database.client`ALTER TABLE instance_state ADD CONSTRAINT instance_state_singleton CHECK(id = 1)`;
    }
  });

  it("rejects missing, uninitialized, malformed and dangling owner state without repairing it", async () => {
    await setReadyFixture(database.db);
    const id = await ownerId();
    const [bootstrapConstraint] = await database.client<
      { definition: string }[]
    >`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='instance_state'::regclass and conname='instance_state_bootstrap'`;
    await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_bootstrap`;
    await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_owner_binding`;
    await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_owner_user_id_user_id_fk`;
    try {
      for (const binding of [null, "", " invalid ", randomUUID()]) {
        await database.db.update(instanceState).set({ ownerUserId: binding });
        expect(await isInstanceReady(database.db)).toBe(false);
      }
      await database.db
        .update(instanceState)
        .set({ ownerUserId: id, initializedAt: null });
      expect(await isInstanceReady(database.db)).toBe(false);
      await database.db.delete(instanceState);
      expect(await isInstanceReady(database.db)).toBe(false);
    } finally {
      await database.db
        .insert(instanceState)
        .values({ id: 1 })
        .onConflictDoNothing();
      await database.db
        .update(instanceState)
        .set({ ownerUserId: id, initializedAt: new Date() });
      await database.client.unsafe(
        `ALTER TABLE instance_state ADD CONSTRAINT instance_state_bootstrap ${bootstrapConstraint.definition}`,
      );
      await database.client`ALTER TABLE instance_state ADD CONSTRAINT instance_state_owner_user_id_user_id_fk FOREIGN KEY(owner_user_id) REFERENCES "user"(id) ON DELETE RESTRICT ON UPDATE RESTRICT`;
      await database.client`ALTER TABLE instance_state ADD CONSTRAINT instance_state_owner_binding CHECK ((initialized_at IS NULL AND owner_user_id IS NULL) OR (initialized_at IS NOT NULL AND owner_user_id IS NOT NULL AND length(trim(owner_user_id)) > 0 AND owner_user_id = trim(owner_user_id)))`;
    }
  });

  it("denies password-only business access while preserving owner identity, setup status, login/get-session and public pages", async () => {
    const cookie = await login();
    expect(
      (await getValidOwnerSession(auth, new Headers({ cookie })))?.user.id,
    ).toBe(await ownerId());
    await denied(cookie);
    expect(await (await setupRead()).json()).toEqual({ initialized: true });
    const { GET } = await import("@/app/api/auth/[...all]/route");
    expect((await GET(request("/api/auth/get-session", cookie))).status).toBe(
      200,
    );
    for (const path of [
      "/login",
      "/setup",
      "/api/setup",
      "/api/auth/get-session",
    ]) {
      expect(
        (await proxy(new NextRequest(request(path, cookie)))).headers.get(
          "x-middleware-next",
        ),
      ).toBe("1");
    }
    expect(
      (await authPost(request("/api/auth/sign-out", cookie, {}))).status,
    ).toBe(200);
    expect(
      await getValidOwnerSession(auth, new Headers({ cookie })),
    ).toBeNull();
  });

  it("characterizes manual READY bypass: pre-enrollment sessions pass until ALL are revoked; future completion MUST synchronize verification, revocation and login", async () => {
    const first = await login();
    const second = await login();
    await denied(first);
    await denied(second);
    await setReadyFixture(database.db); // Deliberate bypass of the future completion procedure.
    for (const cookie of [first, second]) {
      expect(
        await getValidBusinessSession(auth, new Headers({ cookie })),
      ).not.toBeNull();
      expect(
        (await settingsRead(request("/api/settings/auto-read", cookie))).status,
      ).toBe(200);
    }
    // Characterization, NOT an enrollment implementation: READY offers no
    // session MFA evidence. Real completion must revoke these before exposure.
    await database.db
      .delete(session)
      .where(eq(session.userId, await ownerId()));
    for (const cookie of [first, second]) await denied(cookie);
    expect(await isInstanceReady(database.db)).toBe(true);
  });

  it("rejects an in-flight owner read across atomic READY plus all-session revocation", async () => {
    const cookie = await login();
    const readReadiness = auth.isInstanceReady;
    const schedulingBarrier = vi
      .spyOn(auth, "isInstanceReady")
      .mockImplementationOnce(async (userId, sessionId) => {
        // The owner session was read before this commit. State and its exact
        // session must now be rechecked together, without cached session evidence.
        await database.db.transaction(async (tx) => {
          await setReadyFixture(tx);
          await tx.delete(session).where(eq(session.userId, userId));
        });
        return readReadiness(userId, sessionId);
      });
    try {
      expect(
        await getValidBusinessSession(auth, new Headers({ cookie })),
      ).toBeNull();
      expect(await isInstanceReady(database.db)).toBe(true);
      expect(await database.db.select().from(session)).toHaveLength(0);
    } finally {
      schedulingBarrier.mockRestore();
    }
  });

  it("enables the real plugin with unverified enrollment and a 600s TOTP-only password-login challenge, deleting its temporary session", async () => {
    const cookie = await login();
    const enrollment = await auth.api.enableTwoFactor({
      headers: new Headers({ cookie }),
      body: { password },
    });
    if (enrollment.method !== "totp")
      throw new Error("Expected TOTP enrollment");
    expect(enrollment.totpURI).toContain("otpauth://totp/Maildock");
    const [row] = await database.db.select().from(twoFactor);
    expect(row.verified).toBe(false);
    expect((await database.db.select().from(user))[0].twoFactorEnabled).toBe(
      false,
    );
    expect(await isInstanceReady(database.db)).toBe(false);
    // Verify using the installed plugin's own internal test API, no public UI.
    const secret = await symmetricDecrypt({
      key: config.authSecret,
      data: row.secret,
    });
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    await auth.api.verifyTOTP({
      headers: new Headers({ cookie }),
      body: { code },
    });
    expect(await isInstanceReady(database.db)).toBe(true);
    await database.db.delete(session);
    const response = await authPost(
      request("/api/auth/sign-in/username", "", {
        username: "owner-01",
        password,
      }),
    );
    expect(await response.json()).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
    expect(await database.db.select().from(session)).toHaveLength(0);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (c) =>
            c.startsWith("maildock.two_factor=") && c.includes("Max-Age=600"),
        ),
    ).toBe(true);
    expect(
      response.headers
        .getSetCookie()
        .some((c) => c.includes("trust_device=") && !c.includes("Max-Age=0")),
    ).toBe(false);
    const challengeCookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(
      await getValidOwnerSession(
        auth,
        new Headers({ cookie: challengeCookie }),
      ),
    ).toBeNull();
    const verified = await auth.api.verifyTOTP({
      headers: new Headers({ cookie: challengeCookie }),
      body: { code },
      asResponse: true,
    });
    expect(verified.status).toBe(200);
    const freshCookie = verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(
      await getValidBusinessSession(auth, new Headers({ cookie: freshCookie })),
    ).not.toBeNull();
  });

  it("keeps all unapproved two-factor, management, OTP and trusted-device endpoints unreachable through the catch-all", async () => {
    const cookie = await login();
    const { GET } = await import("@/app/api/auth/[...all]/route");
    for (const path of [
      "enable",
      "disable",
      "get-totp-uri",
      "generate-totp",
      "verify-totp",
      "verify-backup-code",
      "generate-backup-codes",
      "view-backup-codes",
      "send-otp",
      "verify-otp",
      "trust-device",
      "unknown",
    ]) {
      expect(
        (
          await authPost(
            request(`/api/auth/two-factor/${path}`, cookie, {
              password,
              trustDevice: true,
            }),
          )
        ).status,
      ).toBe(404);
      expect(
        (await GET(request(`/api/auth/two-factor/${path}`, cookie))).status,
      ).toBe(404);
    }
  });
});
