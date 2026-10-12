import { eq, sql } from "drizzle-orm";
import type {
  RemoteMessageMetadata,
  RemoteFlagDelta,
} from "../../accounts/domain/mail-provider";
import {
  claimReceiving,
  type ReceivingOwner,
  type ReceivingState,
} from "../../../shared/infrastructure/database/receiving-authority";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import { mailboxes } from "../../../shared/infrastructure/database/schema";
import { persistMessageMetadata } from "./message-metadata-persistence";

const UID_MAX = 4294967295n;
export type IntervalEvidence = Readonly<{
  complete: true;
  epoch: bigint;
  low: bigint;
  high: bigint;
  searched: readonly bigint[];
  confirmedAbsent: readonly bigint[];
}>;
export type ReceivingMutation =
  | Readonly<{
      kind: "fresh" | "history";
      evidence: IntervalEvidence;
      metadata: readonly RemoteMessageMetadata[];
    }>
  | Readonly<{
      kind: "repair";
      complete: true;
      epoch: bigint;
      known: readonly bigint[];
      present: readonly bigint[];
      flags: readonly RemoteFlagDelta[];
      wrap: boolean;
    }>
  | Readonly<{ kind: "epoch"; complete: true; epoch: bigint; uidNext: bigint }>;

function uniqueUids(uids: readonly bigint[]) {
  if (
    uids.length > 128 ||
    new Set(uids).size !== uids.length ||
    uids.some((uid) => uid < 1n || uid > UID_MAX)
  )
    throw new Error("Invalid bounded receiving UID evidence");
}

/** Unwired Stage 1 entry point: evidence is completed BEFORE DB admission. */
export class ReceivingPersistence {
  constructor(private readonly executor: ReceivingExecutor) {}

