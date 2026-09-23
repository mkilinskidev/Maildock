import { JobRuntime } from "../modules/jobs/infrastructure/job-runtime.js";
import { getConfig } from "../shared/infrastructure/config/config.js";
import { createLogger } from "../shared/infrastructure/logging/logger.js";

export function createWorkerComposition() {
  const config = getConfig();
  const logger = createLogger(config);
  return { config, logger, jobs: new JobRuntime(config, logger) };
}
