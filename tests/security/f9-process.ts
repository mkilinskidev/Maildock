import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createAuth } from "../../src/modules/auth/infrastructure/auth-factory";
import { initializeOwner } from "../../src/modules/auth/application/instance-auth";
import { parseConfig } from "../../src/shared/infrastructure/config/config";
import { createDatabase } from "../../src/shared/infrastructure/database/database";
import {
  rateLimit,
  session,
} from "../../src/shared/infrastructure/database/schema";
import { forwardingHeaders } from "./f9-headers";

// Separate process: Better Auth's test fallback must not mask production behavior.
assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.TEST, "false");
const origin = "https://maildock.example.test";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const credentials = {
  username: "owner-01",
  password: "correct horse battery staple",
};
const config = parseConfig({
  MAILDOCK_ENV: "production",
  APP_ORIGIN: origin,
  DATABASE_URL: process.env.F9_TEST_DATABASE_URL,
  AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
  MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
  ATTACHMENTS_PATH: tmpdir(),
  LOG_LEVEL: "fatal",
});
const database = createDatabase(config);
try {
  await migrate(database.db, { migrationsFolder: "db/migrations" });
  await initializeOwner(
    database.db,
    { ...credentials, bootstrapSecret },
    config,
  );
  const auth = createAuth(config, database.db);
  const context = await auth.$context;
  assert.deepEqual(context.options.advanced?.ipAddress?.ipAddressHeaders, []);
  assert.equal(
    "disableIpTracking" in context.options.advanced.ipAddress,
    false,
  );
  assert.equal(context.rateLimit.enabled, true);
  assert.equal(context.options.rateLimit?.storage, "database");
  assert.equal(context.baseURL, `${origin}/api/auth`);
  for (const extra of forwardingHeaders) {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, { headers: extra }),
    );
    assert.equal(response.status, 200);
    const login = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...extra,
        },
        body: JSON.stringify(credentials),
      }),
    );
    assert.equal(login.status, 200);
    assert.match(
      login.headers.getSetCookie().join(";"),
      /__Secure-maildock.session_token=/,
    );
    assert.match(login.headers.getSetCookie().join(";"), /; Secure/);
  }
  const sessions = await database.db.select().from(session);
  assert.equal(sessions.length, forwardingHeaders.length);
  assert.ok(sessions.every((row) => row.ipAddress === ""));
  const rows = await database.db.select().from(rateLimit);
  const httpRows = rows.filter(
    (row) =>
      row.key.endsWith("|/get-session") ||
      row.key.endsWith("|/sign-in/username"),
  );
  assert.equal(httpRows.length, 2);
  for (const row of httpRows) {
    assert.ok(row.key.startsWith("no-trusted-ip|"));
    assert.equal(row.count, forwardingHeaders.length);
  }
  await database.db
    .update(rateLimit)
    .set({ count: 100 })
    .where(eq(rateLimit.key, "no-trusted-ip|/get-session"));
  for (const extra of forwardingHeaders) {
    assert.equal(
      (
        await auth.handler(
          new Request(`${origin}/api/auth/get-session`, { headers: extra }),
        )
      ).status,
      429,
    );
  }
  process.send?.({
    status: "pass",
    scenarios: forwardingHeaders.length,
    keys: httpRows.map((row) => row.key),
    sessionIp: "",
    denied: forwardingHeaders.length,
  });
} finally {
  await database.client.end();
}
