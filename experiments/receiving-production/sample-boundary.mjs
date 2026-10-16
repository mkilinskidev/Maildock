// External sampler for the ordinary deployed worker. Does no rendering itself.
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const label = process.argv[2];
const end = Date.now() + 90_000;
const ports = (await readFile("/proc/net/tcp", "utf8"))
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter((r) => r[3] === "0A")
  .map((r) => parseInt(r[1].split(":")[1], 16))
  .filter((p) => p > 32000);
let selected;
for (const port of ports) {
  const entries = await fetch(`http://127.0.0.1:${port}/json/list`)
    .then((r) => r.json())
    .catch(() => []);
  for (const entry of entries) {
    const ws = new WebSocket(entry.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    const call = (method, params) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(
          () => reject(new Error("Sample deadline")),
          5000,
        );
        const receive = (event) => {
          const value = JSON.parse(event.data);
          if (value.id !== key) return;
          clearTimeout(timer);
          ws.removeEventListener("message", receive);
          if (value.error) reject(new Error(value.error.message));
          else resolve(value.result);
        };
        ws.addEventListener("message", receive);
        ws.send(JSON.stringify({ id: key, method, params }));
      });
    const result = await call("Runtime.evaluate", {
      expression:
        "JSON.stringify({pid:process.pid,argv:process.argv,cpu:process.cpuUsage(),memory:process.memoryUsage()})",
      returnByValue: true,
    });
    const info = JSON.parse(result.result.value);
    if (info.argv.some((a) => a.endsWith("worker-process.js")))
      selected = { ws, call, info };
    else ws.close();
  }
}
if (!selected) throw new Error("Actual worker inspector missing");
const samples = [];
await writeFile(`/r16-evidence/${label}-sampling-ready`, "ready");
while (Date.now() < end) {
  const status = await readFile(`/proc/${selected.info.pid}/status`, "utf8");
  const heap = await selected.call("Runtime.getHeapUsage");
  samples.push({
    at: Date.now(),
    rssKiB: Number(/VmRSS:\s+(\d+)/.exec(status)[1]),
    heapUsed: heap.usedSize,
    heapTotal: heap.totalSize,
    containerBytes: Number(
      await readFile("/sys/fs/cgroup/memory.current", "utf8"),
    ),
  });
  const done = await readFile(
    `/r16-evidence/${label}-sampling-stop`,
    "utf8",
  ).catch(() => "");
  if (done) break;
  await delay(100);
}
const result = await selected.call("Runtime.evaluate", {
  expression:
    "JSON.stringify({cpu:process.cpuUsage(),memory:process.memoryUsage()})",
  returnByValue: true,
});
selected.ws.close();
const after = JSON.parse(result.result.value);
const output = {
  label,
  pid: selected.info.pid,
  before: selected.info,
  after,
  cpuMs:
    (after.cpu.user +
      after.cpu.system -
      selected.info.cpu.user -
      selected.info.cpu.system) /
    1000,
  peakRssKiB: Math.max(...samples.map((s) => s.rssKiB)),
  peakHeapBytes: Math.max(...samples.map((s) => s.heapUsed)),
  peakContainerBytes: Math.max(...samples.map((s) => s.containerBytes)),
  cgroupPeakBytes: Number(await readFile("/sys/fs/cgroup/memory.peak", "utf8")),
  samples,
};
await writeFile(
  `/r16-evidence/${label}-resources.json`,
  JSON.stringify(output, null, 2),
);
console.log(JSON.stringify({ ...output, samples: samples.length }));
