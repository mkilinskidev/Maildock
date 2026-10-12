import { readFile, readdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const outputs = new URL("outputs/", import.meta.url);
const summary = JSON.parse(
  await readFile(new URL("summary.json", outputs), "utf8"),
);
const runs = summary.runs.filter(
  (r: { status: string }) => r.status === "PASS",
);
type Run = {
  mode: string;
  profile: string;
  trigger: string;
  first128Ms: number;
  first1000Ms: number;
  completeMs: number;
  peakRss: number;
  peakHeap: number;
  bytesIn: number;
  bytesOut: number;
  commandCount: number;
  eventLoopMs: { max: number };
  occupancyMs: { max: number; p95: number };
  cpuMicros: { user: number; system: number };
  arrivals: {
    appendToAvailableMs: number;
    appendToDetectionMs: number;
    detectionToAdmissionMs: number;
    admissionToRetrievalMs: number;
    retrievalToAvailableMs: number;
    serverAppendCompletionUtc?: string;
    appendStart: number;
    available: number;
  }[];
  userEvents: { waitingMs: number; bodyWaitingMs: number }[];
  trace: string;
  status: string;
  failure?: string;
};
const range = (values: number[], digits = 2) =>
  values.length
    ? `${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)}`
    : "—";
const quantile = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)] ?? 0;
};
const major = (profile: string) =>
  (runs as Run[]).filter(
    (r) =>
      r.mode === "arrivals" && r.profile === profile && r.trigger === "fetch",
  );
const aTable = ["baseline", "progressive"]
  .map((mode) => {
    const rows = (runs as Run[]).filter((r) => r.mode === mode);
    return `| ${mode} | ${rows.length} | ${range(rows.map((r) => r.first128Ms))} | ${range(rows.map((r) => r.first1000Ms))} | ${range(rows.map((r) => r.completeMs / 1000))} | ${range(rows.map((r) => r.peakRss / 1048576))} | ${range(rows.map((r) => r.peakHeap / 1048576))} | ${range(rows.map((r) => r.eventLoopMs.max))} |`;
  })
  .join("\n");
const cTable = ["C1", "C2", "C5-one", "C5-two"]
  .map((profile) => {
    const rows = major(profile),
      latencies = rows.flatMap((r) =>
        r.arrivals.map((a) => Math.max(0, a.appendToAvailableMs)),
      );
    const sessions =
      profile === "C1" ? "1 / 2" : profile === "C5-two" ? "3 / 4" : "2 / 3";
    return `| ${profile} | ${rows.length} | ${sessions} | ${quantile(latencies, 0.5).toFixed(2)} | ${quantile(latencies, 0.95).toFixed(2)} | ${Math.max(0, ...latencies).toFixed(2)} | ${Math.max(0, ...rows.flatMap((r) => r.userEvents.map((e) => e.waitingMs))).toFixed(2)} | ${Math.max(0, ...rows.flatMap((r) => r.userEvents.map((e) => e.bodyWaitingMs))).toFixed(2)} | ${range(rows.map((r) => r.completeMs / 1000))} |`;
  })
  .join("\n");
const resources = ["C1", "C2", "C5-one", "C5-two"]
  .map((profile) => {
    const rows = major(profile);
    return `| ${profile} | ${range(rows.map((r) => r.peakRss / 1048576))} | ${range(rows.map((r) => r.peakHeap / 1048576))} | ${range(rows.map((r) => (r.cpuMicros.user + r.cpuMicros.system) / 1e6))} | ${range(rows.map((r) => r.eventLoopMs.max))} | ${range(rows.map((r) => r.occupancyMs.p95))} | ${Math.max(...rows.map((r) => r.occupancyMs.max)).toFixed(2)} | ${range(
      rows.map((r) => r.commandCount),
      0,
    )} | ${range(rows.map((r) => r.bytesIn / 1048576))} / ${range(rows.map((r) => r.bytesOut / 1048576))} |`;
  })
  .join("\n");
