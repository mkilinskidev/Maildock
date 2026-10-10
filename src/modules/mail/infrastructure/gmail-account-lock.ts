import { drizzle } from "drizzle-orm/postgres-js";
import type {
  createDatabase,
  Database,
} from "../../../shared/infrastructure/database/database";
import * as schema from "../../../shared/infrastructure/database/schema";

export type GmailAccountLock = <T>(
  accountId: string,
  work: (db: Database) => Promise<T>,
) => Promise<T>;
/** Every projection uses the session holding authority, also with pool size one. */
export function createGmailAccountLock(
  client: ReturnType<typeof createDatabase>["client"],
  diagnostic?: (event: { transactionMs: number }) => void,
): GmailAccountLock {
  return async (accountId, work) => {
    const connection = await client.reserve();
    try {
      const [row] = await connection<
        { acquired: boolean; pid: number }[]
      >`select pg_try_advisory_lock(hashtextextended(${`gmail-account:${accountId}`}, 0)) as acquired, pg_backend_pid() as pid`;
      if (!row?.acquired)
        throw new Error("Gmail account work is already running.");
      // postgres.reserve deliberately exposes neither begin nor savepoint. Install
      // serialized transactions on this session, rather than checking out the pool.
      let tail = Promise.resolve();
      let savepoint = 0;
      const session = Object.assign(connection, {
        options: client.options,
        begin: async (
          callback: (session: typeof connection) => Promise<unknown>,
        ) => {
          const previous = tail;
          let release!: () => void;
          tail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          const start = performance.now();
          try {
            const [held] = await connection<
              { held: boolean; pid: number }[]
            >`select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) as held, pg_backend_pid() as pid`;
            if (!held.held || held.pid !== row.pid)
              throw new Error("Gmail execution authority was lost.");
            await connection`begin`;
            try {
              const result = await callback(connection);
              await connection`commit`;
              return result;
            } catch (error) {
              await connection`rollback`;
              throw error;
            }
          } finally {
            release();
            diagnostic?.({ transactionMs: performance.now() - start });
          }
        },
        savepoint: async (
          callback: (session: typeof connection) => Promise<unknown>,
        ) => {
          const name = `gmail_${++savepoint}`;
          await connection.unsafe(`savepoint ${name}`);
          try {
            const result = await callback(connection);
            await connection.unsafe(`release savepoint ${name}`);
            return result;
          } catch (error) {
            await connection.unsafe(`rollback to savepoint ${name}`);
            throw error;
          }
        },
      });
      try {
        return await work(drizzle(session, { schema }) as Database);
      } finally {
        await connection`select pg_advisory_unlock(hashtextextended(${`gmail-account:${accountId}`}, 0))`;
      }
    } finally {
      connection.release();
    }
  };
}
