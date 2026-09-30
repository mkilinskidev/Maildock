import { createWorkerComposition } from "./worker.js";
import { registerMailboxDiscoveryWorker } from "../modules/mail/infrastructure/mailbox-discovery-jobs.js";
import { registerRecentSyncWorker } from "../modules/mail/infrastructure/recent-sync-jobs.js";
import { registerContentWorker } from "../modules/mail/infrastructure/content-jobs.js";
import { registerDeltaWorker } from "../modules/mail/infrastructure/delta-sync-jobs.js";

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
    worker.poller.stop();
    await worker.watchers.stop();
    await worker.jobs.stop();
    await worker.database.client.end();
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
  await registerRecentSyncWorker(
    worker.jobs.boss,
    worker.messages,
    worker.config.messageSyncConcurrency,
    worker.withMailboxLock,
  );
  await registerDeltaWorker(
    worker.jobs.boss,
    worker.delta,
    worker.config.messageSyncConcurrency,
    worker.withMailboxLock,
  );
  await registerContentWorker(worker.jobs.boss, worker.content);
  await registerMailboxDiscoveryWorker(
    worker.jobs.boss,
    worker.mailboxDiscovery,
    worker.config.workerConcurrency,
  );
  await worker.poller.start();
  await worker.watchers.start();
} catch (error) {
  worker.logger.fatal(
    { err: error, event: "worker.start_failed" },
    "Worker failed to start",
  );
  process.exitCode = 1;
}
