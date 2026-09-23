import { createWorkerComposition } from "./worker.js";

const worker = createWorkerComposition();
let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  worker.logger.info(
    { event: "worker.shutdown", signal },
    "Worker shutting down",
  );
  try {
    await worker.jobs.stop();
    process.exitCode = 0;
  } catch (error) {
    worker.logger.error(
      { err: error, event: "worker.shutdown_failed" },
      "Worker shutdown failed",
    );
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await worker.jobs.start();
} catch (error) {
  worker.logger.fatal(
    { err: error, event: "worker.start_failed" },
    "Worker failed to start",
  );
  process.exitCode = 1;
}
