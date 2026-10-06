import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
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
import { initializeOwner } from "@/modules/auth/application/instance-auth";
import {
  startInitialMfa,
  completeInitialMfa,
} from "@/modules/auth/application/initial-mfa";
import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import { verifyMfaLogin } from "@/modules/auth/application/mfa-login";
import { getValidBusinessSession } from "@/modules/auth/application/session-validation";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import {
  managementSchema,
  startAuthenticatorReplacement,
  regenerateRecoveryCodes,
  resumeAuthenticatorReplacement,
  completeAuthenticatorReplacement,
  replacementCookie,
} from "@/modules/auth/application/mfa-management";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  account,
  instanceState,
  mfaReplacement,
  session,
  twoFactor,
  user,
  verification,
  rateLimit,
  authAdmission,
} from "@/shared/infrastructure/database/schema";
import { createLogger } from "@/shared/infrastructure/logging/logger";

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
import { POST as regenerate } from "@/app/api/auth/mfa/manage/recovery/regenerate/route";
import { POST as start } from "@/app/api/auth/mfa/manage/authenticator/start/route";
import { POST as resume } from "@/app/api/auth/mfa/manage/authenticator/resume/route";
import { POST as complete } from "@/app/api/auth/mfa/manage/authenticator/complete/route";
import { POST as genericAuth } from "@/app/api/auth/[...all]/route";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const key = 1296125023;
let container: StartedTestContainer;
let database: ReturnType<typeof createDatabase>;
let independent: ReturnType<typeof createDatabase>;
let control: ReturnType<typeof createDatabase>;
let config: AppConfig;
let auth: ReturnType<typeof createAuth>;
let otherAuth: ReturnType<typeof createAuth>;
let cookie: string;
let oldCodes: string[];
let oldSecret: string;
let ownerId: string;
const headers = (supplied = cookie) =>
  new Headers({ cookie: supplied, Origin: origin });
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
function request(
  path: string,
  body: unknown,
  supplied = cookie,
  extra: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      cookie: supplied,
      Origin: origin,
      "Content-Type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
const proof = (
  type: "totp" | "recovery",
  code: string,
  suppliedPassword = password,
) => ({ password: suppliedPassword, proofType: type, proofCode: code });
async function totp(secret = oldSecret) {
  return (await auth.api.generateTOTP({ body: { secret } })).code;
}
async function login(engine = auth) {
  return engine.api.signInUsername({
    headers: new Headers({ Origin: origin }),
    body: { username: "owner-01", password },
    asResponse: true,
  });
}
async function factorSecret() {
  const [factor] = await database.db.select().from(twoFactor);
  return symmetricDecrypt({
    key: (await auth.$context).secretConfig,
    data: factor.secret,
  });
}
async function snapshot() {
  return JSON.stringify({
    factors: await database.db.select().from(twoFactor),
    sessions: await database.db.select().from(session),
    owners: await database.db.select().from(user),
    replacements: await database.db.select().from(mfaReplacement),
  });
}
async function managed(
  operation: "start" | "regenerate",
  input: ReturnType<typeof proof>,
  db = database.db,
  supplied = cookie,
) {
  const req = request("/api/auth/mfa/manage", input, supplied);
  return initialMfaHttp(
    req,
    config,
    managementSchema,
    (parsed) =>
      operation === "start"
        ? startAuthenticatorReplacement(db, config, req.headers, parsed)
        : regenerateRecoveryCodes(db, config, req.headers, parsed),
    "MFA management could not be completed.",
  );
}
async function started(type: "totp" | "recovery" = "totp") {
  const response = await managed(
    "start",
    proof(type, type === "totp" ? await totp() : oldCodes[0]),
  );
  expect(response.status).toBe(200);
  return cookies(response)
    .split("; ")
    .find((value) => value.startsWith(replacementCookie + "="))!;
}
async function waitForWaiters(count: number) {
  const deadline = Date.now() + 15_000;
  while (true) {
    const rows =
      await control.client`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${key} AND NOT granted`;
    if (rows.length >= count) return;
    if (Date.now() > deadline)
      throw new Error("MFA operations did not reach PostgreSQL boundary");
    await delay(15);
  }
}
async function orderedRace<A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>,
) {
  let a!: Promise<A>, b!: Promise<B>;
  await control.client.begin(async (barrier) => {
    await barrier`SELECT pg_advisory_xact_lock(${key})`;
    a = first();
    await waitForWaiters(1);
    b = second();
    await waitForWaiters(2);
  });
  return Promise.all([a, b]);
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "management",
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
    DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/management`,
    AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
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
  await database.db
    .update(instanceState)
    .set({ initializedAt: null, ownerUserId: null });
  await database.db.delete(user);
  await database.db.delete(verification);
  await database.db.delete(rateLimit);
  await database.db.delete(authAdmission);
  await initializeOwner(
    database.db,
    { bootstrapSecret, username: "owner-01", password },
    config,
  );
  ownerId = (await database.db.select().from(user))[0].id;
  cookie = cookies(await login());
  await startInitialMfa(database.db, config, headers(), {
    bootstrapSecret,
    password,
  });
  oldSecret = await factorSecret();
  const enrolled = await completeInitialMfa(database.db, config, headers(), {
    bootstrapSecret,
    code: await totp(),
  });
  oldCodes = (await enrolled.json()).recoveryCodes;
  const challenge = cookies(await login());
  cookie = cookies(
    await verifyMfaLogin(
      database.db,
      config,
      headers(challenge),
      await totp(),
      "totp",
    ),
  );
  expect(await getValidBusinessSession(auth, headers())).not.toBeNull();
});
afterAll(async () => {
  await database?.client.end();
  await independent?.client.end();
  await control?.client.end();
  await container?.stop();
});

describe("F2.4 recovery regeneration", () => {
  it.each(["totp", "recovery"] as const)(
    "%s proof replaces all codes atomically without changing authenticator or session",
    async (type) => {
      const beforeSessions = await database.db.select().from(session);
      const response = await regenerate(
        request(
          "/api/auth/mfa/manage/recovery/regenerate",
          proof(type, type === "totp" ? await totp() : oldCodes[0]),
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toEqual([]);
      const { recoveryCodes } = await response.json();
      expect(recoveryCodes).toHaveLength(10);
      expect(await factorSecret()).toBe(oldSecret);
      expect(await database.db.select().from(session)).toEqual(beforeSessions);
      expect(
        await getValidBusinessSession(otherAuth, headers()),
      ).not.toBeNull();
      const stored = await snapshot();
      for (const code of recoveryCodes) expect(stored).not.toContain(code);
      const original = await auth.api.viewBackupCodes({
        body: { userId: ownerId },
      });
      expect(original.backupCodes).toEqual(recoveryCodes);
      for (const [index, code] of oldCodes.entries()) {
        expect(recoveryCodes).not.toContain(code);
        const invalid = await managed("regenerate", proof("recovery", code));
        // F8: after five rejected old codes, the shared management factor
        // budget denies further proof work. Normal login has a separate budget.
        expect(invalid.status).toBe(index < 5 ? 403 : 429);
      }
      expect(
        (
          await database.db
            .select()
            .from(authAdmission)
            .where(eq(authAdmission.key, "manage:factor"))
        )[0].count,
      ).toBe(5);
      const challenge = cookies(await login());
      const recoveryLogin = await verifyMfaLogin(
        independent.db,
        config,
        headers(challenge),
        recoveryCodes[0],
        "recovery",
      );
      expect(recoveryLogin.status).toBe(200);
      expect(
        await getValidBusinessSession(
          otherAuth,
          headers(cookies(recoveryLogin)),
        ),
      ).not.toBeNull();
      expect(
        (
          await verifyMfaLogin(
            database.db,
            config,
            headers(cookies(await login())),
            await totp(),
            "totp",
          )
        ).status,
      ).toBe(200);
    },
  );
  it.each(["password", "totp", "recovery", "reused"])(
    "rejects wrong %s with generic errors and no mutation",
    async (failure) => {
      const input = proof(
        failure === "recovery" || failure === "reused" ? "recovery" : "totp",
        failure === "totp" ? "------" : await totp(),
        failure === "password" ? "incorrect password" : password,
      );
      if (failure === "totp")
        input.proofCode = (Number(await totp()) + 333333)
          .toString()
          .padStart(6, "0")
          .slice(-6);
      if (failure === "recovery") input.proofCode = "zzzzz-zzzzz";
      if (failure === "reused") {
        await auth.api.verifyBackupCode({
          headers: headers(),
          body: { code: oldCodes[0], disableSession: true },
        });
        input.proofCode = oldCodes[0];
      }
      const before = await snapshot();
      const response = await managed("regenerate", input);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "MFA management could not be completed.",
      });
      expect(await snapshot()).toBe(before);
    },
  );
  it("rollback on database write/commit failure returns no plaintext and preserves original authority", async () => {
    await control.client`CREATE FUNCTION reject_recovery_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected storage failure'; END $$`;
    await control.client`CREATE CONSTRAINT TRIGGER fail_recovery_commit AFTER UPDATE ON two_factor DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_recovery_write()`;
    const before = await snapshot();
    try {
      const response = await managed(
        "regenerate",
        proof("recovery", oldCodes[0]),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("recoveryCodes");
      expect(await snapshot()).toBe(before);
    } finally {
      await control.client`DROP TRIGGER fail_recovery_commit ON two_factor`;
      await control.client`DROP FUNCTION reject_recovery_write()`;
    }
  });
  it("serializes concurrent TOTP regenerations; only the final set is authoritative", async () => {
    const input = proof("totp", await totp());
    const [a, b] = await orderedRace(
      () => managed("regenerate", input),
      () => managed("regenerate", input, independent.db),
    );
    expect([a.status, b.status]).toEqual([200, 200]);
    const first = (await a.json()).recoveryCodes,
      second = (await b.json()).recoveryCodes;
    expect(first).not.toEqual(second);
    expect(
      (await auth.api.viewBackupCodes({ body: { userId: ownerId } }))
        .backupCodes,
    ).toEqual(second);
    expect((await database.db.select().from(session)).length).toBe(1);
  });
  it("same recovery proof can authorize only one concurrent regeneration", async () => {
    const input = proof("recovery", oldCodes[0]);
    const [a, b] = await orderedRace(
      () => managed("regenerate", input),
      () => managed("regenerate", input, independent.db),
    );
    expect([a.status, b.status]).toEqual([200, 403]);
  });
});

