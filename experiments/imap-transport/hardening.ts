import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { ImapFlow, FetchMessageObject } from "imapflow";

const require = createRequire(import.meta.url);
const ownedClients = new WeakSet<ImapFlow>();

export type FailureKind =
  | "authentication"
  | "connection"
  | "socket-timeout"
  | "deadline"
  | "cancelled"
  | "parser-limit"
  | "malformed"
  | "budget"
  | "incomplete"
  | "epoch"
  | "protocol"
  | "unresolved";
export class EvidenceError extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}
export function classify(error: unknown): FailureKind {
  if (error instanceof EvidenceError) return error.kind;
  const e = error as { code?: string; authenticationFailed?: boolean };
  if (e?.authenticationFailed || e?.code === "AuthenticationFailure")
    return "authentication";
  if (e?.code === "ETIMEOUT") return "socket-timeout";
  if (/TooLarge|LineTooLong|ResponseToo|MAX_IMAP_NESTING/.test(e?.code ?? ""))
    return "parser-limit";
  if (
    /Parser|Unexpected|InvalidResponse|ResponseProcessing/.test(e?.code ?? "")
  )
    return "malformed";
  if (/Connection|Closed|ECONN|CONNECT|GREETING|EPIPE/.test(e?.code ?? ""))
    return "connection";
  return "protocol";
}
type Atom = { value?: string | Buffer; section?: Atom[]; partial?: number[] };
type Parsed = { tag: string; command: string; attributes?: (Atom | Atom[])[] };
type Internal = {
  socket: Socket;
  currentRequest?: { tag: string; command: string; sent: boolean };
  streamer: {
    lineBytes: number;
    responseBytes: number;
    literalBuffer: Buffer[];
    inputQueue: unknown[];
  };
  getUntaggedHandler: (
    command: string,
    attributes?: Parsed["attributes"],
  ) => ((parsed: Parsed) => Promise<void>) | undefined;
};
export type Epoch = { path: string; uidValidity: bigint };
export function validateEpoch(client: ImapFlow, expected: Epoch) {
  if (
    !client.mailbox ||
    client.mailbox.path !== expected.path ||
    client.mailbox.uidValidity !== expected.uidValidity
  )
    throw new EvidenceError(
      "epoch",
      "Explicit mailbox/UIDVALIDITY validation failed",
    );
}
export type Metrics = {
  received: number;
  accepted: number;
  maxChunk: number;
  rejectedChunk: number;
  identities: number;
  maxParsedSearchTokens?: number;
  retainedSearchIdentities?: number;
  parserAtAbort?: {
    lineBytes: number;
    responseBytes: number;
    literalBytes: number;
    queuedChunks: number;
  };
  durationMs?: number;
  closeMs?: number;
  settlementMs?: number;
};
type Scope = {
  valid: boolean;
  end: number;
  failure?: EvidenceError;
  metrics: Metrics;
  search?: { low: number; high: number; maximum: number; seen: Set<number> };
  slice?: {
    uid: number;
    part: string;
    origin: number;
    length: number;
    observed: number;
  };
  tags: {
    tag?: string;
    command?: string;
    kind: FailureKind;
    message: string;
  }[];
};
export type Outcome<T> =
  | {
      status: "justified";
      value: T;
      metrics: Metrics;
      diagnostics: Scope["tags"];
    }
  | {
      status: "unresolved";
      kind: FailureKind;
      remoteOutcome: "read-only" | "ambiguous";
      message: string;
      metrics: Metrics;
      diagnostics: Scope["tags"];
    };

/** Experiment-only access to pinned 2.0.6 internals. One owner; no auto-IDLE,
 * compression, STARTTLS upgrade or overlapping commands while scoped. */
