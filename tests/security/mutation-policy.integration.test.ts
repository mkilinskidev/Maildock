import { initializeOwnerFixture } from "./mfa-fixture";
import { setReadyFixture } from "./mfa-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

import { checkOwnerApiAccess } from "@/modules/auth/application/api-access-check";

const runtime = vi.hoisted(() => ({
  auth: undefined as unknown,
  config: undefined as unknown,
  db: undefined as unknown,
  create: vi.fn(),
  setManual: vi.fn(),
  clearManual: vi.fn(),
  list: vi.fn(),
  setEnabled: vi.fn(),
  testExisting: vi.fn(),
}));
// Only composition singletons and downstream business effects are substituted.
// Routes, access helper, Better Auth, signed cookies and PostgreSQL are real.
vi.mock("@/modules/auth/infrastructure/auth", () => ({
  get auth() {
    return runtime.auth;
  },
}));
vi.mock("@/shared/infrastructure/config/config", async (original) => ({
  ...(await original<typeof import("@/shared/infrastructure/config/config")>()),
  getConfig: () => runtime.config,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  get db() {
    return runtime.db;
  },
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  messageCommandService: { create: runtime.create },
  mailboxRoleService: {
    setManual: runtime.setManual,
    clearManual: runtime.clearManual,
    list: runtime.list,
  },
  accountsService: {
    setEnabled: runtime.setEnabled,
    testExisting: runtime.testExisting,
  },
}));
import { POST as action } from "@/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/actions/route";
import {
  PUT as mapRole,
  DELETE as clearRole,
} from "@/app/api/accounts/[id]/mailbox-roles/[role]/route";
import { PATCH as enable } from "@/app/api/accounts/[id]/enabled/route";
import { POST as testAccount } from "@/app/api/accounts/[id]/test/route";

