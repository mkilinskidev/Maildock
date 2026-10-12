import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { scenarios } from "../imap-transport/scenarios.js";
import { hardeningCases } from "../imap-transport/hardening-cases.js";
import { Lane as Phase2Lane } from "../imap-dovecot/client.js";
import { TransportExperiment } from "../imap-transport/hardening.js";
import { fixture, exec, oracle } from "./support.js";
const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
  runs: object[] = [];
try {
  for (const [phase, file, ids] of [
    ["1", "scenario.ts", scenarios],
    ["1B", "hardening-scenario.ts", hardeningCases],
  ] as const) {
    for (const id of ids) {
      const { stdout, stderr } = await exec(
        process.execPath,
        ["--import", "tsx", "experiments/imap-transport/" + file, id],
        { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(stderr, "");
      const r = JSON.parse(stdout);
      runs.push({ phase, ...r });
      assert.equal(r.assertionStatus, "PASS");
    }
  }
  // Exercise the original Phase 2 class unchanged, using its public host/port
  // and options to route exclusively to the new disposable server/account.
  const account = "p3-original-adapter-" + randomUUID();
  await fixture(account, 256);
  const truth = await oracle(account);
  const ca = await readFile(new URL(".runtime/tls/tls.crt", import.meta.url));
  const lane = new Phase2Lane(ca);
  lane.client.port = 32993;
  lane.client.options.auth = {
    user: account,
    pass: "maildock-disposable-only",
  };
  await lane.client.connect();
  lane.transport = new TransportExperiment(lane.client);
  const selected = await lane.client.mailboxOpen("INBOX");
  assert(selected);
  lane.epoch = { path: "INBOX", uidValidity: selected.uidValidity };
  const hits = await lane.search(129, 256);
  assert.equal(hits.length, 128);
  const rows = await lane.metadata(hits);
  assert.equal(rows.length, 128);
  assert(Buffer.isBuffer(rows[0].headers));
  assert.equal((await lane.slice(hits[0], 64)).length, 64);
  lane.client.close();
  lane.transport.dispose();
  runs.push({
    phase: "2",
    status: "PASS",
    originalClassUnchanged: true,
    identities: truth.rows.length,
    search: 128,
    metadata: 128,
    bodySlice: 64,
  });
} catch (error) {
  runs.push({ status: "FAIL", failure: String((error as Error).stack) });
  process.exitCode = 1;
} finally {
  const hashes: Record<string, string> = {};
  for (const file of [
    "imap-flow.js",
    "commands/search.js",
    "commands/fetch.js",
    "handler/token-parser.js",
    "handler/imap-stream.js",
  ])
    hashes[file] = createHash("sha256")
      .update(
        await readFile(
          new URL(
            "../../node_modules/imapflow/dist/esm/" + file,
            import.meta.url,
          ),
        ),
      )
      .digest("hex");
  await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
  await writeFile(
    new URL(`outputs/${stamp}-regressions.json.gz`, import.meta.url),
    gzipSync(JSON.stringify({ stamp, hashes, runs }, null, 2)),
  );
  await writeFile(
    new URL("outputs/regression-summary.json", import.meta.url),
    JSON.stringify(
      {
        stamp,
        counts: {
          phase1: runs.filter((r) => "phase" in r && r.phase === "1").length,
          phase1B: runs.filter((r) => "phase" in r && r.phase === "1B").length,
          phase2: runs.filter((r) => "phase" in r && r.phase === "2").length,
        },
        failures: runs.filter((r) => "status" in r && r.status === "FAIL"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Regression runner completed");
}
