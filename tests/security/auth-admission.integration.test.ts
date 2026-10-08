import { initializeOwnerFixture } from "./mfa-fixture";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

import {
  startInitialMfa,
  completeInitialMfa,
} from "@/modules/auth/application/initial-mfa";
import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import { verifyMfaLogin } from "@/modules/auth/application/mfa-login";
import { getValidBusinessSession } from "@/modules/auth/application/session-validation";
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
  instanceState,
  mfaReplacement,
  session,
  twoFactor,
  user,
  verification,
  rateLimit,
  loginThrottle,
  authAdmission,
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
import { POST as regenerate } from "@/app/api/auth/mfa/manage/recovery/regenerate/route";
import { POST as start } from "@/app/api/auth/mfa/manage/authenticator/start/route";
import { POST as resume } from "@/app/api/auth/mfa/manage/authenticator/resume/route";
import { POST as complete } from "@/app/api/auth/mfa/manage/authenticator/complete/route";

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
  await database.db.delete(verification);
  await database.db.delete(rateLimit);
  await database.db.delete(loginThrottle);
  await database.db.delete(authAdmission);
  await initializeOwnerFixture(database.db, {
    bootstrapSecret,
    username: "owner-01",
    password,
  });
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
  // Fixture server logins now reserve the shared password work budget too.
  // Assertions below measure the submitted HTTP request, not fixture setup.
  await database.db
    .delete(authAdmission)
    .where(eq(authAdmission.key, "work:password"));
});
afterAll(async () => {
  await database?.client.end();
  await independent?.client.end();
  await control?.client.end();
  await container?.stop();
});

let authPost: typeof import("@/app/api/auth/[...all]/route").POST;
beforeAll(async () => {
  const route = await import("@/app/api/auth/[...all]/route");
  authPost = route.POST;
});
import { POST as totpPost } from "@/app/api/auth/mfa/totp/route";
import { POST as recoveryPost } from "@/app/api/auth/mfa/recovery/route";

async function badCode(secret = oldSecret) {
  const valid = await totp(secret);
  // Verify the candidate with the exact installed primitive, including its tolerance.
  const { createOTP } = await import("@better-auth/utils/otp");
  for (let n = 0; n < 100; n++) {
    const candidate = String(n).padStart(6, "0");
    if (
      candidate !== valid &&
      !(await createOTP(secret, { digits: 6, period: 30 }).verify(candidate))
    )
      return candidate;
  }
  throw new Error("No invalid test code");
}
import {
  reserveAuthWork,
  AuthThrottledError,
} from "@/modules/auth/infrastructure/auth-admission";
import * as passwords from "@/modules/auth/infrastructure/password";
import { forwardingHeaders } from "./ingress-forwarding-headers";
import { POST as cancelPost } from "@/app/api/auth/mfa/cancel/route";
async function bucket(key: string) {
  return (
    await independent.db
      .select()
      .from(authAdmission)
      .where(eq(authAdmission.key, key))
  )[0];
}
async function prime(key: string, count: number, seconds: number) {
  await database.db
    .insert(authAdmission)
    .values({ key, count, expiresAt: new Date(Date.now() + seconds * 1000) })
    .onConflictDoUpdate({
      target: authAdmission.key,
      set: { count, expiresAt: new Date(Date.now() + seconds * 1000) },
    });
}
async function httpLogin(
  engine = auth,
  username = "owner-01",
  suppliedPassword = password,
  ip = "192.0.2.1",
) {
  return engine.handler(
    request(
      "/api/auth/sign-in/username",
      { username, password: suppliedPassword },
      "",
      { "x-forwarded-for": ip },
    ),
  );
}

it("F8 A queued canonical case variants: only first reaches Argon2, failure commits before second admission", async () => {
  const verify = vi.spyOn(passwords, "verifyPassword");
  try {
    const responses = await orderedRace(
      () => httpLogin(auth, "OWNER-01", "wrong password one", "192.0.2.1"),
      () => httpLogin(otherAuth, "owner-01", "wrong password two", "192.0.2.2"),
    );
    expect(responses.map((r) => r.status)).toEqual([401, 429]);
    expect(verify).toHaveBeenCalledTimes(1);
    const rows = await independent.db.select().from(loginThrottle);
    expect(rows).toHaveLength(1);
    expect(rows[0].failureCount).toBe(1);
    expect(rows[0].blockedUntil!.getTime()).toBeGreaterThan(
      rows[0].updatedAt.getTime(),
    );
  } finally {
    verify.mockRestore();
  }
});

