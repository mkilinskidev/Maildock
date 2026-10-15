import { randomUUID } from "node:crypto";
import {
  TopologyCollector,
  TopologyError,
} from "../../accounts/infrastructure/imap-topology";
import {
  ReceivingBoundedPublication,
  type TopologyEntry,
  type TopologySnapshot,
} from "./receiving-bounded-publication";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import type {
  ReceivingOperation,
  ReceivingOperationContext,
} from "./receiving-operation";
import type {
  ReceivingOwner,
  ReceivingState,
} from "../../../shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "./receiving-persistence";
import { ReceivingUnresolvedError } from "../../../shared/infrastructure/database/receiving-executor";
import { roleSpecialUse, type SystemMailboxRole } from "./mailbox-role-service";

/** Trusted, opt-in composition registry. Production registration belongs to R16. */
export const receivingTopologyHandlers = Object.freeze({
  list: Object.freeze({ topology: "list" as const }),
  select: Object.freeze({ topology: "select" as const }),
});
type Row = Record<string, unknown>;
const rows = (s: TopologySnapshot, key: string) => s[key] as Row[];
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function enrollmentState(row: Row): ReceivingState {
  return {
    epoch: BigInt(String(row.epoch)),
    revision: BigInt(String(row.revision)),
    freshThrough: BigInt(String(row.fresh_through)),
    historyBefore: BigInt(String(row.history_before)),
    reconcileAfter: BigInt(String(row.reconcile_after)),
  };
}
function destination(
  snapshot: TopologySnapshot,
  operation: ReceivingOperation,
) {
  if (
    !("account" in operation.identity) ||
    operation.kind !== "select" ||
    !operation.identity.mailbox
  )
    throw new TopologyError(
      "Destination SELECT requires an exact account/mailbox identity",
    );
  const folder = rows(snapshot, "mailboxes").find(
    (m) => m.id === (operation.identity as { mailbox: string }).mailbox,
  );
  if (!folder || !folder.selectable || folder.lifecycle_status !== "active")
    throw new TopologyError("Mapped destination is missing or nonselectable");
  if (operation.role) {
    const mapping = rows(snapshot, "roles").find(
      (m) => m.role === operation.role,
    );
    if (!mapping || mapping.mailbox_id !== folder.id)
      throw new TopologyError("Destination role mapping changed");
    if (mapping.source !== "manual") {
      const candidates = rows(snapshot, "mailboxes").filter(
        (m) =>
          m.selectable &&
          m.lifecycle_status === "active" &&
          (m.special_use as string[]).includes(roleSpecialUse[operation.role!]),
      );
      if (
        mapping.source !== "special_use" ||
        candidates.length !== 1 ||
        candidates[0]?.id !== folder.id
      )
        throw new TopologyError("Destination role is ambiguous");
    }
  }
  return folder;
}
function assignIdentities(
  snapshot: TopologySnapshot,
  observations: Omit<TopologyEntry, "id">[],
): TopologyEntry[] {
  const local = rows(snapshot, "mailboxes"),
    used = new Set<string>();
  const entries = observations.map((entry) => {
    if (
      !entry.providerMailboxId &&
      local.some(
        (m) => m.remote_path === entry.path && m.provider_mailbox_id !== null,
      )
    )
      throw new TopologyError(
        "LIST omitted a previously known stable mailbox identity",
      );
    const canonical =
      entry.path === "INBOX"
        ? local.filter((m) => String(m.remote_path).toUpperCase() === "INBOX")
        : [];
    const stable = entry.providerMailboxId
      ? local.filter((m) => m.provider_mailbox_id === entry.providerMailboxId)
      : [];
    const byPath = local.filter(
      (m) =>
        m.remote_path === entry.path &&
        m.lifecycle_status === "active" &&
        m.provider_mailbox_id === null,
    );
    if (canonical.length > 1 || stable.length > 1 || byPath.length > 1)
      throw new TopologyError("Ambiguous captured mailbox identity");
    // Existing provider identity must never be dropped or transferred to another
    // mailbox. INBOX replacement needs explicit epoch/lifecycle reconciliation.
    const match = canonical[0] ?? stable[0] ?? byPath[0];
    if (
      match &&
      ((match.provider_mailbox_id !== null &&
        match.provider_mailbox_id !== entry.providerMailboxId) ||
        (canonical[0] && stable[0] && canonical[0].id !== stable[0].id))
    )
      throw new TopologyError("Canonical or stable mailbox identity conflicts");
    const id = match ? String(match.id) : randomUUID();
    if (used.has(id))
      throw new TopologyError("Multiple observed paths resolve to one mailbox");
    used.add(id);
    return { ...entry, id };
  });
  if (new Set([...local.map((m) => String(m.id)), ...used]).size > 128)
    throw new TopologyError(
      "Topology union exceeds 128 identities; retained missing folders count toward the limit",
    );
  return entries;
}

