// Opt-in real Compose -> container -> compiled parser contract, synthetic values only.
// node tests/security/f12-compose-config.mjs IMAGE [--baseline]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const image = process.argv[2];
assert.ok(image, "Supply the locally built production image");
const baseline = process.argv.includes("--baseline");
const settings = {
  DATABASE_POOL_SIZE: ["databasePoolSize", 17, 10],
  WORKER_CONCURRENCY: ["workerConcurrency", 7, 5],
  MAILDOCK_INITIAL_SYNC_DAYS: ["initialSyncDays", 43, 30],
  MAILDOCK_MESSAGE_FETCH_BATCH_SIZE: ["messageFetchBatchSize", 173, 150],
  MAILDOCK_MESSAGE_SYNC_CONCURRENCY: ["messageSyncConcurrency", 3, 2],
  MAILDOCK_MAIL_POLL_INTERVAL_SECONDS: ["mailPollIntervalSeconds", 347, 300],
  MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES: [
    "maxMessageTextPartBytes",
    2345678,
    5242880,
  ],
};
const temp = await mkdtemp(path.join(tmpdir(), "maildock-f1246-"));
const output = path.resolve(".security-results/f12-46");
await mkdir(output, { recursive: true });
const envFile = path.join(temp, ".env");
const override = path.join(temp, "compose.yml");
await writeFile(override, `services:\n  app:\n    image: ${image}\n`);
const base = {
  APP_ORIGIN: "https://f1246.invalid",
  POSTGRES_PASSWORD: "synthetic-f1246-only",
  AUTH_SECRET: randomBytes(32).toString("base64"),
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
const cleanEnv = { ...process.env };
// Shell environment takes priority over .env: isolate every schema/Compose key.
for (const key of Object.keys(cleanEnv)) {
  if (
    /^(MAILDOCK_|MICROSOFT_|CREDENTIALS_|AUTH_SECRET$|APP_ORIGIN$|POSTGRES_|DATABASE_|WORKER_CONCURRENCY$|LOG_LEVEL$)/.test(
      key,
    )
  )
    delete cleanEnv[key];
}
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8", env: cleanEnv });
  assert.equal(r.status, 0, `docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
const compose = [
  "compose",
  "--env-file",
  envFile,
  "-p",
  `maildock-f1246-${randomBytes(4).toString("hex")}`,
  "-f",
  "docker-compose.yml",
  "-f",
  override,
];
const probe = `
import {parseConfig} from './dist-worker/shared/infrastructure/config/config.js';
const keys=${JSON.stringify(settings)};
const environment=Object.fromEntries(Object.keys(keys).map(k=>[k,process.env[k]??null]));
try {const c=parseConfig(process.env);console.log(JSON.stringify({environment,parsed:Object.fromEntries(Object.entries(keys).map(([k,[field]])=>[k,c[field]]))}));}
catch(e){console.log(JSON.stringify({environment,problems:e.problems}));}
`;
const evidence = [];
try {
  const cases = [
    [
      "canary",
      Object.fromEntries(
        Object.entries(settings).map(([k, [, v]]) => [k, String(v)]),
      ),
    ],
    ["absent", {}],
    ...Object.keys(settings).map((k) => [`empty:${k}`, { [k]: "" }]),
  ];
  for (const [label, values] of cases) {
    await writeFile(
      envFile,
      Object.entries({ ...base, ...values })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
    );
    const rendered = JSON.parse(
      docker([...compose, "config", "--format", "json"]),
    );
    assert.deepEqual(Object.keys(rendered.services).sort(), [
      "app",
      "postgres",
    ]);
    assert.equal(rendered.services.postgres.ports, undefined);
    const config = Object.fromEntries(
      Object.keys(settings).map((k) => [
        k,
        rendered.services.app.environment[k] ?? null,
      ]),
    );
    const actual = JSON.parse(
      docker([
        ...compose,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--entrypoint",
        "node",
        "app",
        "--input-type=module",
        "-e",
        probe,
      ]).trim(),
    );
    for (const [key, [, canary, fallback]] of Object.entries(settings)) {
      const expected = baseline ? null : (values[key] ?? null);
      assert.equal(config[key], expected, `${label}: Compose ${key}`);
      assert.equal(
        actual.environment[key],
        expected,
        `${label}: container ${key}`,
      );
      if (!label.startsWith("empty:") || baseline)
        assert.equal(
          actual.parsed[key],
          label === "canary" && !baseline ? canary : fallback,
          `${label}: parsed ${key}`,
        );
    }
    if (label.startsWith("empty:") && !baseline)
      assert.ok(
        actual.problems.some((p) => p.startsWith(label.slice(6) + ":")),
        "Explicit empty numeric value must fail rather than silently default",
      );
    evidence.push({
      case: label,
      supplied: values,
      compose: config,
      ...actual,
    });
    console.log(
      `${baseline ? "baseline reproduction" : "contract"} ${label}: PASS`,
    );
  }
  await writeFile(
    path.join(output, baseline ? "compose-before.json" : "compose-after.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
} finally {
  docker([...compose, "down", "--volumes", "--remove-orphans"]);
  assert.equal(path.dirname(temp), path.resolve(tmpdir()));
  assert.ok(path.basename(temp).startsWith("maildock-f1246-"));
  await rm(temp, { recursive: true, force: true });
}
