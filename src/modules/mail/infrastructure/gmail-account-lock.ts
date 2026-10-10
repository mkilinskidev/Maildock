import { SyncLockContentionError } from "./sync-diagnostics";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type {
  createDatabase,
  Database,
} from "../../../shared/infrastructure/database/database";
import * as schema from "../../../shared/infrastructure/database/schema";

export type GmailAccountLock = <T>(
  accountId: string,
  work: (db: Database) => Promise<T>,
) => Promise<T>;
/** Authority has its own short-lived connection, leaving the interactive pool
 * available over remote waits. Every projection still uses that same session. */
export function createGmailAccountLock(
  client: ReturnType<typeof createDatabase>["client"],
  diagnostic?: (event: { transactionMs: number }) => void,
): GmailAccountLock {
  return async (accountId, work) => {
    // postgres accepts the normalized host/port arrays at runtime. Copy exactly
    // the configured connection options; never read a second URL from the env.
    const authority = postgres({
      ...client.options,
      max: 1,
    } as unknown as postgres.Options<Record<string, never>>);
    const connection = await authority.reserve().catch(async (error) => {
      await authority.end({ timeout: 5 });
      throw error;
    });
    const key = `gmail-account:${accountId}`;
    try {
      const [row] = await connection<
        { acquired: boolean; pid: number }[]
      >`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired, pg_backend_pid() as pid`;
      if (!row?.acquired)
        throw new SyncLockContentionError(
          "Gmail account work is already running.",
        );
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
            >`select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted and objsubid=1 and classid=((hashtextextended(${key},0)>>32)&4294967295)::oid and objid=(hashtextextended(${key},0)&4294967295)::oid) as held, pg_backend_pid() as pid`;
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
        await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
      }
    } finally {
      connection.release();
      // Closing also prevents a failed UNLOCK/rollback from leaking authority
      // or transaction state into another account's pooled session.
      await authority.end({ timeout: 5 });
    }
  };
}