export class TransportExperiment {
  private scope?: Scope;
  private disposed = false;
  private wireObserver: (chunk: Buffer) => void;
  private errorObserver: (error: Error) => void;
  private originalHandler: Internal["getUntaggedHandler"];
  private internal: Internal;
  readonly socket: Socket;
  constructor(public client: ImapFlow) {
    if (
      require("imapflow/package.json").version !== "2.0.6" ||
      client.isClosed ||
      ownedClients.has(client)
    )
      throw new Error(
        "A live exclusively owned ImapFlow 2.0.6 client is required",
      );
    this.internal = client as unknown as Internal;
    this.socket = this.internal.socket;
    ownedClients.add(client);
    this.originalHandler = this.internal.getUntaggedHandler;
    this.wireObserver = (chunk) => {
      const scope = this.scope;
      if (!scope?.valid) return;
      scope.metrics.received += chunk.length;
      scope.metrics.maxChunk = Math.max(scope.metrics.maxChunk, chunk.length);
      if (scope.metrics.received > this.byteLimit) {
        scope.metrics.rejectedChunk = chunk.length;
        this.abort(
          new EvidenceError(
            "budget",
            "Aggregate decrypted wire budget exceeded",
          ),
        );
      } else scope.metrics.accepted += chunk.length;
    };
    this.internal.socket.prependListener("data", this.wireObserver);
    this.errorObserver = (error) => {
      const scope = this.scope;
      if (!scope?.valid) return;
      const request = this.internal.currentRequest;
      const kind = classify(error);
      scope.tags.push({
        tag: request?.tag,
        command: request?.command,
        kind,
        message: error.message,
      });
      this.abort(new EvidenceError(kind, error.message));
    };
    this.client.prependListener("error", this.errorObserver);
    this.internal.getUntaggedHandler = (command, attributes) => {
      const original = this.originalHandler.call(
        this.internal,
        command,
        attributes,
      );
      if (!original) return original;
      return async (parsed) => {
        const scope = this.scope;
        if (scope?.valid) {
          try {
            this.inspect(parsed, scope);
          } catch (error) {
            this.abort(error as EvidenceError);
            return;
          }
        }
        if (scope && !scope.valid) return;
        await original(parsed);
      };
    };
  }
  private byteLimit = 0;
  /** Pass this collector in the logger at client construction, forwarding logs
   * normally as well. Uncorrelated diagnostics fail closed as unresolved. */
  diagnostic(entry: { msg?: string; err?: unknown; src?: string }) {
    const scope = this.scope;
    if (!scope?.valid || (!entry.err && !entry.msg)) return;
    const request = this.internal.currentRequest;
    const classified = entry.err ? classify(entry.err) : "unresolved";
    const kind =
      entry.src === "s" && classified !== "parser-limit"
        ? "malformed"
        : classified;
    scope.tags.push({
      tag: request?.tag,
      command: request?.command,
      kind,
      message: entry.err ? String((entry.err as Error).message) : entry.msg!,
    });
    this.abort(
      new EvidenceError(
        request?.sent ? kind : "unresolved",
        entry.msg ?? String((entry.err as Error).message),
      ),
    );
  }
  private inspect(parsed: Parsed, scope: Scope) {
    if (parsed.command === "ESEARCH" && scope.search)
      throw new EvidenceError(
        "unresolved",
        "ESEARCH expansion requires a separate bounded hook",
      );
    if (parsed.command === "SEARCH" && scope.search) {
      scope.metrics.maxParsedSearchTokens = Math.max(
        scope.metrics.maxParsedSearchTokens ?? 0,
        parsed.attributes?.length ?? 0,
      );
      for (const atom of parsed.attributes ?? []) {
        const raw = (atom as Atom).value;
        const value = Number(raw);
        scope.metrics.identities++;
        if (
          typeof raw !== "string" ||
          !/^[0-9]+$/.test(raw) ||
          !Number.isSafeInteger(value) ||
          value < scope.search.low ||
          value > scope.search.high ||
          scope.search.seen.has(value)
        )
          throw new EvidenceError(
            "malformed",
            "Invalid, duplicate or out-of-range SEARCH identity",
          );
        if (scope.metrics.identities > scope.search.maximum)
          throw new EvidenceError(
            "budget",
            "SEARCH identity budget exceeded before collection",
          );
        scope.search.seen.add(value);
        scope.metrics.retainedSearchIdentities = scope.search.seen.size;
      }
    }
    if ((parsed.attributes?.[0] as Atom)?.value !== "FETCH" || !scope.slice)
      return;
    const items = parsed.attributes?.[1];
    if (!Array.isArray(items))
      throw new EvidenceError("malformed", "Missing FETCH attributes");
    let uid: number | undefined;
    for (let i = 0; i < items.length; i += 2) {
      const key = items[i];
      if (key.value === "UID") uid = Number(items[i + 1]?.value);
      if (/^(BODY|BINARY)$/.test(String(key.value))) {
        const bytes = items[i + 1]?.value;
        const part = key.section?.map((a) => a.value).join("");
        if (
          key.value !== "BODY" ||
          part !== scope.slice.part ||
          key.partial?.length !== 1 ||
          key.partial[0] !== scope.slice.origin ||
          !Buffer.isBuffer(bytes) ||
          bytes.length !== scope.slice.length ||
          ++scope.slice.observed !== 1
        )
          throw new EvidenceError(
            "malformed",
            "Slice section/origin/length/count mismatch",
          );
      }
    }
    if (uid !== scope.slice.uid)
      throw new EvidenceError("malformed", "Unexpected slice UID");
  }
  cancel() {
    this.abort(new EvidenceError("cancelled", "Explicit cancellation"));
  }
  private abort(error: EvidenceError) {
    const scope = this.scope;
    if (!scope?.valid) return;
    scope.valid = false;
    scope.failure = error;
    const parser = this.internal.streamer;
    scope.metrics.parserAtAbort = {
      lineBytes: parser.lineBytes,
      responseBytes: parser.responseBytes,
      literalBytes: parser.literalBuffer.reduce((sum, b) => sum + b.length, 0),
      queuedChunks: parser.inputQueue.length,
    };
    this.client.close();
  }
  async execute<T>(
    options: { timeoutMs: number; byteLimit: number; mutation?: boolean },
    work: (guard: () => void, remaining: () => number) => Promise<T>,
    configure?: (scope: Scope) => void,
  ): Promise<Outcome<T>> {
    if (
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      !Number.isSafeInteger(options.byteLimit) ||
      options.byteLimit <= 0
    )
      throw new Error("Finite positive deadline and byte budget required");
    if (this.scope || this.disposed)
      throw new Error("Experiment transport has no available owner");
    const start = performance.now();
    const scope: Scope = {
      valid: true,
      end: start + options.timeoutMs,
      metrics: {
        received: 0,
        accepted: 0,
        maxChunk: 0,
        rejectedChunk: 0,
        identities: 0,
      },
      tags: [],
    };
    this.scope = scope;
    this.byteLimit = options.byteLimit;
    configure?.(scope);
    const socket = this.internal.socket;
    let onClose: () => void;
    const closed = new Promise<void>((resolve) => {
      onClose = () => {
        scope.metrics.closeMs = performance.now() - start;
        resolve();
      };
      socket.once("close", onClose);
    });
    const guard = () => {
      if (performance.now() >= scope.end && scope.valid)
        this.abort(
          new EvidenceError(
            "deadline",
            "Absolute operation deadline exhausted",
          ),
        );
      if (!scope.valid)
        throw (
          scope.failure ??
          new EvidenceError("cancelled", "Invalid operation token")
        );
    };
    const timer = setTimeout(
      () =>
        this.abort(
          new EvidenceError(
            "deadline",
            "Absolute operation deadline exhausted",
          ),
        ),
      options.timeoutMs,
    );
    let value: T | undefined;
    try {
      guard();
      value = await work(guard, () =>
        Math.max(0, scope.end - performance.now()),
      );
      guard();
    } catch (error) {
      if (scope.valid)
        this.abort(
          error instanceof EvidenceError
            ? error
            : new EvidenceError(
                classify(error),
                String((error as Error).message),
              ),
        );
    } finally {
      scope.metrics.settlementMs = performance.now() - start;
      clearTimeout(timer);
      if (scope.failure) await closed;
      else socket.removeListener("close", onClose!);
      scope.valid = false;
      scope.metrics.durationMs = performance.now() - start;
      this.scope = undefined;
    }
    if (scope.failure)
      return {
        status: "unresolved",
        kind: scope.failure.kind,
        remoteOutcome: options.mutation ? "ambiguous" : "read-only",
        message: scope.failure.message,
        metrics: scope.metrics,
        diagnostics: scope.tags,
      };
    return {
      status: "justified",
      value: value as T,
      metrics: scope.metrics,
      diagnostics: scope.tags,
    };
  }
  search(
    low: number,
    high: number,
    maximum: number,
    options: { timeoutMs: number; byteLimit: number },
  ) {
    if (
      !Number.isInteger(low) ||
      !Number.isInteger(high) ||
      low < 1 ||
      high < low ||
      high > 0xffffffff ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 128
    )
      throw new Error("Closed valid UID interval and bounded count required");
    return this.execute(
      options,
      async (guard) => {
        const hits = await this.client.search(
          { uid: `${low}:${high}` },
          { uid: true },
        );
        guard();
        if (!Array.isArray(hits))
          throw new EvidenceError("protocol", "SEARCH returned false");
        if (hits.length !== this.scope?.search?.seen.size)
          throw new EvidenceError(
            "unresolved",
            "Unobserved SEARCH form (including ESEARCH)",
          );
        return hits;
      },
      (scope) => {
        scope.search = { low, high, maximum, seen: new Set() };
      },
    );
  }
  metadata(
    uids: number[],
    epoch: Epoch,
    options: { timeoutMs: number; byteLimit: number },
    externalEpochCheck: () => boolean,
  ) {
    if (
      !uids.length ||
      uids.length > 128 ||
      new Set(uids).size !== uids.length ||
      uids.some((uid) => !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff)
    )
      throw new Error("Explicit distinct bounded UID set required");
    return this.execute(options, async (guard) => {
      validateEpoch(this.client, epoch);
      const requested = new Set(uids);
      const rows = new Map<number, FetchMessageObject>();
      for await (const row of this.client.fetch(
        uids,
        {
          uid: true,
          flags: true,
          headers: true,
          bodyStructure: true,
          size: true,
        },
        { uid: true },
      )) {
        guard();
        if (!requested.has(row.uid) || rows.has(row.uid))
          throw new EvidenceError(
            "incomplete",
            "Unexpected or duplicate FETCH identity",
          );
        if (
          !Buffer.isBuffer(row.headers) ||
          !(row.flags instanceof Set) ||
          !row.bodyStructure ||
          typeof row.size !== "number"
        )
          throw new EvidenceError("incomplete", "Required metadata absent");
        rows.set(row.uid, row);
      }
      guard();
      validateEpoch(this.client, epoch);
      if (!externalEpochCheck())
        throw new EvidenceError(
          "epoch",
          "External mailbox/epoch validation rejected publication",
        );
      const missing = uids.filter((uid) => !rows.has(uid));
      if (missing.length)
        throw new EvidenceError(
          "incomplete",
          `Recheck required for missing UIDs: ${missing.join(",")}; no absence/coverage evidence`,
        );
      return [...rows.values()];
    });
  }
  slice(
    uid: number,
    part: string,
    origin: number,
    length: number,
    epoch: Epoch,
    options: { timeoutMs: number; byteLimit: number },
  ) {
    return this.execute(
      options,
      async (guard) => {
        validateEpoch(this.client, epoch);
        const rows = [];
        for await (const row of this.client.fetch(
          [uid],
          {
            uid: true,
            bodyParts: [{ key: part, start: origin, maxLength: length }],
          },
          { uid: true },
        ))
          rows.push(row);
        guard();
        validateEpoch(this.client, epoch);
        const bytes = rows[0]?.bodyParts?.get(part);
        if (
          rows.length !== 1 ||
          this.scope?.slice?.observed !== 1 ||
          !bytes ||
          bytes.length !== length
        )
          throw new EvidenceError("incomplete", "Slice is incomplete");
        return bytes;
      },
      (scope) => {
        scope.slice = { uid, part, origin, length, observed: 0 };
      },
    );
  }
  dispose() {
    if (this.scope) throw new Error("Cannot dispose active transport");
    this.disposed = true;
    ownedClients.delete(this.client);
    this.socket.removeListener("data", this.wireObserver);
    this.client.removeListener("error", this.errorObserver);
    this.internal.getUntaggedHandler = this.originalHandler;
  }
}