describe("F4 real HTTP handlers and authenticated session boundary", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  let root: string | undefined;
  let config: AppConfig;
  let auth: ReturnType<typeof createAuth>;
  let cookie: string;
  let authPost: typeof import("@/app/api/auth/[...all]/route").POST;
  let authGet: typeof import("@/app/api/auth/[...all]/route").GET;
  const origin = "http://localhost:3000";
  const id = "00000000-0000-4000-8000-000000000001";
  const context = {
    params: Promise.resolve({
      id,
      mailboxId: id,
      messageId: id,
      role: "trash",
    }),
  };
  const credentials = {
    username: "owner",
    password: "correct horse battery staple",
  };
  function request(
    method: string,
    body?: string,
    requestOrigin: string | null = origin,
    contentType = "application/json",
    url = "/api/test",
    authenticated = true,
  ) {
    return new Request(origin + url, {
      method,
      headers: {
        ...(authenticated ? { cookie } : {}),
        ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
        "Content-Type": contentType,
      },
      ...(body === undefined ? {} : { body }),
    });
  }
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maildock-f4-"));
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "f4",
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
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/f4`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: root,
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await initializeOwnerFixture(database.db, {
      ...credentials,
      bootstrapSecret: Buffer.alloc(32, 7).toString("base64"),
    });
    auth = createAuth(config, database.db);
    runtime.auth = auth;
    runtime.config = config;
    runtime.db = database.db;
    const authRoute = await import("@/app/api/auth/[...all]/route");
    authPost = authRoute.POST;
    authGet = authRoute.GET;
    const login = await authPost(
      request(
        "POST",
        JSON.stringify(credentials),
        origin,
        "application/json",
        "/api/auth/sign-in/username",
        false,
      ),
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    await setReadyFixture(database.db);
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.create.mockResolvedValue({ id, status: "queued" });
    runtime.list.mockResolvedValue([]);
    runtime.setEnabled.mockResolvedValue({ id, enabled: true });
    runtime.testExisting.mockResolvedValue({ imap: { success: true } });
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "PROPFIND"])(
    "requires exact Origin by default for %s",
    async (method) => {
      for (const value of [
        null,
        "null",
        "http://sibling.localhost:3000",
        "https://evil.test",
        origin + "/",
      ]) {
        expect(
          (
            await checkOwnerApiAccess(
              auth,
              config,
              request(method, undefined, value),
            )
          )?.status,
        ).toBe(403);
      }
      expect(
        await checkOwnerApiAccess(auth, config, request(method)),
      ).toBeNull();
      expect(
        (
          await checkOwnerApiAccess(
            auth,
            config,
            request(
              method,
              undefined,
              origin,
              "application/json",
              "/api/test",
              false,
            ),
          )
        )?.status,
      ).toBe(401);
    },
  );
  it.each(["GET", "HEAD", "OPTIONS"])(
    "allows authenticated safe %s without Origin",
    async (method) => {
      expect(
        await checkOwnerApiAccess(
          auth,
          config,
          request(method, undefined, null),
        ),
      ).toBeNull();
    },
  );
  it("rejects action, role PUT/DELETE and account PATCH before business effects", async () => {
    for (const value of [
      null,
      "null",
      "http://sibling.localhost:3000",
      "https://evil.test",
    ]) {
      expect(
        (await action(request("POST", '{"action":"trash"}', value), context))
          .status,
      ).toBe(403);
      expect(
        (
          await mapRole(
            request("PUT", JSON.stringify({ mailboxId: id }), value),
            context,
          )
        ).status,
      ).toBe(403);
      expect(
        (await clearRole(request("DELETE", undefined, value), context)).status,
      ).toBe(403);
      expect(
        (await enable(request("PATCH", '{"enabled":true}', value), context))
          .status,
      ).toBe(403);
    }
    for (const effect of [
      runtime.create,
      runtime.setManual,
      runtime.clearManual,
      runtime.list,
      runtime.setEnabled,
    ])
      expect(effect).not.toHaveBeenCalled();
  });
  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "application/json-evil",
    "application/problem+json",
    "",
  ])(
    "rejects action JSON disguised as %s before queuing",
    async (mediaType) => {
      expect(
        (
          await action(
            request("POST", '{"action":"trash"}', origin, mediaType),
            context,
          )
        ).status,
      ).toBe(415);
      expect(
        (
          await action(
            request("POST", '{"action":"trash"}', null, mediaType),
            context,
          )
        ).status,
      ).toBe(403);
      expect(runtime.create).not.toHaveBeenCalled();
    },
  );
  it("allows legitimate mutations and parameterized JSON", async () => {
    expect(
      (
        await action(
          request(
            "POST",
            '{"action":"trash"}',
            origin,
            "Application/JSON; charset=utf-8",
          ),
          context,
        )
      ).status,
    ).toBe(202);
    expect(runtime.create).toHaveBeenCalledExactlyOnceWith(id, id, id, "trash");
    expect(
      (
        await mapRole(
          request("PUT", JSON.stringify({ mailboxId: id })),
          context,
        )
      ).status,
    ).toBe(200);
    expect(runtime.setManual).toHaveBeenCalledExactlyOnceWith(id, "trash", id);
    expect((await clearRole(request("DELETE"), context)).status).toBe(200);
    expect(runtime.clearManual).toHaveBeenCalledExactlyOnceWith(id, "trash");
    expect(
      (await enable(request("PATCH", '{"enabled":true}'), context)).status,
    ).toBe(200);
    expect(runtime.setEnabled).toHaveBeenCalledExactlyOnceWith(id, true);
  });
  it("allows bodyless account diagnostics but requires JSON media type for overrides", async () => {
    const empty = request("POST");
    empty.headers.delete("content-type");
    expect((await testAccount(empty, context)).status).toBe(200);
    expect(runtime.testExisting).toHaveBeenCalledExactlyOnceWith(id, undefined);
    runtime.testExisting.mockClear();
    expect(
      (await testAccount(request("POST", "{}", origin, "text/plain"), context))
        .status,
    ).toBe(415);
    expect(
      (await testAccount(request("POST", undefined, null), context)).status,
    ).toBe(403);
    expect(runtime.testExisting).not.toHaveBeenCalled();
  });
  it("keeps Better Auth login/session/logout protection in its explicit boundary", async () => {
    const sessionRequest = () =>
      request(
        "GET",
        undefined,
        null,
        "application/json",
        "/api/auth/get-session",
      );
    expect(
      (await (await authGet(sessionRequest())).json()).session,
    ).toBeTruthy();
    for (const value of [null, "http://sibling.localhost:3000"]) {
      expect(
        (
          await authPost(
            request(
              "POST",
              "{}",
              value,
              "application/json",
              "/api/auth/sign-out",
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (await (await authGet(sessionRequest())).json()).session,
      ).toBeTruthy();
    }
    expect(
      (
        await authPost(
          request("POST", "{}", origin, "text/plain", "/api/auth/sign-out"),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await authPost(
          request(
            "POST",
            "{}",
            origin,
            "application/json",
            "/api/auth/sign-out",
          ),
        )
      ).status,
    ).toBe(200);
    expect(await (await authGet(sessionRequest())).json()).toBeNull();
    const login = await authPost(
      request(
        "POST",
        JSON.stringify(credentials),
        origin,
        "application/json",
        "/api/auth/sign-in/username",
        false,
      ),
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });
});
