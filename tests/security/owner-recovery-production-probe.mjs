// Synthetic fixture probe copied only into a disposable production container.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { verifyPassword } from "./dist-worker/modules/auth/infrastructure/password.js";
import { createWorkerDatabase } from "./dist-worker/shared/infrastructure/database/database-worker.js";
import { parseConfig } from "./dist-worker/shared/infrastructure/config/config.js";
import { validateDatabaseAuthority } from "./dist-worker/shared/infrastructure/database/database-authority.js";

const config = parseConfig(process.env),
  db = createWorkerDatabase(config);
const stateFile = "/tmp/owner-recovery-synthetic.json";
const oldPassword = "Synthetic recovery password 2026!",
  nextPassword = "Synthetic owner recovery new password!";
const cookie = (r) =>
  r.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
async function post(path, body, authority = "") {
  return fetch(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      Origin: config.appOrigin,
      "Content-Type": "application/json",
      cookie: authority,
    },
    body: JSON.stringify(body),
  });
}
async function login(password) {
  return post("/api/auth/sign-in/username", { username: "owner-01", password });
}
async function factorCode(factor) {
  return createOTP(
    await symmetricDecrypt({ key: config.authSecret, data: factor.secret }),
    { digits: 6, period: 30 },
  ).totp();
}
async function allState() {
  const tables =
    await db.client`select tablename from pg_tables where schemaname='public' order by tablename`;
  const rows = {};
  for (const { tablename } of tables)
    rows[tablename] =
      await db.client`select to_jsonb(t) as value from ${db.client(tablename)} t order by to_jsonb(t)::text`;
  return JSON.parse(JSON.stringify(rows));
}
const durable = (state) =>
  Object.fromEntries(
    Object.entries(state).filter(
      ([name]) =>
        ![
          "user",
          "account",
          "session",
          "verification",
          "two_factor",
          "owner_recovery",
          "mfa_replacement",
          "rate_limit",
          "auth_admission",
          "login_throttle",
        ].includes(name),
    ),
  );
try {
  await validateDatabaseAuthority(db.client);
  const operation = process.argv[2];
  if (operation === "before") {
    const { initializeLocalSearchBodies } =
      await import("./dist-worker/modules/mail/infrastructure/search-local-backfill.js");
    await initializeLocalSearchBodies(db.db);
    await db.client`update instance_state set bootstrap_secret_digest=null,bootstrap_expires_at=null`;
    const [factor] = await db.client`select * from two_factor`;
    const challenge = await login(oldPassword);
    const authenticated = await post(
      "/api/auth/mfa/totp",
      { code: await factorCode({ secret: factor.secret }) },
      cookie(challenge),
    );
    assert.equal(authenticated.status, 200);
    const pending = await login(oldPassword);
    assert.equal(pending.status, 200);
    await writeFile(
      stateFile,
      JSON.stringify({
        state: await allState(),
        oldSession: cookie(authenticated),
        oldChallenge: cookie(pending),
      }),
      { mode: 0o600 },
    );
  } else if (operation === "unchanged") {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(await allState(), saved.state);
  } else if (operation === "pending") {
    const page = await fetch("http://127.0.0.1:3000/owner-recovery-mfa", {
      redirect: "manual",
    });
    assert.equal(
      page.status,
      200,
      "The enrollment page must be reachable without a business session",
    );
    assert.ok((await page.text()).includes("Set up a new authenticator"));
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    const state = await allState();
    assert.deepEqual(durable(state), durable(saved.state));
    for (const key of ["id", "username", "display_username", "email", "name"])
      assert.equal(state.user[0].value[key], saved.state.user[0].value[key]);
    assert.equal(state.owner_recovery.length, 1);
    assert.equal(state.session.length, 0);
    assert.equal(state.verification.length, 0);
    assert.equal(
      await verifyPassword({
        password: oldPassword,
        hash: state.account[0].value.password,
      }),
      false,
    );
    assert.equal(
      await verifyPassword({
        password: nextPassword,
        hash: state.account[0].value.password,
      }),
      true,
    );
    assert.notEqual(
      state.two_factor[0].value.secret,
      saved.state.two_factor[0].value.secret,
    );
    for (const [method, code] of [
      ["totp", await factorCode(saved.state.two_factor[0].value)],
      ["recovery", "ABCDE-12345"],
    ])
      assert.equal(
        (await post(`/api/auth/mfa/${method}`, { code }, saved.oldChallenge))
          .ok,
        false,
      );
    assert.equal(
      (
        await fetch("http://127.0.0.1:3000/api/accounts", {
          headers: { cookie: saved.oldSession },
        })
      ).status,
      401,
    );
    const logged = await login(nextPassword);
    assert.deepEqual(await logged.clone().json(), {
      ownerRecoveryRequired: true,
    });
    assert.ok(
      logged.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith("maildock.owner_recovery=") &&
            value.includes("HttpOnly") &&
            value.includes("Secure") &&
            value.includes("SameSite=Strict"),
        ),
    );
    saved.authority = cookie(logged);
    await writeFile(stateFile, JSON.stringify(saved), { mode: 0o600 });
    const resumed = await post(
      "/api/auth/owner-recovery/resume",
      {},
      saved.authority,
    );
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers.get("cache-control"), "no-store");
    assert.match((await resumed.json()).totpURI, /^otpauth:\/\/totp\//);
  } else if (operation === "complete") {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    const [factor] = await db.client`select * from two_factor`;
    // Re-login after process/container restart, replacing the prior token.
    const logged = await login(nextPassword);
    assert.equal(logged.status, 200);
    const authority = cookie(logged);
    assert.equal(
      (await post("/api/auth/owner-recovery/resume", {}, saved.authority)).ok,
      false,
    );
    const completed = await post(
      "/api/auth/owner-recovery/complete",
      { code: await factorCode(factor) },
      authority,
    );
    assert.equal(completed.status, 200);
    const result = await completed.json();
    assert.equal(result.freshLoginRequired, true);
    assert.equal(result.recoveryCodes.length, 10);
    assert.equal((await db.client`select from session`).length, 0);
    const challenge = await login(nextPassword);
    assert.equal((await challenge.clone().json()).twoFactorRedirect, true);
    assert.equal(
      (
        await post(
          "/api/auth/mfa/totp",
          { code: await factorCode(factor) },
          cookie(challenge),
        )
      ).status,
      200,
    );
    const backup = await login(nextPassword);
    assert.equal(
      (
        await post(
          "/api/auth/mfa/recovery",
          { code: result.recoveryCodes[0] },
          cookie(backup),
        )
      ).status,
      200,
    );
    assert.equal((await db.client`select from owner_recovery`).length, 0);
    assert.deepEqual(durable(await allState()), durable(saved.state));
  } else throw new Error("Unknown synthetic operation");
  console.log(
    JSON.stringify({
      operation,
      status: "PASS",
      evidence: createHash("sha256").update(operation).digest("hex"),
    }),
  );
} finally {
  await db.client.end();
}
