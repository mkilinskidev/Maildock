import { getConfig } from "../shared/infrastructure/config/config.js";
import { createLogger } from "../shared/infrastructure/logging/logger.js";

export function createWebComposition() {
  const config = getConfig();
  return { config, logger: createLogger(config) };
}
