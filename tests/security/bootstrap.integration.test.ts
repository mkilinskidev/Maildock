import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  account,
  instanceState,
  rateLimit,
  authAdmission,
  user,
} from "@/shared/infrastructure/database/schema";
import { createLogger } from "@/shared/infrastructure/logging/logger";
import * as passwords from "@/modules/auth/infrastructure/password";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import {
  initializeOwner,
  BootstrapAuthorizationError,
} from "@/modules/auth/application/instance-auth";

// Capture the real Argon2 implementation before test spies are installed.
const realHashPassword = passwords.hashPassword;

async function provisionInChild(databaseUrl: string): Promise<string> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/security/bootstrap-process.ts"],
    {
      env: { ...process.env, BOOTSTRAP_TEST_DATABASE_URL: databaseUrl },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
  let status: string | undefined;
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    return await new Promise<string>((resolve, reject) => {
      child.on("message", (message: { status: string }) => {
        status = message.status;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0 && status) resolve(status);
        else
          reject(
            new Error("Bootstrap child process did not complete successfully."),
          );
      });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

const runtime = vi.hoisted(() => ({
  db: undefined as unknown,
  config: undefined as unknown,
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
import { POST, GET } from "@/app/api/setup/route";

const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const origin = "http://localhost:3000";
const credentials = {
  bootstrapSecret,
  username: "owner",
  password: "correct horse battery staple",
};
function request(
  input: unknown = credentials,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/setup`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: typeof input === "string" ? input : JSON.stringify(input),
  });
}

describe("first-run bootstrap HTTP boundary with real PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let config: AppConfig;
  let hash: MockInstance<typeof passwords.hashPassword>;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "bootstrap",
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
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/bootstrap`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
      ATTACHMENTS_PATH: tmpdir(),
    });
    database = createDatabase(config);
    runtime.db = database.db;
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    hash = vi.spyOn(passwords, "hashPassword");
    runtime.config = config;
    await database.db
      .update(instanceState)
      .set({ initializedAt: null, ownerUserId: null });
    await database.db.delete(user);
    await database.db.delete(rateLimit);
    await database.db.delete(authAdmission);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await database?.client.end();
    await container?.stop();
  });
  it.each([undefined, "wrong", Buffer.alloc(32, 8).toString("base64")])(
    "rejects absent/wrong authorization before hashing: %s",
    async (secret) => {
      const response = await POST(
        request({ ...credentials, bootstrapSecret: secret }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(bootstrapSecret);
      expect(hash).not.toHaveBeenCalled();
      expect(await database.db.select().from(user)).toHaveLength(0);
    },
  );
  it("fails closed without configured bootstrap secret", async () => {
    runtime.config = { ...config, bootstrapSecretDigest: undefined };
    expect((await POST(request())).status).toBe(403);
    expect(hash).not.toHaveBeenCalled();
  });
  it.each([undefined, "wrong"])(
    "internal calls cannot bypass bootstrap authorization: %s",
    async (secret) => {
      await expect(
        initializeOwner(
          database.db,
          { ...credentials, bootstrapSecret: secret },
          config,
        ),
      ).rejects.toBeInstanceOf(BootstrapAuthorizationError);
      expect(hash).not.toHaveBeenCalled();
      expect(await database.db.select().from(user)).toHaveLength(0);
    },
  );
  it("internal calls validate credentials after authorization", async () => {
    await expect(
      initializeOwner(
        database.db,
        { ...credentials, password: "short" },
        config,
      ),
    ).rejects.toThrow();
    expect(hash).not.toHaveBeenCalled();
  });
  it("holds setup admission across a real Argon2 job and a separate application process", async () => {
    hash.mockImplementationOnce(async (password) => {
      const [passwordHash, status] = await Promise.all([
        realHashPassword(password),
        provisionInChild(config.databaseUrl),
      ]);
      expect(status).toBe("busy");
      return passwordHash;
    });
    expect((await POST(request())).status).toBe(201);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(await database.db.select().from(user)).toHaveLength(1);
    expect(await database.db.select().from(account)).toHaveLength(1);
  });
  it("creates owner without leaking secret and preserves normal login", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"initialized":true}');
    expect(await (await GET()).text()).toBe('{"initialized":true}');
    expect(await database.db.select().from(user)).toHaveLength(1);
    expect(await database.db.select().from(account)).toHaveLength(1);
    const auth = createAuth(config, database.db);
    const persisted = JSON.stringify(
      await Promise.all([
        database.db.select().from(user),
        database.db.select().from(account),
        database.db.select().from(instanceState),
        database.db.select().from(rateLimit),
      ]),
      (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
    );
    expect(persisted).not.toContain(bootstrapSecret);
    expect(persisted).not.toContain(config.bootstrapSecretDigest);
    const login = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
        }),
      }),
    );
    expect(login.status).toBe(200);
  });
  it("remains closed before hashing after reconnect and removal of bootstrap configuration", async () => {
    expect((await POST(request())).status).toBe(201);
    hash.mockClear();
    await database.client.end();
    database = createDatabase(config);
    runtime.db = database.db;
    runtime.config = { ...config, bootstrapSecretDigest: undefined };
    expect((await POST(request())).status).toBe(409);
    expect((await POST(request("invalid JSON"))).status).toBe(409);
    expect(hash).not.toHaveBeenCalled();
  });
  it("admits exactly one concurrent valid hash and owner; unauthorized racers cannot win", async () => {
    const responses = await Promise.all([
      POST(request()),
      POST(request({ ...credentials, username: "second" })),
      POST(request({ ...credentials, bootstrapSecret: "wrong" })),
    ]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    // A racer may reach the boundary after successful setup has closed it.
    expect([403, 409]).toContain(responses[2].status);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(await database.db.select().from(user)).toHaveLength(1);
    expect(await database.db.select().from(account)).toHaveLength(1);
  });
  it("rechecks persisted state when initialization races admission", async () => {
    hash.mockImplementationOnce(async () => {
      // Simulate a state change after the early check. The authoritative check must reject it.
      const id = randomUUID();
      await database.db
        .insert(user)
        .values({ id, name: "Racing owner", email: "owner@localhost.invalid" });
      await database.db
        .update(instanceState)
        .set({ initializedAt: new Date(), ownerUserId: id });
      return "unused-test-hash";
    });
    expect((await POST(request())).status).toBe(409);
    expect(await database.db.select().from(user)).toHaveLength(1);
    expect(await database.db.select().from(account)).toHaveLength(0);
  });
  it("reserves authorized attempts before failures, persists budget, and expires fixed window", async () => {
    hash.mockRejectedValue(new Error("sensitive internal error"));
    for (let index = 0; index < 5; index++) {
      const response = await POST(request());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("sensitive internal error");
    }
    await database.client.end();
    database = createDatabase(config);
    runtime.db = database.db;
    const denied = await POST(request());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");
    expect(hash).toHaveBeenCalledTimes(5);
    await database.db.execute(
      sql`update rate_limit set last_request = last_request - 60001`,
    );
    expect((await POST(request())).status).toBe(500);
    expect(hash).toHaveBeenCalledTimes(6);
  });
  it("throttles invalid-secret attempts independently of operator admission", async () => {
    for (let index = 0; index < 30; index++) {
      expect(
        (await POST(request({ ...credentials, bootstrapSecret: "wrong" })))
          .status,
      ).toBe(403);
    }
    expect(
      (await POST(request({ ...credentials, bootstrapSecret: "wrong" })))
        .status,
    ).toBe(429);
    expect(hash).not.toHaveBeenCalled();
    expect((await POST(request())).status).toBe(201);
  });
  it.each([
    ["{", 400],
    [{ ...credentials, password: "short" }, 400],
    [{ ...credentials, username: "x".repeat(65) }, 400],
    [{ ...credentials, password: "x".repeat(129) }, 400],
    ["x".repeat(4097), 413],
  ])(
    "bounds malformed/oversized input before hashing",
    async (input, status) => {
      expect((await POST(request(input))).status).toBe(status);
      expect(hash).not.toHaveBeenCalled();
    },
  );
  it("bounds streamed bodies even with a false Content-Length", async () => {
    expect(
      (await POST(request("x".repeat(4097), { "Content-Length": "1" }))).status,
    ).toBe(413);
    expect(
      (await POST(request(credentials, { "Content-Length": "99999" }))).status,
    ).toBe(413);
    expect(hash).not.toHaveBeenCalled();
  });
  it("supports the native form fallback", async () => {
    const response = await POST(
      request(new URLSearchParams(credentials).toString(), {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/login`);
  });
  it("cancels a stalled request body before hashing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = await POST(
      new Request(`${origin}/api/setup`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });
  it("does not log submitted secrets or internal setup failures", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await POST(request({ ...credentials, bootstrapSecret: "wrong" })))
        .status,
    ).toBe(403);
    hash.mockRejectedValueOnce(
      new Error(`internal database error ${bootstrapSecret}`),
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(bootstrapSecret);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("redacts bootstrap fields and retains only a digest in parsed configuration", () => {
    const records: string[] = [];
    const logger = createLogger(
      { logLevel: "info" },
      {
        write: (line: string) => {
          records.push(line);
        },
      },
    );
    logger.info({
      bootstrapSecret,
      bootstrapSecretDigest: config.bootstrapSecretDigest,
      MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
      body: { bootstrapSecret },
      config,
    });
    expect(records.join("")).not.toContain(bootstrapSecret);
    expect(records.join("")).not.toContain(config.bootstrapSecretDigest);
    expect(JSON.stringify(config)).not.toContain(bootstrapSecret);
    expect(config.bootstrapSecretDigest).toBe(
      createHash("sha256").update(bootstrapSecret).digest("hex"),
    );
  });
});
