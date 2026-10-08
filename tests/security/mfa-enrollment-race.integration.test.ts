import { initializeOwnerFixture } from "./mfa-fixture";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

import { getValidBusinessSession } from "@/modules/auth/application/session-validation";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  session,
  twoFactor,
  user,
} from "@/shared/infrastructure/database/schema";

// Research harness: deliberately unsafe F2.1 transition, isolated disposable DB.
// BEFORE INSERT pauses the real adapter after user read/password verification,
// before the insert (and its FK locks). The control connection owns the barrier.
let container: StartedTestContainer;
let database: ReturnType<typeof createDatabase>;
let control: ReturnType<typeof createDatabase>;
let config: AppConfig;
const password = "correct horse battery staple";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
beforeAll(async () => {
  container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "race",
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
    APP_ORIGIN: "http://localhost:3000",
    DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/race`,
    AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    ATTACHMENTS_PATH: tmpdir(),
    LOG_LEVEL: "fatal",
  });
  database = createDatabase(config);
  control = createDatabase(config);
  await migrate(database.db, { migrationsFolder: "db/migrations" });
  await initializeOwnerFixture(database.db, {
    bootstrapSecret,
    username: "Owner-01",
    password,
  });
  await control.client`CREATE FUNCTION pause_password_session() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(1296125022); RETURN NEW; END $$`;
  await control.client`CREATE TRIGGER pause_password_session BEFORE INSERT ON session
    FOR EACH ROW EXECUTE FUNCTION pause_password_session()`;
});
afterAll(async () => {
  await database?.client.end();
  await control?.client.end();
  await container?.stop();
});

it("reproduces F2.1: password session inserts after READY/revocation and gets business access", async () => {
  const auth = createAuth(config, database.db);
  const [owner] = await database.db.select().from(user);
  let pending!: Promise<Response>;
  await control.client.begin(async (barrier) => {
    await barrier`SELECT pg_advisory_xact_lock(1296125022)`;
    pending = auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          Origin: config.appOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "owner-01", password }),
      }),
    );
    // Observe a DB wait, never infer scheduling from Promise.all or a delay.
    const deadline = Date.now() + 15_000;
    while (true) {
      const waits = await database.client`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'advisory'
        AND query LIKE 'insert into "session"%'`;
      if (waits.length) break;
      if (Date.now() > deadline)
        throw new Error("Session insertion did not reach the database barrier");
      await delay(20);
    }
    await database.db.transaction(async (tx) => {
      await tx.insert(twoFactor).values({
        id: randomUUID(),
        userId: owner.id,
        secret: "synthetic-test-secret",
        backupCodes: "synthetic-test-backup-codes",
        verified: true,
      });
      await tx
        .update(user)
        .set({ twoFactorEnabled: true })
        .where(eq(user.id, owner.id));
      await tx.delete(session).where(eq(session.userId, owner.id));
    });
    expect(await isInstanceReady(database.db)).toBe(true);
    expect(await database.db.select().from(session)).toHaveLength(0);
    // Explicit unlock lets the already authenticated password request insert.
    // Transaction-scoped barrier is released only by exiting this callback.
  });
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await database.db.select().from(session)).toHaveLength(1);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(
    await getValidBusinessSession(auth, new Headers({ cookie })),
  ).not.toBeNull();
});
