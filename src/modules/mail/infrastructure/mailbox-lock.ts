import type { createWorkerDatabase } from "../../../shared/infrastructure/database/database-worker.js";

type DatabaseClient = ReturnType<typeof createWorkerDatabase>["client"];

/** The lock was held elsewhere; the callback did not start. */
export class MailboxBusyError extends Error {
  constructor() {
    super("Mailbox sync is already running.");
    this.name = "MailboxBusyError";
  }
}

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
      if (!result[0]?.acquired) throw new MailboxBusyError();
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
