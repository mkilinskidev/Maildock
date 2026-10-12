import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
type NetworkRow = {
  name?: string;
  status: string;
  measuredNoopRttMs?: { p50: number | null; max: number | null };
  effectiveMetadataBytesPerSecond?: { p50: number | null };
  firstMetadataMs?: number;
  arrivalMs?: { max: number | null };
  observed?: { durationMs: number };
};
const dir = new URL("outputs/", import.meta.url),
  names = (await readdir(dir)).sort();
const read = async (name: string) =>
  JSON.parse(await readFile(new URL(name, dir), "utf8"));
const storeHash = createHash("sha256")
  .update(await readFile(new URL("store.ts", import.meta.url)))
  .digest("hex");
const lateNames = names.filter((name) =>
  name.endsWith("-late-db-callback.json"),
);
const lateCallbacks = await Promise.all(
  lateNames.map(async (name) => {
    const { events, ...result } = await read(name);
    return { file: name, ...result, eventCount: events?.length };
  }),
);
const loadNames = names.filter((n) =>
  /-workload-W\d-D\d-summary\.json$/.test(n),
);
const loads = await Promise.all(
  loadNames.map(async (name) => ({ file: name, ...(await read(name)) })),
);
const latest = new Map<string, (typeof loads)[number]>();
for (const r of loads)
  latest.set(r.W + "/" + r.pool + "/" + r.duration + "/" + r.saturation, r);
const lastLong = [...loads].reverse().find((r) => r.duration === 600);
const networkNames = names.filter((n) => n.endsWith("-network-summary.json")),
  network = await read(networkNames[networkNames.length - 1]);
const packetNames = names.filter((n) => n.endsWith("-packet-loss.json")),
  packet = await read(packetNames[packetNames.length - 1]);
const dur = await read("durability-summary.json"),
  reconciliation = await read("reconciliation-summary.json");
const number = (value: unknown, digits = 2) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
const rows = [...latest.values()].sort(
  (a, b) => a.duration - b.duration || a.W - b.W || a.pool - b.pool,
);
const loadTable = rows
  .map(
    (r) =>
      `| ${r.duration}s | ${r.W}/${r.pool} | ${r.saturation ? "saturated" : "finite"} | ${r.storeSha256 === storeHash ? "post-fix" : "pre-fix"} | ${r.status} | ${r.arrivals ?? "—"} | ${number(r.freshMs?.p50)} / ${number(r.freshMs?.p95)} / ${number(r.freshMs?.p99)} / ${number(r.freshMs?.max)} | ${number(r.userAdmissionMs?.p95)} / ${number(r.userAdmissionMs?.max)} | ${number((r.actualBusyUtilization ?? 0) * 100)}% |`,
  )
  .join("\n");
const networkTable = (network.results as NetworkRow[])
  .map(
    (r) =>
      `| ${r.name ?? "failure"} | ${r.status} | ${number(r.measuredNoopRttMs?.p50)} / ${number(r.measuredNoopRttMs?.max)} | ${number(r.effectiveMetadataBytesPerSecond?.p50)} | ${number(r.firstMetadataMs)} | ${number(r.arrivalMs?.max ?? r.observed?.durationMs)} |`,
  )
  .join("\n");
const buckets = [];
if (lastLong)
  for (let b = 0; b < 5; b++) {
    const samples = lastLong.samples.filter(
      (s: { at: number }) => s.at >= b * 120000 && s.at < (b + 1) * 120000,
    );
    const values = (field: string) =>
      samples.map((s: Record<string, number>) => s[field] ?? 0);
    buckets.push({
      minutes: `${b * 2}–${b * 2 + 2}`,
      n: samples.length,
      rssMin: Math.min(...values("rss")) / 2 ** 20,
      rssMax: Math.max(...values("rss")) / 2 ** 20,
      heapMax: Math.max(...values("heap")) / 2 ** 20,
      readyMax: Math.max(...values("readySet")),
      usersMax: Math.max(...values("userReady")),
      activeMax: Math.max(...values("running")),
      hintsMax: Math.max(...values("pendingNotifications")),
      traceBufferedMax: Math.max(...values("traceBufferedBytes")),
    });
  }
const memoryTable = buckets
  .map(
    (b) =>
      `| ${b.minutes} | ${b.n} | ${number(b.rssMin)}–${number(b.rssMax)} | ${number(b.heapMax)} | ${b.readyMax}/${b.usersMax}/${b.activeMax}/${b.hintsMax} | ${b.traceBufferedMax} |`,
  )
  .join("\n");
const accounts = lastLong
  ? Object.entries(lastLong.dispatch as Record<string, number>)
      .map(
        ([account, count]) =>
          `| ${account} | ${count} | ${number(lastLong.perAccountWaitMs[account].p95)} | ${number(lastLong.perAccountWaitMs[account].max)} |`,
      )
      .join("\n")
  : "";
