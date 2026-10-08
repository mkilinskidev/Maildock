// Child application process used only by the PostgreSQL bootstrap regression tests.
import {
  initializeOwner,
  SetupThrottledError,
} from "../../src/modules/auth/application/instance-auth";
import { createDatabase } from "../../src/shared/infrastructure/database/database";

const database = createDatabase({
  databaseUrl: process.env.BOOTSTRAP_TEST_DATABASE_URL!,
  databasePoolSize: 2,
});
try {
  await initializeOwner(database.db, {
    bootstrapSecret: Buffer.alloc(32, 7).toString("base64"),
    username: "child",
    password: "child sufficiently long password",
  });
  process.send?.({ status: "created" });
} catch (error) {
  process.send?.({
    status: error instanceof SetupThrottledError ? "busy" : "failed",
  });
} finally {
  await database.client.end();
  process.disconnect?.();
}
