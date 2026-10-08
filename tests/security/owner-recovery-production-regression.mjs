// Actual production launcher and Linux PTY; no published ports, synthetic secrets only.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const Docker = createRequire(import.meta.resolve("testcontainers"))(
  "dockerode",
);
const client = new Docker(
  process.platform === "win32"
    ? { socketPath: "//./pipe/docker_engine" }
    : undefined,
);
const image = process.argv[2];
assert.ok(image, "Supply a local production image");
const prefix = `maildock-owner-recovery-${randomBytes(4).toString("hex")}`,
  network = `${prefix}-net`,
  pg = `${prefix}-db`,
  app = `${prefix}-app`;
const temp = await mkdtemp(path.join(tmpdir(), "maildock-owner-recovery-"));
const created = [];
function docker(args, checked = true) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (checked)
    assert.equal(result.status, 0, `Docker operation failed: ${result.stderr}`);
  return result;
}
async function ready() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (
      docker(
        [
          "exec",
          app,
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        false,
      ).status === 0
    )
      return;
    await delay(1000);
  }
  throw new Error("Disposable production web process did not become ready");
}
async function tty(steps, args = [], expectedExit = 1, env = []) {
  const execution = await client.getContainer(app).exec({
    Cmd: ["maildock", "owner-recovery", ...args],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: "1001",
    Env: env,
  });
  const stream = await execution.start({ hijack: true, stdin: true });
  let output = "",
    ended = false;
  stream.on("data", (data) => {
    output += data.toString();
  });
  stream.on("end", () => {
    ended = true;
  });
  async function wait(predicate) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(20);
    }
    throw new Error("PTY did not reach expected prompt/exit");
  }
  try {
    for (const [prompt, input] of steps) {
      await wait(() => output.includes(prompt));
      stream.write(input);
    }
    await wait(() => ended);
    assert.equal((await execution.inspect()).ExitCode, expectedExit);
    for (const secret of [
      "Synthetic owner recovery new password!",
      "Synthetic owner recovery mismatch!",
      "Terminal password canary!",
    ])
      assert.equal(
        output.includes(secret),
        false,
        "Password was echoed to the PTY",
      );
    return output;
  } finally {
    stream.destroy();
  }
}
function probe(operation) {
  const output = docker([
    "exec",
    app,
    "node",
    "/app/owner-recovery-production-probe.mjs",
    operation,
  ]);
  console.log(output.stdout.trim());
}
try {
  const env = path.join(temp, "synthetic.env");
  await writeFile(
    env,
    `MAILDOCK_ROLE=web\nAPP_ORIGIN=https://owner-recovery.invalid\nPOSTGRES_PASSWORD=synthetic-only\nAUTH_SECRET=${randomBytes(32).toString("base64")}\nCREDENTIALS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\nATTACHMENTS_PATH=/var/lib/maildock/attachments\n`,
    { mode: 0o600 },
  );
  docker(["network", "create", network]);
  docker([
    "run",
    "-d",
    "--name",
    pg,
    "--network",
    network,
    "--network-alias",
    "postgres",
    "-e",
    "POSTGRES_USER=maildock",
    "-e",
    "POSTGRES_DB=maildock",
    "-e",
    "POSTGRES_PASSWORD=synthetic-only",
    "-v",
    `${path.resolve("scripts/postgres/99-maildock-authority.sql")}:/docker-entrypoint-initdb.d/99-maildock-authority.sql:ro`,
    "postgres:18.6-bookworm",
  ]);
  created.push(pg);
  for (let attempt = 0; attempt < 90; attempt++) {
    const logs = docker(["logs", pg], false);
    if (logs.stdout.includes("PostgreSQL init process complete")) break;
    await delay(1000);
  }
  docker([
    "run",
    "-d",
    "--name",
    app,
    "--network",
    network,
    "--env-file",
    env,
    image,
  ]);
  created.push(app);
  await ready();
  assert.equal(docker(["exec", app, "id", "-u"]).stdout.trim(), "1001");
  assert.equal(
    docker(["exec", app, "maildock", "owner-recovery"], false).status,
    1,
  );
  assert.match(await tty([], [], 1), /owner_recovery_uninitialized/);
  for (const name of [
    "recovery-production-fixture.mjs",
    "owner-recovery-production-probe.mjs",
  ])
    docker([
      "cp",
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      `${app}:/app/${name}`,
    ]);
  docker(["exec", app, "node", "/app/recovery-production-fixture.mjs", "seed"]);
  probe("before");
  const unavailable = await tty([], [], 1, [
    "POSTGRES_PASSWORD=synthetic-wrong-password",
  ]);
  assert.match(unavailable, /owner_recovery_failed: No changes submitted/);
  assert.equal(unavailable.includes("synthetic-wrong-password"), false);
  probe("unchanged");
  for (const phrase of ["", "recover owner", "RECOVER OWNER "]) {
    const output = await tty([["Type RECOVER OWNER", `${phrase}\r`]]);
    assert.match(output, /Owner username: owner-01/);
    probe("unchanged");
  }
  await tty([["Type RECOVER OWNER", "\u0003"]], [], 130);
  probe("unchanged");
  await tty(
    [
      ["Type RECOVER OWNER", "RECOVER OWNER\r"],
      ["New password:", "Terminal password canary!\u0003"],
    ],
    [],
    130,
  );
  probe("unchanged");
  await tty([
    ["Type RECOVER OWNER", "RECOVER OWNER\r"],
    ["New password:", "Synthetic owner recovery new password!\r"],
    ["Confirm password:", "Synthetic owner recovery mismatch!\r"],
  ]);
  probe("unchanged");
  await tty([
    ["Type RECOVER OWNER", "RECOVER OWNER\r"],
    ["New password:", "short\r"],
    ["Confirm password:", "short\r"],
  ]);
  probe("unchanged");
  await tty(
    [
      ["Type RECOVER OWNER", "RECOVER OWNER\r"],
      ["New password:", "Synthetic owner recovery new password!\r"],
      ["Confirm password:", "Synthetic owner recovery new password!\r"],
    ],
    [],
    0,
  );
  probe("pending");
  assert.match(await tty([], [], 1), /owner_recovery_pending/);
  await tty(
    [
      ["Type RECOVER OWNER", "RECOVER OWNER\r"],
      ["New password:", "Synthetic owner recovery new password!\r"],
      ["Confirm password:", "Synthetic owner recovery new password!\r"],
    ],
    ["--restart-pending"],
    0,
  );
  probe("pending");
  docker(["restart", app]);
  await ready();
  probe("complete");
  const logs = docker(["logs", app]);
  assert.equal(
    (logs.stdout + logs.stderr).includes(
      "Synthetic owner recovery new password!",
    ),
    false,
  );
  console.log(
    "PASS: production launcher, UID, real PTY/no echo, safe failures, atomic recovery, preserved mail data, explicit restart, process restart and fresh MFA login",
  );
} finally {
  await mkdir(".security-results/owner-recovery", { recursive: true });
  for (const name of created) {
    const logs = docker(["logs", name], false);
    await writeFile(
      `.security-results/owner-recovery/${name.endsWith("-app") ? "app" : "postgres"}.log`,
      logs.stdout + logs.stderr,
    );
  }
  for (const name of created.reverse()) docker(["rm", "-f", "-v", name], false);
  docker(["network", "rm", network], false);
  await rm(temp, { recursive: true, force: true });
}
