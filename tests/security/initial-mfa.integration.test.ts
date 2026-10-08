import { initializeOwnerFixture } from "./mfa-fixture";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { symmetricDecrypt } from "better-auth/crypto";
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

import {
  getValidOwnerSession,
  getValidBusinessSession,
} from "@/modules/auth/application/session-validation";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  instanceState,
  rateLimit,
  authAdmission,
  session,
  twoFactor,
  user,
  account,
} from "@/shared/infrastructure/database/schema";

const runtime = vi.hoisted(() => ({
  db: undefined as unknown,
  config: undefined as unknown,
  auth: undefined as unknown,
  headers: new Headers(),
}));
vi.mock("@/modules/auth/infrastructure/auth", () => ({
  get auth() {
    return runtime.auth;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => runtime.headers }));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  get db() {
    return runtime.db;
  },
}));
vi.mock("@/shared/infrastructure/config/config", async (original) => ({
  ...(await original<typeof import("@/shared/infrastructure/config/config")>()),
  getConfig: () => runtime.config,
}));
import { POST as start } from "@/app/api/auth/initial-mfa/start/route";
import { POST as complete } from "@/app/api/auth/initial-mfa/complete/route";
import { POST as verifyTotp } from "@/app/api/auth/mfa/totp/route";
import { POST as verifyRecovery } from "@/app/api/auth/mfa/recovery/route";
import { POST as cancelChallenge } from "@/app/api/auth/mfa/cancel/route";
import { ownerLanding } from "@/modules/auth/application/auth-navigation";
import LoginPage from "@/app/login/page";
import InitialMfaPage from "@/app/initial-mfa/page";
import SetupPage from "@/app/setup/page";
import {
  sessionAbsoluteMs,
  sessionInactivitySeconds,
} from "@/modules/auth/domain/session-policy";
import { verification } from "@/shared/infrastructure/database/schema";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const startBody = { bootstrapSecret, password };
const boundaryKey = 1296125023;

