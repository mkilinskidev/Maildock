// Opt-in production-image regression: node tests/security/f12-image.mjs [image-tag]
// Requires Docker and a locally built image. Never publishes ports or uses .env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2] ?? "maildock-f12-1:local";
const prefix = `maildock-f12-1-${randomBytes(4).toString("hex")}`;
const db = `${prefix}-db`,
  app = `${prefix}-app`,
  high = `${prefix}-high`;
const network = `${prefix}-net`,
  volume = `${prefix}-blobs`;
const temp = await mkdtemp(path.join(tmpdir(), "maildock-f12-1-"));
const output = path.resolve(".security-results/f12/image");
const productionProbe = fileURLToPath(
  new URL("./production-image-probe.mjs", import.meta.url),
);
const resources = { containers: [], network: false, volume: false };
await mkdir(output, { recursive: true });

function docker(args, checked = true, input) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (checked)
    assert.equal(
      result.status,
      0,
      `docker ${args[0]} failed: ${result.stderr}`,
    );
  return result;
}
async function ready(container, postgres = false) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = postgres
      ? docker(
          ["exec", container, "pg_isready", "-U", "maildock", "-d", "maildock"],
          false,
        )
      : docker(
          [
            "exec",
            container,
            "node",
            "-e",
            "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))",
          ],
          false,
        );
    if (result.status === 0) return;
    await delay(1000);
  }
  throw new Error(
    `Disposable ${postgres ? "database" : "application"} did not become ready`,
  );
}
async function capture(container, label) {
  const logs = docker(["logs", container]);
  await writeFile(path.join(output, `${label}.stdout.log`), logs.stdout);
  await writeFile(path.join(output, `${label}.stderr.log`), logs.stderr);
  const markers = [
    "F12_1_AFTER_QUERY_CANARY",
    "%46%31%32%5F%31%5FENCODED_CANARY",
    "F12_1_ENCODED_CANARY",
    "F12_1_CONTROL",
    "FORGED_EXTRA_LOG_LINE",
    `F12_1_LONG_${"q".repeat(2048)}`,
    "F12_1_PAGE_CANARY",
  ];
  for (const stream of [logs.stdout, logs.stderr]) {
    for (const marker of markers)
      assert.equal(
        stream.includes(marker),
        false,
        `${label}: diagnostic marker leaked`,
      );
  }
  if (label === "default") {
    const warning =
      "Request body exceeded the configured proxy limit; rejecting request.";
    assert.equal(
      logs.stderr
        .trim()
        .split(/\r?\n/)
        .filter((line) => line === warning).length,
      5,
    );
    assert.deepEqual(logs.stderr.trim().split(/\r?\n/), Array(5).fill(warning));
  }
  console.log(`${label}: independent stdout/stderr canary assertions PASS`);
}
function probe(container, args = [], setupSecret) {
  docker([
    "cp",
    productionProbe,
    `${container}:/app/production-image-probe.mjs`,
  ]);
  const result = docker(
    [
      "exec",
      "-i",
      container,
      "node",
      "/app/production-image-probe.mjs",
      ...args,
    ],
    false,
    setupSecret,
  );
  const label = args.includes("--high") ? "high" : "default";
  // These outputs contain only synthetic probe summaries, never MFA/cookies.
  const saved = Promise.all([
    writeFile(path.join(output, `${label}.probe.stdout.log`), result.stdout),
    writeFile(path.join(output, `${label}.probe.stderr.log`), result.stderr),
  ]);
  console.log(result.stdout.trim());
  assert.equal(
    result.status,
    0,
    `${label} production probe failed: ${result.stderr}`,
  );
  return saved;
}
try {
  const imageId = docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  console.log(`image ${image}: ${imageId.stdout.trim()}`);
  const env = [
    "MAILDOCK_ENV=production",
    "APP_ORIGIN=https://f12.invalid",
    `DATABASE_URL=postgresql://maildock:f12-disposable-only@${db}:5432/maildock`,
    `AUTH_SECRET=${randomBytes(32).toString("base64")}`,
    `CREDENTIALS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "ATTACHMENTS_PATH=/var/lib/maildock/attachments",
  ].join("\n");
  const envFile = path.join(temp, "synthetic.env");
  await writeFile(envFile, env, { mode: 0o600 });
  docker(["network", "create", network]);
  resources.network = true;
  docker(["volume", "create", volume]);
  resources.volume = true;
  docker([
    "run",
    "-d",
    "--name",
    db,
    "--network",
    network,
    "-e",
    "POSTGRES_USER=maildock",
    "-e",
    "POSTGRES_DB=maildock",
    "-e",
    "POSTGRES_PASSWORD=f12-disposable-only",
    "-v",
    `${path.resolve("scripts/postgres/99-maildock-authority.sql")}:/docker-entrypoint-initdb.d/99-maildock-authority.sql:ro`,
    "postgres:18.6-bookworm",
  ]);
  resources.containers.push(db);
  await ready(db, true);
  const common = [
    "--network",
    network,
    "--env-file",
    envFile,
    "-v",
    `${volume}:/var/lib/maildock/attachments`,
  ];
  docker(["run", "-d", "--name", app, ...common, image]);
  resources.containers.push(app);
  await ready(app);
  const setupLogs = docker(["logs", app]);
  const setupSecret = setupLogs.stdout.match(
    /Setup secret: ([A-Za-z0-9+/]{43}=)/,
  )?.[1];
  assert.ok(
    setupSecret,
    "generated setup credential missing from startup logs",
  );
  await probe(app, [], setupSecret);
  await capture(app, "default");
  const secretFile = path.join(temp, "synthetic-totp");
  docker(["cp", `${app}:/tmp/f12-totp`, secretFile]);
  docker([
    "run",
    "-d",
    "--name",
    high,
    ...common,
    "-e",
    "MAILDOCK_ROLE=web",
    "-e",
    "MAILDOCK_MAX_ATTACHMENT_BYTES=104857600",
    image,
  ]);
  resources.containers.push(high);
  await ready(high);
  docker(["cp", secretFile, `${high}:/tmp/f12-totp`]);
  await probe(high, ["--high"]);
  await capture(high, "high");
  console.log("F12 production-image regression: PASS");
} finally {
  for (const container of resources.containers.reverse())
    docker(["rm", "-fv", container]);
  if (resources.volume) docker(["volume", "rm", volume]);
  if (resources.network) docker(["network", "rm", network]);
  const resolvedTemp = path.resolve(temp);
  assert.equal(path.dirname(resolvedTemp), path.resolve(tmpdir()));
  assert.ok(path.basename(resolvedTemp).startsWith("maildock-f12-1-"));
  await rm(resolvedTemp, { recursive: true, force: true });
}
