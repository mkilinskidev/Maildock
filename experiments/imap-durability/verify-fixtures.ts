import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { oracle } from "./support.js";
const manifest = await readFile(
  new URL("fixtures/50000/manifest.jsonl", import.meta.url),
  "utf8",
);
const expected = new Map(
  manifest
    .trim()
    .split("\n")
    .map((line) => {
      const r = JSON.parse(line);
      return [r.messageId, r];
    }),
);
const result = [];
for (const account of ["p3-load-0", "p3-load-1"]) {
  const remote = await oracle(account);
  assert.equal(remote.rows.length, 50000);
  for (const row of remote.rows) {
    const e = expected.get(row.messageId);
    assert(e);
    assert.equal(row.subject, e.subject);
    assert.equal(row.size, e.bytes);
    assert.deepEqual(row.flags, e.flags);
  }
  result.push({
    account,
    count: remote.rows.length,
    epoch: remote.epoch,
    next: remote.next,
    oracleMs: remote.durationMs,
    identityHash: createHash("sha256")
      .update(JSON.stringify(remote.rows))
      .digest("hex"),
  });
}
await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
await writeFile(
  new URL("outputs/fixture-verification.json", import.meta.url),
  JSON.stringify(
    {
      seed: 2403,
      manifestHash: createHash("sha256").update(manifest).digest("hex"),
      result,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(result));
