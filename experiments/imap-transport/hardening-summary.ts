import { readFile, writeFile } from "node:fs/promises";
import { hardeningCases } from "./hardening-cases.js";

type Trial = {
  id: string;
  assertionStatus: string;
  property: string;
  evidence?: { kind?: string };
  before: { heapUsed: number };
  sampledPeak: { rss: number; heapUsed: number };
  operations: {
    status: string;
    kind?: string;
    metrics: {
      received: number;
      accepted: number;
      maxChunk: number;
      durationMs: number;
      maxParsedSearchTokens?: number;
      retainedSearchIdentities?: number;
    };
  }[];
};
const data = JSON.parse(
  await readFile(
    new URL("phase-1b-measurements.json", import.meta.url),
    "utf8",
  ),
) as { started: string; finished: string; results: Trial[] };
const span = (values: number[], decimals = 0) =>
  values.length
    ? `${Math.min(...values).toFixed(decimals)}–${Math.max(...values).toFixed(decimals)}`
    : "—";
const table = hardeningCases.map((id) => {
  const trials = data.results.filter((r) => r.id === id);
  const operations = trials.flatMap((r) => r.operations);
  const outcomes = [
    ...new Set(
      trials.map(
        (r) =>
          r.operations.at(-1)?.kind ??
          r.operations.at(-1)?.status ??
          r.evidence?.kind ??
          r.property,
      ),
    ),
  ].join(" / ");
  return `| ${id} | ${outcomes} | ${span(
    operations.map((r) => r.metrics.durationMs),
    2,
  )} | ${span(operations.map((r) => r.metrics.received))} / ${span(operations.map((r) => r.metrics.accepted))} | ${span(operations.map((r) => r.metrics.maxChunk))} | ${span(
    trials.map((r) => r.sampledPeak.rss / 1048576),
    2,
  )} | ${span(
    trials.map((r) => (r.sampledPeak.heapUsed - r.before.heapUsed) / 1048576),
    2,
  )} |`;
});
const summary = [
  `Run ${data.started} through ${data.finished} (UTC). Assertions: ${data.results.filter((r) => r.assertionStatus === "PASS").length}/${data.results.length}. Independently labeled unsafe reproductions: ${data.results.filter((r) => r.property === "unsafe-reproduced").length}. These counts are not safety-gate counts.`,
  "",
  "Per-operation values across three trials; content assembly rows include each separate slice and its interrupted attempt. Memory includes client, peer, decoder and telemetry, measured from process startup every 2 ms. A short transient peak can be missed.",
  "",
  "| Scenario | Final classification | Duration ms | Received / admitted bytes | Largest TLS chunk bytes | Sampled RSS MiB | Startup Δheap MiB |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...table,
].join("\n");
const path = new URL(
  "../../docs/experiments/imap-transport/PHASE_1B_RESULTS.md",
  import.meta.url,
);
const report = await readFile(path, "utf8");
if (
  !report.includes("<!-- phase1b:start -->") ||
  !report.includes("<!-- phase1b:end -->")
)
  throw new Error("Missing Phase 1B summary markers");
await writeFile(
  path,
  report.replace(
    /<!-- phase1b:start -->[\s\S]*?<!-- phase1b:end -->/,
    `<!-- phase1b:start -->\n\n${summary}\n\n<!-- phase1b:end -->`,
  ),
);
