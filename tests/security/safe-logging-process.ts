// Child-process canary harness: synthetic credentials and parent-owned disposable DB.
// Never print result bodies or exception objects; stdout/stderr are the subject.
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { symmetricDecrypt } from "better-auth/crypto";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { initializeOwner } from "@/modules/auth/application/instance-auth";
import {
  startInitialMfa,
  completeInitialMfa,
} from "@/modules/auth/application/initial-mfa";
import { verifyMfaLogin } from "@/modules/auth/application/mfa-login";
import {
  regenerateRecoveryCodes,
  startAuthenticatorReplacement,
  completeAuthenticatorReplacement,
} from "@/modules/auth/application/mfa-management";
import { getValidOwnerSession } from "@/modules/auth/application/session-validation";
import { reserveAuthWork } from "@/modules/auth/infrastructure/auth-admission";
import { securityEvent } from "@/shared/infrastructure/logging/security-events";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { parseConfig } from "@/shared/infrastructure/config/config";

const origin = "https://maildock.example.test";
const password = "F11_PASSWORD_SYNTHETIC_CANARY";
const bootstrap = Buffer.alloc(32, 73).toString("base64");
const config = parseConfig({
  MAILDOCK_ENV: "production",
  APP_ORIGIN: origin,
  DATABASE_URL: process.env.F11_DATABASE_URL,
  AUTH_SECRET: Buffer.alloc(32, 74).toString("base64"),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 75).toString("base64"),
  MAILDOCK_BOOTSTRAP_SECRET: bootstrap,
  ATTACHMENTS_PATH: process.cwd(),
  LOG_LEVEL: "info",
});
const database = createDatabase(config);
const secrets = [
  password,
  bootstrap,
  config.authSecret,
  config.credentialsEncryption.keys.v1,
  "F11_CALLBACK_QUERY_CANARY",
  "F11_FORGED_LINE",
  "F11_SQL_MAIL_SECRET_CANARY",
];
const results: Record<
  string,
  { status: number; startedAt: number; finishedAt: number }
