import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const dir = new URL("outputs/", import.meta.url);
const names = await readdir(dir);
const suites = [];
for (const name of names.filter(
  (n) => n.startsWith("suite-") && n.endsWith(".json"),
)) {
  const bytes = await readFile(new URL(name, dir));
  await writeFile(new URL(name + ".gz", dir), gzipSync(bytes));
  suites.push(JSON.parse(bytes.toString()));
}
suites.sort((a, b) => a.started.localeCompare(b.started));
const latest = suites[suites.length - 1];
const a = suites
  .flatMap((s) => s.runs)
  .filter((r) => r.mode !== "arrivals" && r.status === "PASS");
const b = [];
for (const file of names.filter((n) => /-arrivals-50000-.*\.json$/.test(n))) {
  const bytes = await readFile(new URL(file, dir));
  const run = JSON.parse(bytes.toString());
  const indexed = suites
    .flatMap((s) => s.runs)
    .find((r) => r.trace === file + ".gz");
  const lanes = run.lanes;
  const duration =
    lanes[0]?.operations
      .filter((o: { kind: string }) => o.kind !== "SELECT")
      .map((o: { start: number; end: number }) => o.end - o.start)
      .sort((a: number, b: number) => a - b) ?? [];
  const r = { ...run };
  delete r.lanes;
  b.push({
    ...r,
    trial: indexed?.trial,
    trace: file + ".gz",
    commandCount: lanes.reduce(
      (n: number, l: { commands: unknown[] }) => n + l.commands.length,
      0,
    ),
    occupancyMs: {
      p95: duration[Math.floor(duration.length * 0.95)],
      max: Math.max(0, ...duration),
    },
  });
}
const { stdout, stderr } = await exec(
  "docker",
  [
    "compose",
    "-f",
    "experiments/imap-dovecot/compose.yaml",
    "logs",
    "--no-color",
  ],
  { maxBuffer: 8 * 1024 * 1024 },
);
const prior = names.includes("summary.json")
  ? JSON.parse(await readFile(new URL("summary.json", dir), "utf8"))
  : undefined;
const currentEvents = (stdout + stderr).split("\n").flatMap((line) => {
  const match = line.indexOf('{"event":"imap_command_finished"');
  if (match < 0) return [];
  try {
    return [JSON.parse(line.slice(match))];
  } catch {
    return [];
  }
});
const serverEvents = [
  ...new Map(
    [...(prior?.serverEvents ?? []), ...currentEvents].map((e) => [
      `${e.hostname}/${e.fields.session}/${e.fields.cmd_tag}`,
      e,
    ]),
  ).values(),
];
for (const run of b)
  for (const arrival of run.arrivals ?? []) {
    arrival.remainingWaitAtClientCompletionMs = Math.max(
      0,
      arrival.appendToAvailableMs,
    );
    const e = serverEvents.find((e) =>
      new RegExp(`APPENDUID ${run.initialEpoch} ${arrival.uid}\\]`).test(
        e.fields.tagged_reply,
      ),
    );
    if (e) {
      arrival.serverAppendCompletionUtc = e.end_time;
      arrival.serverAppendDurationMs = e.fields.duration / 1000;
      const anchor = run.clockAnchor;
      arrival.estimatedServerToAvailableMs = anchor
        ? anchor.utcMs +
          arrival.available -
          anchor.monotonicMs -
          Date.parse(e.end_time)
        : null;
    }
  }
const hashes: Record<string, string> = {};
for (const file of [
  "imap-flow.js",
  "commands/search.js",
  "commands/fetch.js",
  "handler/token-parser.js",
  "handler/imap-stream.js",
]) {
  hashes[file] = createHash("sha256")
    .update(
      await readFile(
        new URL(
          `../../node_modules/imapflow/dist/esm/${file}`,
          import.meta.url,
        ),
      ),
    )
    .digest("hex");
}
const preparation = {
  count: 50000,
  seed: 2403,
  generationMs: 8481.9107,
  preparationSeconds: 316.5351135,
  uidValidity: "1791799138",
  uidNext: 50001,
  assignedManifestSha256:
    "491ac00dd03241f4e9d598059b06f3088d9101e163468314baf2f01ad7c19deb",
  verifiedEveryIdentitySizeSubjectAndFlag: true,
  method:
    "deterministic TypeScript ustar Maildir archive; doveadm import; doveadm index; full bounded IMAP verification",
  note: "Recorded from first successful seed.ps1 output, separate from benchmark time",
};
await writeFile(
  new URL("summary.json", dir),
  JSON.stringify(
    {
      preparation,
      dependencyHashes: hashes,
      environment: latest.environment,
      runs: [...a, ...b],
      serverSamples: suites.flatMap((s) => s.serverSamples),
      serverEvents,
      limitations: [
        "Client APPEND acknowledgment is a host monotonic completion proxy; server event end_time is recorded per assigned UID.",
        "Server-to-client estimates use uncalibrated host/WSL clocks; host acknowledgment-to-availability is the principal latency.",
        "All metadata is in-memory; no PostgreSQL, transaction, pg-boss or crash-durability claim.",
        "No injected 20ms RTT or 20MiB/s cap, so original reference-profile SLAs cannot be declared passed.",
      ],
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  new URL("summary.json.gz", dir),
  gzipSync(await readFile(new URL("summary.json", dir))),
);
for (const name of names.filter(
  (n) => n.endsWith(".json") && !n.startsWith("suite-") && n !== "summary.json",
)) {
  const bytes = await readFile(new URL(name, dir));
  await writeFile(new URL(name + ".gz", dir), gzipSync(bytes));
}
console.log(
  JSON.stringify({
    aRuns: a.length,
    bRuns: b.length,
    serverEvents: serverEvents.length,
  }),
);
