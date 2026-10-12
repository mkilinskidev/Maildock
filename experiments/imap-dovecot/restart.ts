import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { Lane } from "./client.js";
import { record, type RecordRow } from "./model.js";
const stage = process.argv[2];
const checkpoint = new URL(".runtime/orderly-checkpoint.json", import.meta.url);
if (stage === "before" || stage === "after") {
  const lane = await Lane.open();
  const local = new Map<number, RecordRow>();
  let historyBefore = Number(
    lane.client.mailbox && lane.client.mailbox.uidNext,
  );
  assert(historyBefore);
  let freshThrough = historyBefore - 1;
  if (stage === "after") {
    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(String(lane.epoch.uidValidity), saved.epoch);
    historyBefore = saved.historyBefore;
    freshThrough = saved.freshThrough;
    for (const row of saved.rows as RecordRow[]) local.set(row.uid, row);
  }
  const previous = historyBefore;
  const start = performance.now();
  for (let i = 0; i < 2 && historyBefore > 1; i++) {
    const low = Math.max(1, historyBefore - 128);
    const hits = await lane.search(low, historyBefore - 1);
    if (hits.length)
      for (const row of (await lane.metadata(hits)).map(record))
        local.set(row.uid, row);
    historyBefore = low;
  }
  // Orderly JSON checkpoint only. No fsync, transactions or power-loss claim.
  const state = {
    epoch: String(lane.epoch.uidValidity),
    historyBefore,
    freshThrough,
    rows: [...local.values()],
  };
  await writeFile(checkpoint, JSON.stringify(state));
  await lane.close();
  console.log(
    JSON.stringify({
      stage,
      previous,
      historyBefore,
      records: local.size,
      durationMs: performance.now() - start,
      setupMs: lane.setupMs,
    }),
  );
} else {
  await mkdir(new URL(".runtime/", import.meta.url), { recursive: true });
  await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
  const exec = promisify(execFile),
    started = new Date().toISOString();
  const runs = [];
  for (const part of ["before", "after"]) {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("restart.ts", import.meta.url)),
        part,
      ],
      { timeout: 15000 },
    );
    assert.equal(stderr, "");
    runs.push(JSON.parse(stdout));
  }
  assert.equal(runs[1].previous, runs[0].historyBefore);
  assert(
    runs[1].historyBefore < runs[0].historyBefore &&
      runs[1].records >= runs[0].records,
  );
  const result = {
    started,
    status: "PASS",
    runs,
    persistence:
      "disposable JSON checkpoint, orderly process exit and restore only",
    durableCrashRecovery: "NOT TESTED",
    transactionalPostgreSQL: "NOT TESTED",
  };
  await writeFile(
    new URL(
      `outputs/${started.replace(/[:.]/g, "-")}-restart.json.gz`,
      import.meta.url,
    ),
    gzipSync(JSON.stringify(result, null, 2) + "\n"),
  );
  console.log(JSON.stringify(result));
}
