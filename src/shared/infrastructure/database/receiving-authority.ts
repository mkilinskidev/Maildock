import { sql } from "drizzle-orm";
import {
  ReceivingUnresolvedError,
  type ReceivingDatabase,
  type ReceivingExecutor,
} from "./receiving-executor";

export type ReceivingOwner = Readonly<{ actor: string; generation: bigint }>;
export type ReceivingState = Readonly<{
  epoch: bigint;
  revision: bigint;
  freshThrough: bigint;
  historyBefore: bigint;
  reconcileAfter: bigint;
}>;

/** Stage 3A startup, including uncertain initialization. Existing Stage 1
 * conflicting locks establish ordering even when enrollment has no row yet.
 * The account/INBOX binding is checked before any receiving socket is opened.
 */
export async function recoverReceivingEnrollment(
  exec: ReceivingExecutor,
  owner: ReceivingOwner,
  account: string,
  mailbox: string,
  options: Parameters<ReceivingExecutor["transaction"]>[1],
): Promise<ReceivingState | null> {
  return exec.transaction(async (db) => {
    await db.execute(
      sql`select maildock_receiving_lock(${owner.actor}::uuid,${owner.generation}::bigint,${mailbox}::uuid)`,
    );
    const [folder] = await db.execute(
      sql`select account_id,remote_path from mailboxes where id=${mailbox}::uuid`,
    );
    if (folder?.account_id !== account || folder.remote_path !== "INBOX")
      throw new Error("Receiving requires the configured account INBOX");
    const [row] = await db.execute(
      sql`select * from receiving_mailboxes where mailbox_id=${mailbox}::uuid for update`,
    );
    return row
      ? {
          epoch: BigInt(row.epoch as string),
          revision: BigInt(row.revision as string),
          freshThrough: BigInt(row.fresh_through as string),
          historyBefore: BigInt(row.history_before as string),
          reconcileAfter: BigInt(row.reconcile_after as string),
        }
      : null;
  }, options);
}

export async function claimReceiving(
  db: ReceivingDatabase,
  owner: ReceivingOwner,
  mailbox: string,
  expected: ReceivingState,
) {
  await db.execute(
    sql`select maildock_receiving_claim(${owner.actor}::uuid,${owner.generation}::bigint,${mailbox}::uuid,${expected.epoch}::bigint,${expected.revision}::bigint,${expected.freshThrough}::bigint,${expected.historyBefore}::bigint,${expected.reconcileAfter}::bigint)`,
  );
}

export async function recoverReceiving(
  exec: ReceivingExecutor,
  owner: ReceivingOwner,
  mailbox: string,
  options: Parameters<ReceivingExecutor["transaction"]>[1],
): Promise<ReceivingState> {
  try {
    return await exec.transaction(async (db) => {
      const rows = await db.execute(
        sql`select * from maildock_receiving_recover(${owner.actor}::uuid,${owner.generation}::bigint,${mailbox}::uuid)`,
      );
      const row = rows[0];
      if (!row) throw new Error("Missing receiving state");
      return {
        epoch: BigInt(row.epoch as string),
        revision: BigInt(row.revision as string),
        freshThrough: BigInt(row.fresh_through as string),
        historyBefore: BigInt(row.history_before as string),
        reconcileAfter: BigInt(row.reconcile_after as string),
      };
    }, options);
  } catch (cause) {
    // A failed recovery transaction says nothing about the old writer's result.
    throw new ReceivingUnresolvedError("transaction", { cause });
  }
}
