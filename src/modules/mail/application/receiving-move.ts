import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ImapFlow, ReceivingResponse, ReceivingToken } from "imapflow";
import type { ReceivingOwner } from "../../../shared/infrastructure/database/receiving-authority";
import {
  ReceivingUnresolvedError,
  type ReceivingExecutor,
} from "../../../shared/infrastructure/database/receiving-executor";
import {
  ReceivingBoundedPublication,
  type DataAuthority,
} from "./receiving-bounded-publication";
import type {
  ReceivingOperation,
  ReceivingOperationContext,
} from "./receiving-operation";

type Token = ReceivingToken | ReceivingToken[] | null | undefined;
const atom = (t: Token): string => {
  if (!t || Array.isArray(t) || typeof t.value !== "string")
    throw Error("Malformed MOVE evidence");
  return t.value;
};
const uid = (t: Token) => {
  const raw = atom(t);
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || BigInt(raw) > 4294967295n)
    throw Error("Invalid MOVE UID");
  return BigInt(raw);
};
export type MoveProof = {
  epoch: string;
  uid: string;
  sourceEpoch: string;
  sourceUid: string;
};

/** Raw evidence only. In particular, the adapter's normalized UID map is ignored. */
export class MoveCollector {
  private rejected = false;
  private command = "";
  private tag?: string;
  private complete = false;
  private epoch?: bigint;
  private mapping?: { epoch: bigint; source: bigint; destination: bigint };
  private row?: { uid: bigint; flags: string[]; modseq: bigint | null };
  private requested?: bigint;
  private writable = false;
  begin(
    command: "SELECT" | "EXAMINE" | "UID FETCH" | "UID MOVE",
    requested?: bigint,
  ) {
    this.command = command;
    this.tag = undefined;
    this.complete = false;
    this.mapping = undefined;
    this.row = undefined;
    this.requested = requested;
    if (command === "SELECT" || command === "EXAMINE") {
      this.epoch = undefined;
      this.writable = false;
    }
  }
  reject() {
    this.rejected = true;
  }
  observe = (
    r: ReceivingResponse,
    request?: { tag: string; command: string; sent: boolean },
  ) => {
    if (this.rejected || r.nullBytesRemoved)
      throw Error("Rejected MOVE protocol evidence");
    if (!this.command || !request?.sent || request.command !== this.command)
      return;
    if (this.tag && this.tag !== request.tag)
      throw Error("Changed MOVE command tag");
    this.tag = request.tag;
    for (const t of r.attributes ?? []) {
      if (!t || Array.isArray(t) || !t.section) continue;
      const section = t.section,
        name = atom(section[0]).toUpperCase();
      if (name === "UIDVALIDITY") {
        const value = uid(section[1]);
        if (
          section.length !== 2 ||
          (this.command === "SELECT" || this.command === "EXAMINE"
            ? this.epoch !== undefined
            : value !== this.epoch)
        )
          throw Error("Contradictory MOVE epoch");
        this.epoch = value;
      }
      if (name === "READ-WRITE" && r.tag === request.tag) this.writable = true;
      if (name === "COPYUID") {
        if (
          this.command !== "UID MOVE" ||
          this.mapping ||
          section.length !== 4 ||
          r.command !== "OK" ||
          (r.tag !== "*" && r.tag !== request.tag)
        )
          throw Error("Ambiguous COPYUID");
        this.mapping = {
          epoch: uid(section[1]),
          source: uid(section[2]),
          destination: uid(section[3]),
        };
        if (this.mapping.source !== this.requested)
          throw Error("COPYUID identifies a different source");
      }
    }
    if (r.tag === "*" && r.attributes?.[0]?.value === "FETCH") {
      if (this.command !== "UID FETCH" || this.row)
        throw Error("Unexpected MOVE FETCH");
      const fields = r.attributes[1];
      if (!Array.isArray(fields) || fields.length % 2)
        throw Error("Malformed MOVE FETCH");
      let found: bigint | undefined,
        flags: string[] | undefined,
        modseq: bigint | null = null;
      const keys = new Set<string>();
      for (let i = 0; i < fields.length; i += 2) {
        const key = atom(fields[i]).toUpperCase(),
          v = fields[i + 1];
        if (keys.has(key)) throw Error("Duplicate MOVE FETCH field");
        keys.add(key);
        if (key === "UID") found = uid(v);
        else if (key === "FLAGS") {
          if (!Array.isArray(v) || v.length > 128)
            throw Error("Invalid MOVE flags");
          flags = v.map(atom);
          if (
            new Set(flags).size !== flags.length ||
            flags.some(
              (f) =>
                !f ||
                Buffer.byteLength(f) > 256 ||
                /[\s(){}\x00-\x1f\x7f]/.test(f),
            )
          )
            throw Error("Malformed MOVE flags");
        } else if (key === "MODSEQ") {
          if (
            !Array.isArray(v) ||
            v.length !== 1 ||
            !/^[1-9][0-9]{0,18}$/.test(atom(v[0])) ||
            BigInt(atom(v[0])) > 9223372036854775807n
          )
            throw Error("Invalid MOVE MODSEQ");
          modseq = BigInt(atom(v[0]));
        } else throw Error("Unexpected MOVE FETCH field");
      }
      if (found === undefined) return false;
      if (found !== this.requested || !flags)
        throw Error("Wrong MOVE FETCH UID");
      this.row = { uid: found, flags, modseq };
    }
    if (r.tag === request.tag) {
      if (this.complete || r.command !== "OK")
        throw Error("Unsuccessful MOVE completion");
      this.complete = true;
    } else if (r.tag !== "*") throw Error("Uncorrelated MOVE completion");
  };
  finish() {
    if (this.rejected || !this.complete || !this.tag)
      throw Error("Incomplete MOVE evidence");
    return {
      epoch: this.epoch,
      writable: this.writable,
      mapping: this.mapping,
      row: this.row,
    };
  }
}

