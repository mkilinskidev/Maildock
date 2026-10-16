import { sql } from "drizzle-orm";
import { prepareReceivingMove } from "./receiving-move";
import { prepareReceivingAttachment } from "./receiving-attachment";
import { prepareReceivingSentCopy } from "./receiving-sent-copy";
import type { BlobStorage } from "../../../shared/application/blob-storage";
import {
  RECEIVING_ATTACHMENT_BYTES,
  RECEIVING_ATTACHMENT_ENCODED_BYTES,
  RECEIVING_ATTACHMENT_LIFETIME_MS,
} from "../domain/receiving-attachment-limits";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type {
  ProviderConnection,
  ConnectionFailureCategory,
} from "../../accounts/domain/mail-provider";
import { imapOptions } from "../../accounts/infrastructure/imap-smtp-mail-provider";
import { DEFAULT_ATTACHMENT_LIMITS } from "../../../shared/application/attachment-limits";
import type {
  ReceivingDatabase,
  ReceivingExecutor,
} from "../../../shared/infrastructure/database/receiving-executor";
import type { ReceivingOwner } from "../../../shared/infrastructure/database/receiving-authority";
import { randomUUID } from "node:crypto";
import { prepareReceivingFlags } from "./receiving-flags";
import { prepareReceivingContent } from "./receiving-content";
import {
  DISPLAY_CONTENT_BYTES,
  CONTENT_PROTOCOL_BYTES,
  DisplayContentLimitError,
} from "../domain/display-content-limits";
import {
  listOwnedTopology,
  selectOwnedDestination,
  type SelectedDestination,
  TOPOLOGY_LIMITS,
} from "../../accounts/infrastructure/imap-topology";
import {
  prepareReceivingTopology,
  type DestinationRole,
} from "./receiving-topology";
import { ReceivingUnresolvedError } from "../../../shared/infrastructure/database/receiving-executor";
import {
  ReceivingPublication,
  type Attempt,
  type IntentKind,
  type PublicationSource,
} from "./receiving-publication";

export type ReceivingOperationPhase =
  | "ADMITTED"
  | "PRE_NETWORK_CLAIM"
  | "CLAIM_SETTLED"
  | "NETWORK"
  | "RETIRING"
  | "NETWORK_RETIRED"
  | "RESULT_PUBLICATION"
  | "SETTLED";
export type ReceivingClaim = Readonly<{
  attempt: Attempt;
  source: PublicationSource;
  kind: IntentKind;
  intent: string;
}>;
export type ReceivingPreNetworkContext = Readonly<{
  signal: AbortSignal;
  deadline: number;
  claim: (source: PublicationSource) => Promise<ReceivingClaim>;
  recover: (
    source: PublicationSource,
  ) => ReturnType<ReceivingPublication["recover"]>;
  /** Read-only reconciliation retains the original attempt; never authorizes STORE. */
  resume: (source: PublicationSource) => Promise<ReceivingClaim>;
}>;

export type ReceivingOperationKind =
  | "repair"
  | "bootstrap"
  | "list"
  | "select"
  | "store"
  | "move"
  | "content-slice"
  | "attachment-slice"
  | "append"
  | "exact-lookup"
  | "diagnostic";
export function receivingOperationClass(
  kind: ReceivingOperationKind,
): "maintenance" | "user" {
  return ["repair", "bootstrap", "list", "select"].includes(kind)
    ? "maintenance"
    : "user";
}
export type ReceivingIdentity =
  | Readonly<{
      account: string;
      configurationVersion: bigint;
      receivingLifecycleVersion?: bigint;
      mailbox?: string;
    }>
  | Readonly<{ ephemeral: string }>;
type Unit =
  | Readonly<{
      kind: "bootstrap" | "list" | "diagnostic";
    }>
  | Readonly<{ kind: "repair" }>
  | Readonly<{
      kind: "repair";
      pendingId: string;
      repairKind: "command" | "content" | "attachment" | "sent";
    }>
  | Readonly<{ kind: "select"; role?: DestinationRole }>
  | Readonly<{
      kind: "store" | "move" | "exact-lookup";
      pendingId: string;
      lookup?: "sent-copy" | "move";
    }>
  | Readonly<{
      kind: "content-slice" | "attachment-slice";
      pendingId: string;
      offset: number;
      maxBytes: number;
    }>
  | Readonly<{ kind: "append"; pendingId: string; mimeBytes: number }>;
/** A bounded unit, never a callback or a durable payload. Slice continuation is
 * a new admission after validated settlement, sourced from the R02 pending row. */
export type ReceivingOperation = Readonly<{
  requestId: string;
  identity: ReceivingIdentity;
  deadline: number;
  signal?: AbortSignal;
  /** Only diagnostic overrides may carry credentials; memory only, no wakes. */
  diagnosticConnection?: ProviderConnection;
}> &
  Unit;
/** R09 authenticates the HTTP caller and converts its bounded wire lifetime to
 * this process's monotonic deadline. A delayed request is bound to one term. */
export type ReceivingDiagnosticRequest = Readonly<{
  requestId: string;
  expectedOwner: ReceivingOwner;
  identity: ReceivingIdentity;
  deadline: number;
  signal?: AbortSignal;
  connection?: ProviderConnection;
}>;
/** Sanitized result contract for the later diagnostic executor; no arbitrary
 * server messages or credential-bearing values cross the RPC response boundary. */
export type ReceivingDiagnosticResult =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; category: ConnectionFailureCategory }>;
export type ReceivingOperationResult = ReceivingDiagnosticResult | void;
export type OwnedReceivingClient = Pick<
  ImapFlow,
  | "connect"
  | "list"
  | "getMailboxLock"
  | "mailboxOpen"
  | "search"
  | "fetch"
  | "fetchOne"
  | "download"
  | "append"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "messageFlagsSet"
  | "messageMove"
  | "noop"