const boundaries = (runs as Run[])
  .filter((r) => r.mode === "arrivals" && r.trigger !== "fetch")
  .map(
    (r) =>
      `| ${r.profile} | ${r.trigger} | ${Math.max(...r.arrivals.map((a) => a.appendToAvailableMs)).toFixed(2)} | ${r.completeMs.toFixed(2)} | PASS: 50,010 exact local UIDs |`,
  )
  .join("\n");
const files = (await readdir(outputs))
  .filter((f) => f.includes("changes-") && f.endsWith(".json.gz"))
  .sort();
const changes = files.length
  ? JSON.parse(
      gunzipSync(
        await readFile(new URL(files[files.length - 1], outputs)),
      ).toString(),
    )
  : undefined;
const cases = changes?.cases ?? [];
const caseTable = cases
  .map(
    (c: {
      case: string;
      status: string;
      rows?: number;
      durationMs?: number;
      overshoot?: number;
      requestedDeletions?: number;
      finalCount?: number;
      arrivals?: { latencyMs: number }[];
    }) =>
      `| ${c.case} | ${c.status} | ${c.rows !== undefined ? `rows=${c.rows}; ` : ""}${c.durationMs !== undefined ? `${c.durationMs.toFixed(2)} ms; ` : ""}${c.overshoot !== undefined ? `received overshoot ${c.overshoot} bytes; ` : ""}${c.requestedDeletions !== undefined ? `${c.requestedDeletions} deletions; final ${c.finalCount}; worst arrival ${Math.max(...(c.arrivals ?? []).map((a) => a.latencyMs)).toFixed(2)} ms` : ""} |`,
  )
  .join("\n");
const failures = (summary.runs as Run[])
  .filter((r) => r.status !== "PASS")
  .map(
    (r) =>
      `| [${r.trace}](../../../experiments/imap-dovecot/outputs/${r.trace}) | ${String(r.failure).split("\n")[0].replaceAll("|", "/").slice(0, 240)} |`,
  )
  .join("\n");
const arrivalRuns = (runs as Run[]).filter((r) => r.mode === "arrivals"),
  arrivals = arrivalRuns.flatMap((r) => r.arrivals);
const negative = arrivals.filter((a) => a.appendToAvailableMs < 0).length;
const serverMatched = arrivals.filter(
  (a) => a.serverAppendCompletionUtc,
).length;
const stats = summary.serverSamples
  .filter((s: { stats?: string }) => s.stats)
  .map((s: { stats: string }) => JSON.parse(s.stats));
