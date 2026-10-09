import { assertNativeReleaseCompatible } from "../shared/infrastructure/database/native-release-guard.js";
import { logFailure } from "../shared/infrastructure/logging/diagnostics";
import { createLogger } from "../shared/infrastructure/logging/logger";
import { registerAttachmentWorker } from "../modules/mail/infrastructure/attachment-jobs";
import { createWorkerComposition } from "./worker.js";
import { registerMailboxDiscoveryWorker } from "../modules/mail/infrastructure/mailbox-discovery-jobs.js";
import { registerRecentSyncWorker } from "../modules/mail/infrastructure/recent-sync-jobs.js";
import {
  registerContentWorker,
  enqueueContent,
  contentJobState,
} from "../modules/mail/infrastructure/content-jobs.js";
import { registerDeltaWorker } from "../modules/mail/infrastructure/delta-sync-jobs.js";
import { registerBackfillWorker } from "../modules/mail/infrastructure/backfill-sync-jobs.js";
import { registerMessageCommandWorker } from "../modules/mail/infrastructure/message-command-jobs.js";
import { registerOutgoingWorker } from "../modules/mail/infrastructure/outgoing-jobs.js";
import { registerSentCopyWorker } from "../modules/mail/infrastructure/sent-copy-jobs.js";
import { setTimeout as delay } from "node:timers/promises";
import { isInstanceReady } from "../modules/auth/application/instance-readiness.js";
import { validateDatabaseAuthority } from "../shared/infrastructure/database/database-authority.js";

async function main() {
  const worker = createWorkerComposition();
  try {
    await validateDatabaseAuthority(worker.database.client);
    await assertNativeReleaseCompatible(worker.database.client);
  } catch (error) {
    await worker.database.client.end();
    throw error;
  }
  let stopping = false;
  const shutdownController = new AbortController();
  const retentionTimer = setInterval(
    () => void worker.events.cleanup(),
    60 * 60_000,
  );
  retentionTimer.unref();
  void worker.events.cleanup();

  function requestShutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    shutdownController.abort();
    clearInterval(retentionTimer);
    worker.logger.info(
      { event: "worker.shutdown", signal },
      "Worker shutting down",
    );
  }

  let contentRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let contentRecoveryWork: Promise<void> | undefined;
  function recoverContent() {
    if (contentRecoveryWork) return;
    contentRecoveryWork = worker.content
      .recoverPending({
        schedule: (accountId, mailboxId, messageId) =>
          enqueueContent(worker.jobs.boss, accountId, mailboxId, messageId),
        state: (mailboxId, messageId, pendingSince) =>
          contentJobState(worker.jobs.boss, mailboxId, messageId, pendingSince),
      })
      .catch((error) => logFailure(worker.logger, error, "jobs", "runtime"))
      .finally(() => {
        contentRecoveryWork = undefined;
      });
  }
  async function stopBusinessWorkers() {
    if (contentRecoveryTimer) clearInterval(contentRecoveryTimer);
    await contentRecoveryWork;
    worker.attachmentPoller.stop();
    worker.poller.stop();
    worker.backfillPoller.stop();
    worker.commandPoller.stop();
    worker.outgoingPoller.stop();
    worker.sentCopyPoller.stop();
    const errors: unknown[] = [];
    try {
      await worker.watchers.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await worker.jobs.stop();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Business worker cleanup failed");
  }

  const onSigterm = () => requestShutdown("SIGTERM");
  const onSigint = () => requestShutdown("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  async function waitForReadinessPoll() {
    try {
      await delay(1_000, undefined, { signal: shutdownController.signal });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError" && stopping))
        throw error;
    }
  }

  async function startBusinessWorkers() {
    // Fresh installations may start the worker before setup/enrollment. Keep
    // consumers, mail pollers and IMAP watchers idle until verified owner MFA.
    while (!stopping && !(await isInstanceReady(worker.database.db)))
      await waitForReadinessPoll();
    if (stopping) return;
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
    recoverContent();
    contentRecoveryTimer = setInterval(recoverContent, 60_000);
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
  }

  async function superviseBusinessReadiness() {
    while (!stopping) {
      await startBusinessWorkers();
      if (stopping) return;
      // Authenticator replacement is the first supported READY -> NOT READY
      // transition. Re-read PostgreSQL instead of caching startup readiness.
      while (!stopping && (await isInstanceReady(worker.database.db)))
        await waitForReadinessPoll();
      if (stopping) return;
      await stopBusinessWorkers();
      worker.logger.info(
        { event: "worker.mfa_pending" },
        "Business workers paused until verified owner MFA.",
      );
    }
  }

  try {
    await superviseBusinessReadiness();
  } catch (error) {
    logFailure(worker.logger, error, "worker", "startup", "fatal");
    process.exitCode = 1;
    requestShutdown("READINESS_FAILURE");
  } finally {
    // The supervisor owns startup, pause and teardown. A signal only requests
    // shutdown: await in-flight startup before clearing the resources it creates.
    // In particular, a poller's start() installs its interval after its first poll.
    requestShutdown("SUPERVISOR_STOPPED");
    try {
      try {
        await stopBusinessWorkers();
      } catch (error) {
        logFailure(worker.logger, error, "worker", "shutdown");
        process.exitCode = 1;
      } finally {
        await worker.database.client.end();
      }
    } catch (error) {
      logFailure(worker.logger, error, "worker", "shutdown");
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
    }
  }
}
try {
  await main();
} catch (error) {
  logFailure(
    createLogger({ logLevel: "info" }),
    error,
    "worker",
    "startup",
    "fatal",
  );
  process.exitCode = 1;
}