  initialize(
    owner: ReceivingOwner,
    mailbox: string,
    evidence: { complete: true; epoch: bigint; uidNext: bigint },
    options: Parameters<ReceivingExecutor["transaction"]>[1],
  ) {
    owner = { ...owner };
    evidence = { ...evidence };
    if (
      evidence.complete !== true ||
      evidence.epoch < 1n ||
      evidence.epoch > UID_MAX ||
      evidence.uidNext < 1n ||
      evidence.uidNext > UID_MAX + 1n
    )
      throw new Error("Invalid receiving SELECT evidence");
    return this.executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_initialize(${owner.actor}::uuid,${owner.generation}::bigint,${mailbox}::uuid,${evidence.epoch}::bigint,${evidence.uidNext}::bigint)`,
      );
    }, options);
  }

  persist(
    owner: ReceivingOwner,
    mailbox: string,
    expected: ReceivingState,
    mutation: ReceivingMutation,
    options: Parameters<ReceivingExecutor["transaction"]>[1],
  ) {
    if (!["fresh", "history", "repair", "epoch"].includes(mutation.kind))
      throw new Error("Unsupported receiving mutation kind");
    if (mutation.kind === "fresh" || mutation.kind === "history") {
      if (mutation.metadata.length > 128)
        throw new Error("Receiving metadata count budget exceeded");
      let bytes = 0;
      for (const record of mutation.metadata) {
        bytes += Buffer.byteLength(JSON.stringify(record));
        if (bytes > 2 * 1024 * 1024)
          throw new Error("Receiving metadata byte budget exceeded");
      }
    }
    if (
      mutation.kind === "repair" &&
      (mutation.known.length > 128 ||
        mutation.present.length > 128 ||
        mutation.flags.length > 128 ||
        Buffer.byteLength(JSON.stringify(mutation.flags)) > 2 * 1024 * 1024)
    )
      throw new Error("Receiving repair evidence budget exceeded");
    // Capture bounded evidence before the first await; caller-owned arrays cannot
    // be changed underneath the already-validated frontier calculation.
    mutation = structuredClone(mutation);
    expected = { ...expected };
    owner = { ...owner };
    let next = { ...expected, revision: expected.revision + 1n };
    if (mutation.kind === "epoch") {
      if (
        mutation.complete !== true ||
        mutation.epoch < 1n ||
        mutation.epoch > UID_MAX ||
        mutation.epoch === expected.epoch ||
        mutation.uidNext < 1n ||
        mutation.uidNext > UID_MAX + 1n
      )
        throw new Error("Invalid receiving epoch replacement");
      next = {
        ...next,
        epoch: mutation.epoch,
        freshThrough: mutation.uidNext - 1n,
        historyBefore: mutation.uidNext,
        reconcileAfter: 0n,
      };
    } else if (mutation.kind === "repair") {
      uniqueUids(mutation.known);
      uniqueUids(mutation.present);
      uniqueUids(mutation.flags.map((flag) => BigInt(flag.uid)));
      if (
        mutation.complete !== true ||
        mutation.epoch !== expected.epoch ||
        mutation.present.some((uid) => !mutation.known.includes(uid)) ||
        mutation.flags.length !== mutation.present.length ||
        mutation.flags.some(
          (flag) => !mutation.present.includes(BigInt(flag.uid)),
        )
      )
        throw new Error("Incomplete receiving repair evidence");
      next.reconcileAfter = mutation.wrap
        ? 0n
        : (mutation.known.at(-1) ?? expected.reconcileAfter);
    } else {
      const e = mutation.evidence;
      uniqueUids(e.searched);
      uniqueUids(e.confirmedAbsent);
      uniqueUids(mutation.metadata.map((m) => BigInt(m.uid)));
      const resolved = new Set([
        ...mutation.metadata.map((m) => BigInt(m.uid)),
        ...e.confirmedAbsent,
      ]);
      if (
        e.complete !== true ||
        e.epoch !== expected.epoch ||
        e.low < 1n ||
        e.high > UID_MAX ||
        e.low > e.high ||
        e.searched.some(
          (uid) => uid < e.low || uid > e.high || !resolved.has(uid),
        ) ||
        resolved.size !== e.searched.length ||
        [...resolved].some((uid) => !e.searched.includes(uid)) ||
        mutation.metadata.some((m) => e.confirmedAbsent.includes(BigInt(m.uid)))
      )
        throw new Error("Unsupported receiving interval progress");
      if (mutation.kind === "fresh") {
        if (e.low !== expected.freshThrough + 1n)
          throw new Error("Fresh interval is not adjacent");
        next.freshThrough = e.high;
      } else {
        if (e.high !== expected.historyBefore - 1n)
          throw new Error("History interval is not adjacent");
        next.historyBefore = e.low;
      }
      if (
        Buffer.byteLength(JSON.stringify(mutation.metadata)) >
        2 * 1024 * 1024
      )
        throw new Error("Receiving metadata byte budget exceeded");
    }
    return this.executor.transaction(async (db) => {
      await claimReceiving(db, owner, mailbox, expected);
      const [folder] = await db
        .select({ account: mailboxes.accountId })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailbox));
      if (mutation.kind === "epoch") {
        await db
          .update(mailboxes)
          .set({ uidValidity: mutation.epoch })
          .where(eq(mailboxes.id, mailbox));
      } else if (mutation.kind === "repair") {
        // Verify the exact durable keyset page under the mailbox lock. Caller
        // cannot wrap R or omit an unvisited placement merely by setting a flag.
        const page = await db.execute(
          sql`select uid from mailbox_messages where mailbox_id=${mailbox}::uuid and uid_validity=${expected.epoch}::bigint and uid>${expected.reconcileAfter}::bigint order by uid limit 128`,
        );
        if (
          page.length !== mutation.known.length ||
          page.some(
            (row, i) => BigInt(row.uid as string) !== mutation.known[i],
          ) ||
          (mutation.wrap && mutation.known.length !== 0)
        )
          throw new Error("Repair is not the complete next durable page");
        for (const uid of mutation.known)
          if (!mutation.present.includes(uid))
            await db.execute(
              sql`delete from mailbox_messages where mailbox_id=${mailbox}::uuid and uid_validity=${expected.epoch}::bigint and uid=${uid}::bigint`,
            );
        for (const flag of mutation.flags)
          await db.execute(
            sql`update mailbox_messages set flags=ARRAY(select jsonb_array_elements_text(${JSON.stringify([...flag.flags])}::jsonb)),modseq=${flag.modseq ?? null}::bigint where mailbox_id=${mailbox}::uuid and uid_validity=${expected.epoch}::bigint and uid=${flag.uid}::bigint and (${flag.modseq ?? null}::bigint is null or modseq is null or modseq<=${flag.modseq ?? null}::bigint)`,
          );
      } else
        await persistMessageMetadata(
          db,
          folder.account,
          mailbox,
          expected.epoch,
          mutation.metadata,
          mutation.kind === "fresh",
          false,
        );
      await db.execute(
        sql`update receiving_mailboxes set epoch=${next.epoch}::bigint,revision=${next.revision}::bigint,fresh_through=${next.freshThrough}::bigint,history_before=${next.historyBefore}::bigint,reconcile_after=${next.reconcileAfter}::bigint where mailbox_id=${mailbox}::uuid`,
      );
      return next;
    }, options);
  }
}
