import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  setImmediate as yieldTurn,
  setTimeout as sleep,
} from "node:timers/promises";
import { cpus, totalmem } from "node:os";
import { Lane, limits } from "./client.js";
import { message } from "./fixture.js";
import { record, type RecordRow } from "./model.js";

const mode = process.argv[2] ?? "progressive";
const count = Number(process.argv[3] ?? 100);
const profile = process.argv[4] ?? "C1";
const trigger = process.argv[5] ?? "fetch";
assert(["baseline", "progressive", "arrivals"].includes(mode));
assert(["C1", "C2", "C5-one", "C5-two"].includes(profile));
assert(["search", "fetch", "after", "waiting", "idle"].includes(trigger));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = new URL(
  `outputs/${stamp}-${mode}-${count}-${profile}-${trigger}.json`,
  import.meta.url,
);
await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
const local = new Map<number, RecordRow>();
const publicationTimes = new Map<
  number,
  { detection: number; admission: number; retrieval: number; available: number }
>();
const lanes: Lane[] = [];
let peakRss = 0,
  peakHeap = 0;
const sample = () => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
};
const sampling = setInterval(sample, 5);
const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();
const cpu = process.cpuUsage();
const result: Record<string, unknown> = {
  started: new Date().toISOString(),
  clockAnchor: { utcMs: Date.now(), monotonicMs: performance.now() },
  mode,
  count,
  profile,
  trigger,
  limits,
  persistence: "in-memory, no crash durability",
  environment: {
    node: process.version,
    imapflow: "2.0.6",
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memory: totalmem(),
    injectedRttMs: 0,
    injectedBandwidthLimit: false,
    serverWarmedByVerification: true,
  },
};
const arrivals: {
  uid: number;
  messageId: string;
  appendStart: number;
  appendCompleted: number;
  detection?: number;
  admission?: number;
  retrieval?: number;
  available?: number;
}[] = [];
let appending: Promise<void> | undefined;
let appendDone = false;
let detected: number | undefined;
let pendingHint = false;
let first = 0,
  first128 = 0,
  first1000 = 0;
