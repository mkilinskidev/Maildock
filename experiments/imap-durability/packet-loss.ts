import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { exec, fixture, compare } from "./support.js";
import { Lane } from "./client.js";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { distribution } from "./metrics.js";
const container = "maildock-imap-durability-dovecot-1",
  image =
    process.env.PHASE3_NETEM_IMAGE ??
    "sha256:b2c9dce7a3d7f144f486a1cd2287aa20dc7ad529637d4adf31a238fde09f52a3";
assert(
  /^sha256:[0-9a-f]{64}$/.test(image),
  "Use an exact locally inspected helper image identity",
);
const tc = async (...args: string[]) =>
  (
    await exec(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "container:" + container,
        "--cap-add",
        "NET_ADMIN",
        image,
        ...args,
      ],
      { timeout: 20000 },
    )
  ).stdout;
const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
  account = "p3-netem-" + stamp,
  result: Record<string, unknown> = { stamp, image, seed: 2403 };
let added = false,
  c: Coordinator | undefined,
  probe: Lane | undefined;
const store = new Store();
await store.setup();
try {
  const project = (
    await exec("docker", [
      "inspect",
      container,
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}',
    ])
  ).stdout.trim();
  assert.equal(project, "maildock-imap-durability");
  await fixture(account, 1024);
  result.before = await tc("qdisc", "show", "dev", "eth0");
  assert(!String(result.before).includes("netem"));
  await tc(
    "qdisc",
    "add",
    "dev",
    "eth0",
    "root",
    "handle",
    "33:",
    "netem",
    "delay",
    "20ms",
    "loss",
    "3%",
    "seed",
    "2403",
  );
  added = true;
  probe = await Lane.open(true, "INBOX", account);
  const rtt: number[] = [],
    throughput: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await probe.op("NOOP LOSS RTT", async (guard) => {
      await probe!.client.noop();
      guard();
    });
    rtt.push(performance.now() - start);
  }
  for (let i = 0; i < 10; i++) {
    const bytes = probe.bytesIn,
      start = performance.now();
    await probe.metadata(Array.from({ length: 128 }, (_, j) => j + 1));
    throughput.push(
      ((probe.bytesIn - bytes) / (performance.now() - start)) * 1000,
    );
  }
  await probe.close();
  probe = undefined;
  const owner = await store.acquire(randomUUID());
  assert(owner);
  c = new Coordinator(store, owner);
  await c.drain(account);
  result.qdiscMeasured = await tc("-s", "qdisc", "show", "dev", "eth0");
  const dropped = /dropped (\d+)/.exec(String(result.qdiscMeasured));
  assert(dropped && Number(dropped[1]) > 0, "Prove actual dropped packets");
  await tc("qdisc", "del", "dev", "eth0", "root", "handle", "33:");
  added = false;
  Object.assign(result, {
    status: "PASS",
    dropped: Number(dropped[1]),
    rttMs: distribution(rtt),
    effectiveBytesPerSecond: distribution(throughput),
    ...(await compare(store, account)),
  });
} catch (error) {
  result.status = "NOT RUN";
  result.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  if (added) await tc("qdisc", "del", "dev", "eth0", "root", "handle", "33:");
  await probe?.close();
  await c?.close();
  await store.close();
  await writeFile(
    new URL(`outputs/${stamp}-packet-loss.json`, import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
