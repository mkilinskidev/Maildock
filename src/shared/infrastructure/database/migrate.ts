import { migrate } from "drizzle-orm/postgres-js/migrator";

import { getConfig } from "../config/config.js";
import { createWorkerDatabase } from "./database-worker.js";

const config = getConfig();
const database = createWorkerDatabase(config);

try {
  await migrate(database.db, { migrationsFolder: "db/migrations" });
  console.log("Database migrations completed.");
} finally {
  await database.client.end();
}