> = {};
let lastFinishedAt = 0;
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const headers = (cookie: string) => new Headers({ cookie, Origin: origin });
async function scenario(name: string, operation: () => Promise<unknown>) {
  // Pino destinations flush independently. Attribute by emission timestamp,
  // not arrival order relative to console markers. Keep intervals disjoint.
  while (Date.now() <= lastFinishedAt) await delay(1);
  const startedAt = Date.now();
  console.log(JSON.stringify({ harness: "scenario", name }));
  try {
    const result = await operation();
    results[name] = {
      status: result instanceof Response ? result.status : 200,
      startedAt,
      finishedAt: Date.now(),
    };
    lastFinishedAt = results[name].finishedAt;
    return result;
  } catch {
    results[name] = { status: 503, startedAt, finishedAt: Date.now() };
    lastFinishedAt = results[name].finishedAt;
    return undefined;
  }
}
async function installFailure(
  table: "user" | "session" | "two_factor" | "mfa_replacement",
  action: "INSERT" | "UPDATE",
) {
  await database.client.unsafe(
    `CREATE FUNCTION f11_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'F11_SQL_MAIL_SECRET_CANARY'; END $$`,
  );
  await database.client.unsafe(
    `CREATE CONSTRAINT TRIGGER f11_fail AFTER ${action} ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f11_reject_commit()`,
  );
}
async function dropFailure(table: string) {
  await database.client.unsafe(`DROP TRIGGER f11_fail ON "${table}"`);
  await database.client.unsafe("DROP FUNCTION f11_reject_commit()");
}
try {
  await migrate(database.db, { migrationsFolder: "db/migrations" });
  const auth = createAuth(config, database.db);
  const setup = () =>
    initializeOwner(
      database.db,
      { username: "owner-f11", password, bootstrapSecret: bootstrap },
      config,
    );
  await installFailure("user", "INSERT");
  await scenario("setup-rollback", setup);
  await dropFailure("user");
  await scenario("setup", setup);
  const login = (extra = {}) =>
    auth.handler(
      new Request(origin + "/api/auth/sign-in/username", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner-f11", password, ...extra }),
      }),
    );
  let response = (await scenario("password-login", login)) as Response;
  let cookie = cookies(response);
  secrets.push(
    ...(await database.client`select token from session`).map(
      (row) => row.token,
    ),
  );
  await scenario("session-db-failure", async () => {
    await database.client`alter table session rename to f11_hidden_session`;
    try {
      return await auth.handler(
        new Request(origin + "/api/auth/get-session", {
          headers: headers(cookie),
        }),
      );
    } finally {
      await database.client`alter table f11_hidden_session rename to session`;
    }
  });
  await scenario("callback-rejection", () =>
    login({
      callbackURL:
        "https://disallowed.example.test/?code=F11_CALLBACK_QUERY_CANARY\nF11_FORGED_LINE\u0001",
    }),
  );
  await scenario("enrollment-start", () =>
    startInitialMfa(database.db, config, headers(cookie), {
      bootstrapSecret: bootstrap,
      password,
    }),
  );
  const secret = async () => {
    const [factor] = await database.client`select secret from two_factor`;
    const value = await symmetricDecrypt({
      key: (await auth.$context).secretConfig,
      data: factor.secret,
    });
    secrets.push(value);
    return value;
  };
  const totp = async () =>
    (await auth.api.generateTOTP({ body: { secret: await secret() } })).code;
  let code = await totp();
  secrets.push(code);
  await installFailure("user", "UPDATE");
  await scenario("enrollment-rollback", () =>
    completeInitialMfa(database.db, config, headers(cookie), {
      bootstrapSecret: bootstrap,
      code,
    }),
  );
  await dropFailure("user");
  response = (await scenario("enrollment", () =>
    completeInitialMfa(database.db, config, headers(cookie), {
      bootstrapSecret: bootstrap,
      code,
    }),
  )) as Response;
  let codes = (await response.json()).recoveryCodes as string[];
  secrets.push(...codes);
  // The rejected callback is an expected password-path failure under existing
  // F8 rules. Reset only this disposable fixture's delay before the next flow.
  await database.client`delete from login_throttle`;
  response = (await scenario("mfa-challenge", login)) as Response;
  cookie = cookies(response);
  code = await totp();
  secrets.push(code);
  const invalid = code === "000000" ? "000001" : "000000";
  secrets.push(invalid);
  await scenario("proof-rejection", () =>
    verifyMfaLogin(database.db, config, headers(cookie), invalid, "totp"),
  );
  await installFailure("session", "INSERT");
  await scenario("mfa-login-rollback", () =>
    verifyMfaLogin(database.db, config, headers(cookie), codes[0], "recovery"),
  );
  await dropFailure("session");
  response = (await scenario("mfa-login", () =>
    verifyMfaLogin(database.db, config, headers(cookie), codes[0], "recovery"),
  )) as Response;
  cookie = cookies(response);
  secrets.push(
    ...(await database.client`select token from session`).map(
      (row) => row.token,
    ),
  );
  const management = () => ({
    password,
    proofType: "recovery" as const,
    proofCode: codes[1],
  });
  await installFailure("two_factor", "UPDATE");
  await scenario("regeneration-rollback", () =>
    regenerateRecoveryCodes(database.db, config, headers(cookie), management()),
  );
  await dropFailure("two_factor");
  const regenerated = (await scenario("regeneration", () =>
    regenerateRecoveryCodes(database.db, config, headers(cookie), management()),
  )) as { recoveryCodes: string[] };
  codes = regenerated.recoveryCodes;
  secrets.push(...codes);
  await installFailure("mfa_replacement", "INSERT");
  await scenario("replacement-start-rollback", () =>
    startAuthenticatorReplacement(database.db, config, headers(cookie), {
      password,
      proofType: "recovery",
      proofCode: codes[0],
    }),
  );
  await dropFailure("mfa_replacement");
  response = (await scenario("replacement-start", () =>
    startAuthenticatorReplacement(database.db, config, headers(cookie), {
      password,
      proofType: "recovery",
      proofCode: codes[0],
    }),
  )) as Response;
  cookie = cookies(response);
  secrets.push(cookie);
  secrets.push(
    ...cookie
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith("maildock.mfa_replacement="))
      .map((value) => value.slice(value.indexOf("=") + 1)),
  );
  code = await totp();
  secrets.push(code);
  await installFailure("user", "UPDATE");
  await scenario("replacement-complete-rollback", () =>
    completeAuthenticatorReplacement(
      database.db,
      config,
      headers(cookie),
      code,
    ),
  );
  await dropFailure("user");
  await scenario("replacement-complete", () =>
    completeAuthenticatorReplacement(
      database.db,
      config,
      headers(cookie),
      code,
    ),
  );
  await scenario("admission-rejection", async () => {
    for (let i = 0; i < 40; i++) {
      try {
        await reserveAuthWork(database.db, "management");
      } catch {
        /* exercise bounded denials */
      }
    }
  });
  await scenario("invariant-rejection", async () => {
    const fake = Object.assign({}, auth, {
      api: {
        getSession: async () => ({
          session: {
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 10000),
            absoluteExpiresAt: new Date(Date.now() + 10000),
          },
          user: { id: "nonowner" },
        }),
      },
      isInstanceOwner: async () => false,
    });
    await getValidOwnerSession(fake as unknown as typeof auth, new Headers());
  });
  await scenario("session-failure", async () => {
    // Session failure signal may have been emitted earlier: advance the coalescer
    // via its real elapsed time is unnecessary; assert the earlier bounded event.
    const fake = Object.assign({}, auth, {
      api: {
        getSession: async () => {
          throw new Error("F11_SQL_MAIL_SECRET_CANARY");
        },
      },
    });
    await getValidOwnerSession(fake as unknown as typeof auth, new Headers());
  });
  await scenario("coalescing", async () => {
    for (let i = 0; i < 100; i++) securityEvent("invariant_rejected");
  });
  await writeFile(
    process.env.F11_RESULT_FILE!,
    JSON.stringify({ results, secrets }),
  );
} catch {
  await writeFile(
    process.env.F11_RESULT_FILE!,
    JSON.stringify({ results, secrets }),
  );
  console.error("F11 synthetic process harness failed");
  process.exitCode = 1;
} finally {
  await database.client.end();
}
