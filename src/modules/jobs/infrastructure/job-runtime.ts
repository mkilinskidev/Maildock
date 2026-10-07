import { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";

import type { AppConfig } from "../../../shared/infrastructure/config/config.js";

export class JobRuntime {
  readonly boss: PgBoss;

  constructor(
    config: Pick<AppConfig, "databaseUrl">,
    private readonly logger: Logger,
  ) {
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
    this.logger.info({ event: "jobs.started" }, "Job runtime started");
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    this.logger.info({ event: "jobs.stopped" }, "Job runtime stopped");
  }
}