describe("F2.2 initial enrollment with real Better Auth/PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let independent: ReturnType<typeof createDatabase>;
  let control: ReturnType<typeof createDatabase>;
  let config: AppConfig;
  let auth: ReturnType<typeof createAuth>;
  let otherAuth: ReturnType<typeof createAuth>;
  let cookie: string;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "enrollment",
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
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/enrollment`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: tmpdir(),
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    independent = createDatabase(config);
    control = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    auth = createAuth(config, database.db);
    otherAuth = createAuth(config, independent.db);
    runtime.db = database.db;
    runtime.config = config;
    runtime.auth = auth;
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
    await initializeOwnerFixture(database.db, {
      bootstrapSecret,
      username: "owner-01",
      password,
    });
    cookie = cookies(await login());
    runtime.headers = new Headers({ cookie });
  });
  afterAll(async () => {
    await database?.client.end();
    await independent?.client.end();
    await control?.client.end();
    await container?.stop();
  });
  function cookies(response: Response) {
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  function request(
    path: string,
    body: unknown,
    suppliedCookie = cookie,
    headers: Record<string, string> = {},
  ) {
    return new Request(`${origin}/api/auth/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        cookie: suppliedCookie,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  function login(engine = auth) {
    return engine.handler(
      request("sign-in/username", { username: "owner-01", password }, ""),
    );
  }
  function begin(body: unknown = startBody, suppliedCookie = cookie) {
    return start(request("initial-mfa/start", body, suppliedCookie));
  }
  function finish(
    code: string,
    body: unknown = { bootstrapSecret, code },
    suppliedCookie = cookie,
  ) {
    return complete(request("initial-mfa/complete", body, suppliedCookie));
  }
  async function code() {
    const [factor] = await database.db.select().from(twoFactor);
    const secret = await symmetricDecrypt({
      key: config.authSecret,
      data: factor.secret,
    });
    return (await auth.api.generateTOTP({ body: { secret } })).code;
  }
  async function readyWithNoSessions() {
    expect(await isInstanceReady(database.db)).toBe(true);
    expect(await database.db.select().from(session)).toHaveLength(0);
    expect(
      await getValidOwnerSession(auth, new Headers({ cookie })),
    ).toBeNull();
    expect(
      await getValidBusinessSession(auth, new Headers({ cookie })),
    ).toBeNull();
    expect(await database.db.select().from(twoFactor)).toHaveLength(1);
  }
  async function waitBoundaryWaiters(count: number) {
    const deadline = Date.now() + 15_000;
    while (true) {
      const rows =
        await control.client`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
        AND objid = ${boundaryKey} AND NOT granted`;
      if (rows.length >= count) return;
      if (Date.now() > deadline)
        throw new Error(
          `Expected ${count} PostgreSQL boundary waiters, got ${rows.length}`,
        );
      await delay(20);
    }
  }
  async function waitInsert() {
    const deadline = Date.now() + 15_000;
    while (true) {
      const rows =
        await control.client`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event = 'advisory' AND query LIKE 'insert into "session"%'`;
      if (rows.length) return;
      if (Date.now() > deadline)
        throw new Error("INSERT did not reach the PostgreSQL barrier");
      await delay(20);
    }
  }

  it("starts NOT READY; creates one encrypted unverified factor; resumes without replacement", async () => {
    expect(await isInstanceReady(database.db)).toBe(false);
    const response = await begin();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json();
    expect(first.resumed).toBe(false);
    expect(first.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(first.backupCodes).toBeUndefined();
    const [pending] = await database.db.select().from(twoFactor);
    expect(pending.verified).toBe(false);
    expect(pending.secret).not.toContain(
      new URL(first.totpURI).searchParams.get("secret"),
    );
    expect(
      JSON.parse(
        await symmetricDecrypt({
          key: config.authSecret,
          data: pending.backupCodes,
        }),
      ),
    ).toHaveLength(10);
    expect((await database.db.select().from(user))[0].twoFactorEnabled).toBe(
      false,
    );
    expect(await isInstanceReady(database.db)).toBe(false);
    const resumed = await begin();
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({
      totpURI: first.totpURI,
      resumed: true,
    });
    expect(await database.db.select().from(twoFactor)).toEqual([pending]);
  });
  it.each([
    {},
    { password },
    { password, bootstrapSecret: "wrong" },
    { bootstrapSecret, password: "incorrect-password" },
    { ...startBody, trustDevice: true },
    { ...startBody, method: "otp" },
  ])("rejects invalid start authority/options %j", async (body) => {
    expect((await begin(body)).status).toBeGreaterThanOrEqual(400);
    expect(await database.db.select().from(twoFactor)).toHaveLength(0);
    expect(await isInstanceReady(database.db)).toBe(false);
  });
  it("rejects absent and non-owner session", async () => {
    expect((await begin(startBody, "")).status).toBe(403);
    const id = randomUUID();
    const [credential] = await database.db.select().from(account);
    await database.db.insert(user).values({
      id,
      name: "Other",
      email: "other@example.test",
      username: "other-01",
    });
    await database.db.insert(account).values({
      id: randomUUID(),
      userId: id,
      accountId: id,
      providerId: "credential",
      password: credential.password,
    });
    const response = await auth.api.signInUsername({
      body: { username: "other-01", password },
      asResponse: true,
    });
    expect((await begin(startBody, cookies(response))).status).toBe(403);
    expect(await database.db.select().from(twoFactor)).toHaveLength(0);
  });
  it("requires password again on resume", async () => {
    await begin();
    const [pending] = await database.db.select().from(twoFactor);
    expect(
      (await begin({ bootstrapSecret, password: "incorrect-password" })).status,
    ).toBe(403);
    expect(await database.db.select().from(twoFactor)).toEqual([pending]);
  });
  it("rejects wrong TOTP and missing/wrong bootstrap without publishing READY", async () => {
    await begin();
    const valid = await code();
    const wrong = valid === "000000" ? "111111" : "000000";
    expect((await finish(wrong)).status).toBe(403);
    expect((await finish(valid, { code: valid })).status).toBe(400);
    expect(
      (await finish(valid, { code: valid, bootstrapSecret: "wrong" })).status,
    ).toBe(403);
    expect(await isInstanceReady(database.db)).toBe(false);
    expect((await database.db.select().from(twoFactor))[0].verified).toBe(
      false,
    );
    expect(
      await getValidOwnerSession(auth, new Headers({ cookie })),
    ).not.toBeNull();
  });
  it("revokes every copied session, clears cookies, and requires a fresh real MFA challenge", async () => {
    const copied = [
      cookie,
      cookies(await login(otherAuth)),
      cookies(await login()),
    ];
    await begin();
    const response = await finish(await code());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      completed: true,
      freshLoginRequired: true,
      recoveryCodes: expect.arrayContaining([expect.any(String)]),
    });
    const [bootstrapState] = await database.db.select().from(instanceState);
    expect(bootstrapState.bootstrapSecretDigest).toBeNull();
    expect(bootstrapState.bootstrapExpiresAt).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cleanup = response.headers.getSetCookie();
    for (const name of [
      "session_token",
      "dont_remember",
      "two_factor",
      "trust_device",
    ]) {
      expect(
        cleanup.some(
          (value) =>
            value.startsWith(`maildock.${name}=`) &&
            value.includes("Max-Age=0"),
        ),
      ).toBe(true);
    }
    expect(cleanup.every((value) => value.includes("Max-Age=0"))).toBe(true);
    await readyWithNoSessions();
    for (const copiedCookie of copied) {
      expect(
        await getValidOwnerSession(auth, new Headers({ cookie: copiedCookie })),
      ).toBeNull();
      expect(
        await getValidBusinessSession(
          auth,
          new Headers({ cookie: copiedCookie }),
        ),
      ).toBeNull();
    }
    const fresh = await login(otherAuth);
    expect(await fresh.json()).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
    expect(
      fresh.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith("maildock.two_factor=") &&
            value.includes("Max-Age=600"),
        ),
    ).toBe(true);
    await readyWithNoSessions();
    expect((await begin()).status).toBe(403);
    expect((await finish(await code())).status).toBe(403);
  });
  it("rejects trustDevice and arbitrary completion plugin bodies", async () => {
    await begin();
    const valid = await code();
    for (const extra of [
      { trustDevice: true },
      { method: "otp" },
      { password },
    ]) {
      expect(
        (await finish(valid, { bootstrapSecret, code: valid, ...extra }))
          .status,
      ).toBe(400);
    }
    expect(await isInstanceReady(database.db)).toBe(false);
  });
  it("enforces exact Origin/JSON and bounded streamed body", async () => {
    expect(
      (
        await start(
          request("initial-mfa/start", startBody, cookie, {
            Origin: "https://evil.example",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await start(
          request("initial-mfa/start", startBody, cookie, {
            "Content-Type": "application/jsonjunk",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await start(
          request("initial-mfa/start", startBody, cookie, {
            "Content-Length": "4097",
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await start(
          request("initial-mfa/start", {
            ...startBody,
            padding: "x".repeat(4096),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await complete(
          request("initial-mfa/complete", {}, cookie, {
            Origin: "https://evil.example",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await complete(
          request("initial-mfa/complete", {}, cookie, {
            "Content-Type": "text/plain",
          }),
        )
      ).status,
    ).toBe(415);
  });
  it.each([
    "enabled-no-factor",
    "verified-disabled",
    "enabled-pending",
    "foreign-factor",
    "missing-state",
    "expired-session",
  ])("fails closed for %s", async (corruption) => {
    if (
      ["verified-disabled", "enabled-pending", "foreign-factor"].includes(
        corruption,
      )
    )
      await begin();
    if (corruption.startsWith("enabled"))
      await database.db.update(user).set({ twoFactorEnabled: true });
    if (corruption === "verified-disabled")
      await database.db.update(twoFactor).set({ verified: true });
    if (corruption === "foreign-factor") {
      const id = randomUUID();
      await database.db
        .insert(user)
        .values({ id, name: "Other", email: "other@example.test" });
      await database.db.update(twoFactor).set({ userId: id });
    }
    if (corruption === "expired-session")
      await database.db.update(session).set({ expiresAt: new Date(0) });
    const states = await database.db.select().from(instanceState);
    if (corruption === "missing-state") await database.db.delete(instanceState);
    try {
      expect((await begin()).status).toBe(403);
      expect((await finish("000000")).status).toBe(403);
      expect(await isInstanceReady(database.db)).toBe(false);
    } finally {
      if (corruption === "missing-state")
        await database.db.insert(instanceState).values(states[0]);
    }
  });
  it("rolls back MFA publication when authoritative revocation cannot be confirmed", async () => {
    await begin();
    await database.client`CREATE FUNCTION prevent_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
    await database.client`CREATE TRIGGER prevent_session_delete BEFORE DELETE ON session FOR EACH ROW EXECUTE FUNCTION prevent_session_delete()`;
    try {
      expect((await finish(await code())).status).toBe(503);
      expect(await isInstanceReady(database.db)).toBe(false);
      expect((await database.db.select().from(twoFactor))[0].verified).toBe(
        false,
      );
      expect(
        await getValidOwnerSession(auth, new Headers({ cookie })),
      ).not.toBeNull();
    } finally {
      await database.client`DROP TRIGGER prevent_session_delete ON session`;
      await database.client`DROP FUNCTION prevent_session_delete()`;
    }
  });
  it("returns a closed no-store response on database failure", async () => {
    const saved = runtime.db;
    runtime.db = {
      execute: () => {
        throw new Error("database unavailable");
      },
    };
    try {
      const response = await begin();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      runtime.db = saved;
    }
  });
  it("serializes competing completions; one succeeds and stale authority fails", async () => {
    await begin();
    const valid = await code();
    let attempts: Promise<Response>[] = [];
    await control.client.begin(async (barrier) => {
      await barrier`SELECT pg_advisory_xact_lock(${boundaryKey})`;
      attempts = [finish(valid), finish(valid), finish(valid)];
      await waitBoundaryWaiters(3);
    });
    const responses = await Promise.all(attempts);
    expect(responses.map((value) => value.status).sort()).toEqual([
      200, 403, 403,
    ]);
    await readyWithNoSessions();
  });
  it("completion queued first excludes independent password requests from READY and hides temporary sessions", async () => {
    await begin();
    const valid = await code();
    let completion!: Promise<Response>;
    let attempts: Promise<Response>[] = [];
    await control.client.begin(async (barrier) => {
      await barrier`SELECT pg_advisory_xact_lock(${boundaryKey})`;
      completion = finish(valid);
      await waitBoundaryWaiters(1);
      // Independent pools and independent Auth instances, DB FIFO waits.
      attempts = Array.from({ length: 6 }, (_, index) =>
        login(index % 2 ? auth : otherAuth),
      );
      await waitBoundaryWaiters(7);
    });
    expect((await completion).status).toBe(200);
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["totp"],
      });
      expect(
        await getValidBusinessSession(
          auth,
          new Headers({ cookie: cookies(response) }),
        ),
      ).toBeNull();
    }
    await readyWithNoSessions();
  });
  it("login queued first finishes before completion; all its password cookies are revoked", async () => {
    await begin();
    const valid = await code();
    let completion!: Promise<Response>;
    let attempts: Promise<Response>[] = [];
    await control.client.begin(async (barrier) => {
      await barrier`SELECT pg_advisory_xact_lock(${boundaryKey})`;
      attempts = Array.from({ length: 6 }, (_, index) =>
        login(index % 2 ? auth : otherAuth),
      );
      await waitBoundaryWaiters(6);
      completion = finish(valid);
      await waitBoundaryWaiters(7);
    });
    const responses = await Promise.all(attempts);
    expect((await completion).status).toBe(200);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.json()).twoFactorRedirect).toBeUndefined();
      expect(
        await getValidOwnerSession(
          auth,
          new Headers({ cookie: cookies(response) }),
        ),
      ).toBeNull();
      expect(
        await getValidBusinessSession(
          auth,
          new Headers({ cookie: cookies(response) }),
        ),
      ).toBeNull();
    }
    await readyWithNoSessions();
  });
  it("holds the boundary across password verification, session INSERT, and commit", async () => {
    await begin();
    const valid = await code();
    await control.client`CREATE FUNCTION pause_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(1296125024); RETURN NEW; END $$`;
    await control.client`CREATE TRIGGER pause_session_insert BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION pause_session_insert()`;
    let completion!: Promise<Response>;
    let signingIn!: Promise<Response>;
    try {
      await control.client.begin(async (barrier) => {
        await barrier`SELECT pg_advisory_xact_lock(1296125024)`;
        signingIn = login(otherAuth);
        await waitInsert();
        completion = finish(valid);
        await waitBoundaryWaiters(1);
        expect(await isInstanceReady(database.db)).toBe(false);
      });
      const response = await signingIn;
      expect((await completion).status).toBe(200);
      expect(
        await getValidBusinessSession(
          auth,
          new Headers({ cookie: cookies(response) }),
        ),
      ).toBeNull();
      await readyWithNoSessions();
    } finally {
      await control.client`DROP TRIGGER pause_session_insert ON session`;
      await control.client`DROP FUNCTION pause_session_insert()`;
    }
  });
  it("direct username/email API calls join the same PostgreSQL boundary", async () => {
    for (const method of ["signInUsername", "signInEmail"] as const) {
      let pending!: Promise<unknown>;
      await control.client.begin(async (barrier) => {
        await barrier`SELECT pg_advisory_xact_lock(${boundaryKey})`;
        pending =
          method === "signInUsername"
            ? otherAuth.api.signInUsername({
                body: { username: "owner-01", password },
              })
            : otherAuth.api.signInEmail({
                body: { email: "owner@localhost.invalid", password },
              });
        await waitBoundaryWaiters(1);
      });
      await pending;
    }
  });
  it("every enabled plugin/credential session-issuing server API enters the boundary before validation", async () => {
    for (const name of [
      "signInUsername",
      "signInEmail",
      "enableTwoFactor",
      "disableTwoFactor",
      "verifyTOTP",
      "verifyBackupCode",
      "verifyTwoFactorOTP",
      "changePassword",
    ] as const) {
      let pending!: Promise<unknown>;
      await control.client.begin(async (barrier) => {
        await barrier`SELECT pg_advisory_xact_lock(${boundaryKey})`;
        pending = (
          Reflect.apply(otherAuth.api[name], undefined, [
            { body: {} },
          ]) as Promise<unknown>
        ).catch((error: unknown) => error);
        await waitBoundaryWaiters(1);
      });
      expect(await pending).toBeInstanceOf(Error);
    }
  });
  it("never publishes the temporary password session while the MFA after hook is pending", async () => {
    await begin();
    expect((await finish(await code())).status).toBe(200);
    await control.client`CREATE FUNCTION pause_temporary_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(1296125025); RETURN NEW; END $$`;
    await control.client`CREATE TRIGGER pause_temporary_session AFTER INSERT ON session FOR EACH ROW EXECUTE FUNCTION pause_temporary_session()`;
    let pending!: Promise<Response>;
    try {
      await control.client.begin(async (barrier) => {
        await barrier`SELECT pg_advisory_xact_lock(1296125025)`;
        pending = login(otherAuth);
        await waitInsert();
        // The row was INSERTed on the other connection, but remains uncommitted.
        expect(await isInstanceReady(database.db)).toBe(true);
        expect(await database.db.select().from(session)).toHaveLength(0);
        expect(
          await getValidBusinessSession(auth, new Headers({ cookie })),
        ).toBeNull();
      });
      expect(await (await pending).json()).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["totp"],
      });
      await readyWithNoSessions();
    } finally {
      await control.client`DROP TRIGGER pause_temporary_session ON session`;
      await control.client`DROP FUNCTION pause_temporary_session()`;
    }
  });
  it("rejects duplicate factors without repairing them", async () => {
    await begin();
    const [factor] = await database.db.select().from(twoFactor);
    await database.client`DROP INDEX two_factor_user_id_unique`;
    try {
      await database.db
        .insert(twoFactor)
        .values({ ...factor, id: randomUUID() });
      expect((await begin()).status).toBe(403);
      expect((await finish("000000")).status).toBe(403);
      expect(await database.db.select().from(twoFactor)).toHaveLength(2);
      expect(await isInstanceReady(database.db)).toBe(false);
    } finally {
      await database.client`DELETE FROM two_factor WHERE id <> ${factor.id}`;
      await database.client`CREATE UNIQUE INDEX two_factor_user_id_unique ON two_factor(user_id)`;
    }
  });
  it("bounds authorized enrollment attempts persistently before expensive verification", async () => {
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await begin()).status).toBe(200);
    const response = await begin();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await database.db.select().from(twoFactor)).toHaveLength(1);
  });
  it("denies an in-flight business read whose exact session was revoked by real completion", async () => {
    await begin();
    const owner = await getValidOwnerSession(
      otherAuth,
      new Headers({ cookie }),
    );
    expect(owner).not.toBeNull();
    expect((await finish(await code())).status).toBe(200);
    expect(
      await isInstanceReady(independent.db, owner!.user.id, owner!.session.id),
    ).toBe(false);
    await readyWithNoSessions();
  });
  it("sensitive enrollment values are not logged", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      const material = await (await begin()).json();
      const [factor] = await database.db.select().from(twoFactor);
      const backups = JSON.parse(
        await symmetricDecrypt({
          key: config.authSecret,
          data: factor.backupCodes,
        }),
      );
      expect((await finish(await code())).status).toBe(200);
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const value of [
        bootstrapSecret,
        material.totpURI,
        new URL(material.totpURI).searchParams.get("secret"),
        ...backups,
      ]) {
        expect(logged).not.toContain(value);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  async function enroll() {
    const started = await begin();
    expect(started.status).toBe(200);
    const [original] = await database.db.select().from(twoFactor);
    const originals = (
      await auth.api.viewBackupCodes({ body: { userId: original.userId } })
    ).backupCodes;
    const completed = await finish(await code());
    expect(completed.status).toBe(200);
    const result = await completed.json();
    expect(result.recoveryCodes).toEqual(originals);
    expect((await database.db.select().from(twoFactor))[0].backupCodes).toBe(
      original.backupCodes,
    );
    expect(original.backupCodes).not.toContain(originals[0]);
    await readyWithNoSessions();
    return result.recoveryCodes as string[];
  }

  async function challenge(engine = auth) {
    const response = await login(engine);
    expect((await response.json()).twoFactorRedirect).toBe(true);
    expect(await database.db.select().from(session)).toHaveLength(0);
    expect(
      await getValidBusinessSession(
        auth,
        new Headers({ cookie: cookies(response) }),
      ),
    ).toBeNull();
    return cookies(response);
  }

  function verify(
    method: "totp" | "recovery",
    suppliedCookie: string,
    input: unknown,
  ) {
    return (method === "totp" ? verifyTotp : verifyRecovery)(
      request(`mfa/${method}`, input, suppliedCookie),
    );
  }

  function noTrust(response: Response) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      response.headers
        .getSetCookie()
        .filter((value) => value.includes("trust_device="))
        .every((value) => value.includes("Max-Age=0")),
    ).toBe(true);
  }

  it("F2.3 routes a pending owner to enrollment, then READY to fresh login", async () => {
    expect(await ownerLanding(auth, new Headers({ cookie }))).toBe(
      "/initial-mfa",
    );
    expect(
      await getValidBusinessSession(auth, new Headers({ cookie })),
    ).toBeNull();
    await enroll();
    expect(await ownerLanding(auth, new Headers({ cookie }))).toBe("/login");
    const second = await challenge();
    const response = await verify("totp", second, { code: await code() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    noTrust(response);
    expect(
      await ownerLanding(auth, new Headers({ cookie: cookies(response) })),
    ).toBe("/");
    const [created] = await database.db.select().from(session);
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(
      sessionInactivitySeconds * 1000,
    );
    expect(
      created.absoluteExpiresAt.getTime() - created.createdAt.getTime(),
    ).toBe(sessionAbsoluteMs);
    expect((await verify("totp", second, { code: await code() })).status).toBe(
      401,
    );
    expect(await database.db.select().from(session)).toHaveLength(1);
    expect(
      (await database.db.select().from(verification)).some((row) =>
        row.identifier.startsWith("trust-device-"),
      ),
    ).toBe(false);
    await database.db.update(session).set({ absoluteExpiresAt: new Date(0) });
    expect(
      await getValidBusinessSession(
        auth,
        new Headers({ cookie: cookies(response) }),
      ),
    ).toBeNull();
  });

  it("F2.3 actual pages close setup, route pending owners without loops, and deny READY enrollment", async () => {
    const redirected = (path: string) =>
      expect.objectContaining({ digest: expect.stringContaining(`;${path};`) });
    await expect(SetupPage()).rejects.toEqual(redirected("/login"));
    await expect(LoginPage()).rejects.toEqual(redirected("/initial-mfa"));
    await expect(InitialMfaPage()).resolves.toBeTruthy();
    runtime.headers = new Headers();
    await expect(InitialMfaPage()).rejects.toEqual(redirected("/login"));
    await expect(LoginPage()).resolves.toBeTruthy();
    runtime.headers = new Headers({ cookie });
    await enroll();
    await expect(InitialMfaPage()).rejects.toEqual(redirected("/login"));
    await expect(LoginPage()).resolves.toBeTruthy();
    const success = await verify("totp", await challenge(), {
      code: await code(),
    });
    runtime.headers = new Headers({ cookie: cookies(success) });
    await expect(LoginPage()).rejects.toEqual(redirected("/"));
    await expect(InitialMfaPage()).rejects.toEqual(redirected("/login"));
  });

  it("F2.3 preserves failed attempt/account counters and refuses missing/expired challenges", async () => {
    await enroll();
    const second = await challenge();
    const valid = await code();
    const wrong = valid === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const failed = await verify("totp", second, { code: wrong });
      expect(failed.status).toBe(401);
      expect((await failed.json()).restart).toBe(false);
      expect(
        (await database.db.select().from(twoFactor))[0].failedVerificationCount,
      ).toBe(i + 1);
    }
    expect(
      (await (await verify("totp", second, { code: valid })).json()).restart,
    ).toBe(true);
    expect(
      (await (await verify("totp", "", { code: valid })).json()).restart,
    ).toBe(true);
    const expired = await challenge();
    await database.db.update(verification).set({ expiresAt: new Date(0) });
    expect(
      (await (await verify("totp", expired, { code: valid })).json()).restart,
    ).toBe(true);
    expect(await database.db.select().from(session)).toHaveLength(0);
  });

  it("F2.3 returns original codes once; recovery requires password and consumes only its chosen code", async () => {
    const codes = await enroll();
    const replay = await finish(await code());
    expect(replay.status).toBe(403);
    expect(await replay.json()).not.toHaveProperty("recoveryCodes");
    expect((await verify("recovery", "", { code: codes[0] })).status).toBe(401);
    const second = await challenge();
    const successful = await verify("recovery", second, { code: codes[0] });
    expect(successful.status).toBe(200);
    noTrust(successful);
    expect(
      await getValidBusinessSession(
        auth,
        new Headers({ cookie: cookies(successful) }),
      ),
    ).not.toBeNull();
    const [factor] = await database.db.select().from(twoFactor);
    const remaining = (
      await auth.api.viewBackupCodes({ body: { userId: factor.userId } })
    ).backupCodes;
    expect(remaining).toEqual(codes.slice(1));
    await database.db.delete(session);
    expect(
      (await verify("recovery", await challenge(), { code: codes[0] })).status,
    ).toBe(401);
    expect(
      (await verify("recovery", await challenge(), { code: codes[1] })).status,
    ).toBe(200);
  });

  it("F2.3 same recovery code on independent concurrent PostgreSQL challenges succeeds EXACTLY once", async () => {
    const codes = await enroll();
    const challenges: string[] = [];
    for (let i = 0; i < 4; i++)
      challenges.push(await challenge(i % 2 ? auth : otherAuth));
    let pending: Promise<Response>[] = [];
    await control.client.begin(async (barrier) => {
      await barrier`SELECT pg_advisory_xact_lock(${boundaryKey})`;
      pending = challenges.map((suppliedCookie) =>
        verify("recovery", suppliedCookie, { code: codes[0] }),
      );
      await waitBoundaryWaiters(4);
    });
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401, 401, 401,
    ]);
    expect(await database.db.select().from(session)).toHaveLength(1);
    const [factor] = await database.db.select().from(twoFactor);
    expect(
      (await auth.api.viewBackupCodes({ body: { userId: factor.userId } }))
        .backupCodes,
    ).toEqual(codes.slice(1));
    await database.db.delete(session);
    expect(
      (await verify("recovery", await challenge(), { code: codes[0] })).status,
    ).toBe(401);
  });

  it("F2.3 rejects all extra plugin fields and exact-Origin/media-type/body violations", async () => {
    const codes = await enroll();
    const second = await challenge();
    for (const method of ["totp", "recovery"] as const) {
      const input = { code: method === "totp" ? await code() : codes[0] };
      for (const extra of [
        { trustDevice: true },
        { trustDevice: false },
        { disableSession: true },
        { method: "otp" },
        { userId: "other" },
      ])
        expect(
          (await verify(method, second, { ...input, ...extra })).status,
        ).toBe(400);
      const route = method === "totp" ? verifyTotp : verifyRecovery;
      for (const [headers, status] of [
        [{ Origin: "https://evil.example" }, 403],
        [{ "Content-Type": "text/plain" }, 415],
        [{ "Content-Length": "4097" }, 413],
      ] as const)
        expect(
          (await route(request(`mfa/${method}`, input, second, headers)))
            .status,
        ).toBe(status);
      expect(
        (
          await route(
            request(
              `mfa/${method}`,
              { ...input, padding: "x".repeat(4096) },
              second,
            ),
          )
        ).status,
      ).toBe(413);
    }
    expect(await database.db.select().from(session)).toHaveLength(0);
  });

  it("F2.3 cancellation only expires engine cookies and bounds stale rows to 600 seconds", async () => {
    await enroll();
    const second = await challenge();
    const before = await database.db.select().from(verification);
    const cancelled = await cancelChallenge(request("mfa/cancel", {}, second));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ cancelled: true });
    expect(
      cancelled.headers
        .getSetCookie()
        .every((value) => value.includes("Max-Age=0")),
    ).toBe(true);
    expect(await database.db.select().from(session)).toHaveLength(0);
    expect(await database.db.select().from(verification)).toEqual(before);
    expect(
      before.every((row) => row.expiresAt.getTime() <= Date.now() + 600000),
    ).toBe(true);
    expect(
      (await verify("totp", cookies(cancelled), { code: await code() })).status,
    ).toBe(401);
    expect(
      (
        await cancelChallenge(
          request("mfa/cancel", { trustDevice: true }, second),
        )
      ).status,
    ).toBe(400);
    expect(
      (await verify("totp", await challenge(), { code: await code() })).status,
    ).toBe(200);
  });

  it("F2.3 refuses the existing-session branch and rolls back non-owner issuance", async () => {
    await enroll();
    const first = await verify("totp", await challenge(), {
      code: await code(),
    });
    expect(first.status).toBe(200);
    expect(
      (await verify("totp", cookies(first), { code: await code() })).status,
    ).toBe(401);
    await database.db.delete(session);
    const second = await challenge();
    const [owner] = await database.db.select().from(user);
    const id = randomUUID();
    await database.db.insert(user).values({
      id,
      name: "Other",
      email: "other@example.test",
      twoFactorEnabled: true,
    });
    const [factor] = await database.db.select().from(twoFactor);
    // A challenge bound to a foreign user must never produce business access.
    await database.db
      .insert(twoFactor)
      .values({ ...factor, id: randomUUID(), userId: id });
    await database.db
      .update(verification)
      .set({ value: id })
      .where((await import("drizzle-orm")).eq(verification.value, owner.id));
    expect((await verify("totp", second, { code: await code() })).status).toBe(
      503,
    );
    expect(await database.db.select().from(session)).toHaveLength(0);
  });

  it("F2.3 ignores even a valid Better Auth trusted-device cookie at password login", async () => {
    await enroll();
    const second = await challenge();
    const privateResult = await auth.api.verifyTOTP({
      headers: new Headers({ cookie: second }),
      body: { code: await code(), trustDevice: true },
      asResponse: true,
    });
    expect(privateResult.status).toBe(200);
    const trusted = privateResult.headers
      .getSetCookie()
      .find((value) => value.includes("trust_device="))!;
    expect(trusted).toBeTruthy();
    await database.db.delete(session);
    const loginWithTrust = await auth.handler(
      request(
        "sign-in/username",
        { username: "owner-01", password },
        trusted.split(";")[0],
      ),
    );
    expect((await loginWithTrust.json()).twoFactorRedirect).toBe(true);
    expect(await database.db.select().from(session)).toHaveLength(0);
  });

  it("F2.3 never logs secret/challenge/session values on success, invalid code or cancellation", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      const codes = await enroll();
      const second = await challenge();
      const totp = await code();
      await verify("totp", second, { code: "999999" });
      const success = await verify("recovery", second, { code: codes[0] });
      expect(success.status).toBe(200);
      await cancelChallenge(request("mfa/cancel", {}, second));
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const value of [
        password,
        bootstrapSecret,
        totp,
        ...codes,
        second,
        cookies(success),
      ])
        expect(logged).not.toContain(value);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
