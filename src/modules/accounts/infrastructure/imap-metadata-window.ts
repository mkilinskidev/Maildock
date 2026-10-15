import {
  ImapFlow,
  type ImapFlowOptions,
  type ReceivingResponse,
  type ReceivingToken,
} from "imapflow";
import type { ProviderConnection } from "../domain/mail-provider";
import type { ReceivingState } from "../../../shared/infrastructure/database/receiving-authority";
import type { IntervalEvidence } from "../../mail/application/receiving-persistence";
import { imapOptions, normalizeMessage } from "./imap-smtp-mail-provider";

export const METADATA_WINDOW_LIMITS = Object.freeze({
  identities: 128,
  responseBytes: 256 * 1024,
  aggregateBytes: 2 * 1024 * 1024,
  controlBytes: 64 * 1024,
  operationMs: 10_000,
});

export type MetadataWindowOptions = Readonly<{
  /** Absolute performance.now() deadline, including subsequent DB publication. */
  deadline: number;
  signal?: AbortSignal;
  /** Revocable caller turn/epoch guard; must throw when obsolete. */
  assertCurrent: () => void;
  /** Additive Stage 3A selection; history remains the Stage 2 default. */
  kind?: "history" | "fresh";
  /** Owned turn may publish a completed SELECT transition before another FETCH. */
  allowIdentityTransition?: boolean;
  selectOnly?: boolean;
}>;

export class MetadataWindowError extends Error {}

function atom(value: ReceivingToken | ReceivingToken[] | null | undefined) {
  return value && !Array.isArray(value) ? value : undefined;
}
function numeric(value: unknown, maximum = 0xffffffff): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new MetadataWindowError("Invalid IMAP numeric evidence");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum)
    throw new MetadataWindowError("IMAP numeric evidence outside bounds");
  return result;
}

function nstring(value: ReceivingToken | undefined) {
  return (
    value === null ||
    typeof atom(value)?.value === "string" ||
    Buffer.isBuffer(atom(value)?.value)
  );
}
function envelope(value: ReceivingToken | undefined) {
  if (!Array.isArray(value) || value.length !== 10)
    throw new MetadataWindowError("Malformed metadata ENVELOPE");
  for (const index of [0, 1, 8, 9])
    if (!nstring(value[index]))
      throw new MetadataWindowError("Malformed envelope string");
  for (const index of [2, 3, 4, 5, 6, 7]) {
    const addresses = value[index];
    if (addresses === null) continue;
    if (
      !Array.isArray(addresses) ||
      addresses.some(
        (address) =>
          !Array.isArray(address) ||
          address.length !== 4 ||
          address.some((part) => !nstring(part)),
      )
    )
      throw new MetadataWindowError("Malformed envelope address list");
  }
}
function zeroNumber(value: ReceivingToken | undefined) {
  const raw = atom(value)?.value;
  if (
    typeof raw !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(raw) ||
    !Number.isSafeInteger(Number(raw))
  )
    throw new MetadataWindowError("Malformed metadata size/line count");
}
function parameters(value: ReceivingToken | undefined) {
  if (
    value !== null &&
    (!Array.isArray(value) ||
      !value.length ||
      value.length % 2 ||
      value.some((p) => !nstring(p) || p === null))
  )
    throw new MetadataWindowError("Malformed MIME parameters");
}
function extensions(value: ReceivingToken[], index: number) {
  if (index < value.length) {
    const disposition = value[index++];
    if (disposition !== null) {
      if (
        !Array.isArray(disposition) ||
        disposition.length !== 2 ||
        !nstring(disposition[0]) ||
        disposition[0] === null
      )
        throw new MetadataWindowError("Malformed MIME disposition");
      parameters(disposition[1]);
    }
  }
  if (index < value.length) {
    const language = value[index++];
    if (
      !nstring(language) &&
      (!Array.isArray(language) ||
        !language.length ||
        language.some((l) => !nstring(l) || l === null))
    )
      throw new MetadataWindowError("Malformed MIME language");
  }
  if (index < value.length && !nstring(value[index]))
    throw new MetadataWindowError("Malformed MIME location");
}
function structure(value: ReceivingToken | undefined, depth = 0) {
  if (!Array.isArray(value) || !value.length || depth > 32)
    throw new MetadataWindowError("Malformed or deeply nested BODYSTRUCTURE");
  if (Array.isArray(value[0])) {
    let index = 0;
    while (Array.isArray(value[index])) structure(value[index++], depth + 1);
    if (typeof atom(value[index])?.value !== "string")
      throw new MetadataWindowError("Missing multipart subtype");
    index++;
    if (index < value.length) parameters(value[index++]);
    extensions(value, index);
    return;
  }
  for (const index of [0, 1, 5])
    if (
      typeof atom(value[index])?.value !== "string" ||
      !atom(value[index])?.value
    )
      throw new MetadataWindowError(
        "Missing BODYSTRUCTURE type/subtype/encoding",
      );
  parameters(value[2]);
  if (!nstring(value[3]) || !nstring(value[4]))
    throw new MetadataWindowError("Malformed MIME id/description");
  zeroNumber(value[6]);
  let extensionIndex = 7;
  if (atom(value[0])?.value?.toString().toUpperCase() === "TEXT") {
    zeroNumber(value[7]);
    extensionIndex = 8;
  }
  if (
    atom(value[0])?.value?.toString().toUpperCase() === "MESSAGE" &&
    ["RFC822", "GLOBAL"].includes(
      atom(value[1])?.value?.toString().toUpperCase() ?? "",
    )
  ) {
    envelope(value[7]);
    structure(value[8], depth + 1);
    zeroNumber(value[9]);
    extensionIndex = 10;
  }
  if (extensionIndex < value.length && !nstring(value[extensionIndex++]))
    throw new MetadataWindowError("Malformed MIME digest");
  extensions(value, extensionIndex);
}

