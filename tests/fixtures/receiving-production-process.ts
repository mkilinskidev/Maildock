// Test instrumentation around the normal process entrypoint. No alternate
// composition, client factory or authority hook is supplied to the worker.
process.on("message", (message) => {
  if (message === "stop") process.emit("SIGTERM");
  if (message === "resources")
    process.send?.({ memory: process.memoryUsage(), cpu: process.cpuUsage() });
});
await import("../../src/composition/worker-process");
process.disconnect?.();

export {};
