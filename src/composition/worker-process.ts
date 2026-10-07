import { registerAttachmentWorker } from "../modules/mail/infrastructure/attachment-jobs";
import { createWorkerComposition } from "./worker.js";
import { registerMailboxDiscoveryWorker } from "../modules/mail/infrastructure/mailbox-discovery-jobs.js";
import { registerRecentSyncWorker } from "../modules/mail/infrastructure/recent-sync-jobs.js";
import { registerContentWorker } from "../modules/mail/infrastructure/content-jobs.js";
import { registerDeltaWorker } from "../modules/mail/infrastructure/delta-sync-jobs.js";
import { registerBackfillWorker } from "../modules/mail/infrastructure/backfill-sync-jobs.js";
import { registerMessageCommandWorker } from "../modules/mail/infrastructure/message-command-jobs.js";
import { registerOutgoingWorker } from "../modules/mail/infrastructure/outgoing-jobs.js";
import { registerSentCopyWorker } from "../modules/mail/infrastructure/sent-copy-jobs.js";

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
    worker.attachmentPoller.stop();
    worker.poller.stop();
    worker.backfillPoller.stop();
    worker.commandPoller.stop();
    worker.outgoingPoller.stop();
    worker.sentCopyPoller.stop();
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
  await registerAttachmentWorker(worker.jobs.boss, worker.attachments);
  await worker.attachmentPoller.start();
  await registerSentCopyWorker(worker.jobs.boss, worker.sentCopy);
  await registerOutgoingWorker(worker.jobs.boss, worker.outgoing);
  await worker.outgoingPoller.start();
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
  await registerBackfillWorker(
    worker.jobs.boss,
    worker.backfill,
    worker.withMailboxLock,
  );
  await registerContentWorker(worker.jobs.boss, worker.content);
  await registerMessageCommandWorker(
    worker.jobs.boss,
    worker.commands,
    worker.withMailboxLock,
  );
  await registerMailboxDiscoveryWorker(
    worker.jobs.boss,
    worker.mailboxDiscovery,
    worker.config.workerConcurrency,
  );
  await worker.poller.start();
  await worker.backfillPoller.start();
  await worker.commandPoller.start();
  await worker.sentCopyPoller.start();
  await worker.watchers.start();
} catch (error) {
  worker.logger.fatal(
    { err: error, event: "worker.start_failed" },
    "Worker failed to start",
  );
  process.exitCode = 1;
}
