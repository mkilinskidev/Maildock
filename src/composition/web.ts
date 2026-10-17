import { configureReceivingDiagnostics } from "../shared/infrastructure/logging/receiving-diagnostics.js";
import { getConfig } from "../shared/infrastructure/config/config.js";
import { createLogger } from "../shared/infrastructure/logging/logger.js";

export function createWebComposition() {
  const config = getConfig();
  const logger = createLogger(config);
  configureReceivingDiagnostics(logger);
  return { config, logger };
}
