import { PgBoss } from "pg-boss";
import { installSyncAdmission } from "../../mail/infrastructure/sync-admission";
import type { Logger } from "pino";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";

import type { AppConfig } from "../../../shared/infrastructure/config/config.js";

export class JobRuntime {
  readonly boss: PgBoss;
  private restoreAdmission?: () => void;
  private readonly syncCapacity: number;

  constructor(
    config: Pick<AppConfig, "databaseUrl"> &
      Partial<Pick<AppConfig, "messageSyncConcurrency">>,
    private readonly logger: Logger,
  ) {
    this.syncCapacity = Math.max(2, config.messageSyncConcurrency ?? 2);
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-worker",
    });
    this.boss.on("error", (error) => {
      logFailure(this.logger, error, "jobs", "runtime");
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    await this.boss.getQueues();
    this.restoreAdmission = installSyncAdmission(
      this.boss,
      this.syncCapacity,
      this.logger,
    );
    this.logger.info({ event: "jobs.started" }, "Job runtime started");
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    this.restoreAdmission?.();
    this.restoreAdmission = undefined;
    this.logger.info({ event: "jobs.stopped" }, "Job runtime stopped");
  }
}
