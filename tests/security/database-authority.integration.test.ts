import { initializeOwnerFixture } from "./mfa-fixture";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { validateDatabaseAuthority } from "@/shared/infrastructure/database/database-authority";
import { failureDiagnostic } from "@/shared/infrastructure/logging/diagnostics";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

import { setReadyFixture } from "./mfa-fixture";
import {
  mailAccounts,
  messages,
  messageContents,
} from "@/shared/infrastructure/database/schema";
import { rollback } from "../../node_modules/pg-boss/dist/migrationStore.js";

const sqlPath = path.resolve("scripts/postgres/99-maildock-authority.sql");
const password = "f122-disposable-only";
const refused = "Maildock database authority transition refused.";
let container: StartedTestContainer | undefined;
let network: StartedNetwork | undefined;
let database: ReturnType<typeof createDatabase> | undefined;
let boss: PgBoss | undefined;
let url: string;

async function start(fresh = false) {
  const builder = new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "maildock",
      POSTGRES_USER: "maildock",
      POSTGRES_PASSWORD: password,
    })
    .withExposedPorts(5432)
    .withCopyFilesToContainer([
      {
        source: sqlPath,
        target: fresh
          ? "/docker-entrypoint-initdb.d/99-maildock-authority.sql"
          : "/authority.sql",
      },
      {
        source: path.resolve(
          "scripts/postgres/maildock-authority-maintenance.sh",
        ),
        target: "/usr/local/bin/maildock-authority-maintenance",
      },
    ])
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    );
  if (network) builder.withNetwork(network).withNetworkAliases("postgres");
  container = await builder.start();
  url = `postgresql://maildock:${password}@${container.getHost()}:${container.getMappedPort(5432)}/maildock`;
  database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
}

async function transition(source?: string) {
  await database?.client.end();
  if (source)
    await container!.copyContentToContainer([
      { content: source, target: "/probe-authority.sql" },
    ]);
  const result = await container!.exec([
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "maildock",
    "-d",
    "maildock",
    "-f",
    source ? "/probe-authority.sql" : "/authority.sql",
  ]);
  database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
  return result;
}

async function model() {
  return database!
    .client`SELECT oid,rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname LIKE 'maildock%' ORDER BY rolname`;
}

afterEach(async () => {
  await boss?.stop();
  boss = undefined;
  await database?.client.end();
  database = undefined;
  await container?.stop();
  container = undefined;
  await network?.stop();
  network = undefined;
});

