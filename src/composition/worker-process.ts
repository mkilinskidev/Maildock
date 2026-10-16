import { ReceivingDemand } from "../modules/mail/application/receiving-demand";
import { registerReceivingWakeDelivery } from "../modules/mail/infrastructure/receiving-wake-jobs";
import { registerReceivingConversions } from "../modules/mail/infrastructure/receiving-conversion-jobs";
import { registerAccountRemovalWorker } from "../modules/accounts/infrastructure/account-removal-jobs";
import { logFailure } from "../shared/infrastructure/logging/diagnostics";
import { createLogger } from "../shared/infrastructure/logging/logger";
import { createWorkerComposition } from "./worker.js";
import { registerOutgoingWorker } from "../modules/mail/infrastructure/outgoing-jobs.js";
import { setTimeout as delay } from "node:timers/promises";
import { isInstanceReady } from "../modules/auth/application/instance-readiness.js";
import { validateDatabaseAuthority } from "../shared/infrastructure/database/database-authority.js";

async function main() {
  const worker = createWorkerComposition();
  try {
    await validateDatabaseAuthority(worker.database.client);
  } catch (error) {
    await worker.database.client.end();
    throw error;
  }
  try {
    await worker.diagnosticRpc.start();
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
    void worker.receiving.stop().catch(() => undefined);
    worker.logger.info(
      { event: "worker.shutdown", signal },
      "Worker shutting down",
    );
  }

  async function stopBusinessWorkers() {
    worker.outgoingPoller.stop();
    const errors: unknown[] = [];
    try {
      await worker.receiving.stop();
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
    await registerAccountRemovalWorker(worker.jobs.boss, worker.accounts);
    await registerReceivingConversions(
      worker.jobs.boss,
      worker.database.db,
      worker.receiving,
    );
    const demand = new ReceivingDemand(worker.database.db, (id) =>
      worker.receiving.notify(id),
    );
    await registerReceivingWakeDelivery(
      worker.jobs.boss,
      demand,
      worker.receiving,
    );
    await registerOutgoingWorker(worker.jobs.boss, worker.outgoing);
    await worker.outgoingPoller.start();
    if (!stopping && (await isInstanceReady(worker.database.db))) {
      await worker.receiving.start();
      return true;
    }
    return false;
  }

  async function superviseBusinessReadiness() {
    while (!stopping) {
      const started = await startBusinessWorkers();
      if (stopping) return;
      if (!started) {
        await stopBusinessWorkers();
        continue;
      }
      // Authenticator replacement is the first supported READY -> NOT READY
      // transition. Re-read PostgreSQL instead of caching startup readiness.
      while (!stopping && (await isInstanceReady(worker.database.db))) {
        await worker.receiving.tick();
        await waitForReadinessPoll();
      }
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
        await worker.diagnosticRpc.stop();
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