describe("F2.4 replacement authority and transitions", () => {
  it.each(["totp", "recovery"] as const)(
    "%s start revokes all sessions and challenges, invalidates old factor, completes once and requires fresh MFA login",
    async (type) => {
      const second = await verifyMfaLogin(
        independent.db,
        config,
        headers(cookies(await login(otherAuth))),
        await totp(),
        "totp",
      );
      const pendingChallenge = cookies(await login());
      expect((await database.db.select().from(session)).length).toBe(2);
      const oldFactor = (await database.db.select().from(twoFactor))[0];
      const ceremony = await started(type);
      expect(await isInstanceReady(independent.db)).toBe(false);
      expect(await getValidBusinessSession(otherAuth, headers())).toBeNull();
      expect(
        await getValidBusinessSession(otherAuth, headers(cookies(second))),
      ).toBeNull();
      expect(await database.db.select().from(session)).toEqual([]);
      const next = (await database.db.select().from(twoFactor))[0];
      expect(next.id).not.toBe(oldFactor.id);
      expect(next.secret).not.toBe(oldFactor.secret);
      expect(next.backupCodes).not.toBe(oldFactor.backupCodes);
      const plaintextToken = ceremony.split("=")[1];
      const records = await database.db.select().from(mfaReplacement);
      expect(records).toHaveLength(1);
      expect(records[0].tokenDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(records)).not.toContain(plaintextToken);
      expect((await login()).ok).toBe(false);
      expect(
        (
          await verifyMfaLogin(
            independent.db,
            config,
            headers(pendingChallenge),
            await totp(),
            "totp",
          )
        ).status,
      ).toBe(401);
      expect(await getValidBusinessSession(auth, headers(ceremony))).toBeNull();
      expect(
        (
          await managed(
            "regenerate",
            proof("totp", await totp()),
            independent.db,
            ceremony,
          )
        ).status,
      ).toBe(403);
      await expect(
        startInitialMfa(independent.db, config, headers(ceremony), {
          bootstrapSecret,
          password,
        }),
      ).rejects.toThrow();
      const restarted = createDatabase(config);
      let uri: string;
      try {
        const resumed = await resumeAuthenticatorReplacement(
          restarted.db,
          config,
          headers(ceremony),
        );
        expect(resumed).not.toBeInstanceOf(Response);
        uri = (resumed as { totpURI: string }).totpURI;
        expect(uri).toContain("otpauth://totp/");
      } finally {
        await restarted.client.end();
      }
      const newSecret = await factorSecret();
      expect(newSecret).not.toBe(oldSecret);
      const invalid = await completeAuthenticatorReplacement(
        independent.db,
        config,
        headers(ceremony),
        await totp(),
      );
      expect(invalid.status).toBe(403);
      expect(await isInstanceReady(database.db)).toBe(false);
      const completion = await complete(
        request(
          "/api/auth/mfa/manage/authenticator/complete",
          { code: await totp(newSecret) },
          ceremony,
        ),
      );
      expect(completion.status).toBe(200);
      expect(completion.headers.get("cache-control")).toBe("no-store");
      expect(
        completion.headers
          .getSetCookie()
          .find((value) => value.startsWith(replacementCookie)),
      ).toContain("Max-Age=0");
      const result = await completion.json();
      expect(result.freshLoginRequired).toBe(true);
      expect(result.recoveryCodes).toHaveLength(10);
      const currentCodes = (
        await auth.api.viewBackupCodes({ body: { userId: ownerId } })
      ).backupCodes;
      for (const oldCode of oldCodes)
        expect(currentCodes).not.toContain(oldCode);
      const oldRecoveryLogin = await verifyMfaLogin(
        independent.db,
        config,
        headers(cookies(await login(otherAuth))),
        oldCodes[0],
        "recovery",
      );
      expect(oldRecoveryLogin.status).toBe(401);
      expect(await isInstanceReady(independent.db)).toBe(true);
      expect(await database.db.select().from(session)).toEqual([]);
      expect(await database.db.select().from(mfaReplacement)).toEqual([]);
      const replay = await completeAuthenticatorReplacement(
        independent.db,
        config,
        headers(ceremony),
        await totp(newSecret),
      );
      expect(replay.status).toBe(403);
      expect(await replay.json()).not.toHaveProperty("recoveryCodes");
      expect(await getValidBusinessSession(otherAuth, headers())).toBeNull();
      expect(
        (
          await verifyMfaLogin(
            independent.db,
            config,
            headers(pendingChallenge),
            await totp(newSecret),
            "totp",
          )
        ).status,
      ).toBe(401);
      for (const code of oldCodes)
        expect(
          (await managed("regenerate", proof("recovery", code))).status,
        ).toBe(403);
      const newLogin = await verifyMfaLogin(
        independent.db,
        config,
        headers(cookies(await login(otherAuth))),
        await totp(newSecret),
        "totp",
      );
      expect(newLogin.status).toBe(200);
      expect(
        await getValidBusinessSession(otherAuth, headers(cookies(newLogin))),
      ).not.toBeNull();
      const recoveryLogin = await verifyMfaLogin(
        database.db,
        config,
        headers(cookies(await login())),
        result.recoveryCodes[0],
        "recovery",
      );
      expect(recoveryLogin.status).toBe(200);
      const stored = await snapshot();
      for (const value of [
        plaintextToken,
        newSecret,
        uri!,
        ...result.recoveryCodes,
      ])
        expect(stored).not.toContain(value);
      expect(
        (await database.db.select().from(verification)).some((row) =>
          row.identifier.startsWith("trust-device"),
        ),
      ).toBe(false);
      expect(
        completion.headers
          .getSetCookie()
          .filter((value) => value.includes("trust_device"))
          .every((value) => value.includes("Max-Age=0")),
      ).toBe(true);
      // A newer supported ceremony starts only after completion, fresh login
      // and another password/current-MFA proof. The previous bearer cannot
      // authorize the new factor even when a replacement record exists again.
      const newProof = proof("totp", await totp(newSecret));
      const denied = await managed(
        "start",
        newProof,
        independent.db,
        cookies(newLogin),
      );
      // This long regression spends the twelve-operation work window, including
      // stale-session calls. Denial cannot become a permanent owner lockout.
      expect(denied.status).toBe(429);
      await database.db
        .update(authAdmission)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(authAdmission.key, "work:management"));
      const newer = await managed(
        "start",
        newProof,
        independent.db,
        cookies(newLogin),
      );
      expect(newer.status).toBe(200);
      const newerCookie = cookies(newer)
        .split("; ")
        .find((value) => value.startsWith(replacementCookie + "="))!;
      expect(newerCookie).not.toBe(ceremony);
      expect(
        await resumeAuthenticatorReplacement(
          database.db,
          config,
          headers(newerCookie),
        ),
      ).not.toBeInstanceOf(Response);
      const stale = await resumeAuthenticatorReplacement(
        independent.db,
        config,
        headers(ceremony),
      );
      expect(stale).toBeInstanceOf(Response);
      expect((stale as Response).status).toBe(403);
    },
  );
  it.each(["password", "totp", "recovery", "reused"])(
    "wrong %s cannot begin replacement or alter state",
    async (failure) => {
      let input = proof("totp", await totp());
      if (failure === "password") input.password = "incorrect password";
      if (failure === "totp")
        input.proofCode = (Number(input.proofCode) + 333333)
          .toString()
          .padStart(6, "0")
          .slice(-6);
      if (failure === "recovery") input = proof("recovery", "zzzzz-zzzzz");
      if (failure === "reused") {
        await auth.api.verifyBackupCode({
          headers: headers(),
          body: { code: oldCodes[0], disableSession: true },
        });
        input = proof("recovery", oldCodes[0]);
      }
      const before = await snapshot();
      expect((await managed("start", input)).status).toBe(403);
      expect(await snapshot()).toBe(before);
    },
  );
  it("production cookie is narrowly scoped, HttpOnly, Secure, Strict and short lived", async () => {
    const production = { ...config, environment: "production" as const };
    // Real production auth cookies, not a test cookie passed into a production engine.
    const productionAuth = createAuth(production, database.db);
    const challenge = cookies(await login(productionAuth));
    const signed = await verifyMfaLogin(
      database.db,
      production,
      headers(challenge),
      await totp(),
      "totp",
    );
    const response = await startAuthenticatorReplacement(
      database.db,
      production,
      headers(cookies(signed)),
      proof("totp", await totp()),
    );
    const authority = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(replacementCookie))!;
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/api/auth/mfa/manage/authenticator",
      "Max-Age=600",
    ])
      expect(authority).toContain(attribute);
    expect(await response.json()).toEqual({ replacementStarted: true });
  });
  it("forged/missing/duplicated/expired authority fails closed; bootstrap cannot resume; no old factor is restored", async () => {
    const ceremony = await started();
    const record = (await database.db.select().from(mfaReplacement))[0];
    for (const supplied of [
      "",
      `${replacementCookie}=${"x".repeat(43)}`,
      `${replacementCookie}=${record.tokenDigest}`,
      `${replacementCookie}=${Buffer.from(record.tokenDigest, "hex").toString("base64url")}`,
      ceremony + "; " + ceremony,
    ]) {
      const response = await resume(
        request("/api/auth/mfa/manage/authenticator/resume", {}, supplied),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty("totpURI");
    }
    await database.db
      .update(mfaReplacement)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` });
    const response = await resume(
      request("/api/auth/mfa/manage/authenticator/resume", {}, ceremony),
    );
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(
      (
        await completeAuthenticatorReplacement(
          independent.db,
          config,
          headers(ceremony),
          await totp(await factorSecret()),
        )
      ).status,
    ).toBe(403);
    expect(await isInstanceReady(independent.db)).toBe(false);
    expect(await database.db.select().from(mfaReplacement)).toHaveLength(1);
    expect(await factorSecret()).not.toBe(oldSecret);
    expect((await login()).ok).toBe(false);
  });
  it("five failed new TOTP attempts persist across instances and exhaust the narrow ceremony", async () => {
    const ceremony = await started();
    const newCode = await totp(await factorSecret());
    const wrong = (Number(newCode) + 333333)
      .toString()
      .padStart(6, "0")
      .slice(-6);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await completeAuthenticatorReplacement(
            i % 2 ? database.db : independent.db,
            config,
            headers(ceremony),
            wrong,
          )
        ).status,
      ).toBe(403);
    expect(
      (await database.db.select().from(mfaReplacement))[0].failedAttempts,
    ).toBe(5);
    expect(
      (
        await completeAuthenticatorReplacement(
          database.db,
          config,
          headers(ceremony),
          newCode,
        )
      ).status,
    ).toBe(403);
    expect(await isInstanceReady(independent.db)).toBe(false);
  });
});

describe("F2.4 synchronized race conditions A-F", () => {
  it.each([true, false])(
    "A regeneration vs recovery login, regeneration first=%s",
    async (regenerationFirst) => {
      const challenge = cookies(await login());
      const input = proof("recovery", oldCodes[0]);
      const regeneration = () => managed("regenerate", input);
      const recoveryLogin = () =>
        verifyMfaLogin(
          independent.db,
          config,
          headers(challenge),
          oldCodes[0],
          "recovery",
        );
      const responses = regenerationFirst
        ? await orderedRace(regeneration, recoveryLogin)
        : await orderedRace(recoveryLogin, regeneration);
      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(regenerationFirst ? 401 : 403);
    },
  );
  it.each([true, false])(
    "B replacement vs password login, replacement first=%s",
    async (replacementFirst) => {
      const input = proof("totp", await totp());
      const replacement = () => managed("start", input);
      const passwordLogin = () => login(otherAuth);
      const results = replacementFirst
        ? await orderedRace(replacement, passwordLogin)
        : await orderedRace(passwordLogin, replacement);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(!replacementFirst);
      expect(await database.db.select().from(session)).toEqual([]);
      expect(await isInstanceReady(independent.db)).toBe(false);
    },
  );
  it.each(["totp", "recovery"] as const)(
    "C replacement vs %s challenge completion",
    async (type) => {
      const challenge = cookies(await login());
      const code = type === "totp" ? await totp() : oldCodes[0];
      const currentTotp = await totp();
      const [a, b] = await orderedRace(
        () => managed("start", proof("totp", currentTotp)),
        () =>
          verifyMfaLogin(
            independent.db,
            config,
            headers(challenge),
            code,
            type,
          ),
      );
      expect([a.status, b.status]).toEqual([200, 401]);
      expect(await database.db.select().from(session)).toEqual([]);
    },
  );
  it.each(["totp", "recovery"] as const)(
    "C challenge %s completion winning before replacement is revoked by the later start",
    async (type) => {
      const challenge = cookies(await login());
      const code = type === "totp" ? await totp() : oldCodes[0];
      const input = proof("totp", await totp());
      const [a, b] = await orderedRace(
        () =>
          verifyMfaLogin(
            independent.db,
            config,
            headers(challenge),
            code,
            type,
          ),
        () => managed("start", input),
      );
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(
        await getValidBusinessSession(otherAuth, headers(cookies(a))),
      ).toBeNull();
      expect(await database.db.select().from(session)).toEqual([]);
    },
  );
  it("D two starts yield exactly one ceremony, and the second session is already revoked", async () => {
    const input = proof("totp", await totp());
    const [a, b] = await orderedRace(
      () => managed("start", input),
      () => managed("start", input, independent.db),
    );
    expect([a.status, b.status]).toEqual([200, 403]);
    expect(await database.db.select().from(mfaReplacement)).toHaveLength(1);
  });
  it("E simultaneous completion/replay returns recovery codes only to the first committed request", async () => {
    const ceremony = await started();
    const code = await totp(await factorSecret());
    const [a, b] = await orderedRace(
      () =>
        completeAuthenticatorReplacement(
          database.db,
          config,
          headers(ceremony),
          code,
        ),
      () =>
        completeAuthenticatorReplacement(
          independent.db,
          config,
          headers(ceremony),
          code,
        ),
    );
    expect([a.status, b.status]).toEqual([200, 403]);
    expect(await a.json()).toHaveProperty("recoveryCodes");
    expect(await b.json()).not.toHaveProperty("recoveryCodes");
    expect(await database.db.select().from(session)).toEqual([]);
  });
  it("F independent READY/business readers see pending before commit and READY without old sessions after commit", async () => {
    const ceremony = await started();
    const code = await totp(await factorSecret());
    await control.client`CREATE FUNCTION pause_factor_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.verified THEN PERFORM pg_advisory_xact_lock(1296125030); END IF; RETURN NEW; END $$`;
    await control.client`CREATE TRIGGER pause_factor_completion BEFORE UPDATE ON two_factor FOR EACH ROW EXECUTE FUNCTION pause_factor_completion()`;
    let completion!: Promise<Response>;
    try {
      await control.client.begin(async (barrier) => {
        await barrier`SELECT pg_advisory_xact_lock(1296125030)`;
        completion = completeAuthenticatorReplacement(
          database.db,
          config,
          headers(ceremony),
          code,
        );
        const deadline = Date.now() + 15_000;
        while (
          !(
            await control.client`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=1296125030 AND NOT granted`
          ).length
        ) {
          if (Date.now() > deadline)
            throw new Error("Completion did not reach update barrier");
          await delay(15);
        }
        expect(await isInstanceReady(independent.db)).toBe(false);
        expect(await getValidBusinessSession(otherAuth, headers())).toBeNull();
      });
      expect((await completion).status).toBe(200);
      expect(await isInstanceReady(independent.db)).toBe(true);
      expect(await getValidBusinessSession(otherAuth, headers())).toBeNull();
    } finally {
      await control.client`DROP TRIGGER pause_factor_completion ON two_factor`;
      await control.client`DROP FUNCTION pause_factor_completion()`;
    }
  });
});

describe("F2.4 management boundaries", () => {
  it("a real worker process observes replacement NOT READY, pauses consumers, and resumes after new enrollment", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/composition/worker-process.ts"],
      {
        env: {
          ...process.env,
          MAILDOCK_ENV: "test",
          APP_ORIGIN: origin,
          DATABASE_URL: config.databaseUrl,
          AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
          CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
          MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
          ATTACHMENTS_PATH: tmpdir(),
          LOG_LEVEL: "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (value) => {
      output += value.toString();
    });
    child.stderr.on("data", (value) => {
      output += value.toString();
    });
    async function waitEvent(event: string, count = 1) {
      const deadline = Date.now() + 30_000;
      while (output.split(`"event":"${event}"`).length - 1 < count) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Worker did not emit ${event}: ${output}`);
        await delay(20);
      }
    }
    try {
      await waitEvent("jobs.started");
      const ceremony = await started();
      await waitEvent("worker.mfa_pending");
      expect(await isInstanceReady(independent.db)).toBe(false);
      expect(
        (
          await completeAuthenticatorReplacement(
            independent.db,
            config,
            headers(ceremony),
            await totp(await factorSecret()),
          )
        ).status,
      ).toBe(200);
      await waitEvent("jobs.started", 2);
      expect(await isInstanceReady(independent.db)).toBe(true);
      for (const secret of [
        password,
        oldSecret,
        ceremony.split("=")[1],
        ...oldCodes,
      ])
        expect(output).not.toContain(secret);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
    }
  });
  it("failed replacement-start commit rolls back revocation, factor replacement and recovery proof consumption without returning authority", async () => {
    const before = await snapshot();
    await control.client`CREATE FUNCTION reject_replacement_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected commit failure'; END $$`;
    await control.client`CREATE CONSTRAINT TRIGGER fail_replacement_commit AFTER INSERT ON mfa_replacement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_replacement_commit()`;
    try {
      const response = await managed("start", proof("recovery", oldCodes[0]));
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).not.toHaveProperty("replacementStarted");
      expect(await snapshot()).toBe(before);
      expect(
        await getValidBusinessSession(otherAuth, headers()),
      ).not.toBeNull();
    } finally {
      await control.client`DROP TRIGGER fail_replacement_commit ON mfa_replacement`;
      await control.client`DROP FUNCTION reject_replacement_commit()`;
    }
  });
  it("failed completion commit discloses no codes and preserves the single-use pending authority for retry", async () => {
    const ceremony = await started();
    const code = await totp(await factorSecret());
    const before = await snapshot();
    await control.client`CREATE FUNCTION reject_completion_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected completion commit failure'; END $$`;
    await control.client`CREATE CONSTRAINT TRIGGER fail_completion_commit AFTER UPDATE ON "user" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_completion_commit()`;
    try {
      const response = await complete(
        request(
          "/api/auth/mfa/manage/authenticator/complete",
          { code },
          ceremony,
        ),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("recoveryCodes");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await snapshot()).toBe(before);
      expect(await isInstanceReady(independent.db)).toBe(false);
    } finally {
      await control.client`DROP TRIGGER fail_completion_commit ON "user"`;
      await control.client`DROP FUNCTION reject_completion_commit()`;
    }
    expect(
      (
        await completeAuthenticatorReplacement(
          independent.db,
          config,
          headers(ceremony),
          code,
        )
      ).status,
    ).toBe(200);
  });
  it.each(["non-owner", "expired", "absolute", "not-ready"])(
    "%s cannot perform either operation",
    async (failure) => {
      let supplied = cookie;
      if (failure === "non-owner") {
        const id = randomUUID();
        await database.db
          .insert(user)
          .values({ id, name: "other", email: "other@local.test" });
        const created = await (
          await auth.$context
        ).internalAdapter.createSession(id, false);
        // Sign through the engine cookie helper would require a login account;
        // a real non-owner credential account exercises the same public engine.
        await database.db.insert(account).values({
          id: randomUUID(),
          userId: id,
          accountId: id,
          providerId: "credential",
          password: (await auth.$context).password
            ? await (await auth.$context).password.hash(password)
            : "",
        });
        await database.db
          .update(user)
          .set({ username: "other-01" })
          .where(eq(user.id, id));
        supplied = cookies(
          await auth.api.signInUsername({
            headers: new Headers({ Origin: origin }),
            body: { username: "other-01", password },
            asResponse: true,
          }),
        );
        expect(created).toBeTruthy();
      }
      if (failure === "expired")
        await database.db
          .update(session)
          .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` });
      if (failure === "absolute")
        await database.db
          .update(session)
          .set({ absoluteExpiresAt: new Date(Date.now() - 1) });
      if (failure === "not-ready")
        await database.db.update(twoFactor).set({ verified: false });
      const before = await database.db.select().from(twoFactor);
      for (const operation of ["start", "regenerate"] as const)
        expect(
          (
            await managed(
              operation,
              proof("totp", await totp()),
              database.db,
              supplied,
            )
          ).status,
        ).toBe(403);
      expect(await database.db.select().from(twoFactor)).toEqual(before);
      expect(await database.db.select().from(mfaReplacement)).toEqual([]);
    },
  );
  it("all new HTTP mutations enforce exact Origin, JSON, bounded strict bodies and no-store", async () => {
    for (const route of [start, regenerate, resume, complete]) {
      for (const [extra, body, status] of [
        [{ Origin: "https://evil.test" }, {}, 403],
        [{ "Content-Type": "text/plain" }, {}, 415],
        [{ "Content-Length": "4097" }, {}, 413],
        [{}, { unexpected: true }, 400],
      ] as const) {
        const response = await route(
          request("/api/auth/mfa/manage", body, cookie, extra),
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
  });
  it("generic management/generation/view/disable routes remain blocked", async () => {
    for (const path of [
      "disable",
      "enable",
      "generate-backup-codes",
      "view-backup-codes",
      "get-totp-uri",
      "verify-totp",
      "verify-backup-code",
    ])
      expect(
        (
          await genericAuth(
            request(`/api/auth/two-factor/${path}`, { password }, cookie),
          )
        ).status,
      ).toBe(404);
  });
  it("logs redact new sensitive fields at root and nested levels", async () => {
    const values = {
      password: "PASSWORD_MARKER",
      proofCode: "PROOF_MARKER",
      secret: "SECRET_MARKER",
      totpURI: "URI_MARKER",
      recoveryCodes: ["RECOVERY_MARKER"],
      backupCodes: ["BACKUP_MARKER"],
      replacementAuthority: "AUTHORITY_MARKER",
      tokenDigest: "DIGEST_MARKER",
      sessionToken: "SESSION_MARKER",
      bootstrapSecret: "BOOTSTRAP_MARKER",
    };
    let output = "";
    const logger = createLogger(
      { logLevel: "info" },
      {
        write: (chunk) => {
          output += chunk;
        },
      },
    );
    logger.info({ ...values, details: { ...values } }, "MFA event");
    for (const value of Object.values(values).flat())
      expect(output).not.toContain(value);
    expect(output).toContain("[REDACTED]");
  });
});