> &
  Readonly<{ selectIdentity: (path: string) => Promise<SelectedDestination> }>;
export type ReceivingOperationContext = Readonly<{
  phase: ReceivingOperationPhase;
  claim: ReceivingClaim | null;
  owner: ReceivingOwner;
  receivingLifecycleVersion?: bigint;
  signal: AbortSignal;
  deadline: number;
  assertCurrent: () => void;
  /** Exactly one client, guarded against late calls and reconnect. */
  client: OwnedReceivingClient;
  retireSocket: () => Promise<void>;
  /** SQL is prohibited until the socket has retired. R04 supplies publication. */
  transaction: <T>(work: (db: ReceivingDatabase) => Promise<T>) => Promise<T>;
  publication: Readonly<{
    attachmentResult: (
      evidence: Parameters<ReceivingPublication["attachmentResult"]>[4],
    ) => Promise<void>;
    contentResult: (
      evidence: Parameters<ReceivingPublication["contentResult"]>[4],
    ) => Promise<void>;
    commandResult: (
      evidence: Parameters<ReceivingPublication["commandResult"]>[4],
    ) => Promise<void>;
    fail: (
      outcome: Parameters<ReceivingPublication["fail"]>[5],
    ) => Promise<void>;
    flagConflict: () => Promise<void>;
  }>;
}>;
/** Trusted composition registry, not supplied by submitters. No operation bodies
 * are registered by R03; isolated fixtures may inject deterministic executors. */
type ReceivingOperationBody = (
  operation: ReceivingOperation,
  context: ReceivingOperationContext,
) => Promise<ReceivingOperationResult>;
export type ReceivingOperationHandler =
  | ReceivingOperationBody
  | Readonly<{ repair: true }>
  | Readonly<{ topology: "list" | "select" }>
  | Readonly<{ flags: true; move?: true }>
  | Readonly<{ move: true; flags?: true; sentCopy?: BlobStorage }>
  | Readonly<{ content: true }>
  | Readonly<{ attachment: BlobStorage }>
  | Readonly<{ sentCopy: BlobStorage; flags?: true; move?: true }>
  | Readonly<{
      /** Trusted composition only. This phase has no client or arbitrary SQL port. */
      preNetwork: (
        operation: ReceivingOperation,
        context: ReceivingPreNetworkContext,
      ) => Promise<void>;
      execute: ReceivingOperationBody;
    }>;
export type ReceivingOperationHandlers = Partial<
  Record<ReceivingOperationKind, ReceivingOperationHandler>
>;
export type ReceivingOperationBoundary = Readonly<{
  owner: ReceivingOwner;
  executor: ReceivingExecutor;
  assertCurrent: () => void;
  validate: (operation: ReceivingOperation) => Promise<
    ProviderConnection & {
      receivingLifecycleVersion?: bigint;
    }
  >;
  createClient?: (options: ImapFlowOptions) => ImapFlow;
}>;

