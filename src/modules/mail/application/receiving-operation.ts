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
      mailbox?: string;
    }>
  | Readonly<{ ephemeral: string }>;
type Unit =
  | Readonly<{
      kind: "repair" | "bootstrap" | "list" | "select" | "diagnostic";
    }>
  | Readonly<{ kind: "store" | "move" | "exact-lookup"; pendingId: string }>
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
>;
export type ReceivingOperationContext = Readonly<{
  owner: ReceivingOwner;
  signal: AbortSignal;
  deadline: number;
  assertCurrent: () => void;
  /** Exactly one client, guarded against late calls and reconnect. */
  client: OwnedReceivingClient;
  retireSocket: () => Promise<void>;
  /** SQL is prohibited until the socket has retired. R04 supplies publication. */
  transaction: <T>(work: (db: ReceivingDatabase) => Promise<T>) => Promise<T>;
}>;
/** Trusted composition registry, not supplied by submitters. No operation bodies
 * are registered by R03; isolated fixtures may inject deterministic executors. */
export type ReceivingOperationHandlers = Partial<
  Record<
    ReceivingOperationKind,
    (
      operation: ReceivingOperation,
      context: ReceivingOperationContext,
    ) => Promise<ReceivingOperationResult>
  >
>;
export type ReceivingOperationBoundary = Readonly<{
  owner: ReceivingOwner;
  executor: ReceivingExecutor;
  assertCurrent: () => void;
  validate: (operation: ReceivingOperation) => Promise<ProviderConnection>;
  createClient?: (options: ImapFlowOptions) => ImapFlow;
}>;

export function validateReceivingOperation(operation: ReceivingOperation) {
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
    operation.deadline > performance.now() + 10_000
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
      operation.maxBytes > 256 * 1024
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
  const cancellation = new AbortController();
  const signal = AbortSignal.any([
    cancellation.signal,
    lifetime,
    ...(operation.signal ? [operation.signal] : []),
  ]);
  let live = true;
  const guard = () => {
    if (!live || signal.aborted || performance.now() >= operation.deadline)
      throw new Error("Receiving operation retired");
    boundary.assertCurrent();
  };
  guard();
  const connection = await boundary.validate(operation);
  guard(); // validation scope has committed before any network construction
  const client = (
    boundary.createClient ?? ((options) => new ImapFlow(options))
  )({
    ...imapOptions(connection),
    disableAutoIdle: true,
    disableCompression: true,
    logger: false,
    maxLiteralSize: "maxBytes" in operation ? operation.maxBytes : 256 * 1024,
    maxResponseSize: 256 * 1024,
    receivingBytes: (() => {
      let bytes = 0;
      return (count: number) => {
        guard();
        bytes += count;
        if (
          bytes >
          64 * 1024 +
            ("maxBytes" in operation ? operation.maxBytes : 256 * 1024)
        )
          throw new Error("Receiving operation response budget exceeded");
      };
    })(),
  });
  let retired: Promise<void> | undefined;
  let socketSettled = false;
  let connected = false;
  const retireSocket = () => {
    retired ??= client.retireReceiving().then(() => {
      socketSettled = true;
    });
    return retired;
  };
  const abort = () => {
    void retireSocket();
  };
  client.on("error", () => cancellation.abort());
  const timer = setTimeout(
    () => cancellation.abort(),
    Math.max(0, operation.deadline - performance.now()),
  );
  signal.addEventListener("abort", abort, { once: true });
  const sqlWork = new Set<Promise<unknown>>();
  const providerWork = new Set<Promise<unknown>>();
  const providerIterators = new Set<AsyncIterator<unknown>>();
  // A method-only facade prevents reflection from exposing client internals.
  // Even a method descriptor contains only the revocable wrapper, not ImapFlow.
  const methods = Object.freeze(
    Object.fromEntries(
      [
        "connect",
        "list",
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
          if (property === "connect") {
            if (connected) throw new Error("Owned socket cannot reconnect");
            connected = true;
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
          }
          const result: unknown = Reflect.apply(
            Reflect.get(client, property),
            client,
            args,
          );
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
  try {
    guard();
    const result = await handler(
      operation,
      Object.freeze({
        owner: Object.freeze({ ...boundary.owner }),
        signal,
        deadline: operation.deadline,
        assertCurrent: guard,
        client: ownedClient,
        retireSocket,
        transaction: <T>(work: (db: ReceivingDatabase) => Promise<T>) => {
          guard();
          if (!socketSettled || sqlWork.size)
            throw new Error(
              "Receiving SQL requires retired socket and serial scope",
            );
          const pending = boundary.executor.transaction(work, {
            deadline: operation.deadline,
            signal,
          });
          sqlWork.add(pending);
          void pending
            .finally(() => sqlWork.delete(pending))
            .catch(() => undefined);
          return pending;
        },
      }),
    );
    guard();
    if (sqlWork.size || providerWork.size)
      throw new Error("Detached receiving work is prohibited");
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
  } finally {
    live = false;
    cancellation.abort(); // revoke issued SQL and delayed helper continuations
    await retireSocket();
    await Promise.allSettled(
      [...providerIterators].map((iterator) => iterator.return?.()),
    );
    await Promise.allSettled([...sqlWork, ...providerWork]);
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
