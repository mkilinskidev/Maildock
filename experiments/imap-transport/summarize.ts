import { readFile, writeFile } from "node:fs/promises";

type Measurement = {
  id: string;
  experiment: string;
  assertionStatus: string;
  startUtc: string;
  endUtc: string;
  operationStartMs: number;
  operationEndMs: number;
  operationDurationMs: number;
  outcome: string;
  bytesReceived: number;
  peakRss: number;
  peakHeap: number;
  heapIncrease: number;
  eventLoopDelayMaxMs: number;
  abortToNativeCloseMs: number | null;
  abortMs: number | null;
  serverCloseMs: number | null;
  nativeSocketCloseMs: number | null;
  observations: Record<string, unknown>;
  commands: {
    connection: number;
    tag: string;
    command: string;
    startMs: number;
    taggedMs: number | null;
  }[];
  events: {
    event: string;
    connection: number;
    ms: number;
    detail?: { tag?: string; status?: string };
  }[];
};
const input = JSON.parse(
  await readFile(new URL("measurements.json", import.meta.url), "utf8"),
) as {
  environment: Record<string, unknown>;
  results: Measurement[];
};
const range = (numbers: number[], digits = 2) => {
  if (!numbers.length) return "—";
  const min = Math.min(...numbers).toFixed(digits),
    max = Math.max(...numbers).toFixed(digits);
  return min === max ? max : `${min}–${max}`;
};
const mib = (number: number) => number / 1024 / 1024;
const grouped = new Map<string, Measurement[]>();
for (const result of input.results) {
  const entries = grouped.get(result.id) ?? [];
  entries.push(result);
  grouped.set(result.id, entries);
}
const lines = [
  `Run: ${input.results[0]?.startUtc} through ${input.results.at(-1)?.endUtc} (UTC). ${input.results.length} child scenarios; ${input.results.filter((result) => result.assertionStatus === "PASS").length} passed assertions; ${input.results.filter((result) => result.assertionStatus !== "PASS").length} failed.`,
  "",
  `Host: ${input.environment.platform}/${input.environment.arch}, ${input.environment.cpu}, ${input.environment.logicalCpus} logical CPUs, ${mib(Number(input.environment.hostMemory)).toFixed(0)} MiB RAM. Runtime ${input.environment.node}; ImapFlow ${input.environment.imapflow}; tsx ${input.environment.tsx}. Transport: ${input.environment.transport}.`,
  "",
  "Per-scenario min–max across repeats; durations/close lag/event-loop delay in ms, memory in MiB. Wire bytes are operation receive totals. RSS/heap are sampled absolute peaks; Δheap is against post-SELECT baseline. This table is descriptive and does not turn an unsafe result into a safety PASS.",
  "",
  "| Scenario | E | Outcome | Duration | Received bytes | Peak RSS | Peak heap / Δheap | Max loop delay | Abort → native close |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
for (const [id, results] of grouped) {
  lines.push(
    `| ${id} | ${results[0].experiment} | ${[...new Set(results.map((result) => result.outcome))].join("/")} | ${range(results.map((result) => result.operationDurationMs))} | ${range(
      results.map((result) => result.bytesReceived),
      0,
    )} | ${range(results.map((result) => mib(result.peakRss)))} | ${range(results.map((result) => mib(result.peakHeap)))} / ${range(results.map((result) => mib(result.heapIncrease)))} | ${range(results.map((result) => result.eventLoopDelayMaxMs))} | ${range(results.flatMap((result) => (result.abortToNativeCloseMs === null ? [] : [result.abortToNativeCloseMs])))} |`,
  );
}
const cancellable = input.results.filter((result) => result.abortMs !== null);
lines.push(
  "",
  `Across destructive watchdog cases: native close lag ${range(cancellable.flatMap((result) => (result.nativeSocketCloseMs === null ? [] : [result.nativeSocketCloseMs - result.abortMs!])))} ms; peer close lag ${range(cancellable.flatMap((result) => (result.serverCloseMs === null ? [] : [result.serverCloseMs - result.abortMs!])))} ms. These are local fixture tails, not remote session-expiration guarantees.`,
);
lines.push(
  "",
  "Tagged-completion details for representative boundaries (first trial). All offsets are relative to operation start; — means absent. These show server write, client parsed completion, API settlement and lock release separately.",
  "",
  "| Scenario / command | Server tagged write | Client parsed tag | API settlement | Lock release |",
  "| --- | --- | --- | --- | --- |",
);
for (const id of [
  "search-small",
  "fetch-complete",
  "fetch-break",
  "fetch-paused",
  "idle-delayed-done",
  "idle-hang-done",
  "lock-error",
]) {
  const result = grouped.get(id)?.[0];
  if (!result) continue;
  const command = result.commands.find(
    (entry) =>
      entry.connection === 1 &&
      /^(UID SEARCH|UID FETCH|DONE)/.test(entry.command),
  );
  if (!command) continue;
  const parsed = result.events.find(
    (entry) =>
      entry.event === "client-tagged-response" &&
      entry.connection === 1 &&
      entry.detail?.tag === command.tag,
  );
  const relative = (time: number | null | undefined) =>
    time == null ? "—" : (time - result.operationStartMs).toFixed(2);
  lines.push(
    `| ${id} / ${command.command} | ${relative(command.taggedMs)} | ${relative(parsed?.ms)} | ${relative(result.operationEndMs)} | ${relative(typeof result.observations.lockReleaseMs === "number" ? result.observations.lockReleaseMs : null)} |`,
  );
}
lines.push(
  "",
  "Raw per-trial timestamps, rows, command ranges, errors/diagnostics, cleanup and subsequent-work outcomes are in [measurements.json](../../../experiments/imap-transport/measurements.json). Expected failure and recovery traces are retained alongside successful ones.",
);
const reportUrl = new URL(
  "../../docs/experiments/imap-transport/RESULTS.md",
  import.meta.url,
);
const report = await readFile(reportUrl, "utf8");
if (
  !report.includes("<!-- measurements:start -->") ||
  !report.includes("<!-- measurements:end -->")
)
  throw new Error("Report markers missing");
await writeFile(
  reportUrl,
  report.replace(
    /<!-- measurements:start -->[\s\S]*?<!-- measurements:end -->/,
    `<!-- measurements:start -->\n${lines.join("\n")}\n<!-- measurements:end -->`,
  ),
);
process.stdout.write(
  `Summarized ${input.results.length} measurements in RESULTS.md\n`,
);
