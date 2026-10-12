import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { platform, arch, cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, after } from "node:test";
import { scenarios } from "./scenarios.js";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const repeat = Number(process.env.IMAP_EXPERIMENT_REPEATS ?? 1);
assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10);
const results: unknown[] = [];
const sourceFiles = [
  "imap-flow.js",
  "commands/search.js",
  "commands/fetch.js",
  "commands/idle.js",
  "handler/imap-stream.js",
  "handler/token-parser.js",
  "handler/limits.js",
  "tools.js",
];
const dependencyRoot = new URL(
  "../../node_modules/imapflow/dist/esm/",
  import.meta.url,
);
after(async () => {
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(new URL(name, dependencyRoot)))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    new URL("measurements.json", import.meta.url),
    JSON.stringify(
      {
        environment: {
          node: process.version,
          imapflow: require("imapflow/package.json").version,
          tsx: require("tsx/package.json").version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          hostMemory: totalmem(),
          repeat,
          transport:
            process.env.IMAP_EXPERIMENT_PLAINTEXT === "1"
              ? "loopback TCP; PREAUTH; no TLS/compression"
              : "loopback TLS; PREAUTH; self-signed fixture certificate; no compression",
        },
        sourceHashes,
        results,
      },
      null,
      2,
    ) + "\n",
  );
});
for (let trial = 1; trial <= repeat; trial++) {
  for (const scenario of scenarios) {
    test(`${scenario} / trial ${trial}`, { timeout: 15000 }, async () => {
      try {
        const { stdout, stderr } = await exec(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("scenario.ts", import.meta.url)),
            scenario,
          ],
          { timeout: 12000, maxBuffer: 4 * 1024 * 1024 },
        );
        assert.equal(stderr, "", "Unexpected stderr/unhandled rejection");
        const result = JSON.parse(stdout);
        results.push({ ...result, trial });
        assert.equal(result.assertionStatus, "PASS", result.failure);
        assert(
          result.nativeSocketCloseMs !== null && result.serverCloseMs !== null,
          "Missing actual transport close evidence",
        );
      } catch (e) {
        const error = e as Error & {
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        let result;
        try {
          result = JSON.parse(error.stdout ?? "");
        } catch {
          result = {
            id: scenario,
            assertionStatus: "FAIL",
            failure: error.message,
            stderr: error.stderr,
            processKilled: error.killed,
          };
        }
        results.push({ ...result, trial });
        throw new Error(JSON.stringify(result.failure ?? result));
      }
    });
  }
}
