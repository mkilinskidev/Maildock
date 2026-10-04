import { drizzle } from "drizzle-orm/postgres-js";
import type { createWorkerDatabase } from "../../../shared/infrastructure/database/database-worker";
import type { OutgoingLock } from "./outgoing-lock";
import * as schema from "../../../shared/infrastructure/database/schema";

export function createAttachmentLock(
  client: ReturnType<typeof createWorkerDatabase>["client"],
): OutgoingLock {
  return async (id, work) => {
    const connection = await client.reserve();
    try {
      const [row] = await connection<
        { acquired: boolean }[]
      >`select pg_try_advisory_lock(hashtextextended(${`attachment:${id}`}, 0)) as acquired`;
      if (!row?.acquired) return;
      try {
        await work(
          drizzle(Object.assign(connection, { options: client.options }), {
            schema,
          }),
        );
      } finally {
        await connection`select pg_advisory_unlock(hashtextextended(${`attachment:${id}`}, 0))`;
      }
    } finally {
      connection.release();
    }
  };
}
