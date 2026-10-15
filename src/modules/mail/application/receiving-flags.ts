import { sql } from "drizzle-orm";
import type { ImapFlow, ReceivingResponse, ReceivingToken } from "imapflow";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import type { PublicationSource } from "./receiving-publication";
import type {
  ReceivingOperation,
  ReceivingOperationHandler,
} from "./receiving-operation";

type Token = ReceivingToken | ReceivingToken[] | null | undefined;
function value(token: Token): string {
  if (!token || Array.isArray(token) || typeof token.value !== "string")
    throw new Error("Malformed flag evidence atom");
  return token.value;
}
function number(token: Token, maximum = 9223372036854775807n) {
  const raw = value(token);
  if (raw.length > 20 || !/^[1-9][0-9]*$/.test(raw) || BigInt(raw) > maximum)
    throw new Error("Invalid flag evidence number");
  return BigInt(raw);
}
const canonical = (flag: string) =>
  [
    "\\Seen",
    "\\Flagged",
    "\\Answered",
    "\\Deleted",
    "\\Draft",
    "\\Recent",
  ].find((known) => known.toLowerCase() === flag.toLowerCase()) ?? flag;

/** One bounded raw collector per owned socket. Library booleans and normalized
 * FETCH rows alone do not prove a correlated, complete remote result. */
export class FlagCollector {
  private failed = false;
  reject() {
    this.failed = true;
  }
  private command?: string;
  private tag?: string;
  private complete = false;
  private epoch?: bigint;
  private readWrite = false;
  private highest?: bigint;
  private noModseq = false;
  private row?: { uid: bigint; flags: string[]; modseq: bigint | null };
  private conflict = false;
  private conditional = false;
  private selected = false;
  private uid?: bigint;

