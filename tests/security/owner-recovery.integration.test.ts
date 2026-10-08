import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import * as s from "@/shared/infrastructure/database/schema";
import { initializeOwnerFixture } from "./mfa-fixture";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import {
  recoverOwner,
  ownerRecoveryCeremony,
  recoveryCookie,
  OwnerRecoveryRejected,
} from "@/modules/auth/application/owner-recovery";
import { preparePendingFactor } from "@/modules/auth/infrastructure/mfa-enrollment";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import {
  getValidBusinessSession,
  getValidOwnerSession,
} from "@/modules/auth/application/session-validation";
import { verifyMfaLogin } from "@/modules/auth/application/mfa-login";
import { startInitialMfa } from "@/modules/auth/application/initial-mfa";
import {
  startAuthenticatorReplacement,
  resumeAuthenticatorReplacement,
  regenerateRecoveryCodes,
} from "@/modules/auth/application/mfa-management";
import { verifyPassword } from "@/modules/auth/infrastructure/password";
import { restoreSecurityState } from "@/modules/auth/application/restore-security-state";
import {
  verifyRecoveryState,
  verifyMaintenance,
} from "@/shared/infrastructure/database/restore-verification";
import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import { recoveryCompleteSchema } from "@/modules/auth/application/owner-recovery";

let container: StartedTestContainer;
let database: ReturnType<typeof createDatabase>,
  control: ReturnType<typeof createDatabase>,
  config: AppConfig,
  auth: ReturnType<typeof createAuth>;
let owner: typeof s.user.$inferSelect,
  oldFactor: typeof s.twoFactor.$inferSelect,
  oldCodes: string[];
const password = "Previous owner password!",
  nextPassword = "Recovered owner password!";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
const headers = (cookie = "") =>
  new Headers({ Origin: config.appOrigin, cookie });
const expected = () => ({ id: owner.id, username: owner.username! });
async function code(factor = oldFactor) {
  return createOTP(
    await symmetricDecrypt({ key: config.authSecret, data: factor.secret }),
    { digits: 6, period: 30 },
  ).totp();
}
async function passwordLogin(value = password) {
  return auth.handler(
    new Request(`${config.appOrigin}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { Origin: config.appOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({
        username: owner.username,
        password: value,
        rememberMe: false,
      }),
    }),
  );
}
async function normalLogin() {
  const challenge = await passwordLogin();
  expect(challenge.ok).toBe(true);
  const response = await verifyMfaLogin(
    database.db,
    config,
    headers(cookies(challenge)),
    await code(),
    "totp",
  );
  expect(response.ok).toBe(true);
  return cookies(response);
}
async function begin() {
  await recoverOwner(database.db, config, expected(), nextPassword);
  const response = await passwordLogin(nextPassword);
  expect(await response.clone().json()).toEqual({
    ownerRecoveryRequired: true,
  });
  return cookies(response);
}
async function snapshot() {
  return {
    users: await database.db.select().from(s.user),
    account: await database.db.select().from(s.account),
    instance: await database.db.select().from(s.instanceState),
    factor: await database.db.select().from(s.twoFactor),
    recovery: await database.db.select().from(s.ownerRecovery),
    sessions: await database.db.select().from(s.session),
    verification: await database.db.select().from(s.verification),
  };
}
beforeAll(async () => {
  container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "recovery",
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
    DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/recovery`,
    AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    ATTACHMENTS_PATH: tmpdir(),
    LOG_LEVEL: "fatal",
  });
  database = createDatabase(config);
  control = createDatabase(config);
  await migrate(database.db, { migrationsFolder: "db/migrations" });
});
beforeEach(async () => {
  await database.client`drop trigger if exists recovery_fault on owner_recovery`;
  await database.client`drop trigger if exists recovery_pause on session`;
  await database.client`drop trigger if exists recovery_pause on account`;
  await database.client`drop trigger if exists recovery_pause on two_factor`;
  await database.db.delete(s.ownerRecovery);
  await database.db.delete(s.recoveryMaintenance);
  await database.db.delete(s.mfaReplacement);
  await database.db.delete(s.verification);
  await database.db.delete(s.authAdmission);
  await database.db.delete(s.rateLimit);
  await database.db.delete(s.loginThrottle);
  await database.db.delete(s.oauthAuthorizationStates);
  await database.db.update(s.instanceState).set({
    initializedAt: null,
    ownerUserId: null,
    bootstrapSecretDigest: null,
    bootstrapExpiresAt: null,
  });
  await database.db.delete(s.user);
  await initializeOwnerFixture(database.db, {
    username: "Owner-01",
    password,
    bootstrapSecret,
  });
  [owner] = await database.db.select().from(s.user);
  const pending = await preparePendingFactor(config, owner.id);
  [oldFactor] = await database.db
    .insert(s.twoFactor)
    .values({ ...pending, verified: true })
    .returning();
  oldCodes = JSON.parse(
    await symmetricDecrypt({
      key: config.authSecret,
      data: oldFactor.backupCodes,
    }),
  );
  await database.db
    .update(s.user)
    .set({ twoFactorEnabled: true })
    .where(eq(s.user.id, owner.id));
  await database.db
    .update(s.instanceState)
    .set({ bootstrapSecretDigest: null });
  auth = createAuth(config, database.db);
});
afterAll(async () => {
  await database?.client.end();
  await control?.client.end();
  await container?.stop();
});