let begin = 0;
let watcherIdle: Promise<boolean | undefined> | undefined;
try {
  const assigned = (
    await readFile(
      new URL(`fixtures/${count}/assigned.jsonl`, import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RecordRow);
  const expected = new Map(assigned.map((r) => [r.uid, r.messageId]));
  const data = await Lane.open();
  lanes.push(data);
  assert.equal(
    data.client.mailbox && data.client.mailbox.exists,
    count,
    "Start with exact initial fixture; clean previous arrivals first",
  );
  const initialNext = data.client.mailbox && data.client.mailbox.uidNext;
  assert(initialNext);
  let freshThrough = initialNext - 1;
  let historyBefore = initialNext;
  let watcher: Lane | undefined,
    user: Lane = data,
    actor: Lane | undefined;
  const hint = () => {
    if (detected === undefined) detected = performance.now();
    pendingHint = true;
  };
  data.client.on("exists", hint);
  if (mode === "arrivals") {
    actor = await Lane.open();
    lanes.push(actor);
    if (profile !== "C1") {
      watcher = await Lane.open();
      lanes.push(watcher);
      watcher.client.on("exists", hint);
      watcherIdle = watcher.client.idle();
    }
    if (profile === "C5-two") {
      user = await Lane.open();
      lanes.push(user);
    }
  }
  result.connectionSetupMs = lanes.map((l) => l.setupMs);
  result.configuredBudget = profile === "C1" ? 1 : profile === "C2" ? 2 : 5;
  result.clientOwnedSessions = lanes.length - (actor ? 1 : 0);
  result.sessionsIncludingIndependentActor = lanes.length;
  begin = performance.now();
  const commit = (rows: RecordRow[]) => {
    for (const row of rows) local.set(row.uid, row);
    if (!first && local.size) first = performance.now() - begin;
    if (!first128 && local.size >= Math.min(128, count))
      first128 = performance.now() - begin;
    if (!first1000 && local.size >= Math.min(1000, count))
      first1000 = performance.now() - begin;
  };
  const inject = () => {
    if (appending || !actor) return;
    userIntent = performance.now();
    if (user !== data) {
      userPromise = userWork();
      userPromise.catch(() => {});
    }
    appending = (async () => {
      for (let i = 1; i <= 10; i++) {
        const m = message(i, "arrival");
        const appendStart = performance.now();
        const appended = await actor!.op("APPEND", async (guard) => {
          const r = await actor!.client.append(
            "INBOX",
            m.data,
            m.flags,
            new Date(m.date),
          );
          guard();
          assert(r && r.uid);
          return r;
        });
        arrivals.push({
          uid: Number(appended.uid),
          messageId: m.messageId,
          appendStart,
          appendCompleted: performance.now(),
        });
      }
      appendDone = true;
    })();
    // Retain rejection until it can be awaited by the owning run.
    appending.catch(() => {});
  };
  let userIntent = 0;
  const userEvents: Record<string, unknown>[] = [];
  let userDone = false;
  const userWork = async () => {
    const uid = assigned[0].uid;
    const admission = performance.now();
    await user.op("USER FLAGS", async (guard) => {
      assert(
        await user.client.messageFlagsAdd([uid], ["\\Flagged"], { uid: true }),
      );
      guard();
    });
    const flagsCompleted = performance.now();
    const bodyAdmission = performance.now();
    const bytes = (await user.slice(uid, 64)).length;
    userEvents.push({
      intent: userIntent,
      admission,
      flagsCompleted,
      bodyAdmission,
      bodyCompleted: performance.now(),
      bytes,
      waitingMs: admission - userIntent,
      bodyWaitingMs: bodyAdmission - userIntent,
    });
    userDone = true;
  };
  let userPromise: Promise<void> | undefined;
  let boundaryCount = 0;
  const service = async () => {
    await yieldTurn(); // Awaited APIs completed tagged commands before re-admission.
    boundaryCount++;
    if (mode !== "arrivals" || !appending) return;
    if (!userIntent) {
      userIntent = performance.now();
      if (user !== data) {
        userPromise = userWork();
        userPromise.catch(() => {});
      }
    }
    // Coalesced hint plus independent bounded polling; no history-success gate.
    if (pendingHint || boundaryCount % 8 === 0 || appendDone) {
      pendingHint = false;
      await data.op("FRESH NOOP", async (guard) => {
        await data.client.noop();
        guard();
      });
      const status = await data.op("FRESH STATUS", async (guard) => {
        const s = await data.client.status("INBOX", { uidNext: true });
        guard();
        assert(s.uidNext);
        return s;
      });
      assert(status.uidNext);
      if (status.uidNext - 1 > freshThrough) {
        const detection = performance.now();
        const admission = performance.now();
        while (freshThrough < status.uidNext - 1) {
          const low = freshThrough + 1,
            high = Math.min(status.uidNext - 1, low + 127);
          const hits = await data.search(low, high);
          const rows = hits.length
            ? (await data.metadata(hits)).map(record)
            : [];
          const retrieval = performance.now();
          commit(rows);
          const available = performance.now();
          for (const row of rows)
            publicationTimes.set(row.uid, {
              detection,
              admission,
              retrieval,
              available,
            });
          freshThrough = high;
          await yieldTurn();
        }
      }
    }
    if (user === data && !userDone) await userWork();
  };
  if (mode === "baseline") {
    // Source-inspired inventory: full UID+FLAGS, then bounded headers. This is
    // deliberately a conservative approximation of Thunderbird's larger dump.
    const inventory = await data.op(
      "FULL UID FLAGS",
      async (guard) => {
        const rows = new Map<number, string[]>();
        for await (const row of data.client.fetch(
          `1:${initialNext - 1}`,
          { uid: true, flags: true },
          { uid: true },
        )) {
          guard();
          assert(
            row.uid > 0 &&
              row.uid < initialNext &&
              !rows.has(row.uid) &&
              row.flags,
          );
          rows.set(row.uid, [...row.flags]);
        }
        guard();
        assert.equal(rows.size, count);
        return [...rows.keys()].sort((a, b) => b - a);
      },
      16 * 1024 * 1024,
    );
    result.inventoryMs = performance.now() - begin;
    for (let i = 0; i < inventory.length; i += 128) {
      commit((await data.metadata(inventory.slice(i, i + 128))).map(record));
      await yieldTurn();
    }
    historyBefore = 1;
  } else {
    let windows = 0;
    const injectionWindow = count <= 256 ? 0 : 2;
    while (historyBefore > 1) {
      const high = historyBefore - 1,
        low = Math.max(1, high - 127);
      const searchPromise = data.search(low, high);
      if (windows === injectionWindow && trigger === "search") inject();
      const hits = await searchPromise;
      await service();
      if (hits.length) {
        const fetchPromise = data.metadata(hits);
        if (windows === injectionWindow && trigger === "fetch") inject();
        const rows = (await fetchPromise).map(record);
        commit(rows);
      }
      historyBefore = low;
      if (windows === injectionWindow && trigger === "after") inject();
      if (windows === injectionWindow && trigger === "waiting") {
        inject();
        await sleep(25);
      }
      if (
        windows === injectionWindow &&
        trigger === "idle" &&
        mode === "arrivals"
      ) {
        if (watcher) inject();
        else {
          const idle = data.client.idle();
          await sleep(10);
          inject();
          await sleep(50);
          await data.op("DONE/NOOP", async (guard) => {
            await data.client.noop();
            guard();
          });
          await idle;
        }
      }
      windows++;
      await service();
    }
  }
  if (appending) {
    await appending;
    for (
      let checks = 0;
      checks < 20 && arrivals.some((a) => !local.has(a.uid));
      checks++
    ) {
      await service();
      await sleep(5);
    }
    if (userPromise) await userPromise;
    for (const a of arrivals) {
      Object.assign(a, publicationTimes.get(a.uid));
      assert.equal(
        local.get(a.uid)?.messageId,
        a.messageId,
        "Exact appended identity available",
      );
      // APPEND reply and FETCH can race; use independently recorded publication
      // timestamp only if this identity was observed after its reply.
      assert(
        a.available !== undefined,
        "Availability timing must be observed, not inferred",
      );
    }
  }
  for (const [uid, id] of expected) assert.equal(local.get(uid)?.messageId, id);
  assert.equal(local.size, count + arrivals.length);
  assert.equal(historyBefore, 1);
  result.status = "PASS";
  Object.assign(result, {
    firstMetadataMs: first,
    first128Ms: first128,
    first1000Ms: first1000,
    completeMs: performance.now() - begin,
    initialEpoch: String(data.epoch.uidValidity),
    historyBefore,
    freshThrough,
    localCount: local.size,
    boundaryCount,
    arrivals: arrivals.map((a) => ({
      ...a,
      appendToDetectionMs: a.detection! - a.appendCompleted,
      detectionToAdmissionMs: a.admission! - a.detection!,
      admissionToRetrievalMs: a.retrieval! - a.admission!,
      retrievalToAvailableMs: a.available! - a.retrieval!,
      appendToAvailableMs: a.available! - a.appendCompleted,
    })),
    userEvents,
    observedHintAt: detected,
  });
  if (watcher) {
    await watcher.op("DONE/NOOP", async (guard) => {
      await watcher.client.noop();
      guard();
    });
    await watcherIdle;
  }
  if (actor) {
    await actor.op("CLEAN ARRIVALS", async (guard) => {
      assert(
        await actor!.client.messageDelete(
          arrivals.map((a) => a.uid),
          { uid: true },
        ),
      );
      guard();
    });
    await actor.op("CLEAN FLAGS", async (guard) => {
      assert(
        await actor!.client.messageFlagsRemove(
          [assigned[0].uid],
          ["\\Flagged"],
          { uid: true },
        ),
      );
      guard();
    });
  }
} catch (error) {
  result.status = "FAIL";
  result.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  sample();
  clearInterval(sampling);
  loop.disable();
  Object.assign(result, {
    finished: new Date().toISOString(),
    peakRss,
    peakHeap,
    cpuMicros: process.cpuUsage(cpu),
    eventLoopMs: {
      p95: loop.percentile(95) / 1e6,
      p99: loop.percentile(99) / 1e6,
      max: loop.max / 1e6,
    },
    bytesIn: lanes.reduce((n, l) => n + l.bytesIn, 0),
    bytesOut: lanes.reduce((n, l) => n + l.bytesOut, 0),
    lanes: lanes.map((l) => ({
      setupMs: l.setupMs,
      bytesIn: l.bytesIn,
      bytesOut: l.bytesOut,
      commands: l.commands,
      tagged: l.tagged,
      operations: l.operations,
    })),
  });
  for (const lane of lanes.reverse()) {
    if (result.status === "FAIL") {
      lane.client.close();
      continue;
    }
    try {
      await lane.close();
    } catch (e) {
      result.cleanupFailure = String(e);
      process.exitCode = 1;
    }
  }
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      file: output.pathname,
      status: result.status,
      failure: result.failure,
      first128Ms: result.first128Ms,
      completeMs: result.completeMs,
      peakRss,
      arrivals: result.arrivals,
    }),
  );
}
