import { logFailure } from "../logging/diagnostics";
import { createLogger } from "../logging/logger";
import { AesGcmSecretEncryption } from "../crypto/aes-gcm-secret-encryption";
import { createOAuthComposition } from "../../../modules/accounts/infrastructure/oauth-composition";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { getConfig } from "../config/config.js";
import { createWorkerDatabase } from "./database-worker.js";
import { initializeLocalSearchBodies } from "../../../modules/mail/infrastructure/search-local-backfill.js";

async function main() {
  const config = getConfig();
  const database = createWorkerDatabase(config);

  try {
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await createOAuthComposition(
      database.db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      config,
    ).microsoft.bootstrap();
    await initializeLocalSearchBodies(database.db);
    console.log("Database migrations completed.");
  } finally {
    await database.client.end();
  }
}
try {
  await main();
} catch (error) {
  logFailure(
    createLogger({ logLevel: "info" }),
    error,
    "database",
    "migration",
    "fatal",
  );
  process.exitCode = 1;
}