it.each(["password", "mfa", "management"] as const)(
  "F8 B/K atomic %s max-1 contention across independent pools",
  async (kind) => {
    const max = kind === "mfa" ? 30 : 12;
    await prime(`work:${kind}`, max - 1, 60);
    let a!: Promise<unknown>, b!: Promise<unknown>;
    await control.client.begin(async (barrier) => {
      await barrier`select * from auth_admission where key = ${`work:${kind}`} for update`;
      a = reserveAuthWork(database.db, kind).catch((e) => e);
      b = reserveAuthWork(independent.db, kind).catch((e) => e);
      // Observe BOTH PostgreSQL row-lock waiters before releasing; no race sleep.
      const deadline = Date.now() + 15000;
      while (
        (
          await control.client`select pid from pg_stat_activity where wait_event_type = 'Lock' and query like '%insert into auth_admission%'`
        ).length < 2
      ) {
        if (Date.now() > deadline)
          throw new Error("reservations did not reach DB barrier");
        await delay(15);
      }
    });
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r instanceof AuthThrottledError)).toHaveLength(
      1,
    );
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect((await bucket(`work:${kind}`)).count).toBe(max + 1);
  },
);

it("F8 B independent usernames/client metadata cannot partition work; denied login does no Argon2 or M wait", async () => {
  await prime("work:password", 12, 60);
  const verify = vi.spyOn(passwords, "verifyPassword");
  const hash = vi.spyOn(passwords, "hashPassword");
  try {
    await control.client.begin(async (barrier) => {
      await barrier`select pg_advisory_xact_lock(${key})`;
      for (const [engine, name, ip] of [
        [auth, "unknown-01", "192.0.2.3"],
        [otherAuth, "unknown-02", "192.0.2.4"],
      ] as const) {
        const response = await httpLogin(engine, name, password, ip);
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      }
      expect(
        await control.client`select pid from pg_locks where locktype='advisory' and objid=${key} and not granted`,
      ).toHaveLength(0);
    });
    expect(hash).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect((await bucket("work:password")).count).toBe(13);
  } finally {
    verify.mockRestore();
    hash.mockRestore();
  }
});

