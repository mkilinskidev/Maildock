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
