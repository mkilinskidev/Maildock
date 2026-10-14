import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
  ReceivingOwner,
  ReceivingState,
} from "../../../shared/infrastructure/database/receiving-authority";
import {
  ReceivingUnresolvedError,
  type ReceivingExecutor,
} from "../../../shared/infrastructure/database/receiving-executor";

export type IntentKind = "command" | "content" | "attachment";
export type PublicationSource = Readonly<{
  mailbox: string;
  configuration: bigint;
  state: ReceivingState;
}>;
export type Attempt = Readonly<Record<string, string>>;
type Options = Parameters<ReceivingExecutor["transaction"]>[1];

const encode = (value: unknown) =>
  JSON.stringify(value, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );

/** Isolated SQL capability API. A successful claim is durable before wire work.
 * Unresolved outcomes require recover() before considering further execution.
 */
export class ReceivingPublication {
  constructor(private readonly executor: ReceivingExecutor) {}

  commandResult(
    owner: ReceivingOwner,
    source: PublicationSource,
    intent: string,
    attempt: string,
    evidence: Readonly<{
      complete: true;
      epoch: bigint;
      uid: bigint;
      flags: readonly string[];
      modseq: bigint | null;
    }>,
    options: Options,
  ) {
    const actor = owner.actor,
      term = owner.generation,
      mailbox = source.mailbox,
      binding = source.configuration,
      expected = encode(source.state),
      completed = encode(evidence);
    return this.executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_command_result(${actor}::uuid,${term}::bigint,${mailbox}::uuid,${expected}::jsonb,${binding}::bigint,${intent}::uuid,${attempt}::uuid,${completed}::jsonb)`,
      );
    }, options);
  }

  claim(
    owner: ReceivingOwner,
    source: PublicationSource,
    kind: IntentKind,
    intent: string,
    options: Options,
  ): Promise<Attempt> {
    const actor = owner.actor,
      term = owner.generation,
      mailbox = source.mailbox,
      binding = source.configuration,
      expected = encode(source.state),
      attempt = randomUUID();
    return this.executor.transaction(async (db) => {
      const [row] = await db.execute(
        sql`select maildock_receiving_attempt_claim(${actor}::uuid,${term}::bigint,${mailbox}::uuid,${expected}::jsonb,${binding}::bigint,${kind},${intent}::uuid,${attempt}::uuid) as attempt`,
      );
      return Object.freeze(row.attempt as Record<string, string>);
    }, options);
  }

  fail(
    owner: ReceivingOwner,
    source: PublicationSource,
    kind: IntentKind,
    intent: string,
    attempt: string,
    outcome:
      | "failed_before_execution"
      | "uncertain_remote_execution"
      | "failed_remote_read",
    options: Options,
  ) {
    const actor = owner.actor,
      term = owner.generation,
      mailbox = source.mailbox,
      binding = source.configuration,
      expected = encode(source.state);
    return this.executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_attempt_failure(${actor}::uuid,${term}::bigint,${mailbox}::uuid,${expected}::jsonb,${binding}::bigint,${kind},${intent}::uuid,${attempt}::uuid,${outcome})`,
      );
    }, options);
  }

  async recover(
    owner: ReceivingOwner,
    source: PublicationSource,
    kind: IntentKind,
    intent: string,
    options: Options,
  ): Promise<{ state: ReceivingState; intent: Record<string, unknown> }> {
    const actor = owner.actor,
      term = owner.generation,
      mailbox = source.mailbox;
    try {
      return await this.executor.transaction(async (db) => {
        const [row] = await db.execute(
          sql`select maildock_receiving_attempt_recover(${actor}::uuid,${term}::bigint,${mailbox}::uuid,${kind},${intent}::uuid) as recovery`,
        );
        const value = row.recovery as {
          state: Record<string, string>;
          intent: Record<string, unknown>;
        };
        return {
          state: {
            epoch: BigInt(value.state.epoch),
            revision: BigInt(value.state.revision),
            freshThrough: BigInt(value.state.fresh_through),
            historyBefore: BigInt(value.state.history_before),
            reconcileAfter: BigInt(value.state.reconcile_after),
          },
          intent: value.intent,
        };
      }, options);
    } catch (cause) {
      throw new ReceivingUnresolvedError("transaction", { cause });
    }
  }
}
