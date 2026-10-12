import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, arch, totalmem } from "node:os";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hardeningCases } from "./hardening-cases.js";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const results: unknown[] = [];
const started = new Date().toISOString();
const repeat = Number(process.env.IMAP_HARDENING_REPEATS ?? 1);
assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10);
after(async () => {
  const names = [
    "imap-flow.js",
    "commands/search.js",
    "commands/fetch.js",
    "commands/authenticate.js",
    "commands/idle.js",
    "handler/imap-stream.js",
    "handler/token-parser.js",
    "handler/limits.js",
    "tools.js",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        createHash("sha256")
          .update(
            await readFile(
              new URL(
                `../../node_modules/imapflow/dist/esm/${name}`,
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    new URL("phase-1b-measurements.json", import.meta.url),
    JSON.stringify(
      {
        started,
        finished: new Date().toISOString(),
        environment: {
          node: process.version,
          imapflow: require("imapflow/package.json").version,
          tsx: require("tsx/package.json").version,
          typescript: require("typescript/package.json").version,
          eslint: require("eslint/package.json").version,
          prettier: require("prettier/package.json").version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          cpus: cpus().length,
          hostMemory: totalmem(),
          transport:
            "loopback TLS; compression disabled; PREAUTH except synthetic LOGIN rejection",
          repeat,
        },
        sourceHashes: hashes,
        results,
      },
      null,
      2,
    ) + "\n",
  );
});
for (let trial = 1; trial <= repeat; trial++) {
  for (const id of hardeningCases) {
    test(`${id} / trial ${trial}`, { timeout: 8000 }, async () => {
      try {
        const { stdout, stderr } = await exec(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("hardening-scenario.ts", import.meta.url)),
            id,
          ],
          { timeout: 6000, maxBuffer: 2 * 1024 * 1024 },
        );
        const result = JSON.parse(stdout);
        results.push({ ...result, trial });
        assert.equal(stderr, "", "Unhandled rejection or stderr");
        assert.equal(result.assertionStatus, "PASS", result.failure);
      } catch (error) {
        const e = error as Error & {
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        let result;
        try {
          result = JSON.parse(e.stdout ?? "");
        } catch {
          result = {
            id,
            assertionStatus: "FAIL",
            failure: e.message,
            stderr: e.stderr,
            killed: e.killed,
          };
        }
        results.push({ ...result, trial });
        throw new Error(result.failure ?? e.message);
      }
    });
  }
}