  begin(
    command: "SELECT" | "UID FETCH" | "UID STORE",
    uid?: bigint,
    conditional = false,
  ) {
    this.command = command;
    this.tag = undefined;
    this.complete = false;
    this.row = undefined;
    this.conflict = false;
    this.conditional = conditional;
    this.uid = uid;
  }
  observe = (
    response: ReceivingResponse,
    request?: { tag: string; command: string; sent: boolean },
  ) => {
    if (this.failed)
      throw new Error("Flag protocol diagnostics rejected evidence");
    if (!this.command) return;
    if (response.nullBytesRemoved)
      throw new Error("Null bytes in flag evidence");
    if (!request?.sent || request.command !== this.command) return;
    if (this.tag && this.tag !== request.tag)
      throw new Error("Repeated flag protocol command");
    this.tag = request.tag;
    const attributes = response.attributes ?? [];
    for (const attribute of attributes) {
      if (!attribute || Array.isArray(attribute) || !attribute.section)
        continue;
      const section = attribute.section;
      const code = value(section[0]).toUpperCase();
      if (
        code === "UIDVALIDITY" &&
        this.command !== "SELECT" &&
        number(section[1], 4294967295n) !== this.epoch
      )
        throw new Error("Selected flag epoch changed during operation");
      if (this.command === "SELECT") {
        if (code === "UIDVALIDITY") {
          if (this.epoch !== undefined)
            throw new Error("Duplicate UIDVALIDITY");
          this.epoch = number(section[1], 4294967295n);
        }
        if (code === "HIGHESTMODSEQ") {
          if (this.highest !== undefined || this.noModseq)
            throw new Error("Duplicate or contradictory selected MODSEQ");
          this.highest = number(section[1]);
        }
        if (code === "NOMODSEQ") {
          if (this.noModseq || this.highest !== undefined)
            throw new Error("Contradictory NOMODSEQ");
          this.noModseq = true;
        }
        if (code === "READ-WRITE" && response.tag === request.tag)
          this.readWrite = true;
      }
      if (this.command === "UID STORE" && code === "MODIFIED") {
        if (
          !this.conditional ||
          response.tag !== request.tag ||
          !["OK", "NO"].includes(response.command ?? "") ||
          value(section[1]) !== String(this.uid)
        )
          throw new Error("Uncorrelated conditional STORE conflict");
        this.conflict = true;
      }
    }
    if (
      this.command === "UID FETCH" &&
      response.tag === "*" &&
      attributes[0] &&
      !Array.isArray(attributes[0]) &&
      attributes[0].value === "FETCH"
    ) {
      if (!/^[1-9][0-9]*$/.test(response.command ?? ""))
        throw new Error("Invalid FETCH sequence");
      const fields = attributes[1];
      if (!Array.isArray(fields) || fields.length % 2)
        throw new Error("Malformed flag FETCH");
      const seen = new Set<string>();
      let uid: bigint | undefined,
        flags: string[] | undefined,
        modseq: bigint | null = null;
      for (let i = 0; i < fields.length; i += 2) {
        const key = value(fields[i]).toUpperCase();
        if (seen.has(key)) throw new Error("Duplicate flag FETCH field");
        seen.add(key);
        if (key === "UID") uid = number(fields[i + 1], 4294967295n);
        else if (key === "FLAGS") {
          const list = fields[i + 1];
          if (!Array.isArray(list) || list.length > 128)
            throw new Error("Malformed flags");
          flags = list.map((token) => {
            const flag = canonical(value(token));
            if (
              !flag ||
              Buffer.byteLength(flag) > 256 ||
              /[\s(){}\x00-\x1f\x7f]/.test(flag)
            )
              throw new Error("Invalid flag atom");
            return flag;
          });
          if (new Set(flags).size !== flags.length)
            throw new Error("Duplicate flags");
        } else if (key === "MODSEQ") {
          const list = fields[i + 1];
          if (!Array.isArray(list) || list.length !== 1)
            throw new Error("Malformed MODSEQ");
          modseq = number(list[0]);
        } else throw new Error("Unexpected flag FETCH field");
      }
      // Unsolicited flag-only updates cannot supply exact UID evidence.
      if (uid === undefined) return false;
      if (uid !== this.uid || this.row || flags === undefined)
        throw new Error("Unexpected or incomplete flag FETCH identity");
      this.row = { uid, flags, modseq };
    }
    if (response.tag === request.tag) {
      if (this.complete || (response.command !== "OK" && !this.conflict))
        throw new Error("Unsuccessful flag protocol completion");
      this.complete = true;
    } else if (response.tag !== "*")
      throw new Error("Uncorrelated flag completion");
  };
  finishSelect(client: ImapFlow, epoch: bigint) {
    if (
      this.failed ||
      !this.complete ||
      !this.tag ||
      this.epoch !== epoch ||
      !this.readWrite ||
      !client.mailbox ||
      client.mailbox.uidValidity !== epoch
    )
      throw new Error("Frozen source SELECT identity or write access rejected");
    this.selected = true;
    if (
      client.enabled.has("CONDSTORE") &&
      !this.noModseq &&
      this.highest === undefined
    )
      throw new Error("Enabled CONDSTORE lacks selected MODSEQ evidence");
    return (
      client.enabled.has("CONDSTORE") &&
      !this.noModseq &&
      this.highest !== undefined
    );
  }
  finishFetch(conditional: boolean) {
    if (
      this.failed ||
      !this.selected ||
      !this.complete ||
      !this.tag ||
      !this.row ||
      (conditional && this.row.modseq === null)
    )
      throw new Error("Incomplete exact flag FETCH evidence");
    return this.row;
  }
  finishStore() {
    if (this.failed || !this.complete || !this.tag)
      throw new Error("Incomplete UID STORE evidence");
    return !this.conflict;
  }
}