describe("host-authorized owner recovery", () => {
  it("refuses an uninitialized or missing singleton without creating an owner", async () => {
    await database.db
      .update(s.instanceState)
      .set({ initializedAt: null, ownerUserId: null });
    await database.db.delete(s.user);
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toMatchObject({ category: "owner_recovery_uninitialized" });
    await database.db.delete(s.instanceState);
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toThrow();
    await database.db.insert(s.instanceState).values({ id: 1 });
  });
  it("refuses corrupt factor ciphertext before replacing credentials", async () => {
    await database.db
      .update(s.twoFactor)
      .set({ secret: "invalid encrypted factor" });
    const before = await snapshot();
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toMatchObject({ category: "owner_recovery_keys" });
    expect(await snapshot()).toEqual(before);
  });
  it("direct API errors commit proof counters and all other session issuers remain blocked", async () => {
    const authority = await begin();
    await expect(
      auth.api.signInUsername({
        headers: headers(),
        body: { username: owner.username!, password },
      }),
    ).rejects.toThrow();
    expect(
      (await database.db.select().from(s.authAdmission)).find(
        (row) => row.key === "manage:password",
      )?.count,
    ).toBe(1);
    await expect(
      auth.api.signInEmail({
        headers: headers(),
        body: { email: owner.email, password: nextPassword },
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.verifyTOTP({
        headers: headers(authority),
        body: { code: await code() },
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.enableTwoFactor({
        headers: headers(authority),
        body: { password: nextPassword, method: "totp" },
      }),
    ).rejects.toThrow();
    expect(await database.db.select().from(s.session)).toHaveLength(0);
  });
  it("rolls back enrollment completion and returns no codes if revocation fails", async () => {
    const authority = await begin();
    const [factor] = await database.db.select().from(s.twoFactor);
    const before = await snapshot();
    await database.client`create or replace function fail_recovery() returns trigger language plpgsql as $$ begin raise exception 'Synthetic recovery fault'; end $$`;
    await database.client`create trigger recovery_fault before delete on owner_recovery for each row execute function fail_recovery()`;
    await expect(
      ownerRecoveryCeremony(
        database.db,
        config,
        headers(authority),
        "complete",
        await code(factor),
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("preserves immutable identity and application settings while revoking every old authority", async () => {
    const sessionCookie = await normalLogin();
    const challenge = await passwordLogin();
    await database.db.insert(s.verification).values({
      id: randomUUID(),
      identifier: "trust-device-stale",
      value: owner.id,
      expiresAt: new Date(Date.now() + 600000),
    });
    await database.db.update(s.instanceState).set({ conversationView: true });
    const before = await snapshot();
    await recoverOwner(database.db, config, expected(), nextPassword);
    const after = await snapshot();
    expect(after.users[0].id).toBe(owner.id);
    expect(after.users[0].username).toBe(owner.username);
    expect(after.account[0].id).toBe(before.account[0].id);
    expect(after.instance).toEqual(before.instance);
    expect(after.sessions).toEqual([]);
    expect(after.verification).toEqual([]);
    expect(after.factor[0].id).not.toBe(oldFactor.id);
    expect(after.factor[0].verified).toBe(false);
    expect(after.users[0].twoFactorEnabled).toBe(false);
    expect(
      await verifyPassword({ hash: after.account[0].password!, password }),
    ).toBe(false);
    expect(await getValidOwnerSession(auth, headers(sessionCookie))).toBeNull();
    expect(
      await getValidBusinessSession(auth, headers(sessionCookie)),
    ).toBeNull();
    expect(await isInstanceReady(database.db)).toBe(false);
    expect(
      (
        await verifyMfaLogin(
          database.db,
          config,
          headers(cookies(challenge)),
          await code(),
          "totp",
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifyMfaLogin(
          database.db,
          config,
          headers(cookies(challenge)),
          oldCodes[0],
          "recovery",
        )
      ).ok,
    ).toBe(false);
    expect((await passwordLogin()).ok).toBe(false);
  });

  it("new password has only enrollment authority; completion returns compatible codes and requires fresh MFA login", async () => {
    const authority = await begin();
    expect(await database.db.select().from(s.session)).toHaveLength(0);
    expect(await getValidBusinessSession(auth, headers(authority))).toBeNull();
    const resumed = await ownerRecoveryCeremony(
      database.db,
      config,
      headers(authority),
      "resume",
    );
    expect(resumed.headers.get("Cache-Control")).toBe("no-store");
    expect((await resumed.json()).totpURI).toContain("otpauth://totp/");
    const [factor] = await database.db.select().from(s.twoFactor);
    const completed = await ownerRecoveryCeremony(
      database.db,
      config,
      headers(authority),
      "complete",
      await code(factor),
    );
    expect(completed.ok).toBe(true);
    const result = await completed.json();
    expect(result.freshLoginRequired).toBe(true);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(
      result.recoveryCodes.some((value: string) => oldCodes.includes(value)),
    ).toBe(false);
    expect(await database.db.select().from(s.session)).toHaveLength(0);
    expect(await isInstanceReady(database.db)).toBe(true);
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(authority),
          "resume",
        )
      ).ok,
    ).toBe(false);
    const challenge = await passwordLogin(nextPassword);
    expect((await challenge.clone().json()).twoFactorRedirect).toBe(true);
    const loggedIn = await verifyMfaLogin(
      database.db,
      config,
      headers(cookies(challenge)),
      await code(factor),
      "totp",
    );
    expect(
      await getValidBusinessSession(auth, headers(cookies(loggedIn))),
    ).not.toBeNull();
    const recoveryChallenge = await passwordLogin(nextPassword);
    expect(
      (
        await verifyMfaLogin(
          database.db,
          config,
          headers(cookies(recoveryChallenge)),
          result.recoveryCodes[0],
          "recovery",
        )
      ).ok,
    ).toBe(true);
  });

  it.each(["short", "a".repeat(129)])(
    "reuses password policy and changes nothing on rejection",
    async (value) => {
      const before = await snapshot();
      await expect(
        recoverOwner(database.db, config, expected(), value),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
  it("rolls back all security state when the final insert fails", async () => {
    await normalLogin();
    await passwordLogin();
    const before = await snapshot();
    await database.client`create or replace function fail_recovery() returns trigger language plpgsql as $$ begin raise exception 'Synthetic recovery fault'; end $$`;
    await database.client`create trigger recovery_fault before insert on owner_recovery for each row execute function fail_recovery()`;
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("refuses repeated recovery but explicit restart invalidates pending factor and token", async () => {
    const token = await begin();
    const before = await snapshot();
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toThrow(OwnerRecoveryRejected);
    expect(await snapshot()).toEqual(before);
    await recoverOwner(
      database.db,
      config,
      expected(),
      "Another recovered password!",
      true,
    );
    const after = await snapshot();
    expect(after.recovery[0].generationId).not.toBe(
      before.recovery[0].generationId,
    );
    expect(after.factor[0].id).not.toBe(before.factor[0].id);
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(token),
          "resume",
        )
      ).ok,
    ).toBe(false);
  });
  it("rejects restart without pending recovery and mismatched inspected identity", async () => {
    const before = await snapshot();
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword, true),
    ).rejects.toThrow();
    await expect(
      recoverOwner(
        database.db,
        config,
        { ...expected(), id: "wrong" },
        nextPassword,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("rotates only browser authority on re-login and survives a fresh application/database client", async () => {
    const first = await begin();
    const before = await snapshot();
    const restarted = createDatabase(config);
    try {
      const response = await createAuth(
        config,
        restarted.db,
      ).api.signInUsername({
        headers: headers(),
        body: { username: owner.username!, password: nextPassword },
        asResponse: true,
      });
      expect(response.ok).toBe(true);
      expect(
        (
          await ownerRecoveryCeremony(
            database.db,
            config,
            headers(first),
            "resume",
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await ownerRecoveryCeremony(
            restarted.db,
            config,
            headers(cookies(response)),
            "resume",
          )
        ).ok,
      ).toBe(true);
      expect((await snapshot()).factor).toEqual(before.factor);
    } finally {
      await restarted.client.end();
    }
  });
  it("expires/cancels browser authority without clearing durable recovery", async () => {
    const authority = await begin();
    await database.db.update(s.ownerRecovery).set({ expiresAt: new Date(0) });
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(authority),
          "resume",
        )
      ).ok,
    ).toBe(false);
    const again = cookies(await passwordLogin(nextPassword));
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(again),
          "cancel",
        )
      ).ok,
    ).toBe(true);
    expect(await database.db.select().from(s.ownerRecovery)).toHaveLength(1);
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(again),
          "resume",
        )
      ).ok,
    ).toBe(false);
  });
  it("does not refund factor proof budgets when a new token is issued", async () => {
    let authority = await begin();
    // Four failed proofs, with per-token limit also exercised independently.
    const [factor] = await database.db.select().from(s.twoFactor);
    const invalid = (await code(factor)) === "000000" ? "999999" : "000000";
    for (let index = 0; index < 4; index++)
      expect(
        (
          await ownerRecoveryCeremony(
            database.db,
            config,
            headers(authority),
            "complete",
            invalid,
          )
        ).ok,
      ).toBe(false);
    authority = cookies(await passwordLogin(nextPassword));
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(authority),
          "complete",
          invalid,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await ownerRecoveryCeremony(
          database.db,
          config,
          headers(authority),
          "complete",
          await code(factor),
        )
      ).status,
    ).toBe(429);
    expect(await isInstanceReady(database.db)).toBe(false);
  });
  it("rejects malformed/duplicate/anonymous ceremony tokens and enforces HTTP origin/body boundaries", async () => {
    await begin();
    for (const cookie of [
      "",
      `${recoveryCookie}=bad`,
      `${recoveryCookie}=${"a".repeat(43)}; ${recoveryCookie}=${"a".repeat(43)}`,
    ])
      expect(
        (
          await ownerRecoveryCeremony(
            database.db,
            config,
            headers(cookie),
            "resume",
          )
        ).ok,
      ).toBe(false);
    const request = new Request(
      `${config.appOrigin}/api/auth/owner-recovery/complete`,
      {
        method: "POST",
        headers: {
          Origin: "https://hostile.invalid",
          "Content-Type": "application/json",
        },
        body: '{"code":"000000"}',
      },
    );
    expect(
      (
        await initialMfaHttp(request, config, recoveryCompleteSchema, () => {
          throw new Error("Must not run");
        })
      ).status,
    ).toBe(403);
  });
  it("invalidates pending replacement and prevents bootstrap enrollment or MFA management fallback", async () => {
    const sessionCookie = await normalLogin();
    const replacement = await startAuthenticatorReplacement(
      database.db,
      config,
      headers(sessionCookie),
      { password, proofType: "totp", proofCode: await code() },
    );
    expect(replacement).toBeInstanceOf(Response);
    await recoverOwner(database.db, config, expected(), nextPassword);
    expect(await database.db.select().from(s.mfaReplacement)).toHaveLength(0);
    expect(
      await resumeAuthenticatorReplacement(
        database.db,
        config,
        headers(cookies(replacement as Response)),
      ),
    ).toBeInstanceOf(Response);
    await expect(
      startInitialMfa(database.db, config, headers(sessionCookie), {
        bootstrapSecret,
        password: nextPassword,
      }),
    ).rejects.toThrow();
    await expect(
      regenerateRecoveryCodes(database.db, config, headers(sessionCookie), {
        password: nextPassword,
        proofType: "totp",
        proofCode: await code(),
      }),
    ).rejects.toThrow();
  });
  it("takes over an unfinished first enrollment while removing bootstrap authority", async () => {
    await database.db.delete(s.twoFactor);
    await database.db.update(s.user).set({ twoFactorEnabled: false });
    await database.db
      .update(s.instanceState)
      .set({ bootstrapSecretDigest: "a".repeat(64) });
    await recoverOwner(database.db, config, expected(), nextPassword);
    const [state] = await database.db.select().from(s.instanceState);
    expect(state.ownerUserId).toBe(owner.id);
    expect(state.bootstrapSecretDigest).toBeNull();
    expect(state.bootstrapExpiresAt).toBeNull();
  });
  it("fails closed for extra users, missing credentials, and inconsistent MFA", async () => {
    const extra = randomUUID();
    await database.db
      .insert(s.user)
      .values({ id: extra, name: "Extra", email: "extra@invalid" });
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toThrow();
    await database.db.delete(s.user).where(eq(s.user.id, extra));
    await database.db.update(s.twoFactor).set({ verified: false });
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toThrow();
    await database.db.update(s.twoFactor).set({ verified: true });
    await database.db.delete(s.account);
    await expect(
      recoverOwner(database.db, config, expected(), nextPassword),
    ).rejects.toThrow();
    expect(await database.db.select().from(s.ownerRecovery)).toHaveLength(0);
  });
  it("supports offline maintenance/completion of a backup captured during recovery", async () => {
    await begin();
    const checked = await verifyRecoveryState(database.db, config, owner.id);
    expect(checked.status).toBe("pending_mfa");
    expect(checked.ownerRecovery).toBeDefined();
    const maintained = await restoreSecurityState(
      database.db,
      config,
      owner.id,
      "maintain",
    );
    expect("status" in maintained && maintained.status).toBe("pending_mfa");
    expect(
      await verifyMaintenance(
        database.db,
        config,
        owner.id,
        maintained.receiptId,
      ),
    ).toBe("pending_mfa");
    const [factor] = await database.db.select().from(s.twoFactor);
    const completed = await restoreSecurityState(
      database.db,
      config,
      owner.id,
      "complete-mfa",
      { password: nextPassword, code: await code(factor) },
    );
    expect(
      await verifyMaintenance(
        database.db,
        config,
        owner.id,
        completed.receiptId,
      ),
    ).toBe("verified");
    expect(await database.db.select().from(s.ownerRecovery)).toHaveLength(0);
    expect(completed.recoveryCodes).toHaveLength(10);
  });
});

