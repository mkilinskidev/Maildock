import postgres from "postgres";
import type { createWorkerDatabase } from "../../../shared/infrastructure/database/database-worker";
import { SyncLockContentionError } from "./sync-diagnostics";

export type IdleAccountLease = (
  accountId: string,
  onLost?: () => void,
) => Promise<() => Promise<void>>;

/** One background IDLE connection per account across worker processes. */
export function createIdleAccountLease(
  client: ReturnType<typeof createWorkerDatabase>["client"],
): IdleAccountLease {
  return async (accountId, onLost) => {
    let held = false;
    let authorityLost = false;
    // Like Gmail authority, use a dedicated session so long-lived IDLE does not
    // exhaust the application pool used for foreground commands and sync.
    const authority = postgres({
      ...client.options,
      max: 1,
      onclose: () => {
        if (held) {
          authorityLost = true;
          onLost?.();
        }
      },
    } as unknown as postgres.Options<Record<string, never>>);
    const connection = await authority.reserve().catch(async (error) => {
      await authority.end({ timeout: 5 });
      throw error;
    });
    const key = `maildock-idle-account:${accountId}`;
    try {
      const [row] = await connection<
        { acquired: boolean }[]
      >`select pg_try_advisory_lock(hashtextextended(${key},0)) as acquired`;
      if (!row?.acquired)
        throw new SyncLockContentionError(
          "Account IDLE watcher is already running.",
        );
      held = true;
    } catch (error) {
      connection.release();
      await authority.end({ timeout: 5 });
      throw error;
    }
    return async () => {
      held = false;
      try {
        if (!authorityLost)
          await connection`select pg_advisory_unlock(hashtextextended(${key},0))`;
      } finally {
        connection.release();
        await authority.end({ timeout: 5 });
      }
    };
  };
}