export async function prepareReceivingTopology(input: {
  operation: ReceivingOperation;
  owner: ReceivingOwner;
  executor: Pick<ReceivingExecutor, "transaction">;
  lifecycle: bigint | undefined;
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  const { operation, owner, executor, signal } = input;
  if (
    !("account" in operation.identity) ||
    !["list", "select"].includes(operation.kind)
  )
    throw new TopologyError("Topology requires persisted account admission");
  const identity = operation.identity;
  const options = () => ({
    deadline: Math.min(operation.deadline, performance.now() + 2000),
    signal,
  });
  const publication = new ReceivingBoundedPublication(executor);
  const snapshot = await publication.captureTopology(
    owner,
    identity.account,
    options(),
  );
  input.assertCurrent();
  if (
    snapshot.configuration !== String(identity.configurationVersion) ||
    snapshot.lifecycle !== String(input.lifecycle)
  )
    throw new TopologyError(
      "Topology admission configuration/lifecycle changed",
    );
  const folder =
    operation.kind === "select" ? destination(snapshot, operation) : undefined;
  const collector = new TopologyCollector();
  const requestId = randomUUID();
  // Only recovery receives this port after an unresolved write; it has no write
  // callback and acquires the same R04 conflicting locks. No evidence is resent.
  const recover = () =>
    publication.captureTopology(owner, identity.account, options());
  const execute = async (
    _operation: ReceivingOperation,
    context: ReceivingOperationContext,
  ) => {
    await context.client.connect();
    input.assertCurrent();
    if (operation.kind === "list") {
      await context.client.list();
      input.assertCurrent();
      const entries = assignIdentities(snapshot, collector.finish());
      const evidence = {
        complete: true as const,
        taggedOk: true as const,
        namespace: "*" as const,
        subscribedOnly: false as const,
        requestId,
        completedRequestId: requestId,
        entries,
      };
      await context.retireSocket();
      const retired = new ReceivingBoundedPublication({
        transaction: (work) => context.transaction(work),
      });
      try {
        await retired.topologyResult(
          owner,
          identity.account,
          snapshot,
          evidence,
          options(),
        );
      } catch (error) {
        if (!(error instanceof ReceivingUnresolvedError)) throw error;
        const current = await recover();
        // Locked recovery never interprets an unchanged/competing snapshot as
        // authorization to replay. Equivalent complete effects prove settlement.
        if (!topologyApplied(snapshot, current, entries)) throw error;
      }
      return;
    }
    const selected = await context.client.selectIdentity(
      String(folder!.remote_path),
    );
    input.assertCurrent();
    const evidence = collector.selectedIdentity();
    if (
      !selected ||
      selected.path !== folder!.remote_path ||
      selected.epoch !== evidence.epoch ||
      BigInt(selected.uidNext) !== evidence.uidNext ||
      selected.exists > Number(evidence.uidNext - 1n) ||
      (folder!.provider_mailbox_id !== null &&
        folder!.provider_mailbox_id !== evidence.providerId)
    )
      throw new TopologyError(
        "Selected destination differs from captured identity",
      );
    await context.retireSocket();
    const stateRow = rows(snapshot, "states").find(
      (s) => s.mailbox_id === folder!.id,
    );
    const replacing =
      stateRow &&
      (BigInt(String(stateRow.epoch)) !== evidence.epoch ||
        stateRow.configuration_binding !==
          String(identity.configurationVersion));
    if (
      stateRow &&
      !replacing &&
      (evidence.uidNext <= BigInt(String(stateRow.fresh_through)) ||
        evidence.uidNext < BigInt(String(stateRow.history_before)))
    )
      throw new TopologyError(
        "Selected destination UIDNEXT regressed below committed coverage",
      );
    const capturedIdentity = {
      account: identity.account,
      configuration: identity.configurationVersion,
      lifecycle: BigInt(String(snapshot.lifecycle)),
    };
    const fencedExecutor: Pick<ReceivingExecutor, "transaction"> = {
      transaction: (work) =>
        context.transaction(async (db) => {
          const current = await new ReceivingBoundedPublication({
            transaction: (capture) => capture(db),
          }).captureTopology(owner, identity.account, options());
          if (!equal(current, snapshot))
            throw new TopologyError(
              "Destination topology or role changed during SELECT",
            );
          return work(db);
        }),
    };
    const persistence = new ReceivingPersistence(fencedExecutor);
    const mailbox = String(folder!.id);
    try {
      if (!stateRow)
        await persistence.initialize(
          owner,
          mailbox,
          evidence,
          options(),
          capturedIdentity,
        );
      else if (replacing)
        await persistence.persist(
          owner,
          mailbox,
          enrollmentState(stateRow),
          { kind: "epoch", ...evidence, rebind: true },
          options(),
          capturedIdentity,
        );
      else await fencedExecutor.transaction(async () => undefined, options());
    } catch (error) {
      if (!(error instanceof ReceivingUnresolvedError)) throw error;
      const current = await recover();
      const state = rows(current, "states").find(
        (s) => s.mailbox_id === mailbox,
      );
      const expectedState =
        !stateRow || replacing
          ? {
              mailbox_id: mailbox,
              epoch: String(evidence.epoch),
              revision: stateRow
                ? String(BigInt(String(stateRow.revision)) + 1n)
                : "0",
              fresh_through: String(evidence.uidNext - 1n),
              history_before: String(evidence.uidNext),
              reconcile_after: "0",
              configuration_binding: String(identity.configurationVersion),
            }
          : stateRow;
      const currentFolder = rows(current, "mailboxes").find(
        (m) => m.id === mailbox,
      );
      if (
        !state ||
        Object.entries(expectedState).some(
          ([key, value]) => state[key] !== value,
        ) ||
        !equal(current.roles, snapshot.roles) ||
        current.configuration !== snapshot.configuration ||
        current.lifecycle !== snapshot.lifecycle ||
        !currentFolder ||
        !currentFolder.selectable ||
        currentFolder.lifecycle_status !== "active" ||
        currentFolder.remote_path !== folder!.remote_path ||
        currentFolder.provider_mailbox_id !== folder!.provider_mailbox_id
      )
        throw error;
    }
  };
  return { collector, execute };
}

function topologyApplied(
  before: TopologySnapshot,
  after: TopologySnapshot,
  entries: TopologyEntry[],
) {
  if (
    before.configuration !== after.configuration ||
    before.lifecycle !== after.lifecycle ||
    rows(after, "mailboxes").length !==
      new Set([
        ...rows(before, "mailboxes").map((m) => m.id),
        ...entries.map((e) => e.id),
      ]).size
  )
    return false;
  for (const m of rows(after, "mailboxes")) {
    const old = rows(before, "mailboxes").find((row) => row.id === m.id);
    const e = entries.find((entry) => entry.id === m.id);
    if (old && old.updated_at === m.updated_at) return false;
    if (!e) {
      if (m.lifecycle_status !== "missing") return false;
      continue;
    }
    if (
      m.remote_path !== e.path ||
      m.name !== e.name ||
      m.delimiter !== e.delimiter ||
      m.selectable !== e.selectable ||
      m.subscribed !== e.subscribed ||
      m.provider_mailbox_id !== e.providerMailboxId ||
      m.lifecycle_status !== "active" ||
      !equal(m.attributes, e.attributes) ||
      !equal(m.special_use, e.specialUse)
    )
      return false;
  }
  if (rows(before, "states").length !== rows(after, "states").length)
    return false;
  for (const state of rows(before, "states")) {
    const current = rows(after, "states").find(
      (s) => s.mailbox_id === state.mailbox_id,
    );
    if (
      !current ||
      !equal(
        { ...state, revision: String(BigInt(String(state.revision)) + 1n) },
        current,
      )
    )
      return false;
  }
  // Manual edits after a lost reply remain unresolved, never overwritten.
  for (const role of rows(before, "roles").filter((r) => r.source === "manual"))
    if (
      !equal(
        role,
        rows(after, "roles").find((r) => r.role === role.role),
      )
    )
      return false;
  for (const [role, specialUse] of Object.entries(roleSpecialUse)) {
    const old = rows(before, "roles").find((r) => r.role === role);
    const current = rows(after, "roles").find((r) => r.role === role);
    if (old?.source === "manual") continue;
    const candidates = entries.filter(
      (e) => e.selectable && e.specialUse.includes(specialUse),
    );
    if (
      candidates.length === 1
        ? current?.source !== "special_use" ||
          current.mailbox_id !== candidates[0].id
        : current !== undefined
    )
      return false;
  }
  if (rows(after, "roles").some((r) => !(String(r.role) in roleSpecialUse)))
    return false;
  return true;
}

export type DestinationRole = SystemMailboxRole;
