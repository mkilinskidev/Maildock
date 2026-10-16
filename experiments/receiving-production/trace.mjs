// A single bounded inspector trace of exception locations, never locals,
// provider error strings, credentials or message payloads.
import { readFile } from "node:fs/promises";
const ports = (await readFile("/proc/net/tcp", "utf8"))
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter((row) => row[3] === "0A")
  .map((row) => parseInt(row[1].split(":")[1], 16))
  .filter((p) => p > 32000);
let target;
for (const port of ports) {
  const endpoints = await fetch(`http://127.0.0.1:${port}/json/list`)
    .then((r) => r.json())
    .catch(() => []);
  target ??= endpoints.find((e) => e.url?.includes("worker-process.js"));
}
if (!target) throw new Error("Worker inspector unavailable");
await new Promise((resolve) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl),
    scripts = new Map();
  let count = 0;
  ws.onopen = () =>
    ws.send(JSON.stringify({ id: 1, method: "Debugger.enable" }));
  ws.onmessage = (event) => {
    const value = JSON.parse(event.data);
    if (value.method === "Debugger.scriptParsed")
      scripts.set(value.params.scriptId, value.params.url);
    if (value.id === 1)
      ws.send(
        JSON.stringify({
          id: 2,
          method: "Debugger.setPauseOnExceptions",
          params: { state: "all" },
        }),
      );
    if (value.method === "Debugger.paused") {
      if (
        value.params.callFrames
          .slice(0, 4)
          .some((f) =>
            /receiving-|imapflow|mailparser/.test(
              scripts.get(f.location.scriptId) ?? "",
            ),
          ) &&
        count++ < 100
      )
        console.log(
          JSON.stringify({
            reason: value.params.reason,
            frames: value.params.callFrames.slice(0, 5).map((f) => ({
              file: scripts.get(f.location.scriptId),
              line: f.location.lineNumber + 1,
              function: f.functionName,
            })),
          }),
        );
      ws.send(JSON.stringify({ id: 3, method: "Debugger.resume" }));
    }
  };
  setTimeout(() => {
    ws.send(
      JSON.stringify({
        id: 4,
        method: "Debugger.setPauseOnExceptions",
        params: { state: "none" },
      }),
    );
    ws.send(JSON.stringify({ id: 5, method: "Debugger.resume" }));
    setTimeout(() => {
      ws.close();
      resolve();
    }, 200);
  }, 30_000);
});
