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

describe("F2.1 transactional Drizzle migration on disposable PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let previousFolder: string;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "mfa_migration",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/mfa_migration`,
      databasePoolSize: 2,
    });
    previousFolder = await mkdtemp(
      path.join(tmpdir(), "maildock-f21-migrations-"),
    );
    const journal = JSON.parse(
      await readFile("db/migrations/meta/_journal.json", "utf8"),
    );
    expect(journal.entries[29].tag).toBe("0029_omniscient_leper_queen");
    journal.entries = journal.entries.slice(0, 29);
    await mkdir(path.join(previousFolder, "meta"));
    await writeFile(
      path.join(previousFolder, "meta/_journal.json"),
      JSON.stringify(journal),
    );
    for (const entry of journal.entries)
      await copyFile(
        `db/migrations/${entry.tag}.sql`,
        path.join(previousFolder, `${entry.tag}.sql`),
      );
  });
  beforeEach(async () => {
    // Exclusively this suite's disposable database, never development volumes.
    await database.client`DROP SCHEMA public CASCADE`;
    await database.client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await database.client`CREATE SCHEMA public`;
    await migrate(database.db, { migrationsFolder: previousFolder });
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (previousFolder)
      await rm(previousFolder, { recursive: true, force: true });
  });
  it("applies cleanly and idempotently, leaves the instance uninitialized and defaults direct factors to unverified", async () => {
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    const [state] =
      await database.client`SELECT initialized_at, owner_user_id FROM instance_state`;
    expect(state).toEqual({ initialized_at: null, owner_user_id: null });
    const [column] =
      await database.client`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'two_factor' AND column_name = 'verified'`;
    expect(column).toEqual({ column_default: "false", is_nullable: "NO" });
    const [journal] =
      await database.client`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`;
    expect(journal.count).toBe(30);
  });
  it.each([
    "missing row",
    "extra row",
    "dangling owner",
    "initialized without owner",
    "uninitialized with user",
  ])("rejects %s and rolls back schema and journal changes", async (state) => {
    if (state === "missing row")
      await database.client`DELETE FROM instance_state`;
    if (state === "extra row") {
      await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_singleton`;
      await database.client`INSERT INTO instance_state(id) VALUES(2)`;
    }
    if (state === "dangling owner" || state === "initialized without owner") {
      await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_owner_binding`;
      await database.client`ALTER TABLE instance_state DROP CONSTRAINT instance_state_owner_user_id_user_id_fk`;
      await database.client`UPDATE instance_state SET initialized_at = now(), owner_user_id = ${state === "dangling owner" ? "missing" : null}`;
    }
    if (state === "uninitialized with user")
      await database.client`INSERT INTO "user"(id, name, email) VALUES('unbound', 'Unbound', 'unbound@example.test')`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        migrate(database.db, { migrationsFolder: "db/migrations" }),
      ).rejects.toThrow();
      expect(
        await database.client`SELECT column_name FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'two_factor_enabled'`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT table_name FROM information_schema.tables WHERE table_name = 'two_factor' AND table_schema = 'public'`,
      ).toHaveLength(0);
      const [journal] =
        await database.client`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`;
      expect(journal.count).toBe(29);
    }
  });
});