export async function prepareReceivingMove(input: {
  operation: ReceivingOperation;
  owner: ReceivingOwner;
  lifecycle: bigint | undefined;
  executor: Pick<ReceivingExecutor, "transaction">;
  assertCurrent(): void;
}) {
  const { operation, owner, executor } = input;
  if (
    !("account" in operation.identity) ||
    !("pendingId" in operation) ||
    !["move", "exact-lookup"].includes(operation.kind) ||
    input.lifecycle === undefined
  )
    throw Error("Invalid MOVE admission");
  const identity = operation.identity,
    intent = operation.pendingId,
    lookup = operation.kind === "exact-lookup";
  const options = () => ({
    deadline: Math.min(operation.deadline, performance.now() + 2000),
    signal: operation.signal,
  });
  const publication = new ReceivingBoundedPublication(executor);
  const rows = await executor.transaction(
    async (db) =>
      db.execute(sql`
    select c.*,b.id as scope_mailbox,b.remote_path as scope_path,s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after
    from message_commands c join mailboxes b on b.id in (c.mailbox_id,c.destination_mailbox_id)
    join receiving_mailboxes s on s.mailbox_id=b.id
    where c.id=${intent}::uuid and c.account_id=${identity.account}::uuid and c.mailbox_id=${identity.mailbox ?? null}::uuid
      and c.action in ('archive','trash') order by b.id`),
    options(),
  );
  if (rows.length !== 2)
    throw Error(
      "MOVE destination unavailable; owned destination SELECT required",
    );
  const row = rows[0];
  let authority: DataAuthority = {
    owner,
    account: identity.account,
    configuration: identity.configurationVersion,
    lifecycle: input.lifecycle,
    scopes: rows.map((r) => ({
      mailbox: String(r.scope_mailbox),
      path: String(r.scope_path),
      configuration: identity.configurationVersion,
      state: {
        epoch: BigInt(r.epoch as string),
        revision: BigInt(r.revision as string),
        freshThrough: BigInt(r.fresh_through as string),
        historyBefore: BigInt(r.history_before as string),
        reconcileAfter: BigInt(r.reconcile_after as string),
      },
    })),
  };
  const source = authority.scopes.find((s) => s.mailbox === row.mailbox_id)!,
    destination = authority.scopes.find(
      (s) => s.mailbox === row.destination_mailbox_id,
    )!;
  const sourceUid = BigInt(row.source_uid as string),
    sourceEpoch = BigInt(row.source_uid_validity as string);
  const previous = row.receiving_attempt as Record<string, unknown> | null;
  const attempt = lookup ? String(previous?.id) : randomUUID();
  if (!lookup && (previous || row.status !== "pending"))
    throw Error("MOVE cannot replay an attempted command");
  try {
    if (lookup)
      await executor.transaction(async (db) => {
        const scopes = JSON.stringify(
          authority.scopes.map(({ mailbox, path, state }) => ({
            mailbox,
            path,
            state,
          })),
          (_, v) => (typeof v === "bigint" ? String(v) : v),
        );
        await db.execute(
          sql`select maildock_receiving_move_resume(${owner.actor}::uuid,${owner.generation}::bigint,${identity.account}::uuid,${identity.configurationVersion}::bigint,${input.lifecycle}::bigint,${scopes}::jsonb,${intent}::uuid)`,
        );
      }, options());
    else await publication.claim(authority, "move", intent, options(), attempt);
  } catch (error) {
    if (!(error instanceof ReceivingUnresolvedError)) throw error;
  }
  const reload = async () => {
    const recovered = await publication.recover(
      authority,
      "move",
      intent,
      options(),
    );
    const marker = recovered.intent.receiving_attempt as Record<
      string,
      unknown
    >;
    if (
      !marker ||
      marker.id !== attempt ||
      marker.actor !== owner.actor ||
      marker.generation !== String(owner.generation) ||
      marker.uid !== String(sourceUid) ||
      marker.epoch !== String(sourceEpoch)
    )
      throw Error("MOVE claim acknowledgement unresolved");
    const scopes = recovered.scope.scopes as {
      mailbox: string;
      state: { revision: string };
    }[];
    authority = {
      ...authority,
      scopes: authority.scopes.map((s) => ({
        ...s,
        state: {
          ...s.state,
          revision: BigInt(
            scopes.find((r) => r.mailbox === s.mailbox)!.state.revision,
          ),
        },
      })),
    };
    return recovered.intent;
  };
  const prepared = await reload();
  const marker = prepared.receiving_attempt as Record<string, unknown>;
  if (
    marker.phase !== "claimed" ||
    (lookup &&
      Number(marker.observations) !== Number(previous?.observations ?? 0) + 1)
  )
    throw Error("MOVE preparation COMMIT unresolved");
  input.assertCurrent();
  const collector = new MoveCollector();
  let client: ImapFlow,
    mutated = false,
    settled = false,
    proof: MoveProof | undefined;
  const settle = async (work: () => Promise<void>, phase: string) => {
    try {
      await work();
      settled = true;
    } catch (error) {
      const recovered = await reload();
      if (
        (recovered.receiving_attempt as Record<string, unknown>).phase === phase
      ) {
        settled = true;
        return;
      }
      // Recovery observes a rollback at the original revisions before repeating SQL.
      // It must never rebase wire evidence over another publication.
      if (!(error instanceof ReceivingUnresolvedError)) throw error;
      throw Error("MOVE result remains unresolved", { cause: error });
    }
  };
  const fail = async () => {
    if (settled) return;
    const outcome =
      mutated || lookup
        ? "uncertain_remote_execution"
        : "failed_before_execution";
    await settle(
      () =>
        executor.transaction(async (db) => {
          const scopes = JSON.stringify(
            authority.scopes.map(({ mailbox, path, state }) => ({
              mailbox,
              path,
              state,
            })),
            (_, v) => (typeof v === "bigint" ? String(v) : v),
          );
          await db.execute(
            sql`select maildock_receiving_move_uncertain(${owner.actor}::uuid,${owner.generation}::bigint,${identity.account}::uuid,${identity.configurationVersion}::bigint,${input.lifecycle}::bigint,${scopes}::jsonb,${intent}::uuid,${attempt}::uuid,${outcome},${proof ? JSON.stringify(proof) : null}::jsonb)`,
          );
        }, options()),
      outcome,
    );
  };
  return {
    collector,
    bind(c: ImapFlow) {
      client = c;
    },
    fail,
    async revalidate() {
      await executor.transaction(async (db) => {
        const scopes = JSON.stringify(
          authority.scopes.map(({ mailbox, path, state }) => ({
            mailbox,
            path,
            state,
          })),
          (_, v) => (typeof v === "bigint" ? String(v) : v),
        );
        await db.execute(
          sql`select maildock_receiving_move_validate(${owner.actor}::uuid,${owner.generation}::bigint,${identity.account}::uuid,${identity.configurationVersion}::bigint,${input.lifecycle}::bigint,${scopes}::jsonb,${intent}::uuid,${attempt}::uuid)`,
        );
      }, options());
    },
    authorize(range: unknown, path: unknown, opts: unknown) {
      if (
        lookup ||
        mutated ||
        range !== String(sourceUid) ||
        path !== destination.path ||
        !opts ||
        (opts as { uid?: boolean }).uid !== true ||
        !client.capabilities.has("MOVE")
      )
        throw Error("MOVE differs from original claim or is unsupported");
      mutated = true;
    },
    async execute(
      _operation: ReceivingOperation,
      context: ReceivingOperationContext,
    ) {
      await context.client.connect();
      // R07 paths are absolute LIST identities. This single-use adapter must
      // not prepend its personal namespace to a shared/other frozen path.
      if (client.namespace)
        client.namespace = { ...client.namespace, prefix: "" };
      const select = async (path: string, epoch: bigint, write = false) => {
        collector.begin(write ? "SELECT" : "EXAMINE");
        const selected = await context.client.mailboxOpen(path, {
          readOnly: !write,
        });
        const evidence = collector.finish();
        if (
          selected.path !== path ||
          evidence.epoch !== epoch ||
          selected.uidValidity !== epoch ||
          (write && !evidence.writable)
        )
          throw Error("Frozen MOVE selected identity changed");
      };
      const fetch = async (id: bigint) => {
        collector.begin("UID FETCH", id);
        await context.client.fetchOne(
          String(id),
          { uid: true, flags: true },
          { uid: true },
        );
        return collector.finish().row;
      };
      await select(destination.path, destination.state.epoch);
      await select(source.path, sourceEpoch, !lookup);
      const original = await fetch(sourceUid);
      let destinationUid: bigint | null = null;
      if (!lookup) {
        if (!original) throw Error("Original MOVE UID unavailable");
        if (!client.capabilities.has("MOVE"))
          throw Error(
            "IMAP MOVE unsupported; unsafe COPY/delete fallback disabled",
          );
        collector.begin("UID MOVE", sourceUid);
        await context.client.messageMove(String(sourceUid), destination.path, {
          uid: true,
        });
        const mapping = collector.finish().mapping;
        if (mapping) {
          if (mapping.epoch !== destination.state.epoch)
            throw Error("COPYUID destination epoch changed");
          destinationUid = mapping.destination;
          proof = {
            epoch: String(mapping.epoch),
            uid: String(mapping.destination),
            sourceEpoch: String(sourceEpoch),
            sourceUid: String(sourceUid),
          };
        }
      } else {
        // Source absence and Message-ID matches alone cannot establish MOVE.
        const saved = marker.moveProof as MoveProof | undefined;
        if (
          !original &&
          saved &&
          saved.epoch === String(destination.state.epoch) &&
          saved.sourceEpoch === String(sourceEpoch) &&
          saved.sourceUid === String(sourceUid)
        )
          destinationUid = BigInt(saved.uid);
        else {
          await context.retireSocket();
          await fail();
          return;
        }
      }
      let target: { flags: string[]; modseq: bigint | null } = {
        flags: [],
        modseq: null,
      };
      if (destinationUid !== null) {
        await select(destination.path, destination.state.epoch);
        const found = await fetch(destinationUid);
        if (!found) throw Error("COPYUID target unavailable");
        target = { flags: found.flags, modseq: found.modseq };
      }
      await context.retireSocket();
      await settle(
        () =>
          publication.moveResult(
            authority,
            intent,
            attempt,
            {
              complete: true,
              taggedOk: true,
              accepted: true,
              sourceEpoch,
              sourceUid,
              destinationEpoch:
                destinationUid === null ? null : destination.state.epoch,
              destinationUid,
              sourceRemoved: true,
              ...target,
            },
            options(),
          ),
        destinationUid === null ? "awaiting_uid" : "succeeded",
      );
    },
  };
}
