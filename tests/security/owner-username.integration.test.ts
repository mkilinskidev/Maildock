import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
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
import * as passwords from "@/modules/auth/infrastructure/password";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { parseConfig } from "@/shared/infrastructure/config/config";
import {
  account,
  instanceState,
  loginThrottle,
  rateLimit,
  user,
} from "@/shared/infrastructure/database/schema";

// Only application singletons are substituted: handlers, authentication, password
// hashing/verification, cookies and the migrated PostgreSQL database are real.
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
import { POST as setup } from "@/app/api/setup/route";

const origin = "http://localhost:3000";
const password = "correct horse battery staple";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const validUsernames = [
  "owner",
  "my-owner",
  "owner.name",
  "owner_name",
  "Owner-01",
  "Ab-",
  "X".repeat(64),
];
const invalidUsernames = [
  "",
  "ab",
  "x".repeat(65),
  "owner name",
  "owner@name",
  "owner/name",
  "owner+name",
  "właściciel",
  "Ｏwner",
  "owner\nname",
];

function request(path: string, body: unknown, cookie?: string) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("F7 owner username contract with real Better Auth and PostgreSQL", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let auth: ReturnType<typeof createAuth>;
  let authPost: typeof import("@/app/api/auth/[...all]/route").POST;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "username",
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
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/username`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
      ATTACHMENTS_PATH: tmpdir(),
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    auth = createAuth(config, database.db);
    runtime.db = database.db;
    runtime.config = config;
    runtime.auth = auth;
    authPost = (await import("@/app/api/auth/[...all]/route")).POST;
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await database.db.delete(user);
    await database.db.delete(rateLimit);
    await database.db.delete(loginThrottle);
    await database.db.update(instanceState).set({ initializedAt: null });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await database?.client.end();
    await container?.stop();
  });

  async function provision(username: string) {
    expect(
      (
        await setup(
          request("/api/setup", { bootstrapSecret, username, password }),
        )
      ).status,
    ).toBe(201);
    expect(await isInstanceInitialized(database.db)).toBe(true);
  }
  async function login(username: string, submittedPassword = password) {
    return authPost(
      request("/api/auth/sign-in/username", {
        username,
        password: submittedPassword,
      }),
    );
  }

  it.each(validUsernames)(
    "provisions %s and signs in with original, lower and upper case",
    async (username) => {
      await provision(username);
      const [owner] = await database.db.select().from(user);
      expect(owner).toMatchObject({
        username: username.toLowerCase(),
        displayUsername: username,
        name: username,
      });
      const [credential] = await database.db.select().from(account);
      expect(credential).toMatchObject({
        userId: owner.id,
        accountId: owner.id,
        providerId: "credential",
      });
      for (const spelling of new Set([
        username,
        username.toLowerCase(),
        username.toUpperCase(),
      ])) {
        const response = await login(spelling);
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toContain(
          "maildock.session_token=",
        );
        expect((await response.json()).user).toMatchObject({
          id: owner.id,
          username: username.toLowerCase(),
          displayUsername: username,
        });
      }
      expect(await database.db.select().from(user)).toHaveLength(1);
    },
  );

  it("preserves setup trimming without adding login aliases", async () => {
    await provision("  Owner-01  ");
    expect((await database.db.select().from(user))[0]).toMatchObject({
      username: "owner-01",
      displayUsername: "Owner-01",
    });
    expect((await login("owner-01")).status).toBe(200);
    expect((await login("  Owner-01  ")).status).toBe(422);
  });

  it.each(invalidUsernames)(
    "rejects invalid setup/login username %j before setup hashing or initialization",
    async (username) => {
      const hash = vi.spyOn(passwords, "hashPassword");
      expect(
        (
          await setup(
            request("/api/setup", { bootstrapSecret, username, password }),
          )
        ).status,
      ).toBe(400);
      expect(hash).not.toHaveBeenCalled();
      expect(await database.db.select().from(user)).toHaveLength(0);
      expect(await database.db.select().from(account)).toHaveLength(0);
      expect(await isInstanceInitialized(database.db)).toBe(false);
      expect([401, 422]).toContain((await login(username)).status);
      expect(hash).not.toHaveBeenCalled();
    },
  );

  it.each(validUsernames)(
    "authenticates previously persisted owner %s without rewriting it",
    async (displayUsername) => {
      // Reproduce the old provisioning rows independently of the new schema/helper.
      const id = randomUUID();
      await database.db.insert(user).values({
        id,
        email: "owner@localhost.invalid",
        emailVerified: true,
        name: displayUsername,
        username: displayUsername.toLowerCase(),
        displayUsername,
      });
      await database.db.insert(account).values({
        id: randomUUID(),
        userId: id,
        accountId: id,
        providerId: "credential",
        password: await passwords.hashPassword(password),
      });
      await database.db
        .update(instanceState)
        .set({ initializedAt: new Date() });
      const before = await database.db.select().from(user);
      expect(
        (
          await setup(
            request("/api/setup", {
              bootstrapSecret,
              username: displayUsername,
              password,
            }),
          )
        ).status,
      ).toBe(409);
      for (const spelling of new Set([
        displayUsername,
        displayUsername.toLowerCase(),
        displayUsername.toUpperCase(),
      ])) {
        expect((await login(spelling)).status).toBe(200);
      }
      expect(await database.db.select().from(user)).toEqual(before);
    },
  );

  it("keeps wrong-password verification and case-insensitive per-username backoff", async () => {
    await provision("Owner-01");
    expect((await login("Owner-01", "wrong password")).status).toBe(401);
    const blocked = await login("owner-01");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await database.db.select().from(loginThrottle)).toHaveLength(1);
  });

  it("keeps Better Auth's login rate limit on the real sign-in path", async () => {
    await provision("my-owner");
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (
          await auth.handler(
            request("/api/auth/sign-in/username", {
              username: "MY-OWNER",
              password,
            }),
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await auth.handler(
          request("/api/auth/sign-in/username", {
            username: "my-owner",
            password,
          }),
        )
      ).status,
    ).toBe(429);
  });

  it("keeps signup disabled and username immutable in Better Auth and the route allowlist", async () => {
    await provision("Owner-01");
    const signup = request("/api/auth/sign-up/email", {
      email: "other@example.com",
      username: "other-owner",
      name: "Other",
      password,
    });
    expect((await authPost(signup.clone())).status).toBe(404);
    expect((await auth.handler(signup)).status).toBe(400);
    const response = await login("owner-01");
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const update = request(
      "/api/auth/update-user",
      { username: "another-owner" },
      cookie,
    );
    expect((await authPost(update.clone())).status).toBe(404);
    const rejected = await auth.handler(update);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).code).toBe("USERNAME_IS_IMMUTABLE");
    expect(await database.db.select().from(user)).toHaveLength(1);
    expect((await database.db.select().from(user))[0].username).toBe(
      "owner-01",
    );
  });
});
