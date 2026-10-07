import type { createWorkerDatabase } from "../../../shared/infrastructure/database/database-worker";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "../../../shared/infrastructure/database/database";
import * as schema from "../../../shared/infrastructure/database/schema";

export type OutgoingLock = (
  id: string,
  work: (database: Database) => Promise<void>,
) => Promise<void>;
export function createOutgoingLock(
  client: ReturnType<typeof createWorkerDatabase>["client"],
): OutgoingLock {
  return async (id, work) => {
    const connection = await client.reserve();
    try {
      const [row] = await connection<
        { acquired: boolean }[]
      >`select pg_try_advisory_lock(hashtextextended(${`outgoing:${id}`}, 0)) as acquired`;
      if (!row?.acquired) return; // Active worker owns this attempt; poll again later.
      try {
        // Use the reserved connection for both the session lock and durable
        // autocommit writes. Workers do not consume a second pool connection.
        // postgres.reserve() omits options at runtime; Drizzle needs the parent
        // client's parser/serializer configuration when wrapping that connection.
        await work(
          drizzle(Object.assign(connection, { options: client.options }), {
            schema,
          }),
        );
      } finally {
        await connection`select pg_advisory_unlock(hashtextextended(${`outgoing:${id}`}, 0))`;
      }
    } finally {
      connection.release();
    }
  };
}
