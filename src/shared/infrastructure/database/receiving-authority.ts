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

export type ReceivingAccountIdentity = Readonly<{
  account: string;
  configuration: bigint;
  lifecycle: bigint;
}>;

/** SQL-only recovery also covers a bootstrap whose COMMIT reply was lost. */
export async function recoverInboxIdentity(
  exec: ReceivingExecutor,
  owner: ReceivingOwner,
  account: string,
  mailbox: string,
  bootstrap: boolean,
  configuration: bigint | undefined,
  lifecycle: bigint | undefined,
  options: Parameters<ReceivingExecutor["transaction"]>[1],
) {
  return exec.transaction(async (db) => {
    const [lease] = await db.execute(
      sql`select maildock_receiving_validate(${owner.actor}::uuid,${owner.generation}::bigint) live`,
    );
    if (lease.live !== true) throw new Error("Receiving owner fenced");
    const [a] = await db.execute(
      sql`select configuration_version,receiving_lifecycle_version from mail_accounts where id=${account}::uuid and enabled for share`,
    );
    if (
      !a ||
      (configuration !== undefined &&
        BigInt(a.configuration_version as string) !== configuration) ||
      (lifecycle !== undefined &&
        BigInt(a.receiving_lifecycle_version as string) !== lifecycle)
    )
      throw new Error("Receiving configuration or lifecycle changed");
    const identity: ReceivingAccountIdentity = {
      account,
      configuration: BigInt(a.configuration_version as string),
      lifecycle: BigInt(a.receiving_lifecycle_version as string),
    };
    const [folder] = await db.execute(
      sql`select id,selectable,lifecycle_status from mailboxes where account_id=${account}::uuid and remote_path='INBOX' for update`,
    );
    if (!folder) {
      if (!bootstrap) throw new Error("Receiving INBOX missing");
      return { mailbox, identity, state: null, binding: null, missing: true };
    }
    if (
      (!bootstrap && folder.id !== mailbox) ||
      !folder.selectable ||
      folder.lifecycle_status !== "active"
    )
      throw new Error("Receiving INBOX identity changed");
    mailbox = folder.id as string;
    await db.execute(
      sql`select maildock_receiving_lock(${owner.actor}::uuid,${owner.generation}::bigint,${mailbox}::uuid)`,
    );
    const [s] = await db.execute(
      sql`select * from receiving_mailboxes where mailbox_id=${mailbox}::uuid for update`,
    );
    const state: ReceivingState | null = s
      ? {
          epoch: BigInt(s.epoch as string),
          revision: BigInt(s.revision as string),
          freshThrough: BigInt(s.fresh_through as string),
          historyBefore: BigInt(s.history_before as string),
          reconcileAfter: BigInt(s.reconcile_after as string),
        }
      : null;
    return {
      mailbox,
      identity,
      state,
      binding: s ? BigInt(s.configuration_binding as string) : null,
      missing: false,
    };
  }, options);
}

export async function assertReceivingAccount(
  db: ReceivingDatabase,
  identity: ReceivingAccountIdentity,
) {
  await db.execute(
    sql`select maildock_receiving_account_identity(${identity.account}::uuid,${identity.configuration}::bigint,${identity.lifecycle}::bigint)`,
  );
}

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
