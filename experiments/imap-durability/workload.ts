import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "./store.js";
import { Coordinator, type Kind } from "./coordinator.js";
import { Lane } from "./client.js";
import { message } from "./fixture.js";
import { compare } from "./support.js";
import { Trace, distribution } from "./metrics.js";
import { Proxy } from "./proxy.js";
const duration = Number(process.argv[2] ?? 600),
  W = Number(process.argv[3] ?? 4),
  pool = Number(process.argv[4] ?? 2),
  saturation = process.argv[5] !== "finite";
assert(
  duration > 0 &&
    duration <= 600 &&
    [1, 2, 4].includes(W) &&
    [1, 2, 6].includes(pool),
);
const accounts = Array.from({ length: 8 }, (_, i) => "p3-load-" + i),
  stamp = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
const trace = new Trace(
  new URL(`outputs/${stamp}-workload-W${W}-D${pool}.jsonl.gz`, import.meta.url),
);
const store = new Store(pool);
await store.setup();
const owner = await store.acquire(randomUUID());
assert(owner);
const c = new Coordinator(store, owner);
c.emit = async (e) => {
  if (loadEnd && Number(e.start) >= start && Number(e.start) < loadEnd)
    workerBusyMs += Math.max(
      0,
      Math.min(Number(e.end), loadEnd) - Number(e.start),
    );
  if (loadEnd && Number(e.start) >= start && Number(e.start) < loadEnd) {
    activeOccupancy.push(Number(e.durationMs));
    if (e.kind === "history" && e.status === "PASS")
      activeHistoryRows += Number(e.persisted ?? 0);
  }
  if (e.kind === "user") {
    const intent = userIntents.get(String(e.account));
    const command = (
      e.commands as { at: number; command: string }[] | undefined
    )?.find((command) => /UID STORE/.test(command.command));
    if (intent !== undefined && command) {
      userWait.push(command.at - intent);
      e.userIntent = intent;
      e.actualUserCommandAdmission = command.at;
    }
    userIntents.delete(String(e.account));
  }
  if (e.kind === "fresh" && e.status === "PASS") {
    for (const op of (e.transport ?? []) as { kind: string; uids?: number[] }[])
      if (op.kind === "FETCH")
        for (const uid of op.uids ?? [])
          freshPublication.set(String(e.account) + "/" + uid, Number(e.end));
    const after = e.after as { fresh: number } | undefined;
    const before = e.before as { fresh: number } | undefined;
    if (after && before)
      for (const a of arrivals)
        if (
          a.account === e.account &&
          a.available === undefined &&
          a.uid <= after.fresh
        )
          a.available = Number(e.end);
  }
  await trace.operation(e);
};
const slow = new Proxy(32993, 50),
  unavailable = new Proxy();
c.ports.set(accounts[6], await slow.listen());
c.ports.set(accounts[7], await unavailable.listen());
const actors: Lane[] = [],
  arrivals: {
    account: string;
    uid: number;
    completed: number;
    available?: number;
  }[] = [];
const running = new Map<string, Promise<void>>(),
  freshPublication = new Map<string, number>(),
  users = new Map<string, number>(),
  lastCurrent = new Map<string, "fresh" | "user">(),
  userIntents = new Map<string, number>(),
  retryUntil = new Map<string, number>();
const userWait: number[] = [],
  waiting: Record<string, number[]> = {},
  dispatch: Record<string, number> = {},
  errors: Record<string, unknown>[] = [],
  samples: object[] = [];
let actorDone = false,
  actorFailure: unknown,
  tick = 0,
  userLast = 0,
  rotation = 0,
  opportunities = 0;
let actorTask: Promise<void> | undefined;
const eligibleSince = new Map<string, number>(),
  waitHistory: number[] = [];
let busyIntegral = 0,
  lastSample = performance.now(),
  start = 0;
let workerBusyMs = 0,
  loadEnd = 0;
