import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Lane } from "./client.js";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { Proxy } from "./proxy.js";
import { fixture, compare } from "./support.js";
import { message } from "./fixture.js";
import { Trace, distribution } from "./metrics.js";
await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const results: Record<string, unknown>[] = [];
const trace = new Trace(
  new URL(`outputs/${stamp}-network.jsonl.gz`, import.meta.url),
);
const store = new Store(1);
const proxies = new Set<Proxy>(),
  lanes = new Set<Lane>(),
  coordinators = new Set<Coordinator>();
await store.setup();
try {
  for (const profile of [
    { name: "local", delay: 0, bandwidth: 0 },
    { name: "20ms-requested", delay: 10, bandwidth: 0 },
    { name: "100ms-requested", delay: 50, bandwidth: 0 },
    { name: "128KiB-per-second", delay: 10, bandwidth: 128 * 1024 },
  ]) {
    const account = "p3-network-" + profile.name + "-" + stamp;
    await fixture(account, 384);
    const proxy = new Proxy(32993, profile.delay, profile.bandwidth),
      port = await proxy.listen();
    proxies.add(proxy);
    const probe = await Lane.open(true, "INBOX", account, port),
      rtt: number[] = [],
      throughput: number[] = [];
    lanes.add(probe);
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await probe.op("NOOP RTT", async (guard) => {
        await probe.client.noop();
        guard();
      });
      rtt.push(performance.now() - start);
    }
    for (let i = 0; i < 3; i++) {
      const bytes = probe.bytesIn,
        start = performance.now();
      await probe.metadata(Array.from({ length: 128 }, (_, j) => j + 1));
      throughput.push(
        ((probe.bytesIn - bytes) / (performance.now() - start)) * 1000,
      );
    }
    await probe.close();
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    coordinators.add(c);
    c.port = port;
    c.emit = (e) => {
      if (e.kind === "user" && pendingUserIntent) {
        const command = (e.commands as { at: number; command: string }[]).find(
          (command) => /UID STORE/.test(command.command),
        );
        if (command) {
          userAdmission.push(command.at - pendingUserIntent);
          e.userIntent = pendingUserIntent;
          e.actualUserCommandAdmission = command.at;
        }
      }
      return trace.operation(e);
    };
    const actor = await Lane.open(true, "INBOX", account),
      arrivals: number[] = [],
      userWait: number[] = [],
      userAdmission: number[] = [];
    let pendingUserIntent = 0;
    lanes.add(actor);
    try {
      const start = performance.now();
      await c.turn(account, "history");
      const first = performance.now() - start;
      for (let i = 0; i < 10; i++) {
        const m = message(i + 1, "network-arrival-" + stamp);
        const appended = await actor.op("APPEND", async (guard) => {
          const r = await actor.client.append("INBOX", m.data);
          guard();
          assert(r && r.uid);
          return r;
        });
        const acknowledged = performance.now();
        await store.due(account);
        const intent = performance.now();
        pendingUserIntent = intent;
        await c.turn(account, "user");
        userWait.push(performance.now() - intent);
        await c.turn(account, "fresh");
        assert(
          (await store.placements(account)).some(
            (r) => r.uid === Number(appended.uid),
          ),
        );
        arrivals.push(performance.now() - acknowledged);
      }
      await c.drain(account);
      await c.repair(account);
      const verification = await compare(store, account);
      results.push({
        ...profile,
        status: "PASS",
        firstMetadataMs: first,
        measuredNoopRttMs: distribution(rtt),
        effectiveMetadataBytesPerSecond: distribution(throughput),
        arrivalMs: distribution(arrivals),
        userTurnCompletionMs: distribution(userWait),
        userWireAdmissionMs: distribution(userAdmission),
        proxyBytes: proxy.bytes,
        peakProxyBuffered: proxy.peakBuffered,
        ...verification,
      });
    } finally {
      await actor.close();
      await c.close();
      await proxy.close();
    }
  }
  for (const fault of [
    "hang-after-search",
    "reset-after-search",
    "temporary-blackout",
  ]) {
    const account = "p3-network-" + fault + "-" + stamp;
    await fixture(account, 128);
    const proxy = new Proxy(),
      port = await proxy.listen(),
      owner = await store.acquire(randomUUID());
    assert(owner);
    proxies.add(proxy);
    const c = new Coordinator(store, owner);
    coordinators.add(c);
    c.port = port;
    c.emit = (e) => trace.operation(e);
    let observed: unknown;
    try {
      const start = performance.now();
      if (fault === "temporary-blackout") {
        await c.turn(account, "history", async (point) => {
          if (point === "after-search") {
            proxy.oneWayMs = 500;
          }
        });
        observed = {
          durationMs: performance.now() - start,
          inducedError: false,
        };
      } else {
        await assert.rejects(
          c.turn(account, "history", async (point) => {
            if (point === "after-search") {
              if (fault === "hang-after-search") proxy.hold = true;
              else proxy.reset();
            }
          }),
        );
        assert.equal((await store.state(account)).history, 129);
        observed = {
          durationMs: performance.now() - start,
          inducedError: true,
        };
      }
      proxy.hold = false;
      proxy.oneWayMs = 0;
      proxy.reset();
      await c.drain(account);
      results.push({
        name: fault,
        status: "PASS",
        observed,
        ...(await compare(store, account)),
      });
    } finally {
      await c.close();
      await proxy.close();
    }
  }
} catch (error) {
  results.push({ status: "FAIL", failure: String((error as Error).stack) });
  process.exitCode = 1;
} finally {
  for (const c of coordinators) await c.close().catch(() => {});
  for (const lane of lanes) await lane.close().catch(() => lane.client.close());
  for (const proxy of proxies) await proxy.close().catch(() => {});
  await trace.close();
  await store.close();
  await writeFile(
    new URL(`outputs/${stamp}-network-summary.json`, import.meta.url),
    JSON.stringify(
      { stamp, trace: `${stamp}-network.jsonl.gz`, results },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(results));
}