describe("F12.2 authority on real disposable PostgreSQL 18.6", () => {
  it("requires real password authentication during maintenance, rejecting wrong passwords and custom trust", async () => {
    network = await new Network().start();
    await start(true);
    const command = [
      "sh",
      "/usr/local/bin/maildock-authority-maintenance",
      "--writers-stopped-backup-verified",
    ];
    expect((await container!.exec(["sh", command[1]])).exitCode).toBe(1);
    expect(
      (
        await container!.exec([
          "env",
          "POSTGRES_PASSWORD=wrong-disposable",
          ...command,
        ])
      ).exitCode,
    ).not.toBe(0);
    expect((await container!.exec(command)).exitCode).toBe(0);
    await validateDatabaseAuthority(database!.client);
    const [beforeReload] = await database!
      .client`SELECT pg_conf_load_time()::text AS loaded`;
    await container!.exec([
      "sh",
      "-c",
      'sed -i \'s/scram-sha-256/trust/g\' "$PGDATA/pg_hba.conf"; kill -HUP "$(head -n 1 "$PGDATA/postmaster.pid")"',
    ]);
    await expect
      .poll(
        async () =>
          (
            await database!.client`SELECT pg_conf_load_time()::text AS loaded`
          )[0].loaded,
      )
      .not.toBe(beforeReload.loaded);
    const result = await container!.exec(command);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Maildock password authentication could not be verified.",
    );
    expect(result.output).not.toContain(password);
    await validateDatabaseAuthority(database!.client);
  });
  it("hardens the official fresh init path, preserves TCP credentials and supports a verified no-op", async () => {
    await start(true);
    await validateDatabaseAuthority(database!.client);
    const roles = await model();
    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({
      rolname: "maildock",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    expect(roles[0].oid).not.toBe(10);
    expect(roles[1]).toMatchObject({
      oid: 10,
      rolname: "maildock_bootstrap",
      rolsuper: true,
      rolcanlogin: false,
    });
    const result = await transition(await readFile(sqlPath, "utf8"));
    expect(result.exitCode, result.output).toBe(0);
    expect(await model()).toEqual(roles);
    const locked = postgres(url.replace("maildock:", "maildock_bootstrap:"), {
      max: 1,
    });
    try {
      await expect(locked`SELECT 1`).rejects.toMatchObject({ code: "28P01" });
    } finally {
      await locked.end();
    }
  });

  it("transfers populated application/auth/MFA/jobs without changing row bytes or definitions", async () => {
    await start();
    await expect(
      validateDatabaseAuthority(database!.client),
    ).rejects.toMatchObject({ category: "database_authority" });
    await migrate(database!.db, { migrationsFolder: "db/migrations" });
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: url,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: tmpdir(),
    });
    const auth = createAuth(config, database!.db);
    const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
    await initializeOwnerFixture(database!.db, {
      bootstrapSecret,
      username: "Owner-01",
      password: "correct horse battery staple",
    });
    const login = await auth.api.signInUsername({
      body: { username: "Owner-01", password: "correct horse battery staple" },
      asResponse: true,
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await setReadyFixture(database!.db);
    const accountId = "00000000-0000-4000-8000-000000000001";
    const messageId = "00000000-0000-4000-8000-000000000002";
    await database!.db.insert(mailAccounts).values({
      id: accountId,
      displayName: "Synthetic preserved account",
      email: "owner@example.invalid",
      imapHost: "unused.invalid",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      imapPassword: { v: 1, synthetic: "preserved-envelope" } as never,
      smtpHost: "unused.invalid",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    await database!.db.insert(messages).values({
      id: messageId,
      accountId,
      internalDate: new Date("2026-01-01T00:00:00Z"),
      size: 100n,
      subject: "Synthetic preserved mail",
      from: [{ address: "sender@example.invalid" }],
    });
    await database!.db.insert(messageContents).values({
      messageId,
      status: "ready",
      plainText: "Synthetic preserved body",
      sanitizedHtml: "<p>Synthetic preserved body</p>",
    });
    boss = new PgBoss({
      connectionString: url,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    await boss.createQueue("f122-preserved", { partition: true });
    const jobId = await boss.send("f122-preserved", {
      synthetic: "preserved-job-data",
    });
    await boss.stop();
    boss = undefined;
    async function snapshot() {
      const tables = await database!
        .client`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle','pgboss') AND c.relkind IN ('r','p') ORDER BY 1,2`;
      const hashes: Record<string, string> = {};
      for (const table of tables) {
        const rows = await database!
          .client`SELECT to_jsonb(t) AS row FROM ${database!.client(table.nspname)}.${database!.client(table.relname)} t`;
        hashes[`${table.nspname}.${table.relname}`] = createHash("sha256")
          .update(
            rows
              .map((r) => JSON.stringify(r.row))
              .sort()
              .join("\n"),
          )
          .digest("hex");
      }
      return hashes;
    }
    const before = await snapshot();
    const functionsBefore = await database!
      .client`SELECT p.oid,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','pgboss') ORDER BY p.oid`;
    const relationsBefore = await database!
      .client`SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle','pgboss') ORDER BY c.oid`;
    const result = await transition();
    expect(result.exitCode, result.output).toBe(0);
    await validateDatabaseAuthority(database!.client);
    expect(await snapshot()).toEqual(before);
    expect(
      await database!
        .client`SELECT p.oid,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','pgboss') ORDER BY p.oid`,
    ).toEqual(functionsBefore);
    expect(
      await database!
        .client`SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle','pgboss') ORDER BY c.oid`,
    ).toEqual(relationsBefore);
    await migrate(database!.db, { migrationsFolder: "db/migrations" });
    await migrate(database!.db, { migrationsFolder: "db/migrations" });
    const hardenedAuth = createAuth(config, database!.db);
    expect(
      await hardenedAuth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toMatchObject({ user: { username: "owner-01" } });
    expect(
      (await database!.client`SELECT verified FROM two_factor`)[0].verified,
    ).toBe(true);
    boss = new PgBoss({
      connectionString: url,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    expect((await boss.fetch("f122-preserved"))[0].id).toBe(jobId);
    await boss.complete("f122-preserved", jobId!);
    expect((await transition()).exitCode).toBe(0);
  });

  it("rolls back a fault while the bridge exists, and a fault immediately before commit", async () => {
    await start();
    const source = await readFile(sqlPath, "utf8");
    for (const faulty of [
      source.replace(
        "  ALTER DATABASE maildock",
        "  PERFORM 1 / 0; ALTER DATABASE maildock",
      ),
      source.replace("COMMIT;", "SELECT 1 / 0;\nCOMMIT;"),
    ]) {
      expect((await transition(faulty)).exitCode).not.toBe(0);
      expect(await model()).toEqual([
        expect.objectContaining({
          oid: 10,
          rolname: "maildock",
          rolsuper: true,
          rolcanlogin: true,
        }),
      ]);
      expect(
        (
          await database!
            .client`SELECT datdba FROM pg_database WHERE datname='maildock'`
        )[0].datdba,
      ).toBe(10);
    }
    expect((await transition()).exitCode).toBe(0);
    await expect(
      database!.client.begin(async (tx) => {
        await tx`CREATE TABLE public.failed_future_ddl(id integer)`;
        await tx`SELECT 1/0`;
      }),
    ).rejects.toMatchObject({ code: "22012" });
    await validateDatabaseAuthority(database!.client);
    expect(
      (
        await database!
          .client`SELECT to_regclass('public.failed_future_ddl') AS object`
      )[0].object,
    ).toBeNull();
  });

  it.each([
    "CREATE ROLE maildock_bootstrap",
    "CREATE ROLE unrelated LOGIN",
    "CREATE SCHEMA custom",
    "CREATE TABLE public.custom(id integer)",
    "CREATE FUNCTION pg_catalog.custom() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    "CREATE TYPE public.custom AS ENUM ('a')",
    "ALTER ROLE maildock SET search_path=public",
    "ALTER ROLE maildock CONNECTION LIMIT 5",
    "GRANT pg_read_all_data TO maildock",
    "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
    "CREATE SCHEMA pgboss; CREATE TABLE pgboss.custom(id integer)",
  ])("fails closed for custom state: %s", async (custom) => {
    await start();
    await database!.client.unsafe(custom);
    const result = await transition();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(refused);
    expect(result.output).not.toContain(password);
    expect((await model()).find((r) => r.rolname === "maildock")).toMatchObject(
      { oid: 10, rolsuper: true },
    );
  });

  it("refuses remaining bootstrap client sessions", async () => {
    await start();
    const writer = postgres(url, { max: 1 });
    try {
      await writer`SELECT 1`;
      expect((await transition()).exitCode).not.toBe(0);
    } finally {
      await writer.end();
    }
    expect((await transition()).exitCode).toBe(0);
  });

  it("denies cluster/server powers and supports owner DDL, locks, jobs and real 41 -> 42 upgrade", async () => {
    await start(true);
    await migrate(database!.db, { migrationsFolder: "db/migrations" });
    await migrate(database!.db, { migrationsFolder: "db/migrations" });
    for (const statement of [
      "CREATE DATABASE forbidden",
      "CREATE ROLE forbidden",
      "ALTER ROLE maildock_bootstrap LOGIN",
      "SET ROLE maildock_bootstrap",
      "SELECT pg_read_file('/etc/passwd')",
      "COPY (SELECT 1) TO PROGRAM 'true'",
    ]) {
      await expect(database!.client.unsafe(statement)).rejects.toMatchObject({
        code: "42501",
      });
    }
    await database!.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1296125023)`;
      await tx`CREATE TABLE public.future_owner_ddl(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text)`;
      await tx`ALTER TABLE public.future_owner_ddl ADD COLUMN active boolean DEFAULT true`;
      await tx`INSERT INTO public.future_owner_ddl(value) VALUES ('synthetic')`;
    });
    await database!
      .client`CREATE INDEX CONCURRENTLY future_owner_index ON public.future_owner_ddl(value)`;
    await database!.client`DROP TABLE public.future_owner_ddl`;
    boss = new PgBoss({
      connectionString: url,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    await boss.createQueue("f122-partition", {
      partition: true,
      retryLimit: 1,
      retryDelay: 0,
    });
    const id = await boss.send("f122-partition", { sample: true });
    expect((await boss.fetch("f122-partition"))[0].id).toBe(id);
    await boss.fail("f122-partition", id!, { message: "synthetic retry" });
    expect((await boss.findJobs("f122-partition", { id: id! }))[0].state).toBe(
      "retry",
    );
    expect((await boss.fetch("f122-partition"))[0].id).toBe(id);
    await boss.fail("f122-partition", id!, {
      message: "synthetic terminal failure",
    });
    expect((await boss.findJobs("f122-partition", { id: id! }))[0].state).toBe(
      "failed",
    );
    const complete = await boss.send("f122-partition", { complete: true });
    await boss.fetch("f122-partition");
    await boss.complete("f122-partition", complete!);
    expect(
      (await boss.findJobs("f122-partition", { id: complete! }))[0].state,
    ).toBe("completed");
    await boss.stop();
    boss = undefined;
    await database!.client.reserve().then(async (connection) => {
      try {
        await connection.unsafe(rollback("pgboss", 42));
      } finally {
        connection.release();
      }
    });
    expect(
      (await database!.client`SELECT version FROM pgboss.version`)[0].version,
    ).toBe(41);
    boss = new PgBoss({
      connectionString: url,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    expect(
      (await database!.client`SELECT version FROM pgboss.version`)[0].version,
    ).toBe(42);
    await boss.stop();
    boss = undefined;
    expect((await transition(await readFile(sqlPath, "utf8"))).exitCode).toBe(
      0,
    );
  });

  it("rejects every forbidden role flag, transitive SET membership, server roles and inadequate scoped authority", async () => {
    await start();
    await database!
      .client`CREATE ROLE ordinary LOGIN PASSWORD 'f122-disposable-only'`;
    await database!.client`CREATE DATABASE external OWNER ordinary`;
    const external = postgres(
      url.replace("maildock:", "ordinary:").replace(/\/maildock$/, "/external"),
      { max: 1 },
    );
    try {
      await validateDatabaseAuthority(external);
      await database!.client`CREATE ROLE unrelated`;
      await expect(external`ALTER ROLE unrelated LOGIN`).rejects.toMatchObject({
        code: "42501",
      });
      for (const flag of [
        "SUPERUSER",
        "CREATEDB",
        "CREATEROLE",
        "REPLICATION",
        "BYPASSRLS",
      ]) {
        await database!.client.unsafe(`ALTER ROLE ordinary ${flag}`);
        await expect(validateDatabaseAuthority(external)).rejects.toMatchObject(
          { category: "database_authority" },
        );
        await database!.client.unsafe(`ALTER ROLE ordinary NO${flag}`);
      }
      // An already authenticated superuser session retains a stale GUC after
      // catalog demotion. The validator must use actual catalog authority.
      await database!.client`ALTER ROLE ordinary SUPERUSER`;
      const stale = postgres(
        url
          .replace("maildock:", "ordinary:")
          .replace(/\/maildock$/, "/external"),
        { max: 1 },
      );
      try {
        expect(
          (await stale`SELECT current_setting('is_superuser') AS value`)[0]
            .value,
        ).toBe("on");
        await database!.client`ALTER ROLE ordinary NOSUPERUSER`;
        expect(
          (await stale`SELECT current_setting('is_superuser') AS value`)[0]
            .value,
        ).toBe("on");
        await validateDatabaseAuthority(stale);
      } finally {
        await stale.end();
      }
      await database!.client`CREATE ROLE middle NOLOGIN NOINHERIT`;
      await database!.client`GRANT maildock TO middle WITH INHERIT FALSE`;
      await database!.client`GRANT middle TO ordinary WITH INHERIT FALSE`;
      await expect(validateDatabaseAuthority(external)).rejects.toMatchObject({
        category: "database_authority",
      });
      await database!.client`REVOKE middle FROM ordinary`;
      await database!.client`GRANT pg_read_server_files TO ordinary`;
      await expect(validateDatabaseAuthority(external)).rejects.toMatchObject({
        category: "database_authority",
      });
      await database!.client`REVOKE pg_read_server_files FROM ordinary`;
      await validateDatabaseAuthority(external);
      await external`CREATE TABLE public.wrong_owner(id integer)`;
      await database!.client`GRANT ordinary TO maildock`;
      const adminExternal = postgres(url.replace(/\/maildock$/, "/external"), {
        max: 1,
      });
      try {
        await adminExternal`ALTER TABLE public.wrong_owner OWNER TO maildock`;
      } finally {
        await adminExternal.end();
      }
      await expect(validateDatabaseAuthority(external)).rejects.toMatchObject({
        category: "database_authority",
      });
    } finally {
      await external.end();
    }
  });

  it("maps connection failures to fixed F11 diagnostics without dependency secrets", async () => {
    const unavailable = postgres(
      "postgresql://canary:SECRET_CANARY@127.0.0.1:1/maildock",
      { connect_timeout: 1 },
    );
    try {
      let failure: unknown;
      try {
        await validateDatabaseAuthority(unavailable);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        category: "database_unavailable",
        stack: undefined,
      });
      expect(
        JSON.stringify(failureDiagnostic(failure, "database", "startup")),
      ).not.toContain("CANARY");
      expect(failureDiagnostic(failure, "database", "startup").category).toBe(
        "database_unavailable",
      );
    } finally {
      await unavailable.end();
    }
  });
});
