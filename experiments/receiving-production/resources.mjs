// Bounded diagnostic sampling inside the disposable deployment. Inspector binds
// only to loopback in this explicit benchmark override; production has no port.
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { getConfig } from "/app/dist-worker/shared/infrastructure/config/config.js";
import { createWorkerDatabase } from "/app/dist-worker/shared/infrastructure/database/database-worker.js";
const label = process.argv[2] ?? "sample";
const ports = new Set(
  (await readFile("/proc/net/tcp", "utf8"))
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[3] === "0A")
    .map((row) => parseInt(row[1].split(":")[1], 16))
    .filter((port) => port > 32000),
);
async function inspect(endpoint) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Inspector sample deadline"));
    }, 2500);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression:
              "JSON.stringify({pid:process.pid,argv:process.argv,memory:process.memoryUsage(),cpu:process.cpuUsage()})",
            returnByValue: true,
          },
        }),
      );
    ws.onmessage = (event) => {
      const result = JSON.parse(event.data);
      if (result.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (result.error || !result.result?.result?.value)
        reject(new Error("Inspector sample rejected"));
      else resolve(JSON.parse(result.result.result.value));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Inspector unavailable"));
    };
  });
}
const nodes = [];
for (const port of ports) {
  const endpoints = await fetch(`http://127.0.0.1:${port}/json/list`)
    .then((r) => r.json())
    .catch(() => []);
  for (const endpoint of endpoints)
    nodes.push(await inspect(endpoint.webSocketDebuggerUrl));
}
const processes = [];
for (const pid of (await readdir("/proc")).filter((name) =>
  /^\d+$/.test(name),
)) {
  const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  if (!/(server\.js|worker-process\.js|container-entrypoint\.mjs)/.test(cmd))
    continue;
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  processes.push({
    pid: Number(pid),
    argv: cmd.split("\0").filter(Boolean),
    rssKiB: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]),
    highWaterKiB: Number(/VmHWM:\s+(\d+)/.exec(status)?.[1]),
    fileDescriptors: (await readdir(`/proc/${pid}/fd`).catch(() => [])).length,
  });
}
const database = createWorkerDatabase(getConfig());
try {
  const activity =
    await database.client`select application_name,state,wait_event_type,count(*)::int from pg_stat_activity where datname=current_database() group by application_name,state,wait_event_type`;
  const [disk] =
    await database.client`select pg_database_size(current_database())::text as database_bytes,pg_total_relation_size('messages')::text as messages_bytes,pg_total_relation_size('mailbox_messages')::text as placement_bytes`;
  console.log(
    JSON.stringify({
      label,
      at: new Date().toISOString(),
      nodes,
      processes,
      activity,
      disk,
      blobsKiB: Number(
        execFileSync("du", ["-sk", "/var/lib/maildock/attachments"], {
          encoding: "utf8",
        }).split(/\s+/)[0],
      ),
    }),
  );
} finally {
  await database.client.end({ timeout: 0 });
}
