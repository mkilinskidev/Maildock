import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { hardeningCases } from "../imap-transport/hardening-cases.js";
const exec = promisify(execFile);
const results: unknown[] = [];
const started = new Date().toISOString();
await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
// Call the existing individual children, preserving all Phase 1B output files.
for (const id of hardeningCases) {
  const { stdout, stderr } = await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../imap-transport/hardening-scenario.ts", import.meta.url),
      ),
      id,
    ],
    { timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(stderr, "");
  const r = JSON.parse(stdout);
  results.push(r);
  assert.equal(r.assertionStatus, "PASS");
}
const file = new URL(
  `outputs/${started.replace(/[:.]/g, "-")}-scripted-regression.json.gz`,
  import.meta.url,
);
await writeFile(
  file,
  gzipSync(
    JSON.stringify(
      {
        started,
        finished: new Date().toISOString(),
        fixture: "scripted TLS peer; not Dovecot measurements",
        results,
      },
      null,
      2,
    ) + "\n",
  ),
);
console.log(
  JSON.stringify({
    cases: results.length,
    status: "PASS",
    file: file.pathname,
  }),
);