const maxObserved = Math.max(...loads.map((r) => r.freshMs?.max ?? 0));
const summary = {
  at: new Date().toISOString(),
  durability: dur,
  lateCallbacks,
  reconciliation,
  network,
  packet,
  loads: loads.map((r) => ({ ...r, samples: undefined })),
  lastLong: lastLong?.file,
  memoryBuckets: buckets,
  worstAllRetainedLoadFreshMs: maxObserved,
  notRun: [
    "production pg-boss delivery/ACK",
    "production notifications/conversations/command intents/cache publication",
    "real billion-sized/near-2^32 UID gaps",
    "persistence-backed permanently omitted FETCH (oversized poison UID tested separately)",
    "30 seeded schedules per network/load profile",
  ],
};
await writeFile(
  new URL("measurements.json", dir),
  JSON.stringify(summary, null, 2) + "\n",
);
const report = `# Network, fairness and sustained-operation results

Measured on 2026-10-12 using isolated Dovecot/PostgreSQL. Commands and pins:
[SETUP.md](SETUP.md). All raw summaries, including partial/failing runs, are
retained in [measurements.json](../../../experiments/imap-durability/outputs/measurements.json)
and timestamped gzip traces. These are laboratory observations, not provider SLAs.

## Network profiles

| Profile | Result | Measured NOOP RTT p50 / max ms | Metadata bytes/s median | First metadata ms | Worst arrival or fault occupation ms |
| --- | --- | --- | --- | --- | --- |
${networkTable}

The relay forwards TLS unchanged, with no host-wide network settings. Delay and
bandwidth are requested settings; the table gives actual measured values. A
zero-delay relay now forwards immediately; earlier retained runs incurred Windows
timer quantization even at zero requested delay. Requested 20 ms does not establish
20 ms measured RTT. There are 20 RTT samples, three throughput samples and ten
arrival samples per healthy profile. No p99 is inferred from those small arrival
samples. Arrival reference is the actor's actual APPEND acknowledgment, with
visibility from successful durable ingestion; user work intervenes deliberately.

Hung FETCH and connection reset advance no frontier and recover by replay.
The configured full turn remains 10 s. The delayed/blackout case completes within
that budget. Healthy impaired trials did not justify raising it; production policy
still needs provider/cold-authentication measurements and bounded reconnect/backoff.

Kernel netem (Dovecot namespace only): result **${packet.status}**, requested
20 ms egress delay / 3% loss / seed 2403; actual dropped packets **${packet.dropped ?? "unavailable"}**.
RTT p50/p95/p99/max: ${number(packet.rttMs?.p50)} / ${number(packet.rttMs?.p95)} /
${number(packet.rttMs?.p99)} / ${number(packet.rttMs?.max)} ms. Independent final
comparison: ${packet.identities ?? "unavailable"} exact current identities.
The qdisc's actual byte/packet/drop counters are in its trace and it is removed
after the test. TCP blackout/reset relay tests are separate from actual packet loss.

## Eight-account worker/pool matrix

Two initial accounts have 50,000-message history, two receive continuous APPENDs,
two have coalesced simulated user flag/content work, two have external flag/delete
mutations, and the remaining profiles include slow/temporarily rejected connections.
Roles overlap across eight independent accounts. All own data operations are serial
within an account; the independent actors are additional server sessions. Due times,
owner renewal, actual SEARCH/FETCH/STORE/BODY.PEEK and PostgreSQL commits consume
shared resources. W>=2 preserves one current worker opportunity while history uses
leftover capacity; constrained PostgreSQL pools are actual client pools.

Latest result for each profile (all earlier results remain in the measurement index):

| Run | W/DB pool | Demand | DB boundary | Result | Arrivals | Fresh p50 / p95 / p99 / max ms | User wire admission p95 / max ms | Core-operation worker occupation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${loadTable}

User admission in final instrumentation is the actual logged UID STORE command,
not just selector order. Fresh visibility is recorded independently of the APPEND
callback so already-ingested UIDs are not assigned an invented later timestamp.
Per-account eligible waiting, transport scopes, commits, retries and one-second
resource samples remain in the traces. Occupation includes connection preparation,
selection, SEARCH/FETCH and database admission/commit; synchronous trace serialization
and gzip backpressure are experimental observation overhead. Histories rotate again
after saturation rather than draining one mailbox at a time.

The fixed saturation reference intentionally keeps current demand eligible for all
accounts; **zero history progress under that demand is expected**. Each saturated
run checks its historical frontiers are unchanged. Finite-load history progress and
actual post-demand history admission/completion are separately measured. The
600-second run admitted ${lastLong?.activeHistoryRows ?? "unavailable"} history rows
during saturation; its first post-demand history admissions were
${number(lastLong ? Math.max(...Object.values(lastLong.historyResumeMs as Record<string, number>)) : undefined)} ms
after current flushing began. This is admission followed by real completed history
turns, not a scheduler-order-only assertion. Full repair/convergence plus independent
oracle reading took ${number(lastLong?.historyResumedAndConvergedMs)} ms; that total
includes expensive verification and is not the first history-resume latency.

Final long-run account counts and waits:

| Account | Admitted turns | Eligible wait p95 ms | Worst eligible wait ms |
| --- | --- | --- | --- |
${accounts}

The slow account has different service cost and the unavailable account has retry
cooldown; neither is hidden from the table. Compare similarly eligible healthy
accounts, not unequal service costs. There is one deterministic schedule per matrix
profile, plus repeated development trials, not 30 independently seeded schedules.

## Ten-minute resource behavior

Final long reference: ${lastLong?.file ?? "NOT RUN"}; ${lastLong?.operations ?? "—"} complete/rejected
operation records, ${lastLong?.arrivals ?? "—"} APPEND identities, ${lastLong?.hintEvents ?? "—"} actual
EXISTS hints, ${lastLong?.hintFlushes ?? "—"} coalesced durable hint flushes. Work sets are
asserted at most eight account hints/ready entries, two user intents and W running
operations. No promise is created for each notification. Gzip writers respect
backpressure; the latest resource trace also exposes their pending bytes.

| Minutes | Samples | RSS range MiB | Peak heap MiB | Max ready/user/running/hints | Max pending trace bytes |
| --- | --- | --- | --- | --- | --- |
${memoryTable}

Memory includes ImapFlow, the coordinator, PostgreSQL client/prepared statements and
measurement arrays. DB wait/transaction samples retain at most the last 20,000;
the operation ring retains 512. One-second samples miss transient peaks and do not
prove a strict allocation ceiling. Warming/GC changes are distinguished from
unbounded work-set growth. Queue bounds and final convergence are mandatory;
a flat dispatch list alone is insufficient.

Active reference DB wait p50/p95/p99/max:
${number(lastLong?.activeDbWaitMs?.p50)} / ${number(lastLong?.activeDbWaitMs?.p95)} /
${number(lastLong?.activeDbWaitMs?.p99)} / ${number(lastLong?.activeDbWaitMs?.max)} ms.
Active DB transaction p50/p95/p99/max:
${number(lastLong?.activeDbTransactionMs?.p50)} / ${number(lastLong?.activeDbTransactionMs?.p95)} /
${number(lastLong?.activeDbTransactionMs?.p99)} / ${number(lastLong?.activeDbTransactionMs?.max)} ms.
Retries are retained individually, mainly induced connection resets/retirement on
the unavailable account. Correctness is evaluated after quieting, completed coverage
and membership/flags repair. Every completed load profile compares all current UIDs,
message IDs, subjects, sizes and permanent flags with independent IMAP reads.

## Counterexamples and explicit limits

**Retained safety failure:** the cancelled DB callback reproduction found a newer
writer reporting success with 0/32 durable rows. Its old postgres.js callback
ROLLBACK ran on a reused connection. The post-fix boundary explicitly owns transaction
commands, invalidates SQL and lazy-query execution on retirement, and rejects that
old callback. Only rows marked post-fix above exercise the repaired store. Older
matrix/network metrics remain useful historical measurements but do not pass that
fault's safety gate. The corrected callback, atomic/crash and reconciliation cases
are rerun before dependent post-fix performance; see DURABILITY_RESULTS.md and the
retained old/new store hashes.

Worst fresh availability across **all retained load runs** is ${number(maxObserved)} ms.
The initial W=1 shutdown harness withheld its last two arrivals while draining history
before the final fresh check (about 179 s). That is a retained performance failure,
not excluded from the overall worst. Final recovery flushes current work first and
rotates history. Initial utilization sampling also understated occupancy; those
legacy utilization values are invalid. Global parity could repeatedly favor one
current category; final selection alternates per account. Earlier network failures
were a stale measurement-client deadline and LOGOUT cleanup evidence, not passing
profiles; both traces remain. The first netem coordinator stage was blocked by a
concurrent uncertainty-test lease and was rerun sequentially.

Reference restoration after the 15,000-deletion case imports 15,000 synthetic
messages with fresh server-assigned UIDs into **only** the Phase 3 account. It restores
two >=50k histories for final repeats and leaves the real old numeric UID gap.
No UID index files are fabricated; original Phase 2 data is untouched.

Provisional 5 s user admission and 2 s healthy occupation hypotheses must be judged
against the relevant finite/degraded conditions, not saturation totals or selected
means. Some early saturation tails exceeded 5 s and remain reported. Provider OAuth,
production queue/notifications/business work, permanent FETCH omission and billion-
sized real UID gaps remain unproven. K=128 is a work size; measured input and parser
budgets are enforced, without a strict parser-token claim or parser fork.

Recommendation: [REQUIRES ARCHITECTURE REVISION](RECOMMENDATION.md).
`;
await writeFile(
  new URL(
    "../../docs/experiments/imap-durability/PERFORMANCE_RESULTS.md",
    import.meta.url,
  ),
  report,
);
console.log(
  JSON.stringify({
    profiles: rows.length,
    long: lastLong?.file,
    allRetainedWorstMs: maxObserved,
  }),
);