let activeHistoryRows = 0;
const activeOccupancy: number[] = [];
const result: Record<string, unknown> = {
  stamp,
  duration,
  W,
  pool,
  saturation,
  seed: 2403,
  sourceSha256: createHash("sha256")
    .update(await readFile(new URL("workload.ts", import.meta.url)))
    .digest("hex"),
  storeSha256: createHash("sha256")
    .update(await readFile(new URL("store.ts", import.meta.url)))
    .digest("hex"),
  coordinatorSha256: createHash("sha256")
    .update(await readFile(new URL("coordinator.ts", import.meta.url)))
    .digest("hex"),
};
try {
  // Clean only the eight experiment accounts' DB facts; remote fixture stays.
  for (const account of accounts) {
    await store.sql`delete from placement where account=${account}`;
    await store.sql`delete from mailbox where account=${account}`;
    await c.turn(account, "history");
    waiting[account] = [];
  }
  for (let i = 0; i < 8; i++)
    actors.push(await Lane.open(true, "INBOX", accounts[i]));
  start = performance.now();
  const finish = start + duration * 1000;
  loadEnd = finish;
  const initialHistory =
    await store.sql`select account,history from mailbox where account in ${store.sql(accounts)} order by account`;
  actorTask = (async () => {
    while (performance.now() < finish) {
      tick++;
      // Two independent accounts receive real APPENDs while eight accounts compete.
      for (let i = 0; i < 2; i++) {
        const actor = actors[i],
          m = message(tick, "sustained-" + stamp + "-" + i);
        const r = await actor.op("APPEND", async (guard) => {
          const r = await actor.client.append("INBOX", m.data);
          guard();
          assert(r && r.uid);
          return r;
        });
        const arrival = {
          account: accounts[i],
          uid: Number(r.uid),
          completed: performance.now(),
          available: freshPublication.get(accounts[i] + "/" + Number(r.uid)),
        };
        arrivals.push(arrival);
        await trace.write({ event: "append", ...arrival });
        await store.due(accounts[i]);
      }
      if (tick % 5 === 0) {
        const actor = actors[4],
          uid = (tick % 128) + 1;
        await actor.op("REMOTE FLAGS", async (guard) => {
          await actor.client.messageFlagsSet(
            [uid],
            tick % 10 ? ["\\Seen", "\\Flagged"] : [],
            { uid: true },
          );
          guard();
        });
        await store.due(accounts[4], true);
        const victim = tick / 5;
        await actors[5].op("DELETE", async (guard) => {
          await actors[5].client.messageDelete([victim], { uid: true });
          guard();
        });
        await store.due(accounts[5], true);
      }
      if (tick % 15 === 0) {
        const lane = c.lanes.get(accounts[6]);
        if (lane && !c.busy.has(accounts[6])) {
          lane.client.close();
          await trace.write({ event: "disconnect", account: accounts[6] });
        }
      }
      slow.oneWayMs = tick % 20 < 3 ? 150 : 50;
      unavailable.reject = tick % 20 < 2;
      if (unavailable.reject) unavailable.reset();
      for (const actor of actors) {
        actor.operations.length = 0;
        actor.commands.length = 0;
        actor.tagged.length = 0;
      }
      await sleep(750);
    }
  })()
    .catch((e) => {
      actorFailure = e;
    })
    .finally(() => (actorDone = true));
  while (performance.now() < finish || running.size) {
    const now = performance.now(),
      active = running.size;
    busyIntegral += active * (now - lastSample);
    lastSample = now;
    if (now - userLast >= 250 && now < finish) {
      for (const account of [accounts[2], accounts[3]])
        if (!users.has(account)) users.set(account, now);
      userLast = now;
    }
    assert(
      running.size <= W &&
        users.size <= 2 &&
        eligibleSince.size <= 8 &&
        c.hints.size <= 8,
      "Bounded ready sets and worker capacity",
    );
    if (
      samples.length === 0 ||
      now - start - Number((samples[samples.length - 1] as { at: number }).at) >
        1000
    ) {
      const sample = {
        at: now - start,
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
        running: active,
        userReady: users.size,
        lanes: c.lanes.size,
        readySet: eligibleSince.size,
        pendingNotifications: c.hints.size,
        traceBufferedBytes: trace.gzip.writableLength,
        retries: errors.length,
      };
      samples.push(sample);
      await trace.write({ event: "resources", ...sample });
    }
    if (now >= finish) {
      if (running.size) await Promise.race(running.values());
      continue;
    }
    await c.flushHints();
    const rows =
      await store.sql`select account,history,fresh_due<=clock_timestamp() fresh_due,repair_due<=clock_timestamp() repair_due from mailbox where account in ${store.sql(accounts)}`;
    const ready = rows.filter(
      (r) => !running.has(r.account) && (retryUntil.get(r.account) ?? 0) <= now,
    );
    const current = ready.filter(
        (r) => saturation || r.fresh_due || users.has(r.account),
      ),
      maintenance = ready.filter((r) => r.repair_due),
      history = ready.filter((r) => Number(r.history) > 1);
    for (const row of ready)
      if (!eligibleSince.has(row.account)) eligibleSince.set(row.account, now);
    let selected: (typeof ready)[number] | undefined, kind: Kind | undefined;
    const choose = (list: typeof ready) => {
      for (let i = 0; i < 8; i++) {
        const idx = (rotation + i) % 8,
          found = list.find((r) => r.account === accounts[idx]);
        if (found) {
          rotation = (idx + 1) % 8;
          return found;
        }
      }
    };
    if (running.size < W) {
      if (maintenance.length && (opportunities % 8 === 7 || !current.length)) {
        selected = choose(maintenance);
        kind = "repair";
      } else if (current.length) {
        selected = choose(current);
        kind =
          selected &&
          users.has(selected.account) &&
          ((!saturation && !selected.fresh_due) ||
            lastCurrent.get(selected.account) !== "user")
            ? "user"
            : "fresh";
      } else if (history.length && running.size < (W === 1 ? 1 : W - 1)) {
        selected = choose(history);
        kind = "history";
      }
    }
    if (selected && kind) {
      const account = selected.account,
        admission = performance.now(),
        readyAt = eligibleSince.get(account) ?? admission;
      if (kind === "user" || kind === "fresh") lastCurrent.set(account, kind);
      waiting[account].push(admission - readyAt);
      eligibleSince.delete(account);
      opportunities++;
      dispatch[account] = (dispatch[account] ?? 0) + 1;
      if (kind === "user") {
        userIntents.set(account, users.get(account)!);
        users.delete(account);
      }
      if (kind === "history") waitHistory.push(admission - readyAt);
      await trace.write({
        event: "admission",
        account,
        kind,
        waitMs: admission - readyAt,
        running: running.size + 1,
      });
      const task = c
        .turn(account, kind)
        .then(async () => {
          if (kind === "fresh") {
            const state = await store.state(account);
            for (const a of arrivals)
              if (
                a.account === account &&
                a.available === undefined &&
                a.uid <= state.fresh
              ) {
                a.available = performance.now();
                await trace.write({ event: "arrival-visible", ...a });
              }
          }
        })
        .catch((error) => {
          errors.push({
            account,
            kind,
            error: String(error),
            at: performance.now() - start,
          });
          retryUntil.set(account, performance.now() + 500);
        })
        .finally(() => running.delete(account));
      running.set(account, task);
    } else if (running.size) await Promise.race(running.values());
    else await sleep(10);
    if (actorFailure) throw actorFailure;
  }
  await actorTask;
  assert(actorDone);
  if (actorFailure) throw actorFailure;
  slow.oneWayMs = 0;
  unavailable.reject = false;
  unavailable.reset();
  const activeDbWaitMs = distribution(store.waits),
    activeDbTransactionMs = distribution(store.transactions);
  const saturatedHistory =
    await store.sql`select account,history from mailbox where account in ${store.sql(accounts)} order by account`;
  if (saturation)
    assert.deepEqual(
      saturatedHistory.map((r) => String(r.history)),
      initialHistory.map((r) => String(r.history)),
      "History uses only leftover capacity",
    );
  // Remove urgent demand and observe actual history completion, then repair oracle.
  const recoveryStart = performance.now();
  // Current demand remains eligible at shutdown; flush the last appends before
  // using leftover capacity for historical completion.
  for (const account of accounts) await c.turn(account, "fresh");
  const historyResumeMs: Record<string, number> = {};
  const historyWorkers = W === 1 ? 1 : W - 1;
  for (;;) {
    const pending = (
      await store.sql`select account from mailbox where account in ${store.sql(accounts)} and history>1 order by account`
    ).map((r) => r.account as string);
    if (!pending.length) break;
    for (let i = 0; i < pending.length; i += historyWorkers)
      await Promise.all(
        pending.slice(i, i + historyWorkers).map(async (account) => {
          historyResumeMs[account] ??= performance.now() - recoveryStart;
          await c.turn(account, "history");
        }),
      );
  }
  for (const account of accounts) {
    await c.turn(account, "fresh");
    await c.repair(account);
  }
  const convergence = [];
  for (const account of accounts)
    convergence.push({ account, ...(await compare(store, account)) });
  const late = arrivals.filter((a) => a.available === undefined);
  for (const a of late) {
    assert((await store.placements(a.account)).some((r) => r.uid === a.uid));
    a.available = performance.now();
  }
  Object.assign(result, {
    status: "PASS",
    runMs: finish - start,
    actualBusyUtilization: workerBusyMs / (duration * 1000 * W),
    hintEvents: c.hintEvents,
    hintFlushes: c.hintFlushes,
    activeOccupancyMs: distribution(activeOccupancy),
    activeHistoryRows,
    activeHistoryRowsPerSecond: activeHistoryRows / duration,
    activeDbWaitMs,
    activeDbTransactionMs,
    selectorSampledBusyIntegral: busyIntegral,
    historyResumeMs,
    operations: trace.count,
    dispatch,
    perAccountWaitMs: Object.fromEntries(
      accounts.map((a) => [a, distribution(waiting[a])]),
    ),
    freshMs: distribution(arrivals.map((a) => a.available! - a.completed)),
    userAdmissionMs: distribution(userWait),
    dbWaitMs: distribution(store.waits),
    dbTransactionMs: distribution(store.transactions),
    historyWaitMs: distribution(waitHistory),
    initialHistory,
    saturatedHistory,
    historyResumedAndConvergedMs: performance.now() - recoveryStart,
    convergence,
    errors,
    arrivals: arrivals.length,
    lateAtQuiescence: late.length,
    samples,
    eventLoopMs: {
      p50: trace.loop.percentile(50) / 1e6,
      p95: trace.loop.percentile(95) / 1e6,
      p99: trace.loop.percentile(99) / 1e6,
      max: trace.loop.max / 1e6,
    },
  });
} catch (error) {
  result.status = "FAIL";
  result.failure = String((error as Error).stack);
  result.errors = errors;
  result.samples = samples;
  process.exitCode = 1;
} finally {
  await actorTask;
  for (const actor of actors) {
    try {
      await actor.close();
    } catch {
      actor.client.close();
    }
  }
  await c.close();
  await slow.close();
  await unavailable.close();
  await store.close();
  await trace.close();
  await writeFile(
    new URL(
      `outputs/${stamp}-workload-W${W}-D${pool}-summary.json`,
      import.meta.url,
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({ ...result, samples: undefined, convergence: undefined }),
  );
}