/** One exclusive client/lock, no pool, automatic IDLE, bodies or orchestration.
 * The additive pinned-package hooks run before lossy normalization/expansion.
 */
export async function fetchInboxMetadataWindow(
  connection: ProviderConnection,
  expected: ReceivingState | null,
  options: MetadataWindowOptions,
  createClient: (options: ImapFlowOptions) => ImapFlow = (opts) =>
    new ImapFlow(opts),
) {
  expected = expected ? { ...expected } : null;
  options = { ...options };
  if (
    !Number.isFinite(options.deadline) ||
    options.deadline - performance.now() > METADATA_WINDOW_LIMITS.operationMs
  )
    throw new MetadataWindowError("Invalid absolute metadata window deadline");
  let client: ImapFlow | undefined;
  let failure: Error | undefined;
  let retired: Promise<void> | undefined;
  const abort = (error: unknown) => {
    failure ??=
      error instanceof Error ? error : new MetadataWindowError(String(error));
    if (client) retired ??= client.retireReceiving();
  };
  const guard = () => {
    if (failure) throw failure;
    if (options.signal?.aborted)
      throw new MetadataWindowError("Metadata window cancelled");
    if (performance.now() >= options.deadline)
      throw new MetadataWindowError("Metadata window deadline exhausted");
    options.assertCurrent();
  };
  let bytes = 0;
  let controlBytes = 0;
  let metadataBytes = 0;
  let phase: "control" | "search" | "fetch" = "control";
  let low = 0,
    high = 0;
  const searched = new Set<number>();
  const rawMetadata = new Set<number>();
  let searchResponses = 0;
  const completed = new Map<string, number>();
  let selectedEpoch: number | undefined;
  let selectedNext: number | undefined;
  const observe = (
    response: ReceivingResponse,
    request?: { tag: string; command: string; sent: boolean },
  ) => {
    guard();
    if (response.nullBytesRemoved)
      throw new MetadataWindowError(
        "IMAP response contained removed null bytes",
      );
    if (request?.sent && response.tag === request.tag) {
      if (response.command !== "OK")
        throw new MetadataWindowError(`IMAP ${request.command} failed`);
      completed.set(request.command, (completed.get(request.command) ?? 0) + 1);
    }
    if (
      request?.sent &&
      (request.command === "SELECT" || request.command === "EXAMINE")
    ) {
      const section = atom(response.attributes?.[0])?.section;
      if (section?.[0]?.value === "UIDVALIDITY") {
        if (selectedEpoch !== undefined)
          throw new MetadataWindowError("Duplicate selected UIDVALIDITY");
        selectedEpoch = numeric(section[1]?.value);
      }
      if (section?.[0]?.value === "UIDNEXT") {
        if (selectedNext !== undefined)
          throw new MetadataWindowError("Duplicate selected UIDNEXT");
        selectedNext = numeric(section[1]?.value, 0x100000000);
      }
    }
    if (response.tag !== "*") return;
    const epochSection = atom(response.attributes?.[0])?.section;
    if (
      epochSection?.[0]?.value === "UIDVALIDITY" &&
      selectedEpoch !== numeric(epochSection[1]?.value)
    )
      throw new MetadataWindowError("Selected epoch changed during operation");
    if (response.command === "ESEARCH")
      throw new MetadataWindowError("ESEARCH is unsupported by this window");
    if (response.command === "SEARCH") {
      if (phase !== "search" || request?.command !== "UID SEARCH")
        throw new MetadataWindowError("Uncorrelated SEARCH evidence");
      if (++searchResponses !== 1)
        throw new MetadataWindowError("Multiple SEARCH responses");
      for (const item of response.attributes ?? []) {
        const uid = numeric(atom(item)?.value);
        if (
          uid < low ||
          uid > high ||
          searched.has(uid) ||
          searched.size >= METADATA_WINDOW_LIMITS.identities
        )
          throw new MetadataWindowError("Invalid bounded SEARCH identity");
        searched.add(uid);
      }
    }
    if (atom(response.attributes?.[0])?.value !== "FETCH") return;
    numeric(response.command);
    const items = response.attributes?.[1];
    if (!Array.isArray(items) || items.length % 2)
      throw new MetadataWindowError("Malformed FETCH items");
    const fields = new Map<string, ReceivingToken | ReceivingToken[] | null>();
    for (let i = 0; i < items.length; i += 2) {
      const key = atom(items[i]);
      if (!key || typeof key.value !== "string" || fields.has(key.value))
        throw new MetadataWindowError("Invalid or duplicate FETCH field");
      fields.set(key.value, items[i + 1]);
      if (
        ![
          "UID",
          "FLAGS",
          "MODSEQ",
          "ENVELOPE",
          "BODYSTRUCTURE",
          "INTERNALDATE",
          "RFC822.SIZE",
          "BODY",
          "EMAILID",
          "X-GM-MSGID",
        ].includes(key.value)
      )
        throw new MetadataWindowError("Unexpected metadata FETCH field");
      if (key.value === "BODY") {
        if (
          key.partial ||
          key.section?.[0]?.value !== "HEADER.FIELDS" ||
          key.section.length !== 2 ||
          !Array.isArray(key.section[1]) ||
          key.section[1].length !== 1 ||
          key.section[1][0]?.value?.toString().toUpperCase() !== "REFERENCES" ||
          !Buffer.isBuffer(atom(items[i + 1])?.value)
        )
          throw new MetadataWindowError("Unexpected metadata header section");
      }
    }
    if (
      fields.has("FLAGS") &&
      (!Array.isArray(fields.get("FLAGS")) ||
        (fields.get("FLAGS") as ReceivingToken[]).some(
          (flag) => typeof atom(flag)?.value !== "string",
        ))
    )
      throw new MetadataWindowError("Malformed FETCH flags");
    if (fields.has("MODSEQ")) {
      const modseq = fields.get("MODSEQ");
      const raw =
        Array.isArray(modseq) && modseq.length === 1
          ? atom(modseq[0])?.value
          : undefined;
      if (
        typeof raw !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(raw) ||
        BigInt(raw) > 0xffffffffffffffffn
      )
        throw new MetadataWindowError("Malformed FETCH MODSEQ");
    }
    // Legal flag-only/sequence-only notifications are hints, never metadata.
    if (
      [...fields.keys()].every((key) =>
        ["UID", "FLAGS", "MODSEQ"].includes(key),
      )
    ) {
      if (fields.has("UID")) numeric(atom(fields.get("UID"))?.value);
      return false;
    }
    const uid = numeric(atom(fields.get("UID"))?.value);
    if (
      phase !== "fetch" ||
      request?.command !== "UID FETCH" ||
      !searched.has(uid) ||
      rawMetadata.has(uid)
    )
      throw new MetadataWindowError("Unexpected or duplicate metadata UID");
    if (
      !Array.isArray(fields.get("FLAGS")) ||
      !Array.isArray(fields.get("ENVELOPE")) ||
      (fields.get("ENVELOPE") as ReceivingToken[]).length !== 10 ||
      !Array.isArray(fields.get("BODYSTRUCTURE")) ||
      !fields.has("INTERNALDATE") ||
      !fields.has("RFC822.SIZE") ||
      !fields.has("BODY")
    )
      throw new MetadataWindowError("Incomplete raw metadata");
    envelope(fields.get("ENVELOPE"));
    structure(fields.get("BODYSTRUCTURE"));
    zeroNumber(fields.get("RFC822.SIZE"));
    if (typeof atom(fields.get("INTERNALDATE"))?.value !== "string")
      throw new MetadataWindowError("Malformed INTERNALDATE");
    rawMetadata.add(uid);
  };
  const cancel = () =>
    abort(new MetadataWindowError("Metadata window cancelled"));
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | undefined;
  const timer = setTimeout(
    () => abort(new MetadataWindowError("Metadata window deadline exhausted")),
    Math.max(0, options.deadline - performance.now()),
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    guard();
    const diagnostic = (entry: unknown) =>
      abort(
        (entry as { err?: unknown })?.err ??
          new MetadataWindowError("IMAP diagnostic rejected metadata", {
            cause: entry,
          }),
      );
    client = createClient({
      ...imapOptions(connection),
      disableCompression: true,
      disableAutoIdle: true,
      maxLineLength: METADATA_WINDOW_LIMITS.responseBytes,
      maxLiteralSize: METADATA_WINDOW_LIMITS.responseBytes,
      maxResponseSize: METADATA_WINDOW_LIMITS.responseBytes,
      logger: {
        debug() {},
        info() {},
        trace() {},
        warn: diagnostic,
        error: diagnostic,
        fatal: diagnostic,
      },
      receivingBytes: (count) => {
        guard();
        bytes += count;
        if (phase === "control") controlBytes += count;
        else metadataBytes += count;
        if (
          controlBytes > METADATA_WINDOW_LIMITS.controlBytes ||
          metadataBytes > METADATA_WINDOW_LIMITS.aggregateBytes
        )
          throw new MetadataWindowError(
            "Aggregate IMAP response budget exceeded",
          );
      },
      receivingResponse: observe,
    });
    client.on("error", abort);
    await client.connect();
    guard();
    lock = await client.getMailboxLock("INBOX");
    guard();
    // Fresh SELECT evidence; never STATUS's possibly stale selected cache.
    if (completed.get("EXAMINE") !== 1 && completed.get("SELECT") !== 1)
      throw new MetadataWindowError("SELECT did not complete");
    if (
      !client.mailbox ||
      selectedEpoch === undefined ||
      selectedNext === undefined ||
      client.mailbox.uidValidity !== BigInt(selectedEpoch) ||
      client.mailbox.uidNext !== selectedNext
    )
      throw new MetadataWindowError("Missing authoritative SELECT identity");
    if (client.mailbox.exists > selectedNext - 1)
      throw new MetadataWindowError("SELECT count exceeds UIDNEXT space");
    const epoch = BigInt(selectedEpoch);
    if (
      options.selectOnly ||
      (options.allowIdentityTransition && expected && expected.epoch !== epoch)
    )
      return {
        epoch,
        uidNext: BigInt(selectedNext),
        evidence: null,
        metadata: [],
        bytes,
      };
    if (expected && expected.epoch !== epoch)
      throw new MetadataWindowError(
        "Selected UIDVALIDITY mismatches receiving epoch",
      );
    const historyBefore = expected?.historyBefore ?? BigInt(selectedNext);
    if (
      historyBefore > BigInt(selectedNext) ||
      (expected && expected.freshThrough >= BigInt(selectedNext))
    )
      throw new MetadataWindowError(
        "Selected UIDNEXT regressed below coverage",
      );
    const metadata: ReturnType<typeof normalizeMessage>[] = [];
    let evidence: IntervalEvidence | null = null;
    if (options.kind === "fresh" && expected) {
      low = Number(expected.freshThrough + 1n);
      high = Math.min(
        selectedNext - 1,
        low + METADATA_WINDOW_LIMITS.identities - 1,
      );
    } else if (options.kind !== "fresh") {
      high = Number(historyBefore - 1n);
      low = Math.max(1, high - METADATA_WINDOW_LIMITS.identities + 1);
    }
    if (low >= 1 && high >= low) {
      phase = "search";
      const result = await client.search(
        { uid: `${low}:${high}` },
        { uid: true },
      );
      guard();
      if (
        !Array.isArray(result) ||
        searchResponses !== 1 ||
        completed.get("UID SEARCH") !== 1 ||
        result.length !== searched.size ||
        result.some((uid) => !searched.has(uid))
      )
        throw new MetadataWindowError("SEARCH lacks complete exact evidence");
      if (searched.size) {
        phase = "fetch";
        const seen = new Set<number>();
        for await (const row of client.fetch(
          [...searched].sort((a, b) => b - a),
          {
            uid: true,
            flags: true,
            envelope: true,
            internalDate: true,
            size: true,
            bodyStructure: true,
            headers: ["references"],
          },
          { uid: true },
        )) {
          guard();
          if (
            !searched.has(row.uid) ||
            seen.has(row.uid) ||
            !rawMetadata.has(row.uid) ||
            !(row.flags instanceof Set) ||
            !row.envelope ||
            !row.bodyStructure ||
            !Buffer.isBuffer(row.headers) ||
            row.size === undefined ||
            row.size < 0
          )
            throw new MetadataWindowError(
              "Incomplete normalized metadata identity",
            );
          seen.add(row.uid);
          metadata.push(normalizeMessage(row));
        }
        guard();
        if (
          completed.get("UID FETCH") !== 1 ||
          seen.size !== searched.size ||
          rawMetadata.size !== searched.size
        )
          throw new MetadataWindowError(
            "FETCH incomplete; missing UIDs remain unresolved",
          );
      }
      evidence = {
        complete: true,
        epoch,
        low: BigInt(low),
        high: BigInt(high),
        searched: [...searched].map(BigInt),
        confirmedAbsent: [],
      };
    }
    guard();
    if (!client.mailbox || client.mailbox.uidValidity !== epoch)
      throw new MetadataWindowError("Selected epoch invalidated");
    if (
      Buffer.byteLength(JSON.stringify(metadata)) >
      METADATA_WINDOW_LIMITS.aggregateBytes
    )
      throw new MetadataWindowError("Normalized metadata budget exceeded");
    return { epoch, uidNext: BigInt(selectedNext), evidence, metadata, bytes };
  } catch (error) {
    abort(error);
    throw failure;
  } finally {
    // All command awaits / FETCH iterator have settled before releasing a healthy lock.
    lock?.release();
    if (client) await (retired ?? client.retireReceiving());
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (!failure) guard();
  }
}
