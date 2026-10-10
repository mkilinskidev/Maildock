import { SyncLockContentionError } from "./sync-diagnostics";
import type { createWorkerDatabase } from "../../../shared/infrastructure/database/database-worker.js";

type DatabaseClient = ReturnType<typeof createWorkerDatabase>["client"];

export function createMailboxLock(client: DatabaseClient) {
  return async (
    mailboxId: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    const connection = await client.reserve();
    try {
      const result = await connection<
        { acquired: boolean }[]
      >`select pg_try_advisory_lock(hashtextextended(${`mailbox-sync:${mailboxId}`}, 0)) as acquired`;
      if (!result[0]?.acquired)
        throw new SyncLockContentionError("Mailbox sync is already running.");
      try {
        await work();
      } finally {
        await connection`select pg_advisory_unlock(hashtextextended(${`mailbox-sync:${mailboxId}`}, 0))`;
      }
    } finally {
      connection.release();
    }
  };
}