async function waitForQuery(pattern: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows =
      await control.client`select pid from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like ${pattern}`;
    if (rows.length) return;
    await delay(20);
  }
  throw new Error("Authentication did not reach the explicit database barrier");
}
it("verified MFA login queued before recovery cannot preserve its issued session", async () => {
  const challenge = await passwordLogin();
  const proof = await code();
  await database.client`create or replace function pause_recovery_test() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(1296125022); return new; end $$`;
  await database.client`create trigger recovery_pause before insert on session for each row execute function pause_recovery_test()`;
  let login!: Promise<Response>, recovery!: Promise<void>;
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(1296125022)`;
    login = verifyMfaLogin(
      database.db,
      config,
      headers(cookies(challenge)),
      proof,
      "totp",
    );
    await waitForQuery('insert into "session"%');
    recovery = recoverOwner(database.db, config, expected(), nextPassword);
    await waitForQuery("%pg_advisory_xact_lock(1296125023)%");
  });
  const response = await login;
  await recovery;
  expect(response.ok).toBe(true);
  expect(
    await getValidBusinessSession(auth, headers(cookies(response))),
  ).toBeNull();
  expect(await database.db.select().from(s.session)).toHaveLength(0);
});
it("a concurrent authenticator replacement is completely superseded by recovery", async () => {
  const sessionCookie = await normalLogin(),
    proof = await code();
  await database.client`create or replace function pause_recovery_test() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(1296125022); return new; end $$`;
  await database.client`create trigger recovery_pause before insert on two_factor for each row execute function pause_recovery_test()`;
  let replacement!: ReturnType<typeof startAuthenticatorReplacement>,
    recovery!: Promise<void>;
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(1296125022)`;
    replacement = startAuthenticatorReplacement(
      database.db,
      config,
      headers(sessionCookie),
      { password, proofType: "totp", proofCode: proof },
    );
    await waitForQuery('insert into "two_factor"%');
    recovery = recoverOwner(database.db, config, expected(), nextPassword);
    await waitForQuery("%pg_advisory_xact_lock(1296125023)%");
  });
  const response = await replacement;
  await recovery;
  expect(await database.db.select().from(s.mfaReplacement)).toHaveLength(0);
  expect(
    (
      (await resumeAuthenticatorReplacement(
        database.db,
        config,
        headers(cookies(response as Response)),
      )) as Response
    ).ok,
  ).toBe(false);
  expect(await database.db.select().from(s.ownerRecovery)).toHaveLength(1);
});
it("two competing administrators cannot both reset ordinary recovery", async () => {
  let first!: Promise<void>, second!: Promise<void>;
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(1296125023)`;
    first = recoverOwner(database.db, config, expected(), nextPassword);
    second = recoverOwner(
      database.db,
      config,
      expected(),
      "Another competing password!",
    );
    await waitForQuery("%pg_advisory_xact_lock(1296125023)%");
  });
  const results = await Promise.allSettled([first, second]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(await database.db.select().from(s.ownerRecovery)).toHaveLength(1);
});
it("session refresh cannot revive a session deleted by recovery", async () => {
  const authority = await normalLogin();
  const dontRemember = (await auth.$context).authCookies.dontRememberToken.name;
  const refreshAuthority = authority
    .split(";")
    .filter((value) => !value.trim().startsWith(`${dontRemember}=`))
    .join(";");
  const past = new Date(Date.now() - 20 * 60 * 1000);
  await database.db.update(s.session).set({
    createdAt: past,
    updatedAt: past,
    expiresAt: new Date(past.getTime() + 12 * 60 * 60 * 1000),
  });
  await database.client`create or replace function pause_recovery_test() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(1296125022); return new; end $$`;
  await database.client`create trigger recovery_pause before update on session for each row execute function pause_recovery_test()`;
  let refresh!: ReturnType<typeof auth.api.getSession>,
    recovery!: Promise<void>;
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(1296125022)`;
    refresh = auth.api.getSession({ headers: headers(refreshAuthority) });
    await waitForQuery('update "session"%');
    recovery = recoverOwner(database.db, config, expected(), nextPassword);
    // Recovery may wait on the session row; the refresh deliberately does not hold M.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const rows =
        await control.client`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'delete from "session"%'`;
      if (rows.length) break;
      await delay(20);
      if (Date.now() >= deadline)
        throw new Error("Recovery did not wait on the refreshing session");
    }
  });
  await refresh;
  await recovery;
  expect(await database.db.select().from(s.session)).toHaveLength(0);
  expect(await getValidBusinessSession(auth, headers(authority))).toBeNull();
});
it("a password operation already inside M cannot preserve stale authority after recovery", async () => {
  await database.client`create or replace function pause_recovery_test() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(1296125022); return new; end $$`;
  await database.client`create trigger recovery_pause before insert on session for each row execute function pause_recovery_test()`;
  let login!: Promise<Response>, recovery!: Promise<void>;
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(1296125022)`;
    login = passwordLogin();
    await waitForQuery('insert into "session"%');
    recovery = recoverOwner(database.db, config, expected(), nextPassword);
    await waitForQuery("%pg_advisory_xact_lock(1296125023)%");
  });
  const response = await login;
  await recovery;
  expect(await database.db.select().from(s.session)).toHaveLength(0);
  expect(await database.db.select().from(s.verification)).toHaveLength(0);
  expect(
    (
      await verifyMfaLogin(
        database.db,
        config,
        headers(cookies(response)),
        await code(),
        "totp",
      )
    ).ok,
  ).toBe(false);
});
it("login queued behind recovery reads the new password and issues no stale session", async () => {
  await database.client`create or replace function pause_recovery_test() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(1296125022); return new; end $$`;
  await database.client`create trigger recovery_pause before update on account for each row execute function pause_recovery_test()`;
  let login!: Promise<Response>, recovery!: Promise<void>;
  await control.client.begin(async (barrier) => {
    await barrier`select pg_advisory_xact_lock(1296125022)`;
    recovery = recoverOwner(database.db, config, expected(), nextPassword);
    await waitForQuery('update "account"%');
    login = passwordLogin();
    await waitForQuery("%pg_advisory_xact_lock(1296125023)%");
  });
  await recovery;
  expect((await login).ok).toBe(false);
  expect(await database.db.select().from(s.session)).toHaveLength(0);
});
