import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { ConfigurationError, type AppConfig } from "../config/config";
import * as schema from "./schema";

export function createDatabase(
  config: Pick<AppConfig, "databaseUrl" | "databasePoolSize">,
) {
  // This constructor runs during web module evaluation, before route catches.
  // Connection/query failures still follow their existing async boundaries.
  try {
    return createConfiguredDatabase(config);
  } catch {
    throw new ConfigurationError([
      "DATABASE_URL: database initialization failed",
    ]);
  }
}

function createConfiguredDatabase(
  config: Pick<AppConfig, "databaseUrl" | "databasePoolSize">,
) {
  const client = postgres(config.databaseUrl, {
    max: config.databasePoolSize,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    onnotice: () => undefined,
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
