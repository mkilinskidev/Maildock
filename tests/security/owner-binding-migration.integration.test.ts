import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import * as databaseSchema from "@/shared/infrastructure/database/schema";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { hashPassword } from "@/modules/auth/infrastructure/password";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { getValidSession } from "@/modules/auth/application/session-validation";
import { checkOwnerApiAccess } from "@/modules/auth/application/api-access-check";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { instanceState } from "@/shared/infrastructure/database/schema";

describe("F10 actual Drizzle migration against pre-F10 PostgreSQL databases", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let legacyFolder: string;
  let matchedLegacyFolder: string;
  let passwordHash: string;
  let auth: ReturnType<typeof createAuth>;
  const origin = "http://localhost:3000";

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "f10_migration",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/f10_migration`,
      databasePoolSize: 2,
    });
    auth = createAuth(
      parseConfig({
        MAILDOCK_ENV: "test",
        APP_ORIGIN: origin,
        DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/f10_migration`,
        AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
        CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
        ATTACHMENTS_PATH: tmpdir(),
      }),
      database.db,
    );
    legacyFolder = await mkdtemp(
      path.join(tmpdir(), "maildock-f10-migrations-"),
    );
    const journal = JSON.parse(
      await readFile("db/migrations/meta/_journal.json", "utf8"),
    );
    const ownerIndex = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0028_owner_binding",
    );
    expect(ownerIndex).toBe(28);
    matchedLegacyFolder = await mkdtemp(
      path.join(tmpdir(), "maildock-f10-matched-legacy-"),
    );
    await mkdir(path.join(matchedLegacyFolder, "meta"));
    const matchedJournal = {
      ...journal,
      entries: journal.entries.slice(0, 36),
    };
    await writeFile(
      path.join(matchedLegacyFolder, "meta/_journal.json"),
      JSON.stringify(matchedJournal),
    );
    for (const entry of matchedJournal.entries)
      await copyFile(
        `db/migrations/${entry.tag}.sql`,
        path.join(matchedLegacyFolder, `${entry.tag}.sql`),
      );
    journal.entries = journal.entries.slice(0, ownerIndex);
    await mkdir(path.join(legacyFolder, "meta"));
    await writeFile(
      path.join(legacyFolder, "meta/_journal.json"),
      JSON.stringify(journal),
    );
    for (const entry of journal.entries)
      await copyFile(
        `db/migrations/${entry.tag}.sql`,
        path.join(legacyFolder, `${entry.tag}.sql`),
      );
    passwordHash = await hashPassword("correct horse battery staple");
  });
  beforeEach(async () => {
    // All schemas belong exclusively to this suite's disposable container DB.
    await database.client`DROP SCHEMA public CASCADE`;
    await database.client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await database.client`CREATE SCHEMA public`;
    await migrate(database.db, { migrationsFolder: legacyFolder });
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (matchedLegacyFolder)
      await rm(matchedLegacyFolder, { recursive: true, force: true });
    if (legacyFolder) await rm(legacyFolder, { recursive: true, force: true });
  });

  async function legacyUser(index = 0) {
    const id = randomUUID();
    const now = new Date();
    await database.client`INSERT INTO "user" (id, name, email, email_verified, username, display_username, created_at, updated_at)
      VALUES (${id}, ${`Owner${index}`}, ${index === 0 ? "owner@localhost.invalid" : `other${index}@example.test`}, true, ${`owner${index}`}, ${`Owner${index}`}, ${now.toISOString()}, ${now.toISOString()})`;
    await database.client`INSERT INTO account (id, user_id, account_id, provider_id, password, created_at, updated_at)
      VALUES (${randomUUID()}, ${id}, ${id}, 'credential', ${passwordHash}, ${now.toISOString()}, ${now.toISOString()})`;
    return { id, now };
  }
  async function legacyOwner() {
    const owner = await legacyUser();
    await database.client`UPDATE instance_state SET initialized_at = ${owner.now.toISOString()}, password_algorithm = 'argon2id', password_parameters = '{"memoryCost":65536}'`;
    return owner;
  }
  function upgrade() {
    // Historical owner binding is tested with its matched pre-native release.
    return migrate(database.db, { migrationsFolder: matchedLegacyFolder });
  }
  async function ownerCookie() {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "OWNER0",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }
  async function expectRejected() {
    await expect(upgrade()).rejects.toThrow();
    // Prove transactional rollback: no partially added column or journal entry.
    const columns =
      await database.client`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'instance_state' AND column_name = 'owner_user_id'`;
    expect(columns).toHaveLength(0);
    const [journal] =
      await database.client`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`;
    expect(journal.count).toBe(28);
    // Retrying cannot silently turn an ambiguous database into an owner.
    await expect(upgrade()).rejects.toThrow();
  }

  it("binds only the single consistent legacy provisioned user and is idempotent", async () => {
    const owner = await legacyOwner();
    await upgrade();
    const [state] = await database.db.select().from(instanceState);
    expect(state).toMatchObject({
      ownerUserId: owner.id,
      initializedAt: owner.now,
    });
    const cookie = await ownerCookie();
    expect(
      (await getValidSession(auth, new Headers({ cookie })))?.user.id,
    ).toBe(owner.id);
    await legacyUser(1);
    await upgrade();
    expect(
      (await database.db.select().from(instanceState))[0].ownerUserId,
    ).toBe(owner.id);
    await expect(
      database.client`DELETE FROM "user" WHERE id = ${owner.id}`,
    ).rejects.toThrow();
    expect(
      (await database.db.select().from(instanceState))[0].initializedAt,
    ).toEqual(owner.now);
  });

  it("keeps a clean uninitialized database unbound and available to bootstrap setup", async () => {
    await upgrade();
    expect((await database.db.select().from(instanceState))[0]).toMatchObject({
      initializedAt: null,
      ownerUserId: null,
    });
  });

  it("rejects initialized state with zero users without resetting initialization", async () => {
    await database.client`UPDATE instance_state SET initialized_at = now()`;
    await expectRejected();
    expect(
      (await database.client`SELECT initialized_at FROM instance_state`)[0]
        .initialized_at,
    ).not.toBeNull();
  });

  it("rejects initialized state with multiple legitimate users without choosing the first", async () => {
    await legacyOwner();
    await legacyUser(1);
    await expectRejected();
    expect(await database.client`SELECT id FROM "user"`).toHaveLength(2);
  });

  it("cannot authorize a real authenticated legacy user after an ambiguous migration fails", async () => {
    const owner = await legacyOwner();
    await legacyUser(1);
    // Reproduce the historical protocol against its historical user schema.
    // The current MFA plugin cannot read a pre-F2.1 database by design.
    const legacyAuth = betterAuth({
      ...auth.options,
      // Historical session issuance predates the replacement-table guard.
      // Keep F5 fields, but do not query a table absent from this legacy DB.
      databaseHooks: {
        session: {
          create: {
            before: async (session) => ({
              data: {
                ...session,
                absoluteExpiresAt: new Date(
                  session.createdAt.getTime() + 24 * 60 * 60 * 1000,
                ),
              },
            }),
          },
        },
      },
      plugins: auth.options.plugins.filter(
        (plugin) => plugin.id !== "two-factor",
      ),
      database: drizzleAdapter(database.db, {
        provider: "pg",
        schema: {
          ...databaseSchema,
          user: pgTable("user", {
            id: text("id").primaryKey(),
            name: text("name").notNull(),
            email: text("email").notNull(),
            emailVerified: boolean("email_verified").notNull(),
            image: text("image"),
            username: text("username"),
            displayUsername: text("display_username"),
            createdAt: timestamp("created_at", {
              withTimezone: true,
            }).notNull(),
            updatedAt: timestamp("updated_at", {
              withTimezone: true,
            }).notNull(),
          }),
        },
      }),
    });
    const login = await legacyAuth.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "OWNER0",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await expectRejected();
    expect(
      (await legacyAuth.api.getSession({ headers: new Headers({ cookie }) }))
        ?.user.id,
    ).toBe(owner.id);
    // The missing schema raises a server error rather than granting access.
    await expect(
      getValidSession(auth, new Headers({ cookie })),
    ).rejects.toThrow();
    await expect(
      checkOwnerApiAccess(
        auth,
        { appOrigin: origin },
        new Request(`${origin}/api/settings/auto-read`, {
          headers: { cookie },
        }),
      ),
    ).rejects.toThrow();
  });

  it.each([1, 2])(
    "rejects uninitialized state containing %s users without deleting them",
    async (count) => {
      for (let index = 0; index < count; index++) await legacyUser(index);
      await expectRejected();
      expect(await database.client`SELECT id FROM "user"`).toHaveLength(count);
    },
  );

  it.each([
    "email",
    "username",
    "unverified",
    "credentials",
    "account-id",
    "password",
    "algorithm",
    "parameters",
    "creation-time",
    "user-id",
    "extra-account",
  ])(
    "rejects one-user state inconsistent with legacy provisioning: %s",
    async (corruption) => {
      const owner = await legacyOwner();
      if (corruption === "email")
        await database.client`UPDATE "user" SET email = 'unknown@example.test'`;
      if (corruption === "username")
        await database.client`UPDATE "user" SET username = NULL`;
      if (corruption === "unverified")
        await database.client`UPDATE "user" SET email_verified = false`;
      if (corruption === "credentials")
        await database.client`DELETE FROM account`;
      if (corruption === "account-id")
        await database.client`UPDATE account SET account_id = 'unknown'`;
      if (corruption === "password")
        await database.client`UPDATE account SET password = NULL`;
      if (corruption === "algorithm")
        await database.client`UPDATE instance_state SET password_algorithm = NULL`;
      if (corruption === "parameters")
        await database.client`UPDATE instance_state SET password_parameters = NULL`;
      if (corruption === "creation-time")
        await database.client`UPDATE "user" SET created_at = created_at - interval '1 second'`;
      if (corruption === "user-id") {
        await database.client`DELETE FROM account`;
        await database.client`UPDATE "user" SET id = ' malformed '`;
      }
      if (corruption === "extra-account")
        await database.client`INSERT INTO account (id, user_id, account_id, provider_id) VALUES (${randomUUID()}, ${owner.id}, 'other', 'unknown')`;
      await expectRejected();
    },
  );

  it("rejects a missing singleton instead of recreating claimable setup", async () => {
    await database.client`DELETE FROM instance_state`;
    await expectRejected();
    expect(await database.client`SELECT id FROM instance_state`).toHaveLength(
      0,
    );
  });
});