export function validateReceivingOperation(operation: ReceivingOperation) {
  if (
    operation.kind === "select" &&
    operation.role !== undefined &&
    !["sent", "trash", "archive", "drafts", "junk"].includes(operation.role)
  )
    throw new Error("Invalid selected destination role");
  if (
    ![
      "repair",
      "bootstrap",
      "list",
      "select",
      "store",
      "move",
      "content-slice",
      "attachment-slice",
      "append",
      "exact-lookup",
      "diagnostic",
    ].includes(operation.kind)
  )
    throw new Error("Unknown receiving operation kind");
  if (
    [
      "store",
      "move",
      "content-slice",
      "attachment-slice",
      "append",
      "exact-lookup",
    ].includes(operation.kind) &&
    !("pendingId" in operation)
  )
    throw new Error("Receiving operation requires existing pending identity");
  if (
    Buffer.byteLength(
      JSON.stringify(operation, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ) >
    20 * 1024
  )
    throw new Error("Receiving envelope exceeds memory budget");
  if ("pendingId" in operation && !/^[0-9a-f-]{36}$/i.test(operation.pendingId))
    throw new Error("Invalid receiving pending identity");
  if (
    !/^[a-zA-Z0-9-]{1,64}$/.test(operation.requestId) ||
    !Number.isFinite(operation.deadline) ||
    operation.deadline <= performance.now() ||
    operation.deadline >
      performance.now() +
        (operation.kind === "attachment-slice"
          ? RECEIVING_ATTACHMENT_LIFETIME_MS
          : 10_000)
  )
    throw new Error("Invalid receiving operation envelope");
  const identity = operation.identity;
  if ("ephemeral" in identity) {
    if (
      operation.kind !== "diagnostic" ||
      !operation.diagnosticConnection ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(identity.ephemeral)
    )
      throw new Error("Invalid ephemeral diagnostic identity");
  } else if (
    !/^[0-9a-f-]{36}$/i.test(identity.account) ||
    typeof identity.configurationVersion !== "bigint" ||
    identity.configurationVersion < 1n
  )
    throw new Error("Invalid receiving account identity");
  if (
    "account" in identity &&
    identity.mailbox &&
    !/^[0-9a-f-]{36}$/i.test(identity.mailbox)
  )
    throw new Error("Invalid receiving mailbox identity");
  if (operation.diagnosticConnection && operation.kind !== "diagnostic")
    throw new Error("Credentials are restricted to diagnostic admission");
  if (
    operation.kind === "content-slice" ||
    operation.kind === "attachment-slice"
  ) {
    if (
      !Number.isSafeInteger(operation.offset) ||
      operation.offset < 0 ||
      !Number.isSafeInteger(operation.maxBytes) ||
      operation.maxBytes < 1 ||
      operation.maxBytes >
        (operation.kind === "content-slice"
          ? DISPLAY_CONTENT_BYTES
          : RECEIVING_ATTACHMENT_BYTES)
    )
      throw new Error("Receiving slice exceeds unit budget");
  }
  if (
    operation.kind === "append" &&
    (!Number.isSafeInteger(operation.mimeBytes) ||
      operation.mimeBytes < 1 ||
      operation.mimeBytes > DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes)
  )
    throw new Error("Receiving APPEND exceeds MIME policy");
  if (
    operation.diagnosticConnection &&
    Buffer.byteLength(JSON.stringify(operation.diagnosticConnection)) >
      16 * 1024
  )
    throw new Error("Diagnostic credentials exceed envelope budget");
}

export async function runReceivingOperation(
  operation: ReceivingOperation,
  boundary: ReceivingOperationBoundary,
  handler: NonNullable<ReceivingOperationHandlers[ReceivingOperationKind]>,
  lifetime: AbortSignal,
) {
  const moveOperation =
    typeof handler !== "function" &&
    "move" in handler &&
    (operation.kind === "move" ||
      (operation.kind === "exact-lookup" && operation.lookup === "move"));
  let move: Awaited<ReturnType<typeof prepareReceivingMove>> | undefined;
  const sentStorage =
    typeof handler !== "function" &&
    "sentCopy" in handler &&
    (operation.kind === "append" ||
      (operation.kind === "exact-lookup" &&
        (operation.lookup === "sent-copy" ||
          (!("flags" in handler) && !moveOperation))))
      ? handler.sentCopy
      : undefined;
  const flagOperation =
    !moveOperation &&
    !sentStorage &&
    typeof handler !== "function" &&
    "flags" in handler;
  let sent: Awaited<ReturnType<typeof prepareReceivingSentCopy>> | undefined;
  const contentOperation =
    typeof handler !== "function" && "content" in handler;
  const attachmentOperation =
    typeof handler !== "function" && "attachment" in handler;
  const attachmentStorage =
    typeof handler !== "function" && "attachment" in handler
      ? handler.attachment
      : undefined;
  let attachment:
    Awaited<ReturnType<typeof prepareReceivingAttachment>> | undefined;
  let content: Awaited<ReturnType<typeof prepareReceivingContent>> | undefined;
  let flags: Awaited<ReturnType<typeof prepareReceivingFlags>> | undefined;
  const topologyKind =
    typeof handler !== "function" && "topology" in handler
      ? handler.topology
      : undefined;
  if (topologyKind && topologyKind !== operation.kind)
    throw new Error("Topology handler kind mismatch");
  let topology:
    Awaited<ReturnType<typeof prepareReceivingTopology>> | undefined;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([
    cancellation.signal,
    lifetime,
    ...(operation.signal ? [operation.signal] : []),
  ]);
  let live = true;
  let topologyFailure: unknown;
  const guard = () => {
    if (topologyFailure) throw topologyFailure;
    if (!live || signal.aborted || performance.now() >= operation.deadline)
      throw new Error("Receiving operation retired");
    boundary.assertCurrent();
  };
  let phase: ReceivingOperationPhase = "ADMITTED";
  let client: ImapFlow | undefined;
  let claim: ReceivingClaim | null = null;
  const currentClaim = (): ReceivingClaim | null => claim;
  let claimStarted = false;
  let preFailed = false;
  let mutationMayHaveExecuted = false;
  let publicationSettled = false;
  let resultUnresolved = false;
  let capturedLifecycle: bigint | undefined;
  const owner = Object.freeze({ ...boundary.owner });
  let retired: Promise<void> | undefined;
  let socketSettled = false;
  let connected = false;
  const retireSocket = () => {
    retired ??= (async () => {
      phase = "RETIRING";
      await client?.retireReceiving();
      socketSettled = true;
      phase = "NETWORK_RETIRED";
    })();
    return retired;
  };
  const abort = () => {
    void retireSocket();
  };
  const timer = setTimeout(
    () => cancellation.abort(),
    Math.max(0, operation.deadline - performance.now()),
  );
  signal.addEventListener("abort", abort, { once: true });
  const sqlWork = new Set<Promise<unknown>>();
  const preWork = new Set<Promise<unknown>>();
  let preparing = false;
  const options = () => ({ deadline: operation.deadline, signal });
  const publication = new ReceivingPublication(
    {
      transaction: <T>(
        work: (db: ReceivingDatabase) => Promise<T>,
        budget: Parameters<ReceivingExecutor["transaction"]>[1],
      ) => {
        guard();
        if (
          sqlWork.size ||
          (phase !== "PRE_NETWORK_CLAIM" &&
            phase !== "CLAIM_SETTLED" &&
            phase !== "RESULT_PUBLICATION") ||
          (phase === "RESULT_PUBLICATION" ? !socketSettled : Boolean(client))
        )
          throw new Error(
            "Receiving capability phase or serial SQL scope fenced",
          );
        const pending = boundary.executor.transaction(work, budget);
        sqlWork.add(pending);
        void pending
          .finally(() => sqlWork.delete(pending))
          .catch(() => undefined);
        return pending;
      },
    },
    attachmentStorage,
  );
  const boundIntent = () => {
    if (!("pendingId" in operation) || !("account" in operation.identity))
      throw new Error("Pre-network claim requires a persisted intent identity");
    const kind: IntentKind =
      operation.kind === "store"
        ? "command"
        : operation.kind === "content-slice"
          ? "content"
          : operation.kind === "attachment-slice"
            ? "attachment"
            : (() => {
                throw new Error("Operation has no R04-A claim capability");
              })();
    return { kind, intent: operation.pendingId };
  };
  const captureSource = (source: PublicationSource) => {
    const identity = operation.identity;
    if (
      !("account" in identity) ||
      source.mailbox !== identity.mailbox ||
      source.configuration !== identity.configurationVersion
    )
      throw new Error("Pre-network source differs from captured admission");
    return Object.freeze({
      ...source,
      state: Object.freeze({ ...source.state }),
    });
  };
  const preGuard = () => {
    guard();
    if (!preparing || preFailed || phase !== "PRE_NETWORK_CLAIM" || client)
      throw new Error("Pre-network capability is retired");
  };
  const preBudget = () => ({
    ...options(),
    deadline: Math.min(operation.deadline, performance.now() + 2000),
  });
  const confirm = async (source: PublicationSource, attempt: string) => {
    const { kind, intent } = boundIntent();
    const recovered = await publication.recover(
      owner,
      source,
      kind,
      intent,
      preBudget(),
    );
    guard();
    const marker = recovered.intent.receiving_attempt as Attempt | null;
    if (
      !marker ||
      marker.id !== attempt ||
      marker.actor !== owner.actor ||
      marker.generation !== String(owner.generation) ||
      marker.phase !== "claimed" ||
      marker.kind !== kind ||
      (attachmentOperation && marker.part !== recovered.intent.part_id) ||
      marker.account !== (operation.identity as { account: string }).account ||
      marker.mailbox !== source.mailbox ||
      marker.configuration !== String(source.configuration) ||
      marker.path !== recovered.authority.path ||
      marker.epoch !== String(recovered.state.epoch) ||
      marker.uid !== String(recovered.intent.source_uid) ||
      marker.lifecycle !== String(recovered.authority.lifecycle) ||
      recovered.authority.lifecycle !== capturedLifecycle ||
      !recovered.authority.activeSource ||
      recovered.authority.configuration !== source.configuration ||
      recovered.intent.status !==
        (kind === "command" ? "executing" : "fetching")
    )
      throw new Error("Pre-network matching claim recovery fenced");
    return Object.freeze({
      attempt: Object.freeze({ ...marker }),
      source: captureSource({ ...source, state: recovered.state }),
      kind,
      intent,
    });
  };
  const confirmResume = async (source: PublicationSource, attempt?: string) => {
    if (
      !flagOperation ||
      operation.kind !== "exact-lookup" ||
      !("pendingId" in operation) ||
      !("account" in operation.identity)
    )
      throw new Error("Reconciliation admission required");
    const recovered = await publication.recover(
      owner,
      source,
      "command",
      operation.pendingId,
      preBudget(),
    );
    const marker = recovered.intent.receiving_attempt as Attempt | null;
    if (
      !marker ||
      (attempt && marker.id !== attempt) ||
      marker.kind !== "command" ||
      !["claimed", "uncertain_remote_execution"].includes(marker.phase) ||
      !["executing", "failed"].includes(String(recovered.intent.status)) ||
      marker.account !== operation.identity.account ||
      marker.mailbox !== source.mailbox ||
      marker.path !== recovered.authority.path ||
      marker.configuration !== String(source.configuration) ||
      marker.epoch !== String(recovered.state.epoch) ||
      marker.uid !== String(recovered.intent.source_uid) ||
      marker.reconciliationActor !== owner.actor ||
      marker.reconciliationGeneration !== String(owner.generation) ||
      marker.reconciliationLifecycle !== String(capturedLifecycle) ||
      !recovered.authority.activeSource ||
      recovered.authority.configuration !== source.configuration
    )
      throw new Error("Reconciliation original attempt fenced");
    return Object.freeze({
      attempt: Object.freeze({ ...marker }),
      source: captureSource({ ...source, state: recovered.state }),
      kind: "command" as const,
      intent: operation.pendingId,
    });
  };
  const trackPre = <T>(pending: Promise<T>) => {
    const settled = pending
      .catch((error) => {
        preFailed = true;
        throw error;
      })
      .finally(() => preWork.delete(settled));
    preWork.add(settled);
    void settled.catch(() => undefined);
    return settled;
  };
  const preNetwork: ReceivingPreNetworkContext = Object.freeze({
    signal,
    deadline: operation.deadline,
    resume: (input: PublicationSource) => {
      preGuard();
      if (claimStarted || preWork.size)
        throw new Error("Reconciliation preparation is single-use");
      claimStarted = true;
      const source = captureSource(input);
      return trackPre(
        (async () => {
          if (
            !flagOperation ||
            operation.kind !== "exact-lookup" ||
            !("pendingId" in operation)
          )
            throw new Error("Reconciliation admission required");
          // Unknown resume COMMIT cannot open a socket. A later bounded selection
          // may inspect the original mutation, never replay it.
          await publication.flagResume(
            owner,
            source,
            operation.pendingId,
            preBudget(),
          );
          preGuard();
          claim = await confirmResume(source);
          preGuard();
          return claim;
        })(),
      );
    },
    claim: (input: PublicationSource) => {
      preGuard();
      if (claimStarted || preWork.size)
        throw new Error("Pre-network claim is single-use and serial");
      claimStarted = true;
      const source = captureSource(input);
      const { kind, intent } = boundIntent();
      const attempt = randomUUID();
      return trackPre(
        (async () => {
          try {
            await (
              contentOperation
                ? publication.contentClaim.bind(publication)
                : attachmentOperation
                  ? publication.attachmentClaim.bind(publication)
                  : publication.claim.bind(publication)
            )(owner, source, kind, intent, preBudget(), attempt);
          } catch (error) {
            // Never resend a claim. Recovery must find this exact UUID, not merely
            // an executing row left by a previous remote operation.
            if (!(error instanceof ReceivingUnresolvedError)) throw error;
            preGuard();
          }
          preGuard();
          claim = await confirm(source, attempt);
          preGuard();
          return claim;
        })(),
      );
    },
    recover: (input: PublicationSource) => {
      preGuard();
      if (preWork.size) throw new Error("Pre-network recovery must be serial");
      const source = captureSource(input);
      const { kind, intent } =
        operation.kind === "exact-lookup" &&
        flagOperation &&
        "pendingId" in operation
          ? { kind: "command" as const, intent: operation.pendingId }
          : boundIntent();
      return trackPre(
        publication
          .recover(owner, source, kind, intent, preBudget())
          .then((value) => {
            preGuard();
            return value;
          }),
      );
    },
  });
  const publish = async (work: (claimed: ReceivingClaim) => Promise<void>) => {
    guard();
    if (
      !claim ||
      !socketSettled ||
      sqlWork.size ||
      phase !== "NETWORK_RETIRED" ||
      publicationSettled ||
      resultUnresolved
    )
      throw new Error(
        "Receiving result requires matching claim and retired socket",
      );
    phase = "RESULT_PUBLICATION";
    try {
      await work(claim);
      guard();
      publicationSettled = true;
    } catch (error) {
      if (error instanceof ReceivingUnresolvedError) resultUnresolved = true;
      throw error;
    } finally {
      phase = "NETWORK_RETIRED";
    }
  };
  const providerWork = new Set<Promise<unknown>>();
  const flagResult = async (
    c: ReceivingClaim,
    evidence: Parameters<ReceivingPublication["commandResult"]>[4] | null,
  ) => {
    const write = () =>
      evidence === null || operation.kind === "exact-lookup"
        ? publication.flagRecovery(
            owner,
            c.source,
            c.intent,
            c.attempt.id,
            evidence,
            options(),
          )
        : publication.commandResult(
            owner,
            c.source,
            c.intent,
            c.attempt.id,
            evidence,
            options(),
          );
    try {
      await write();
    } catch (error) {
      // Recover unknown COMMIT acknowledgements and stale-result rejection under
      // conflicting locks. Remote success alone never acknowledges settlement.
      const recovery = await publication.recover(
        owner,
        c.source,
        "command",
        c.intent,
        options(),
      );
      const marker = recovery.intent.receiving_attempt as Attempt | null;
      if (marker?.id !== c.attempt.id || !recovery.authority.activeSource)
        throw error;
      if (
        (evidence !== null &&
          recovery.intent.status === "succeeded" &&
          marker.phase === "succeeded") ||
        (evidence === null &&
          recovery.intent.status === "failed" &&
          marker.phase === "flag_conflict")
      )
        return;
      // Never rebase old evidence over newer canonical facts without MODSEQ.
      // A new admitted lookup must fetch those flags again.
      if (recovery.state.revision !== c.source.state.revision) throw error;
      await write();
    }
  };
  const providerIterators = new Set<AsyncIterator<unknown>>();
  // A method-only facade prevents reflection from exposing client internals.
  // Even a method descriptor contains only the revocable wrapper, not ImapFlow.
  const methods = Object.freeze(
    Object.fromEntries(
      [
        "connect",
        "list",
        "selectIdentity",
        "getMailboxLock",
        "mailboxOpen",
        "search",
        "fetch",
        "fetchOne",
        "download",
        "append",
        "messageFlagsAdd",
        "messageFlagsRemove",
        "messageFlagsSet",
        "messageMove",
        "noop",
      ].map((property) => [
        property,
        (...args: unknown[]) => {
          guard();
          if (
            retired ||
            property === "retireReceiving" ||
            property === "close" ||
            property === "logout"
          )
            throw new Error("Owned socket is retired or requires retireSocket");
          if (phase !== "NETWORK" || sqlWork.size)
            throw new Error(
              "Owned network method requires NETWORK without SQL",
            );
          if (property === "connect") {
            if (connected) throw new Error("Owned socket cannot reconnect");
            connected = true;
          }
          if (property === "messageMove") {
            if (!move || operation.kind !== "move")
              throw Error("MOVE requires R14 authority");
            move.authorize(args[0], args[1], args[2]);
          }
          if (property === "append") {
            if (operation.kind !== "append")
              throw new Error("APPEND requires typed append admission");
            const content = args[1];
            if (
              (!Buffer.isBuffer(content) && typeof content !== "string") ||
              Buffer.byteLength(content) > operation.mimeBytes
            )
              throw new Error("APPEND payload exceeds admitted MIME policy");
            if (!sent) throw new Error("APPEND requires R13 authority");
            sent.authorize(args[0], args[1]);
          }
          if (
            property !== "append" &&
            property !== "messageMove" &&
            [
              "messageMove",
              "messageFlagsAdd",
              "messageFlagsRemove",
              "messageFlagsSet",
            ].includes(property)
          ) {
            if (
              !claim ||
              claim.kind !== "command" ||
              operation.kind !== "store" ||
              property === "append" ||
              property === "messageMove"
            )
              throw new Error(
                "Remote mutation requires a prepared durable claim capability",
              );
            mutationMayHaveExecuted = true;
          }
          const result: unknown =
            property === "list" && topologyKind === "list"
              ? (topology!.collector.begin(client!),
                listOwnedTopology(client!, topology!.collector))
              : property === "selectIdentity"
                ? topologyKind === "select"
                  ? selectOwnedDestination(
                      client!,
                      String(args[0]),
                      topology!.collector,
                    )
                  : (() => {
                      throw new Error(
                        "Destination identity requires typed SELECT admission",
                      );
                    })()
                : Reflect.apply(Reflect.get(client!, property), client!, args);
          if (result instanceof Promise) {
            providerWork.add(result);
            void result
              .finally(() => providerWork.delete(result))
              .catch(() => undefined);
          }
          if (
            result &&
            typeof result === "object" &&
            Symbol.asyncIterator in result
          ) {
            const iterator = (result as AsyncIterable<unknown>)[
              Symbol.asyncIterator
            ]();
            providerIterators.add(iterator);
            return (async function* () {
              try {
                while (true) {
                  guard();
                  if (retired) throw new Error("Owned iterator is retired");
                  const pending = Promise.resolve(iterator.next());
                  providerWork.add(pending);
                  void pending
                    .finally(() => providerWork.delete(pending))
                    .catch(() => undefined);
                  const item = await pending;
                  guard();
                  if (item.done) return;
                  yield item.value;
                }
              } finally {
                try {
                  await iterator.return?.();
                } finally {
                  providerIterators.delete(iterator);
                }
              }
            })();
          }
          return result;
        },
      ]),
    ),
  );
  const ownedClient = new Proxy(methods, {
    get(target, property) {
      if (typeof property !== "string" || !Object.hasOwn(target, property))
        throw new Error(
          "Provider helper requested an unowned client capability",
        );
      return Reflect.get(target, property);
    },
  }) as OwnedReceivingClient;
  const rejectDiagnostic = (entry: unknown) => {
    if (flags || content || attachment || sent || move) {
      (flags ?? content ?? attachment ?? sent ?? move)!.collector.reject();
      void retireSocket();
    } else {
      topologyFailure ??= new Error("IMAP diagnostic rejected topology", {
        cause: entry,
      });
      cancellation.abort();
    }
  };
  try {
    guard();
    let connection = await boundary.validate({ ...operation, signal });
    guard();
    capturedLifecycle = connection.receivingLifecycleVersion;
    phase = "PRE_NETWORK_CLAIM";
    if (
      operation.kind === "repair" &&
      typeof handler !== "function" &&
      "repair" in handler
    ) {
      if (
        !("pendingId" in operation) ||
        !("repairKind" in operation) ||
        !operation.pendingId ||
        !operation.repairKind ||
        !("account" in operation.identity) ||
        capturedLifecycle === undefined
      )
        throw Error("Invalid bounded repair admission");
      const identity = operation.identity;
      await boundary.executor.transaction(
        async (db) => {
          await db.execute(
            sql`select maildock_receiving_repair_intent(${owner.actor}::uuid,${owner.generation}::bigint,${identity.account}::uuid,${identity.configurationVersion}::bigint,${capturedLifecycle}::bigint,${operation.repairKind},${operation.pendingId}::uuid)`,
          );
        },
        {
          deadline: Math.min(operation.deadline, performance.now() + 2000),
          signal,
        },
      );
      return;
    }
    if (moveOperation) {
      move = await prepareReceivingMove({
        operation: { ...operation, signal },
        owner,
        lifecycle: capturedLifecycle,
        assertCurrent: guard,
        executor: {
          transaction: (work, budget) => {
            guard();
            if (
              sqlWork.size ||
              (phase !== "PRE_NETWORK_CLAIM" &&
                phase !== "CLAIM_SETTLED" &&
                phase !== "NETWORK_RETIRED") ||
              (client && !socketSettled)
            )
              throw new Error("MOVE SQL phase fenced");
            const pending = boundary.executor.transaction(work, budget);
            sqlWork.add(pending);
            void pending
              .finally(() => sqlWork.delete(pending))
              .catch(() => undefined);
            return pending;
          },
        },
      });
      handler = move.execute;
      connection = await boundary.validate({ ...operation, signal });
      guard();
      if (connection.receivingLifecycleVersion !== capturedLifecycle)
        throw new Error("MOVE lifecycle changed after claim");
      await move.revalidate();
    }
    if (sentStorage) {
      sent = await prepareReceivingSentCopy({
        operation: { ...operation, signal },
        owner,
        lifecycle: capturedLifecycle,
        storage: sentStorage,
        assertCurrent: guard,
        executor: {
          transaction: (work, budget) => {
            guard();
            if (
              sqlWork.size ||
              (phase !== "PRE_NETWORK_CLAIM" &&
                phase !== "CLAIM_SETTLED" &&
                phase !== "NETWORK_RETIRED") ||
              (client && !socketSettled)
            )
              throw new Error("Sent SQL phase fenced");
            const pending = boundary.executor.transaction(work, budget);
            sqlWork.add(pending);
            void pending
              .finally(() => sqlWork.delete(pending))
              .catch(() => undefined);
            return pending;
          },
        },
      });
      handler = sent.execute;
      connection = await boundary.validate({ ...operation, signal });
      guard();
      if (connection.receivingLifecycleVersion !== capturedLifecycle)
        throw new Error("Sent lifecycle changed after claim");
    }
    if (flagOperation) {
      flags = await prepareReceivingFlags(
        { ...operation, signal },
        boundary.executor,
      );
      handler = flags.handler;
    }
    if (contentOperation) {
      content = await prepareReceivingContent(
        { ...operation, signal },
        boundary.executor,
      );
      handler = content.handler;
    }
    if (attachmentOperation) {
      attachment = await prepareReceivingAttachment(
        { ...operation, signal },
        boundary.executor,
        attachmentStorage!,
      );
      handler = attachment.handler;
    }
    if (topologyKind) {
      topology = await prepareReceivingTopology({
        operation,
        owner,
        executor: boundary.executor,
        lifecycle: capturedLifecycle,
        signal,
        assertCurrent: guard,
      });
      handler = topology.execute;
    }
    if (typeof handler !== "function") {
      if (!("preNetwork" in handler))
        throw new Error("Unresolved topology handler");
      if (capturedLifecycle === undefined)
        throw new Error(
          "Prepared operation requires captured lifecycle identity",
        );
      preparing = true;
      try {
        await handler.preNetwork(operation, preNetwork);
      } finally {
        preparing = false;
      }
      guard();
      const prepared = currentClaim();
      if (preFailed || preWork.size || sqlWork.size || !prepared)
        throw new Error("Prepared operation requires a settled matching claim");
      phase = "CLAIM_SETTLED";
      connection = await boundary.validate({ ...operation, signal });
      guard();
      if (connection.receivingLifecycleVersion !== capturedLifecycle)
        throw new Error("Receiving post-claim lifecycle fenced");
      claim =
        operation.kind === "exact-lookup" && flagOperation
          ? await confirmResume(prepared.source, prepared.attempt.id)
          : await confirm(prepared.source, prepared.attempt.id);
      guard();
    } else {
      // Existing R03 no-claim handlers retain admission-only fixture behavior.
      // R04-A business execution uses the typed prepared descriptor above.
      phase = "CLAIM_SETTLED";
    }
    client = (boundary.createClient ?? ((options) => new ImapFlow(options)))({
      ...imapOptions(connection),
      disableAutoIdle: true,
      disableCompression: true,
      ...(contentOperation || attachmentOperation
        ? { disableBinary: true }
        : {}),
      logger:
        topologyKind ||
        flagOperation ||
        contentOperation ||
        attachmentOperation ||
        sent ||
        move
          ? {
              debug() {},
              info() {},
              trace() {},
              warn: rejectDiagnostic,
              error: rejectDiagnostic,
              fatal: rejectDiagnostic,
            }
          : false,
      maxLiteralSize: sent
        ? sent.mimeBytes
        : contentOperation || attachmentOperation
          ? 32 * 1024
          : "maxBytes" in operation
            ? operation.maxBytes
            : 256 * 1024,
      maxResponseSize: topologyKind
        ? TOPOLOGY_LIMITS.responseBytes
        : sent
          ? sent.mimeBytes + 256 * 1024
          : 256 * 1024,
      maxLineLength: topologyKind
        ? TOPOLOGY_LIMITS.responseBytes
        : contentOperation || attachmentOperation || sent
          ? 64 * 1024
          : undefined,
      receivingResponse: move
        ? (response, request) => {
            guard();
            return move!.collector.observe(response, request);
          }
        : topology
          ? (response, request) => {
              guard();
              return topology!.collector.observe(response, request);
            }
          : flags
            ? (response, request) => {
                guard();
                return flags!.collector.observe(response, request);
              }
            : content
              ? (response, request) => {
                  guard();
                  return content!.collector.observe(response, request);
                }
              : attachment
                ? (response, request) => {
                    guard();
                    return attachment!.collector.observe(response, request);
                  }
                : sent
                  ? (response, request) => {
                      guard();
                      return sent!.collector.observe(response, request);
                    }
                  : undefined,
      receivingBytes: (() => {
        let bytes = 0;
        return (count: number) => {
          guard();
          bytes += count;
          if (
            bytes >
            (topologyKind
              ? TOPOLOGY_LIMITS.bytes
              : sent
                ? sent.mimeBytes + 1024 * 1024
                : attachmentOperation
                  ? RECEIVING_ATTACHMENT_ENCODED_BYTES + 8 * 1024 * 1024
                  : (contentOperation ? CONTENT_PROTOCOL_BYTES : 64 * 1024) +
                    ("maxBytes" in operation ? operation.maxBytes : 256 * 1024))
          )
            throw new Error("Receiving operation response budget exceeded");
        };
      })(),
    });
    flags?.bind(client);
    move?.bind(client);

    client.on("error", (error) => {
      if (topologyKind) topologyFailure ??= error;
      // Prepared intents may settle a matching failure after actual retirement.
      // Existing admission-only handlers retain R03's error cancellation.
      if (typeof handler === "function" && !sent && !move) cancellation.abort();
      else void retireSocket();
    });
    guard();
    phase = "NETWORK";
    const result = await (
      typeof handler === "function" ? handler : handler.execute
    )(
      operation,
      Object.freeze({
        get phase() {
          return phase;
        },
        get claim() {
          return claim;
        },
        owner,
        receivingLifecycleVersion: capturedLifecycle,
        signal,
        deadline: operation.deadline,
        assertCurrent: guard,
        client: ownedClient,
        retireSocket,
        publication: Object.freeze({
          attachmentResult: (
            evidence: Parameters<ReceivingPublication["attachmentResult"]>[4],
          ) =>
            publish(async (c) => {
              if (!attachmentOperation || c.kind !== "attachment")
                throw new Error(
                  "Attachment publication requires typed admission",
                );
              const write = () =>
                publication.attachmentResult(
                  owner,
                  c.source,
                  c.intent,
                  c.attempt.id,
                  evidence,
                  options(),
                );
              try {
                await write();
              } catch (error) {
                const recovery = await publication.recover(
                  owner,
                  c.source,
                  "attachment",
                  c.intent,
                  preBudget(),
                );
                const marker = recovery.intent
                  .receiving_attempt as Attempt | null;
                if (
                  marker?.id !== c.attempt.id ||
                  !recovery.authority.activeSource
                )
                  throw error;
                if (
                  recovery.intent.status === "ready" &&
                  marker.phase === "succeeded"
                )
                  return;
                if (
                  !(error instanceof ReceivingUnresolvedError) ||
                  recovery.state.revision !== c.source.state.revision
                )
                  throw error;
                await write();
              }
            }),
          contentResult: (
            evidence: Parameters<ReceivingPublication["contentResult"]>[4],
          ) =>
            publish(async (c) => {
              if (!contentOperation || c.kind !== "content")
                throw new Error("Content publication requires typed admission");
              const write = () =>
                publication.contentResult(
                  owner,
                  c.source,
                  c.intent,
                  c.attempt.id,
                  evidence,
                  options(),
                );
              try {
                await write();
              } catch (error) {
                const recovery = await publication.recover(
                  owner,
                  c.source,
                  "content",
                  c.intent,
                  {
                    ...options(),
                    deadline: Math.min(
                      operation.deadline,
                      performance.now() + 2000,
                    ),
                  },
                );
                const marker = recovery.intent
                  .receiving_attempt as Attempt | null;
                if (
                  marker?.id !== c.attempt.id ||
                  !recovery.authority.activeSource
                )
                  throw error;
                if (
                  recovery.intent.status === "ready" &&
                  marker.phase === "succeeded"
                )
                  return;
                if (
                  !(error instanceof ReceivingUnresolvedError) ||
                  recovery.state.revision !== c.source.state.revision
                )
                  throw error;
                await write();
              }
            }),
          commandResult: (
            evidence: Parameters<ReceivingPublication["commandResult"]>[4],
          ) =>
            publish((c) =>
              flagOperation
                ? flagResult(c, evidence)
                : publication.commandResult(
                    owner,
                    c.source,
                    c.intent,
                    c.attempt.id,
                    evidence,
                    options(),
                  ),
            ),
          flagConflict: () => {
            if (!flagOperation)
              throw new Error("Flag conflict capability unavailable");
            return publish((c) => flagResult(c, null));
          },
          fail: (outcome: Parameters<ReceivingPublication["fail"]>[5]) => {
            if (
              outcome === "failed_before_execution" &&
              mutationMayHaveExecuted
            )
              throw new Error(
                "Remote mutation requires uncertainty settlement",
              );
            return publish((c) =>
              publication.fail(
                owner,
                c.source,
                c.kind,
                c.intent,
                c.attempt.id,
                outcome,
                options(),
              ),
            );
          },
        }),
        transaction: <T>(work: (db: ReceivingDatabase) => Promise<T>) => {
          guard();
          if (!socketSettled || sqlWork.size)
            throw new Error(
              "Receiving SQL requires retired socket and serial scope",
            );
          if (typeof handler !== "function")
            throw new Error(
              "Prepared operations require typed result publication",
            );
          if (
            phase !== "NETWORK_RETIRED" ||
            resultUnresolved ||
            publicationSettled
          )
            throw new Error("Receiving result transition fenced");
          phase = "RESULT_PUBLICATION";
          const pending = boundary.executor.transaction(work, {
            deadline: topologyKind
              ? Math.min(operation.deadline, performance.now() + 2000)
              : operation.deadline,
            signal,
          });
          sqlWork.add(pending);
          const settled = pending
            .catch((error) => {
              if (error instanceof ReceivingUnresolvedError)
                resultUnresolved = true;
              throw error;
            })
            .finally(() => {
              sqlWork.delete(pending);
              phase = "NETWORK_RETIRED";
            });
          void settled.catch(() => undefined);
          return settled;
        },
      }),
    );
    guard();
    if (sqlWork.size || providerWork.size || preWork.size)
      throw new Error("Detached receiving work is prohibited");
    if (claim && !publicationSettled)
      throw new Error("Prepared operation requires terminal publication");
    if (result !== undefined) {
      if (operation.kind !== "diagnostic")
        throw new Error("Only diagnostics return ephemeral results");
      if (result.success === true)
        return Object.freeze({ success: true } as const);
      if (
        result.success !== false ||
        ![
          "dns_or_host_unreachable",
          "connection_timeout",
          "tls_certificate_failure",
          "authentication_rejected",
          "starttls_unavailable",
          "verification_failed",
          "internal_error",
        ].includes(result.category)
      )
        throw new Error("Invalid diagnostic result");
      return Object.freeze({
        success: false,
        category: result.category,
      } as const);
    }
  } catch (error) {
    if (move && !signal.aborted) {
      await retireSocket();
      await move.fail();
    }
    if (sent && !signal.aborted) {
      await retireSocket();
      await sent.fail();
    }
    if (
      claim &&
      !publicationSettled &&
      !resultUnresolved &&
      !signal.aborted &&
      !(flagOperation && operation.kind === "exact-lookup")
    ) {
      await retireSocket();
      const outcome = mutationMayHaveExecuted
        ? "uncertain_remote_execution"
        : "failed_before_execution";
      try {
        await publish((c) =>
          flagOperation && mutationMayHaveExecuted
            ? publication.flagUncertain(
                owner,
                c.source,
                c.intent,
                c.attempt.id,
                options(),
              )
            : publication.fail(
                owner,
                c.source,
                c.kind,
                c.intent,
                c.attempt.id,
                c.kind === "command"
                  ? outcome
                  : c.kind === "content" &&
                      error instanceof DisplayContentLimitError &&
                      operation.kind === "content-slice" &&
                      operation.maxBytes === DISPLAY_CONTENT_BYTES
                    ? "display_content_limit_exceeded"
                    : connected
                      ? "failed_remote_read"
                      : "failed_before_execution",
                options(),
              ),
        );
      } catch (settlement) {
        throw new AggregateError(
          [error, settlement],
          "Receiving failure settlement requires recovery",
        );
      }
    }
    throw error;
  } finally {
    preparing = false;
    live = false;
    cancellation.abort(); // revoke issued SQL and delayed helper continuations
    await retireSocket();
    await Promise.allSettled(
      [...providerIterators].map((iterator) => iterator.return?.()),
    );
    await Promise.allSettled([...preWork, ...sqlWork, ...providerWork]);
    phase = "SETTLED";
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
