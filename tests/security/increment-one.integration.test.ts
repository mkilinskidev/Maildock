import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as applicationSchema from "../../src/shared/infrastructure/database/schema";

// Better Auth 1.7.5's Drizzle adapter guarded only the LIMIT 1 subquery:
// PostgreSQL READ COMMITTED waiting writers could all update the selected ID.
// Protect one recovery-code CAS winner, one admission at max-1, and limit-one.
// Test-only plugin schema: Maildock's production auth still has no MFA plugin.
const twoFactorTable = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: timestamp("locked_until"),
});
const testUser = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
});
const schema = {
  user: testUser,
  session: applicationSchema.session,
  account: applicationSchema.account,
  verification: applicationSchema.verification,
  rateLimit: applicationSchema.rateLimit,
  twoFactor: twoFactorTable,
};
const contenders = 20;
const oldCodes = JSON.stringify(
  Array.from({ length: 10 }, (_, i) => `code-${i}`),
);
const newCodes = JSON.stringify(
  Array.from({ length: 9 }, (_, i) => `code-${i + 1}`),
);

describe("PostgreSQL incrementOne security invariants", () => {
  let container: StartedTestContainer;
  let control: ReturnType<typeof postgres>;
  const clients: ReturnType<typeof postgres>[] = [];
  const authInstances: ReturnType<typeof makeAuth>[] = [];

  function makeAuth(client: ReturnType<typeof postgres>) {
    return betterAuth({
      baseURL: "http://localhost:3000",
      secret: "increment-one-regression-secret-at-least-32-characters",
      database: drizzleAdapter(drizzle(client, { schema }), {
        provider: "pg",
        schema,
      }),
      plugins: [twoFactor()],
      session: {
        additionalFields: {
          absoluteExpiresAt: { type: "date", required: true, input: false },
        },
      },
      rateLimit: { enabled: true, storage: "database", window: 3600, max: 10 },
      advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    });
  }

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "concurrency",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections", 2),
      )
      .start();
    const url = `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/concurrency`;
    control = postgres(url, { max: 2 });
    expect((await control`SHOW server_version`)[0].server_version).toMatch(
      /^18\.6(?:\D|$)/,
    );
    expect(
      (await control`SHOW default_transaction_isolation`)[0]
        .default_transaction_isolation,
    ).toBe("read committed");
    await control`CREATE TABLE two_factor (
      id text PRIMARY KEY, user_id text NOT NULL, secret text NOT NULL,
      backup_codes text NOT NULL, verified boolean NOT NULL DEFAULT true,
      failed_verification_count integer DEFAULT 0, locked_until timestamp
    )`;
    await control`CREATE TABLE rate_limit (
      id text PRIMARY KEY, key text NOT NULL UNIQUE,
      count integer NOT NULL, last_request bigint NOT NULL
    )`;
    for (let i = 0; i < contenders; i++) {
      // Each contender has its own pool and backend connection, with no JS mutex.
      const client = postgres(url, {
        max: 1,
        connection: { application_name: `increment-regression-${i}` },
      });
      clients.push(client);
      authInstances.push(makeAuth(client));
    }
    await Promise.all(authInstances.map((auth) => auth.$context));
    const pids = await Promise.all(
      clients.map(
        async (client) => (await client`SELECT pg_backend_pid() AS pid`)[0].pid,
      ),
    );
    expect(new Set(pids).size).toBe(contenders);
  });

  beforeEach(async () => {
    await control`TRUNCATE two_factor, rate_limit`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await control?.end();
    await container?.stop();
  });

  async function blockedRace<T>(
    table: "two_factor" | "rate_limit",
    id: string,
    operations: (() => Promise<T>)[],
  ) {
    // Intentionally queue all writers behind the row lock so their predicates
    // see the same initial state; reproduce contention without a scheduler race.
    const blocker = await control.reserve();
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    let transactionOpen = false;
    try {
      await blocker`BEGIN`;
      transactionOpen = true;
      await blocker`SELECT id FROM ${blocker(table)} WHERE id = ${id} FOR UPDATE`;
      pending = Promise.allSettled(operations.map((operation) => operation()));
      const deadline = Date.now() + 20_000;
      let waiting = 0;
      do {
        const rows =
          await control`SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE application_name LIKE 'increment-regression-%'
            AND state = 'active' AND wait_event_type = 'Lock'
            AND lower(query) LIKE ${`update "${table}"%`}`;
        waiting = rows[0].count;
        if (waiting === operations.length) break;
        await delay(20);
      } while (Date.now() < deadline);
      // Release only after EVERY real UPDATE has started and is blocked in PG.
      expect(waiting).toBe(operations.length);
      await blocker`COMMIT`;
      transactionOpen = false;
      const results = await pending;
      return results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
    } finally {
      if (transactionOpen) await blocker`ROLLBACK`;
      blocker.release();
      // Drain even on assertion failure, before the next test truncates tables.
      await pending;
    }
  }

  it("allows exactly one recovery-code CAS using the installed factory-wrapped adapter", async () => {
    await control`INSERT INTO two_factor (id, user_id, secret, backup_codes) VALUES ('recovery', 'owner', 'test-only', ${oldCodes})`;
    const results = await blockedRace(
      "two_factor",
      "recovery",
      authInstances.map((auth) => async () => {
        const { adapter } = await auth.$context;
        // Exact backup-codes/index.mjs predicate and set-only mutation shape.
        return adapter.incrementOne({
          model: "twoFactor",
          where: [
            { field: "id", value: "recovery" },
            { field: "backupCodes", value: oldCodes },
          ],
          increment: {},
          set: { backupCodes: newCodes },
        });
      }),
    );
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(results.filter((row) => row === null)).toHaveLength(contenders - 1);
    expect(
      (
        await control`SELECT backup_codes FROM two_factor WHERE id = 'recovery'`
      )[0].backup_codes,
    ).toBe(newCodes);
  });

  it("admits exactly one actual Better Auth HTTP request at database bucket max-1", async () => {
    const request = () =>
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { "x-forwarded-for": "192.0.2.10" },
      });
    expect((await authInstances[0].handler(request())).status).toBe(200);
    const bucket = (await control`SELECT id, count FROM rate_limit`)[0];
    expect(bucket.count).toBe(1);
    await control`UPDATE rate_limit SET count = 9 WHERE id = ${bucket.id}`;
    const results = await blockedRace(
      "rate_limit",
      bucket.id,
      authInstances.map((auth) => () => auth.handler(request())),
    );
    expect({
      admitted: results.filter((response) => response.status === 200).length,
      rejected: results.filter((response) => response.status === 429).length,
      count: (
        await control`SELECT count FROM rate_limit WHERE id = ${bucket.id}`
      )[0].count,
    }).toEqual({ admitted: 1, rejected: contenders - 1, count: 10 });
  });

  it("preserves limit-one, grouped OR predicates, signed increments and null on no match", async () => {
    await control`INSERT INTO two_factor (id, user_id, secret, backup_codes, failed_verification_count)
      VALUES ('a', 'owner', 'test-only', ${oldCodes}, 2), ('b', 'owner', 'test-only', ${oldCodes}, 2)`;
    const { adapter } = await authInstances[0].$context;
    const where = [
      { field: "userId", value: "owner" },
      { field: "id", value: "a", connector: "OR" as const },
      { field: "id", value: "b", connector: "OR" as const },
    ];
    expect(
      await adapter.incrementOne({
        model: "twoFactor",
        where,
        increment: { failedVerificationCount: -1 },
      }),
    ).not.toBeNull();
    const rows =
      await control`SELECT failed_verification_count FROM two_factor`;
    expect(rows.map((row) => row.failed_verification_count).sort()).toEqual([
      1, 2,
    ]);
    expect(
      await adapter.incrementOne({
        model: "twoFactor",
        where: [{ field: "id", value: "missing" }],
        increment: {},
        set: { backupCodes: newCodes },
      }),
    ).toBeNull();
  });
});
