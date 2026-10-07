// Actual base Compose/Dockerfile recovery drill; synthetic env, unique storage.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile),
  id = randomUUID().slice(0, 8);
const root = path.resolve(`.security-results/f125-${id}`);
await mkdir(root, { recursive: true });
const source = `maildock-f125-source-${id}`,
  target = `maildock-f125-target-${id}`,
  operator = `maildock-f125-operator-${id}`;
const env = path.join(root, "synthetic.env"),
  override = path.join(root, "compose.yml");
const legacyDrill = process.argv.includes("--legacy");
const productionImage =
  process.env.MAILDOCK_RECOVERY_TEST_IMAGE ??
  "maildock-f125-implementation:d98c1d3";
await writeFile(
  env,
  `APP_ORIGIN=https://recovery.invalid\nPOSTGRES_PASSWORD=synthetic-${id}\nAUTH_SECRET=${randomBytes(32).toString("base64")}\nCREDENTIALS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\nLOG_LEVEL=info\n`,
);
await writeFile(
  override,
  `services:\n  app:\n    image: ${productionImage}\n    volumes:\n      - operator_data:/operator\nvolumes:\n  operator_data:\n    external: true\n    name: ${operator}\n`,
);
async function docker(args, expectedFailure = false) {
  try {
    const result = await exec("docker", args, { maxBuffer: 20 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    if (expectedFailure)
      return {
        code: error.code,
        output: String(error.stdout ?? "") + String(error.stderr ?? ""),
      };
    await writeFile(
      path.join(root, "failure.txt"),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    throw Error(
      "Disposable Docker drill failed; inspect protected synthetic evidence.",
    );
  }
}
const compose = (project, args, expectedFailure = false) =>
  docker(
    [
      "compose",
      "--env-file",
      env,
      "-p",
      project,
      "-f",
      "docker-compose.yml",
      "-f",
      override,
      ...args,
    ],
    expectedFailure,
  );
async function wait(project, service) {
  const container = await compose(project, ["ps", "-q", service]);
  for (let i = 0; i < 90; i++) {
    const status = await docker([
      "inspect",
      "-f",
      "{{.State.Health.Status}}",
      container,
    ]);
    if (status === "healthy") return container;
    await delay(1000);
  }
  throw Error("Disposable service did not become healthy");
}
const fixture = path.resolve(
  "tests/security/f12-recovery-production-fixture.mjs",
);
async function offline(project, operation) {
  await compose(project, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "-v",
    `${fixture}:/app/recovery-fixture.mjs:ro`,
    "app",
    "recovery-fixture.mjs",
    operation,
  ]);
}
const owner = "d7afb047-b000-4b7d-bff7-450de57c5800";
try {
  await docker(["volume", "create", operator]);
  await compose(source, ["up", "-d", "--no-build"]);
  const app = await wait(source, "app");
  assert.equal(
    await docker(["inspect", "-f", "{{.Config.StopTimeout}}", app]),
    "60",
  );
  await compose(source, ["stop", "app"]);
  await compose(source, [
    "run",
    "--rm",
    "--no-deps",
    "--user",
    "0",
    "--entrypoint",
    "sh",
    "app",
    "-c",
    "chown 1001:1001 /operator; chmod 700 /operator",
  ]);
  await offline(source, "seed");
  await compose(source, ["start", "app"]);
  await wait(source, "app");
  await docker(["cp", fixture, `${app}:/app/recovery-fixture.mjs`]);
  await compose(source, [
    "exec",
    "-T",
    "app",
    "node",
    "recovery-fixture.mjs",
    "login",
  ]);
  const started = Date.now();
  await compose(source, ["stop", "app"]);
  const shutdownMs = Date.now() - started;
  const shutdown = JSON.parse(
    await docker(["inspect", "-f", "{{json .State}}", app]),
  );
  const sourceLogs = await compose(source, ["logs", "--no-color", "app"]);
  assert.ok(
    sourceLogs.includes("worker.shutdown") &&
      sourceLogs.includes("jobs.stopped"),
  );
  await offline(source, "prepare-backup");
  if (legacyDrill) {
    // Produce the real baseline archive shape in a DISPOSABLE source only.
    // The two historical functions and 32 journal rows match baseline HEAD.
    const legacyPrelude = path.resolve(
      "scripts/postgres/recovery/legacy-functions.sql",
    );
    await docker([
      "cp",
      legacyPrelude,
      `${await compose(source, ["ps", "-q", "postgres"])}:/tmp/legacy-functions.sql`,
    ]);
    await compose(source, [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'sed "s/CREATE FUNCTION/CREATE OR REPLACE FUNCTION/" /tmp/legacy-functions.sql > /tmp/legacy-prelude.sql; PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U maildock -d maildock -v ON_ERROR_STOP=1 -f /tmp/legacy-prelude.sql',
    ]);
    await compose(source, [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U maildock -d maildock -v ON_ERROR_STOP=1 -c "DROP TABLE public.recovery_maintenance; DELETE FROM drizzle.__drizzle_migrations WHERE id = 33"',
    ]);
  }
  await compose(source, [
    "exec",
    "-T",
    "postgres",
    "sh",
    "-c",
    'umask 077; PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U maildock -d maildock -Fc --no-acl -f /tmp/recovery.dump',
  ]);
  const pg = await compose(source, ["ps", "-q", "postgres"]);
  await docker([
    "cp",
    `${pg}:/tmp/recovery.dump`,
    path.join(root, "database.dump"),
  ]);
  await compose(source, [
    "run",
    "--rm",
    "--no-deps",
    "--user",
    "0",
    "--entrypoint",
    "tar",
    "app",
    "-cpf",
    "/operator/attachments.tar",
    "-C",
    "/var/lib/maildock/attachments",
    ".",
  ]);
  await offline(source, "revoke-source-session");
  // Destroy original containers AND both original data volumes before import.
  await compose(source, ["down", "-v"]);
  console.log(
    "Source destroyed; restoring matched recovery set into fresh storage.",
  );
  await compose(target, ["up", "-d", "postgres"]);
  await wait(target, "postgres");
  const targetPg = await compose(target, ["ps", "-q", "postgres"]);
  await docker([
    "cp",
    path.join(root, "database.dump"),
    `${targetPg}:/tmp/recovery.dump`,
  ]);
  if (legacyDrill)
    await compose(target, [
      "exec",
      "-T",
      "postgres",
      "sh",
      "/usr/local/bin/maildock-restore-compatibility",
      "--fresh-destination-writers-stopped",
      "/tmp/recovery.dump",
    ]);
  else
    await compose(target, [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h postgres -U maildock -d maildock --no-owner --no-acl --exit-on-error --single-transaction /tmp/recovery.dump',
    ]);
  await compose(target, [
    "run",
    "--rm",
    "--no-deps",
    "--user",
    "0",
    "--entrypoint",
    "tar",
    "app",
    "-xpf",
    "/operator/attachments.tar",
    "-C",
    "/var/lib/maildock/attachments",
  ]);
  await compose(target, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "app",
    "dist-worker/shared/infrastructure/database/migrate.js",
  ]);
  await offline(target, "verify-restored-not-maintained");
  for (const envArgs of [
    ["-e", `AUTH_SECRET=${Buffer.alloc(32, 97).toString("base64")}`],
    ["-e", "CREDENTIALS_ENCRYPTION_KEY_ID=v2"],
  ]) {
    const failure = await compose(
      target,
      [
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "node",
        ...envArgs,
        "app",
        "dist-worker/composition/recovery-process.js",
        "maintain",
        "--writers-stopped-recovery-set-verified",
        owner,
        `/operator/refused-${envArgs[1].split("=")[0]}.json`,
      ],
      true,
    );
    assert.equal(failure.code, 1);
    assert.ok(failure.output.includes("recovery_keys:"), failure.output);
    assert.ok(
      !failure.output.includes("canary") &&
        !failure.output.includes("PostgresError") &&
        !failure.output.includes("postgresql://"),
    );
    if (envArgs[1].startsWith("AUTH_SECRET="))
      assert.ok(
        !failure.output.includes(envArgs[1].slice("AUTH_SECRET=".length)),
      );
    await offline(target, "verify-restored-not-maintained");
  }
  await compose(target, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "app",
    "dist-worker/composition/recovery-process.js",
    "maintain",
    "--writers-stopped-recovery-set-verified",
    owner,
    "/operator/recovery.json",
  ]);
  await compose(target, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "app",
    "dist-worker/composition/recovery-process.js",
    "verify",
    "--writers-stopped-recovery-set-verified",
    owner,
    "/operator/recovery.json",
  ]);
  await offline(target, "verify-offline");
  const channelTest = path.resolve("tests/security/f12-recovery-channel.mjs");
  await compose(target, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "-v",
    `${channelTest}:/app/recovery-channel-test.mjs:ro`,
    "app",
    "recovery-channel-test.mjs",
  ]);
  await compose(target, ["up", "-d", "--no-build", "app"]);
  const targetApp = await wait(target, "app");
  await docker(["cp", fixture, `${targetApp}:/app/recovery-fixture.mjs`]);
  await compose(target, [
    "exec",
    "-T",
    "app",
    "node",
    "recovery-fixture.mjs",
    "verify-http",
  ]);
  const logs = await compose(target, ["logs", "--no-color", "app"]);
  assert.ok(logs.includes("jobs.started"));
  assert.ok(
    !logs.includes("ABCDE-12345") && !logs.includes("JBSWY3DPEHPK3PXP"),
  );
  if (legacyDrill) {
    await compose(target, ["stop", "app"]);
    await writeFile(
      override,
      (await readFile(override, "utf8")).replace(
        productionImage,
        "maildock-f125:d98c1d3",
      ),
    );
    await compose(target, ["up", "-d", "--no-build", "app"]);
    const oldApp = await wait(target, "app");
    // Baseline image does not contain the new maintenance modules. Check its
    // actual HTTP/worker roots after maintenance by the compatible new helper.
    await docker([
      "exec",
      oldApp,
      "node",
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict'; import {createOTP} from '@better-auth/utils/otp'; const origin=process.env.APP_ORIGIN; const post=(path,body,cookie='')=>fetch('http://127.0.0.1:3000'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',cookie},body:JSON.stringify(body)}); const cookies=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '); const challenge=await post('/api/auth/sign-in/username',{username:'owner-01',password:'Synthetic recovery password 2026!'}); assert.equal(challenge.status,200); const factor=await post('/api/auth/mfa/totp',{code:await createOTP('JBSWY3DPEHPK3PXP').totp()},cookies(challenge)); assert.equal(factor.status,200); assert.equal((await fetch('http://127.0.0.1:3000/api/accounts',{headers:{cookie:cookies(factor)}})).status,200); assert.equal((await fetch('http://127.0.0.1:3000/api/health/ready')).status,200); console.log('Matching baseline release authentication/readiness passed.');`,
    ]);
    assert.ok(
      (await compose(target, ["logs", "--no-color", "app"])).includes(
        "jobs.started",
      ),
    );
  }
  const evidence = {
    id,
    sourceDestroyed: true,
    ordinaryRestore: !legacyDrill,
    ordinaryRoleRestore: true,
    legacyBridge: legacyDrill,
    matchingOldReleaseStartup: legacyDrill,
    maintenance: true,
    verification: true,
    oldSessionRejected: true,
    oldCodeRejected: true,
    passwordTotp: true,
    newRecoveryCode: true,
    blobVerified: true,
    pgBossStarted: true,
    ready: true,
    remoteFenced: true,
    wrongAuthSecretRefusedBeforeMutation: true,
    missingCredentialKeyRefusedBeforeMutation: true,
    privateChannelVerified: true,
    stopGraceSeconds: 60,
    workerGracefulStopObserved: true,
    shutdownMs,
    sourceShutdown: {
      exitCode: shutdown.ExitCode,
      oomKilled: shutdown.OOMKilled,
    },
    archiveSha256: createHash("sha256")
      .update(await readFile(path.join(root, "database.dump")))
      .digest("hex"),
    image: await docker(["image", "inspect", "-f", "{{.Id}}", productionImage]),
    matchingOldImage: legacyDrill
      ? await docker([
          "image",
          "inspect",
          "-f",
          "{{.Id}}",
          "maildock-f125:d98c1d3",
        ])
      : undefined,
  };
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await compose(source, ["down", "-v"]).catch(() => {});
  await compose(target, ["down", "-v"]).catch(() => {});
  await docker(["volume", "rm", operator]).catch(() => {});
}