const text = `# Dovecot benchmark results

Measured on 2026-10-12. Sources and exact reproduction commands: [SETUP.md](SETUP.md). Machine-readable evidence: [summary.json](../../../experiments/imap-dovecot/outputs/summary.json); lossless per-run traces are linked there. All protected Phase 1/1B artifacts remain unchanged.

## Scope and conditions

Actual Dovecot 2.4.3-dev, authenticated verified loopback TLS, ImapFlow 2.0.6. Host: Intel Core Ultra 7 155H, 22 logical CPUs, 33,777,467,392 bytes RAM, Node 24.21.0. Docker Desktop WSL Linux engine has 22 CPUs and 16,481,640,448 bytes memory; fixture container is limited to two CPUs and 1 GiB. No injected RTT or bandwidth limit. Server indexes and metadata were warmed by complete independent fixture verification. Client processes are fresh; cold storage/server runs were not measured.

Initial count: **50,000**, independently verified against every manifest identity, subject, size and permanent flag; UIDNEXT 50,001, UIDVALIDITY 1791799138. Fixture generation 8.482 seconds; total preparation including verification 316.535 seconds. Actual assigned UIDs were retrieved from IMAP, never manufactured. Old-Date messages, multipart and attachments are in the fixture. The initial manifest hash is in SETUP and summary. A later destructive-test reset has its own epoch in the trace.

An in-memory Map holds compact metadata keyed by current epoch/UID, and boundaries move only after complete exact metadata. This is observable local availability, **not PostgreSQL transaction durability**. The orderly-restart JSON checkpoint is also not a crash-consistent database. The runner never invokes production services.

## A — Full inventory versus descending windows

Three runs each, alternating order. First visibility is after the first complete bounded metadata commit, not first iterator delivery. First 1,000 means the first completed batch crossing that count. Setup/authentication is recorded separately.

| Method | Runs | First 128 ms | First 1,000 ms | Full 50k seconds | Peak RSS MiB | Peak heap MiB | Maximum event-loop delay ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
${aTable}

The baseline performs one full closed-UID-range FLAGS inventory and then newest-first exact metadata batches of 128. This corresponds to Thunderbird research T07–T10's full initial UID/flag discovery prerequisite. Its metadata batching, descending order, ImapFlow parser, in-memory publication and BODYSTRUCTURE differ from Thunderbird; **this is not a Thunderbird benchmark**. The 16 MiB inventory aggregate budget is a disclosed larger baseline allowance; other operations use 2 MiB.

Baseline wire totals: 25,071,888 incoming / 319,275 outgoing bytes and 402 logged outgoing commands including startup. Progressive totals: 22,971,897–22,971,913 incoming / 331,567 outgoing bytes, 792 commands. TLS record overhead, authentication bytes before transport instrumentation, server disk I/O and body bytes outside requested metadata are not included. Progressive work saves the inventory but adds closed-window SEARCH commands. Complete-time ranges overlap: faster first availability does not establish universally higher throughput. Full inventory caused much larger measured event-loop stalls.

## B/C — 50,000 plus ten arrivals and connection budgets

**${arrivalRuns.length} successful primary-size arrival runs**, ${arrivals.length} independently appended identities, all ten observed and all 50,010 UIDs checked in every successful run. Failure traces remain below. Each major profile has at least three FETCH-trigger trials. C5-one is one data socket plus watcher; C5-two adds one preconnected user-data socket. C5 does not open five sockets.

| Profile | FETCH-trigger runs | Own / with external actor sessions | Post-completion wait p50 ms | p95 ms | Worst ms | Worst user admission wait ms | Worst BODY.PEEK admission from intent ms | Full-history seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${cTable}

Resource totals below include the watcher and external actor, initial setup, fixture oracle and cleanup. Data-socket occupancy excludes SELECT and passive IDLE. Per-lane breakdowns and every command interval are in the trace; total occupied duration can be obtained by summing those intervals, rather than treating passive authentication as busy work.

| Profile | RSS MiB | Heap MiB | Whole-process CPU seconds | Max loop delay ms | Data occupation p95 ms | Max data occupation ms | Logged commands | Decrypted in / out MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${resources}

Session counts distinguish client-owned data/watcher sockets from the independent APPEND actor. doveadm who samples corroborate live sessions but are not an exhaustive peak audit. One data socket is never used concurrently by two operations. Watcher IDLE occupies its own socket without a data turn. C1 IDLE is explicitly exited by DONE; actual tagged IDLE completion precedes NOOP. Command/tag times and operation intervals are retained in raw traces. The extra C5 user lane greatly reduces this small request's queue delay, while these measurements do not establish a freshness or throughput gain that justifies concurrent authoritative writers.

Latency reference: local monotonic completion of the independent APPEND call. Dovecot's actual imap_command_finished.end_time and APPENDUID are matched for **${serverMatched}/${arrivals.length}** successful arrivals. Server-to-client UTC estimates have no host/WSL clock calibration and are uncertain. Metadata was already available before the APPEND call completed in **${negative}** cases; raw signed values are retained. The table reports remaining wait at that checkpoint as max(0, signed delta), meaning “already available” for those cases, not a negative delivery duration. APPEND request duration and server command duration remain separate.

Each UID has separate append completion, fresh-frontier detection, arrival-unit admission, completed retrieval and synchronous local publication timestamps. Detection here is the refreshed STATUS frontier observation, not the watcher hint or first metadata iterator row. Selector admission is immediate after that observation in this small single-account loop; waiting behind history appears in append-to-detection and user-intent wait. The first EXISTS hint is recorded separately. This is not a complete production selector/due-generation implementation.

Closed SEARCH/FETCH commands fully settle before re-admission and setImmediate yields an execution turn. Hints coalesce into a boolean; polling runs every eighth boundary and, conservatively, every boundary once APPEND work has completed. That extra polling slows history and prevents treating B/C throughput as an isolated metadata algorithm cost. No 15-second production polling SLA, continuous-arrival fairness, many-account workload or ten-minute queue plateau is proved.

## Arrival boundary trials

| Profile | Injection | Worst remaining signed completion-to-availability ms | Full run ms | Identity result |
| --- | --- | --- | --- | --- |
${boundaries}

SEARCH/FETCH injection launches the independent append while the client's operation promise is active. Dovecot completion can race the append; it does not provide a deterministic server-side pause barrier. These are **nondeterministic overlap trials**, with exact operation/APPEND intervals retained. “After” is an explicit completed-operation boundary; “waiting” is a controlled 25 ms admission pause; C1 IDLE has an explicit IDLE/DONE boundary. Boundary cases have one trial per profile, not three or a broad seeded race matrix. The existing scripted TLS fixture retains deterministic malformed/hung cases.

## D/E — Remote changes, resource limits and recovery

Latest destructive trace: ${files.length ? `[${files[files.length - 1]}](../../../experiments/imap-dovecot/outputs/${files[files.length - 1]})` : "not yet recorded"}. Overall destructive runner: **${changes?.status ?? "NOT RUN"}**.

| Case | Outcome | Measurement / observation |
| --- | --- | --- |
${caseTable}

D starts with the verified fixture's compact local model and runs bounded reconciliation, rather than rebuilding all historical metadata while deleting. The external actor changes Seen/Flagged in both directions, expunges a UID between SEARCH and FETCH, performs equal-count removal/old-Date arrival, and deletes 15,000 known messages in 128-sized batches. Ten arrivals during deletion are discovered through fresh NOOP/STATUS/closed SEARCH, independently of the actor's UID oracle. Membership and flags converge through two bounded passes after finite churn; this is not recovery of mail expunged before observation. Every missing required FETCH remains unresolved until complete same-epoch membership recheck. CHANGEDSINCE is compared with full FLAGS for the same 128 known identities; both still require independent complete membership evidence, and neither uses QRESYNC.

Ordinary read reconnect/replay, abandoned partial FETCH, completed-read retry, aggregate-budget rejection, and server connection rejection are exercised on Dovecot. A separate orderly two-process checkpoint restart resumes the saved lower frontier and records replay/SELECT overhead. It deliberately has no fsync, transaction, lease, pg-boss ACK or power-loss contract. Malformed/deep/never-ending responses, missing tagged completions and wrong BODY.PEEK origins run against the existing scripted TLS peer: **46/46 assertions passed** in a new output file; expected unsafe reproductions remain classified unsafe. These are not Dovecot measurements. Existing application regression: **47/47**, three IMAP-related Vitest files.

## Resource and correctness interpretation

Primary A–C process memory includes the loaded ground-truth oracle, compact 50k local model, ImapFlow and retained instrumentation. It is sampled every 5 ms and may miss transient peaks; it is not a strict process-memory limit. CPU includes process setup and oracle preparation; per-operation byte/time scopes exclude fixture loading. The destructive D/E runner retains command bytes/timing but does not sample process RSS/heap/CPU/event-loop peaks; those D/E resource metrics are **not measured**. Docker samples for the primary suites reached approximately **${Math.max(0, ...stats.map((s: { CPUPerc: string }) => parseFloat(s.CPUPerc))).toFixed(2)}% CPU** and **${Math.max(0, ...stats.map((s: { MemUsage: string }) => parseFloat(s.MemUsage))).toFixed(1)} MiB** memory. These container samples include filesystem cache and span sequential profiles; they are not per-profile attribution.

The approved byte/resource direction is used. K=128 is the work batch size, not a token-allocation assertion. Incoming decrypted aggregate budgets include the rejected current chunk; measured overshoot is recorded. Arbitrary TLS/native/allocator headroom remains outside this logical budget. Compact ESEARCH expansion, compression and IMAP4rev2 remain unvalidated in this real-server profile; the scripted adapter explicitly rejects dangerous ESEARCH expansion. Active cancellation invalidates the scope, destroys the actual socket and awaits native close/work settlement; successful cancellation is not inferred from Promise.race.

Every successful A/B/C run compares all still-existing initial UID identities to the independent assigned manifest, forbids duplicate local keys and advances history only after complete metadata. Flags-only unsolicited FETCH, including sequence-only notifications, is kept as a bounded hint without assigning it a remote UID or authorizing metadata/absence. Requested metadata remains exact-set and complete. UIDVALIDITY rejection is exercised only in a separate supported delete/recreate mailbox. Owner/transaction fencing, epoch changes during concurrent production commits and application integrations are unproven.

## Retained failures and repairs

| Trace | First reported failure |
| --- | --- |
${failures}

Small-fixture failures and destructive-run failures are also preserved as gzip traces. They include stale STATUS UIDNEXT before NOOP, an incorrect assumption about the public NOOP return value, APPEND/FETCH timing collection racing the APPEND callback, legitimate unsolicited flags during metadata/repair, a 256 KiB line-cap rejection of full SEARCH, and a passive actor socket expiring after ten seconds of unrelated history. The fixes refresh selection, require actual tagged success, retain publication timestamps independently, classify hints without weakening required metadata, bound inventories and separate 60-second passive inactivity from the unchanged 10-second active deadline. One suite collector also discovered a concurrently written summary instead of its child's result; filenames are now matched to that exact scenario. No partial/failed trace was counted as a passing complete run.

## Architecture hypotheses

| Original hypothesis | Assessment |
| --- | --- |
| First 128 within 5 s | Observed within 5 s locally for both A variants. Reference RTT/bandwidth profile absent: **not an original-SLA pass**. |
| Ten arrivals within 5 s with watcher / 20 s without | Observed within these values in completed local trials. Nondeterministic boundaries and absent reference network: **partial evidence**. |
| Individual user/content admission within 5 s | Observed for one small request per trial; sustained/moderate multi-account demand **not measured**. |
| Healthy occupancy p95 <=2 s, configured absolute deadline 10 s | Local individual command p95 below 2 s; active deadline configured and scripted hangs rejected. SEARCH and FETCH have separate scopes here, so complete multi-command/DB turn deadline **not proved**. |
| Hung turn released within 11 s | Scripted accelerated deadlines prove local destruction under responsive event loop. Unconditional wall-clock/production 10 s failure matrix **not measured**. |
| Metadata DB commit p95 <=250 ms, statement/lock <=2 s | **Not measured**, no PostgreSQL. |
| Recent flags/deletions <=45 s, bulk 50k <=10 min | Finite D convergence measured; cadence/production protected admission **not measured**. |
| Multi-account 2:1 fairness, rotations, saturation, post-crash 45 s | **Not measured**. |
| Logarithmic huge sparse gaps | Only deletion-created moderate holes here; billion-UID adaptive probing **not measured**. |
| Strict K parser allocation | Explicitly superseded by approved byte/resource contract; never claimed. Memory amplification/headroom and long queue plateau still **uncertain**. |

This is a substantial real-server latency and correctness experiment, with explicit partial D/E and durability boundaries. It is not the full production evidence gate from SYNC_ENGINE_VALIDATION.md. See [architecture review](ARCHITECTURE_REVIEW.md) and [recommendation](RECOMMENDATION.md).
`;
await writeFile(
  new URL(
    "../../docs/experiments/imap-dovecot/BENCHMARK_RESULTS.md",
    import.meta.url,
  ),
  text,
);
console.log(
  JSON.stringify({
    successfulRuns: runs.length,
    arrivalRuns: arrivalRuns.length,
    destructiveStatus: changes?.status,
    negativeCompletionDeltas: negative,
  }),
);
