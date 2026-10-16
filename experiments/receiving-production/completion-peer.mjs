// Test-only relay in the existing fixture container, never production composition.
import "./peer.mjs";
import { connect, createServer } from "node:net";
import { createServer as httpServer } from "node:http";
const control = { pid: null, dropped: [], connections: [] };
const relay = createServer((client) => {
  client.setNoDelay(true);
  const upstream = connect(5432, "database-target");
  upstream.setNoDelay(true);
  const record = { pid: null, closed: false };
  control.connections.push(record);
  let buffer = Buffer.alloc(0),
    suppressReady = false;
  client.on("data", (bytes) => upstream.write(bytes));
  upstream.on("data", (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    // postgres.js uses cleartext local TCP. Do not inject during authentication.
    while (buffer.length >= 5) {
      const size = buffer.readUInt32BE(1) + 1;
      if (size < 5 || size > 16 * 1024 * 1024)
        throw new Error("Invalid PostgreSQL frame");
      if (buffer.length < size) break;
      const frame = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      const tag = String.fromCharCode(frame[0]);
      if (tag === "K") record.pid = frame.readUInt32BE(5);
      if (
        record.pid === control.pid &&
        tag === "C" &&
        frame.subarray(5).toString() === "COMMIT\0"
      ) {
        control.dropped.push({
          pid: record.pid,
          tag: "COMMIT",
          at: Date.now(),
        });
        control.pid = null;
        suppressReady = true;
        continue;
      }
      if (suppressReady && tag === "Z") {
        control.dropped.push({
          pid: record.pid,
          tag: "ReadyForQuery",
          at: Date.now(),
        });
        suppressReady = false;
        continue;
      }
      client.write(frame);
    }
  });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("end", () => upstream.end());
  upstream.on("end", () => client.end());
  client.on("close", () => {
    record.closed = true;
    upstream.destroy();
  });
  upstream.on("close", () => client.destroy());
});
const api = httpServer(async (req, res) => {
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { pid } = JSON.parse(body);
    if (
      !Number.isInteger(pid) ||
      !control.connections.some((c) => c.pid === pid && !c.closed)
    ) {
      res.writeHead(400);
      res.end("Unknown live backend");
      return;
    }
    control.pid = pid;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(control));
});
await Promise.all([
  new Promise((r) => relay.listen(5432, "127.0.0.1", r)),
  new Promise((r) => api.listen(1996, "127.0.0.1", r)),
]);
console.log("R16 test-only COMMIT relay ready");