it("F8 aggregate admission is before M for every explicit public/management wrapper", async () => {
  await prime("work:mfa", 30, 60);
  await prime("work:management", 12, 60);
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(${key})`;
    for (const [route, path, body] of [
      [totpPost, "/api/auth/mfa/totp", { code: "000000" }],
      [recoveryPost, "/api/auth/mfa/recovery", { code: "AAAAA-BBBBB" }],
      [cancelPost, "/api/auth/mfa/cancel", {}],
      [resume, "/api/auth/mfa/manage/authenticator/resume", {}],
      [
        complete,
        "/api/auth/mfa/manage/authenticator/complete",
        { code: "000000" },
      ],
      [
        start,
        "/api/auth/mfa/manage/authenticator/start",
        proof("totp", "000000"),
      ],
      [
        regenerate,
        "/api/auth/mfa/manage/recovery/regenerate",
        proof("totp", "000000"),
      ],
    ] as const) {
      const response = await route(request(path, body));
      expect(response.status).toBe(429);
      expect(response.headers.has("Retry-After")).toBe(true);
    }
    expect(
      await control.client`select pid from pg_locks where locktype='advisory' and objid=${key} and not granted`,
    ).toHaveLength(0);
  });
});

it("F9 all address-header variants retain exhausted F8 password, MFA and management admission", async () => {
  await prime("work:password", 12, 60);
  await prime("work:mfa", 30, 60);
  await prime("work:management", 12, 60);
  const verify = vi.spyOn(passwords, "verifyPassword");
  const hash = vi.spyOn(passwords, "hashPassword");
  try {
    for (const extra of forwardingHeaders) {
      const login = await otherAuth.handler(
        request(
          "/api/auth/sign-in/username",
          { username: "owner-01", password },
          "",
          extra,
        ),
      );
      expect(login.status).toBe(429);
      for (const [route, path, body] of [
        [totpPost, "/api/auth/mfa/totp", { code: "000000" }],
        [recoveryPost, "/api/auth/mfa/recovery", { code: "AAAAA-BBBBB" }],
        [cancelPost, "/api/auth/mfa/cancel", {}],
        [resume, "/api/auth/mfa/manage/authenticator/resume", {}],
        [
          complete,
          "/api/auth/mfa/manage/authenticator/complete",
          { code: "000000" },
        ],
        [
          start,
          "/api/auth/mfa/manage/authenticator/start",
          proof("totp", "000000"),
        ],
        [
          regenerate,
          "/api/auth/mfa/manage/recovery/regenerate",
          proof("totp", "000000"),
        ],
      ] as const) {
        expect((await route(request(path, body, cookie, extra))).status).toBe(
          429,
        );
      }
    }
    expect(verify).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect((await bucket("work:password")).count).toBe(13);
    expect((await bucket("work:mfa")).count).toBe(31);
    expect((await bucket("work:management")).count).toBe(13);
  } finally {
    verify.mockRestore();
    hash.mockRestore();
  }
});

it("F8 C/E fifth concurrent wrong management password commits; sixth does not verify or mutate", async () => {
  await prime("manage:password", 4, 900);
  const before = await snapshot();
  const verify = vi.spyOn(passwords, "verifyPassword");
  try {
    const responses = await orderedRace(
      () =>
        managed("regenerate", proof("totp", "000000", "incorrect password")),
      () =>
        managed(
          "start",
          proof("recovery", "AAAAA-BBBBB", "incorrect password"),
          independent.db,
        ),
    );
    expect(responses.map((r) => r.status)).toEqual([403, 429]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await bucket("manage:password")).count).toBe(5);
    expect(await snapshot()).toBe(before);
    expect(await bucket("manage:factor")).toBeUndefined();
  } finally {
    verify.mockRestore();
  }
});

it("F8 D/E mixed TOTP/recovery failures share factor budget across instances and operations; password success does not refund it", async () => {
  await prime("manage:factor", 3, 900);
  await prime("manage:password", 2, 900);
  const before = await snapshot();
  const invalidCode = await badCode();
  const responses = await orderedRace(
    () => managed("regenerate", proof("totp", invalidCode)),
    () => managed("start", proof("recovery", "AAAAA-BBBBB"), independent.db),
  );
  expect(responses.map((r) => r.status)).toEqual([403, 403]);
  expect((await bucket("manage:factor")).count).toBe(5);
  expect(await bucket("manage:password")).toBeUndefined();
  expect(await snapshot()).toBe(before);
  const verify = vi.spyOn(passwords, "verifyPassword");
  try {
    expect(
      (
        await managed(
          "regenerate",
          proof("recovery", oldCodes[0]),
          independent.db,
        )
      ).status,
    ).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  } finally {
    verify.mockRestore();
  }
});

it("F8 management success resets only its stages, preserves anonymous failures and expiry permits automatic recovery", async () => {
  await prime("manage:factor", 5, -1);
  await prime("manage:password", 5, -1);
  await database.db.update(twoFactor).set({ failedVerificationCount: 3 });
  expect(
    (
      await managed(
        "regenerate",
        proof("recovery", oldCodes[0]),
        independent.db,
      )
    ).status,
  ).toBe(200);
  expect(await bucket("manage:factor")).toBeUndefined();
  expect(await bucket("manage:password")).toBeUndefined();
  expect(
    (await database.db.select().from(twoFactor))[0].failedVerificationCount,
  ).toBe(3);
});

it("F8 failure reservations survive downstream rollback; recovery CAS and successful resets roll back together", async () => {
  await prime("manage:factor", 2, 900);
  const before = await snapshot();
  await control.client`create function fail_recovery_update() returns trigger language plpgsql as $$ begin raise exception 'fixture rollback'; end $$`;
  // Recovery proof CAS is one update, regeneration is the second update.
  await control.client`create trigger fail_regeneration before update on two_factor for each row when (old.backup_codes <> new.backup_codes and current_setting('maildock.fixture_seen', true) = 'yes') execute function fail_recovery_update()`;
  await control.client`create function mark_recovery_update() returns trigger language plpgsql as $$ begin perform set_config('maildock.fixture_seen','yes',true); return new; end $$`;
  await control.client`create trigger mark_recovery_update after update on two_factor for each row execute function mark_recovery_update()`;
  try {
    await expect(
      regenerateRecoveryCodes(
        database.db,
        config,
        headers(),
        proof("recovery", oldCodes[0]),
      ),
    ).rejects.toThrow();
    expect((await bucket("work:management")).count).toBe(1);
    expect((await bucket("manage:factor")).count).toBe(2);
    expect(await snapshot()).toBe(before);
  } finally {
    await control.client`drop trigger fail_regeneration on two_factor`;
    await control.client`drop trigger mark_recovery_update on two_factor`;
    await control.client`drop function fail_recovery_update()`;
    await control.client`drop function mark_recovery_update()`;
  }
  expect(
    (await managed("regenerate", proof("recovery", oldCodes[0]))).status,
  ).toBe(200);
});

it("F8 F concurrent same recovery code has one consumer across independent management instances", async () => {
  const responses = await orderedRace(
    () => managed("regenerate", proof("recovery", oldCodes[0])),
    () => managed("regenerate", proof("recovery", oldCodes[0]), independent.db),
  );
  expect(responses.map((r) => r.status)).toEqual([200, 403]);
  expect((await bucket("manage:factor")).count).toBe(1);
});

it("F8 unknown-user dummy work remains; stale attacker-selected backoff is pruned without erasing active delay", async () => {
  const hash = vi.spyOn(passwords, "hashPassword");
  try {
    expect((await httpLogin(auth, "unknown-name")).status).toBe(401);
    expect(hash).toHaveBeenCalledTimes(1);
  } finally {
    hash.mockRestore();
  }
  await database.db.insert(loginThrottle).values({
    key: "stale",
    failureCount: 14,
    updatedAt: new Date(Date.now() - 901000),
    blockedUntil: new Date(Date.now() - 1000),
  });
  await database.db.insert(loginThrottle).values({
    key: "active",
    failureCount: 14,
    updatedAt: new Date(Date.now() - 901000),
    blockedUntil: new Date(Date.now() + 100000),
  });
  expect((await httpLogin(otherAuth)).status).toBe(200);
  const rows = await independent.db.select().from(loginThrottle);
  expect(rows.some((r) => r.key === "stale")).toBe(false);
  expect(rows.some((r) => r.key === "active")).toBe(true);
});

it.each([
  [
    "oversized",
    JSON.stringify({ username: "unknown-name", password: "p".repeat(5000) }),
    413,
  ],
  [
    "overlong",
    JSON.stringify({ username: "unknown-name", password: "p".repeat(129) }),
    400,
  ],
  [
    "short",
    JSON.stringify({ username: "unknown-name", password: "p".repeat(11) }),
    400,
  ],
  ["malformed", "{", 400],
  [
    "unknown property",
    JSON.stringify({ username: "owner-01", password, extra: true }),
    400,
  ],
] as const)(
  "F8 J %s rejected before Argon2 and admission",
  async (_label, body, status) => {
    const hash = vi.spyOn(passwords, "hashPassword"),
      verify = vi.spyOn(passwords, "verifyPassword");
    try {
      const response = await authPost(
        new Request(origin + "/api/auth/sign-in/username", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(status);
      expect(hash).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(await bucket("work:password")).toBeUndefined();
    } finally {
      hash.mockRestore();
      verify.mockRestore();
    }
  },
);

it("F8 J stalled body hits deterministic 10-second deadline before work", async () => {
  const hash = vi.spyOn(passwords, "hashPassword"),
    verify = vi.spyOn(passwords, "verifyPassword");
  const cancelled = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = authPost(
      new Request(origin + "/api/auth/sign-in/username", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: new ReadableStream({ cancel: cancelled }),
        duplex: "half",
      } as RequestInit),
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).status).toBe(413);
    expect(cancelled).toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    hash.mockRestore();
    verify.mockRestore();
  }
  expect(await bucket("work:password")).toBeUndefined();
});

it("F8 valid protocol fields/case normalization work; password success preserves MFA account failures", async () => {
  await database.db.update(twoFactor).set({ failedVerificationCount: 4 });
  const response = await httpLogin(otherAuth, "OWNER-01");
  expect(response.status).toBe(200);
  expect((await response.json()).twoFactorRedirect).toBe(true);
  expect(
    (await database.db.select().from(twoFactor))[0].failedVerificationCount,
  ).toBe(4);
});

it("F8 fixed-window denial cannot extend expiry; expired work recovers across independent pools", async () => {
  await prime("work:password", 12, 60);
  const expiry = (await bucket("work:password")).expiresAt;
  await expect(
    reserveAuthWork(independent.db, "password"),
  ).rejects.toBeInstanceOf(AuthThrottledError);
  expect((await bucket("work:password")).expiresAt).toEqual(expiry);
  await prime("work:password", 13, -1);
  await reserveAuthWork(independent.db, "password");
  expect((await bucket("work:password")).count).toBe(1);
});

it("F8 G normal MFA retains five/challenge and ten/account across fresh challenges and independent instances", async () => {
  const invalid = await badCode();
  const first = cookies(await login());
  for (let n = 0; n < 5; n++)
    expect(
      (
        await verifyMfaLogin(
          database.db,
          config,
          headers(first),
          invalid,
          "totp",
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await verifyMfaLogin(
        independent.db,
        config,
        headers(first),
        "AAAAA-BBBBB",
        "recovery",
      )
    ).status,
  ).toBe(401);
  expect(
    (await database.db.select().from(twoFactor))[0].failedVerificationCount,
  ).toBe(5);
  const second = cookies(await login(otherAuth));
  for (let n = 0; n < 5; n++)
    expect(
      (
        await verifyMfaLogin(
          n % 2 ? database.db : independent.db,
          config,
          headers(second),
          n % 2 ? invalid : "AAAAA-BBBBB",
          n % 2 ? "totp" : "recovery",
        )
      ).status,
    ).toBe(401);
  const third = cookies(await login());
  const locked = await verifyMfaLogin(
    independent.db,
    config,
    headers(third),
    invalid,
    "totp",
  );
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
  const row = (await database.db.select().from(twoFactor))[0];
  expect(row.failedVerificationCount).toBe(10);
  expect(row.lockedUntil).not.toBeNull();
});
it("F8 H replacement confirmation retains five invalid new-factor proofs across resume/instances", async () => {
  const response = await managed("start", proof("recovery", oldCodes[0]));
  expect(response.status).toBe(200);
  const ceremony = cookies(response)
    .split("; ")
    .find((v) => v.startsWith(replacementCookie + "="))!;
  const invalid = await badCode(await factorSecret());
  for (let n = 0; n < 5; n++) {
    expect(
      (
        await completeAuthenticatorReplacement(
          n % 2 ? database.db : independent.db,
          config,
          headers(ceremony),
          invalid,
        )
      ).status,
    ).toBe(403);
    if (n < 4)
      expect(
        await resumeAuthenticatorReplacement(
          independent.db,
          config,
          headers(ceremony),
        ),
      ).toHaveProperty("totpURI");
  }
  expect(
    (await database.db.select().from(mfaReplacement))[0].failedAttempts,
  ).toBe(5);
  expect(
    (
      (await resumeAuthenticatorReplacement(
        independent.db,
        config,
        headers(ceremony),
      )) as Response
    ).status,
  ).toBe(403);
  expect(
    (
      (await completeAuthenticatorReplacement(
        independent.db,
        config,
        headers(ceremony),
        await totp(await factorSecret()),
      )) as Response
    ).status,
  ).toBe(403);
  expect(await database.db.select().from(session)).toHaveLength(0);
});