/** Reads only a single existing intent; locked recovery below is authoritative. */
export async function prepareReceivingFlags(
  operation: ReceivingOperation,
  executor: ReceivingExecutor,
) {
  if (
    !("pendingId" in operation) ||
    !("account" in operation.identity) ||
    !["store", "exact-lookup"].includes(operation.kind)
  )
    throw new Error("Invalid flag operation");
  const identity = operation.identity;
  const row = await executor.transaction(
    async (db) => {
      const [row] = await db.execute(sql`
      select c.*,s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after
      from message_commands c join receiving_mailboxes s on s.mailbox_id=c.mailbox_id
      where c.id=${operation.pendingId}::uuid and c.account_id=${identity.account}::uuid
        and c.mailbox_id=${identity.mailbox ?? null}::uuid
        and c.action in ('mark_read','mark_unread','flag','unflag')`);
      if (!row) throw new Error("Missing durable flag intent");
      return row;
    },
    {
      deadline: Math.min(operation.deadline, performance.now() + 2000),
      signal: operation.signal,
    },
  );
  let source: PublicationSource = {
    mailbox: row.mailbox_id as string,
    configuration: BigInt(row.source_configuration_binding as string),
    state: {
      epoch: BigInt(row.epoch as string),
      revision: BigInt(row.revision as string),
      freshThrough: BigInt(row.fresh_through as string),
      historyBefore: BigInt(row.history_before as string),
      reconcileAfter: BigInt(row.reconcile_after as string),
    },
  };
  const collector = new FlagCollector();
  let path: string, uid: bigint, epoch: bigint, flag: string, desired: boolean;
  const reconciliation = operation.kind === "exact-lookup";
  const handler: ReceivingOperationHandler = {
    preNetwork: async (_operation, context) => {
      const recovered = await context.recover(source);
      const command = recovered.intent;
      if (
        !recovered.authority.activeSource ||
        recovered.authority.configuration !== source.configuration ||
        recovered.authority.path !== command.source_path
      )
        throw new Error("Obsolete flag source");
      source = { ...source, state: recovered.state };
      path = String(command.source_path);
      uid = BigInt(command.source_uid as string);
      epoch = BigInt(command.source_uid_validity as string);
      const action = String(command.action);
      flag = ["mark_read", "mark_unread"].includes(action)
        ? "\\Seen"
        : "\\Flagged";
      desired = ["mark_read", "flag"].includes(action);
      if (reconciliation) await context.resume(source);
      else await context.claim(source);
    },
    execute: async (_operation, context) => {
      await context.client.connect();
      collector.begin("SELECT");
      const selected = await context.client.mailboxOpen(path, {
        readOnly: false,
      });
      if (selected.uidValidity !== epoch)
        throw new Error("Flag source UIDVALIDITY changed");
      // finishSelect is invoked by the boundary, which owns the actual client.
      const conditional = finishSelect(epoch);
      if (
        !reconciliation &&
        desired &&
        selected.permanentFlags &&
        !selected.permanentFlags.has("\\*") &&
        !selected.permanentFlags.has(flag)
      )
        throw new Error("Requested flag is not permitted by selected source");
      const fetch = async () => {
        collector.begin("UID FETCH", uid);
        await context.client.fetchOne(
          String(uid),
          { uid: true, flags: true },
          { uid: true },
        );
        return collector.finishFetch(conditional);
      };
      const before = await fetch();
      let evidence = before;
      if (!reconciliation) {
        collector.begin("UID STORE", uid, conditional);
        try {
          const options = {
            uid: true,
            ...(conditional ? { unchangedSince: before.modseq! } : {}),
          };
          const applied = desired
            ? await context.client.messageFlagsAdd(String(uid), [flag], options)
            : await context.client.messageFlagsRemove(
                String(uid),
                [flag],
                options,
              );
          if (!applied) throw new Error("UID STORE not executed");
        } catch (error) {
          if (collector.finishStore()) throw error;
        }
        if (!collector.finishStore()) {
          await context.retireSocket();
          await context.publication.flagConflict();
          return;
        }
        evidence = await fetch();
        if (
          before.modseq !== null &&
          (evidence.modseq === null || evidence.modseq < before.modseq)
        )
          throw new Error("Regressed remote flag MODSEQ");
      }
      await context.retireSocket();
      if (evidence.flags.includes(flag) !== desired) {
        await context.publication.flagConflict();
        return;
      }
      await context.publication.commandResult({
        complete: true,
        epoch,
        uid,
        flags: evidence.flags,
        modseq: evidence.modseq,
      });
    },
  };
  let finishSelect: (epoch: bigint) => boolean;
  return {
    collector,
    handler,
    bind: (client: ImapFlow) => {
      finishSelect = (epoch) => collector.finishSelect(client, epoch);
    },
  };
}
