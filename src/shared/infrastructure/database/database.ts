import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { AppConfig } from "../config/config.js";
import * as schema from "./schema";

export function createDatabase(
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
