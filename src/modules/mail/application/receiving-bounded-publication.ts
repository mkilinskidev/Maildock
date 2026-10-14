import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ReceivingOwner } from "../../../shared/infrastructure/database/receiving-authority";
import {
  ReceivingUnresolvedError,
  type ReceivingExecutor,
  type ReceivingDatabase,
} from "../../../shared/infrastructure/database/receiving-executor";
import type { PublicationSource } from "./receiving-publication";

type Options = Parameters<ReceivingExecutor["transaction"]>[1];
export type DataAuthority = Readonly<{
  owner: ReceivingOwner;
  account: string;
  configuration: bigint;
  lifecycle: bigint;
  scopes: readonly (PublicationSource & Readonly<{ path: string }>)[];
}>;
export type TopologySnapshot = Readonly<Record<string, unknown>>;
export type TopologyEntry = Readonly<{
  id: string;
  path: string;
  name: string;
  delimiter: string | null;
  attributes: readonly string[];
  specialUse: readonly string[];
  selectable: boolean;
  subscribed: boolean | null;
  providerMailboxId: string | null;
}>;
export type TopologyEvidence = Readonly<{
  complete: true;
  taggedOk: true;
  namespace: "*";
  subscribedOnly: false;
  requestId: string;
  completedRequestId: string;
  entries: readonly TopologyEntry[];
}>;
const encode = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** SQL authority only; admitted remote operation bodies remain later-stage work. */
export class ReceivingBoundedPublication {
  constructor(
    private readonly executor: Pick<ReceivingExecutor, "transaction">,
  ) {}
  private transaction<T>(
    work: (db: ReceivingDatabase) => Promise<T>,
    options: Options,
  ) {
    return this.executor.transaction(work, {
      ...options,
      deadline: Math.min(options.deadline, performance.now() + 2000),
    });
  }
  private capture(a: DataAuthority) {
    if (
      a.scopes.length < 1 ||
      a.scopes.length > 2 ||
      a.scopes.some((s) => s.configuration !== a.configuration)
    )
      throw Error("Invalid data publication scopes");
    return {
      actor: a.owner.actor,
      term: a.owner.generation,
      account: a.account,
      binding: a.configuration,
      lifecycle: a.lifecycle,
      scopes: encode(
        a.scopes.map((s) => ({
          mailbox: s.mailbox,
          path: s.path,
          state: s.state,
        })),
      ),
    };
  }
  claim(
    a: DataAuthority,
    operation: "move" | "append",
    intent: string,
    options: Options,
    attempt = randomUUID(),
  ) {
    const c = this.capture(a);
    return this.transaction(async (db) => {
      const [row] =
        operation === "move"
          ? await db.execute(
              sql`select maildock_receiving_move_claim(${c.actor}::uuid,${c.term}::bigint,${c.account}::uuid,${c.binding}::bigint,${c.lifecycle}::bigint,${c.scopes}::jsonb,${intent}::uuid,${attempt}::uuid) attempt`,
            )
          : await db.execute(
              sql`select maildock_receiving_append_claim(${c.actor}::uuid,${c.term}::bigint,${c.account}::uuid,${c.binding}::bigint,${c.lifecycle}::bigint,${c.scopes}::jsonb,${intent}::uuid,${attempt}::uuid) attempt`,
            );
      return Object.freeze(row.attempt as Record<string, unknown>);
    }, options);
  }
  moveResult(
    a: DataAuthority,
    intent: string,
    attempt: string,
    evidence: Readonly<{
      complete: true;
      taggedOk: true;
      sourceEpoch: bigint;
      sourceUid: bigint;
      destinationEpoch: bigint | null;
      destinationUid: bigint | null;
      sourceRemoved: boolean;
      flags: readonly string[];
      modseq: bigint | null;
    }>,
    options: Options,
  ) {
    const c = this.capture(a),
      completed = encode(evidence);
    return this.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_move_result(${c.actor}::uuid,${c.term}::bigint,${c.account}::uuid,${c.binding}::bigint,${c.lifecycle}::bigint,${c.scopes}::jsonb,${intent}::uuid,${attempt}::uuid,${completed}::jsonb)`,
      );
    }, options);
  }
  appendResult(
    a: DataAuthority,
    intent: string,
    attempt: string,
    evidence: Readonly<{
      kind: "append" | "lookup";
      complete: true;
      taggedOk: true;
      destinationEpoch: bigint | null;
      destinationUid: bigint | null;
      message: string | null;
      flags: readonly string[];
      modseq: bigint | null;
    }>,
    options: Options,
  ) {
    const c = this.capture(a),
      completed = encode(evidence);
    return this.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_append_result(${c.actor}::uuid,${c.term}::bigint,${c.account}::uuid,${c.binding}::bigint,${c.lifecycle}::bigint,${c.scopes}::jsonb,${intent}::uuid,${attempt}::uuid,${completed}::jsonb)`,
      );
    }, options);
  }
  async recover(
    a: DataAuthority,
    operation: "move" | "append",
    intent: string,
    options: Options,
  ) {
    const c = this.capture(a);
    try {
      return await this.transaction(async (db) => {
        const [row] = await db.execute(
          sql`select maildock_receiving_data_recover(${c.actor}::uuid,${c.term}::bigint,${c.account}::uuid,${c.binding}::bigint,${c.lifecycle}::bigint,${c.scopes}::jsonb,${operation},${intent}::uuid) recovery`,
        );
        return row.recovery as {
          scope: Record<string, unknown>;
          intent: Record<string, unknown>;
        };
      }, options);
    } catch (cause) {
      throw new ReceivingUnresolvedError("transaction", { cause });
    }
  }
  fail(
    a: DataAuthority,
    operation: "move" | "append",
    intent: string,
    attempt: string,
    outcome: "failed_before_execution" | "uncertain_remote_execution",
    options: Options,
  ) {
    const c = this.capture(a);
    return this.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_data_failure(${c.actor}::uuid,${c.term}::bigint,${c.account}::uuid,${c.binding}::bigint,${c.lifecycle}::bigint,${c.scopes}::jsonb,${operation},${intent}::uuid,${attempt}::uuid,${outcome})`,
      );
    }, options);
  }
  captureTopology(
    owner: ReceivingOwner,
    account: string,
    options: Options,
  ): Promise<TopologySnapshot> {
    const actor = owner.actor,
      term = owner.generation;
    return this.transaction(async (db) => {
      const [row] = await db.execute(
        sql`select maildock_receiving_topology_capture(${actor}::uuid,${term}::bigint,${account}::uuid) snapshot`,
      );
      return Object.freeze(row.snapshot as Record<string, unknown>);
    }, options);
  }
  async topologyResult(
    owner: ReceivingOwner,
    account: string,
    snapshot: TopologySnapshot,
    evidence: TopologyEvidence,
    options: Options,
  ) {
    const actor = owner.actor,
      term = owner.generation,
      expected = encode(snapshot),
      completed = encode(evidence);
    if (
      Buffer.byteLength(completed, "utf8") > 2 * 1024 * 1024 ||
      evidence.complete !== true ||
      evidence.taggedOk !== true ||
      evidence.namespace !== "*" ||
      evidence.subscribedOnly !== false ||
      !Array.isArray(evidence.entries) ||
      evidence.entries.length > 128
    ) {
      throw Error("Invalid bounded complete topology evidence");
    }
    return this.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_topology_result(${actor}::uuid,${term}::bigint,${account}::uuid,${expected}::jsonb,${completed}::jsonb)`,
      );
    }, options);
  }
  /** Authenticated account lifecycle composition only; works with workers stopped. */
  removeAccount(
    account: string,
    configuration: bigint,
    lifecycle: bigint,
    options: Options,
  ) {
    return this.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_terminal_remove(${account}::uuid,${configuration}::bigint,${lifecycle}::bigint)`,
      );
    }, options);
  }
  async recoverRemoval(
    account: string,
    configuration: bigint,
    lifecycle: bigint,
    options: Options,
  ) {
    try {
      return await this.transaction(async (db) => {
        const [row] = await db.execute(
          sql`select maildock_receiving_terminal_recover(${account}::uuid,${configuration}::bigint,${lifecycle}::bigint) removed`,
        );
        return row.removed === true;
      }, options);
    } catch (cause) {
      throw new ReceivingUnresolvedError("transaction", { cause });
    }
  }
}
