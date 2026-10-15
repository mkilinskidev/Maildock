import { sql } from "drizzle-orm";
import type { ReceivingResponse, ReceivingToken } from "imapflow";
import { finished } from "node:stream/promises";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import { normalizeMimeStructure } from "../../accounts/infrastructure/imap-smtp-mail-provider";
import type { RemoteMimePart } from "../../accounts/domain/mail-provider";
import { selectDisplayParts } from "../domain/display-parts";
import {
  DISPLAY_CONTENT_BYTES,
  DisplayContentLimitError,
} from "../domain/display-content-limits";
import type { PublicationSource } from "./receiving-publication";
import type {
  ReceivingOperation,
  ReceivingOperationHandler,
} from "./receiving-operation";

export const CONTENT_LIMITS = Object.freeze({
  bytes: DISPLAY_CONTENT_BYTES,
  chunk: 32 * 1024,
  header: 16 * 1024,
  nodes: 128,
  depth: 16,
});
type Token = ReceivingToken | undefined;
function atom(t: Token): string {
  if (!t || Array.isArray(t) || typeof t.value !== "string")
    throw new Error("Malformed content evidence atom");
  return t.value;
}
function integer(t: Token, max = Number.MAX_SAFE_INTEGER) {
  const value = atom(t);
  if (
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 16 ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    throw new Error("Invalid content evidence number");
  return Number(value);
}
/** Reject structures the tolerant library parser would otherwise repair. */
function structure(root: Token) {
  let count = 0;
  // IMAP MIME strings may be literals. Numeric source/size evidence continues
  // to use integer()/atom(), which never accepts a literal in place of a number.
  const mimeString = (t: Token) =>
    t && !Array.isArray(t) && t.type === "LITERAL" && Buffer.isBuffer(t.value)
      ? t.value.toString("utf8")
      : atom(t);
  const params = (t: Token) => {
    if (t === null) return;
    if (!Array.isArray(t) || t.length % 2)
      throw new Error("Malformed MIME parameters");
    const names = new Set<string>();
    for (let i = 0; i < t.length; i += 2) {
      const name = mimeString(t[i]).toLowerCase();
      if (names.has(name) || /^(?:__proto__|constructor|prototype)$/.test(name))
        throw new Error("Ambiguous MIME parameter");
      names.add(name);
      mimeString(t[i + 1]);
    }
  };
  const visit = (t: Token, depth: number) => {
    if (
      !Array.isArray(t) ||
      ++count > CONTENT_LIMITS.nodes ||
      depth > CONTENT_LIMITS.depth
    )
      throw new Error("Invalid or excessive MIME structure");
    let extension: number;
    if (Array.isArray(t[0])) {
      let i = 0;
      while (Array.isArray(t[i])) visit(t[i++], depth + 1);
      if (!/^[a-z0-9-]+$/i.test(mimeString(t[i++])))
        throw new Error("Invalid multipart subtype");
      if (i < t.length) params(t[i++]);
      extension = i;
    } else {
      const type = mimeString(t[0]).toLowerCase(),
        subtype = mimeString(t[1]).toLowerCase();
      if (
        !/^[a-z0-9!#$&^_.+-]+$/.test(type) ||
        !/^[a-z0-9!#$&^_.+-]+$/.test(subtype)
      )
        throw new Error("Invalid MIME type");
      params(t[2]);
      for (const i of [3, 4]) if (t[i] !== null) mimeString(t[i]);
      mimeString(t[5]);
      integer(t[6]);
      extension = 7;
      if (type === "text") {
        integer(t[7]);
        extension = 8;
      }
      if (type === "message" && subtype === "rfc822") {
        if (!Array.isArray(t[7])) throw new Error("Missing embedded envelope");
        visit(t[8], depth + 1);
        integer(t[9]);
        extension = 10;
      }
      if (extension < t.length) {
        if (t[extension] !== null) mimeString(t[extension]);
        extension++;
      }
    }
    if (extension < t.length && t[extension] !== null) {
      const disposition = t[extension];
      if (!Array.isArray(disposition) || disposition.length !== 2)
        throw new Error("Malformed MIME disposition");
      mimeString(disposition[0]);
      params(disposition[1]);
    }
  };
  visit(root, 0);
}

/** Correlates every FETCH, including download()'s internal structure/header and
 * chunk requests. EOF requires exact BODYSTRUCTURE size plus a short final chunk. */
export class ContentCollector {
  private failed = false;
  private mode: "select" | "structure" | "download" = "select";
  private tag?: string;
  private complete = false;
  private row = false;
  private selectedEpoch?: number;
  private expected?: {
    section: string;
    size: number;
    encoding: string;
    charset?: string;
  };
  private header?: Buffer;
  private validated = false;
  private offset = 0;
  private eof = false;
  private raw: Buffer[] = [];
  private total = 0;
  private headers = false;
  private sawStructure = false;
  constructor(
    private readonly uid: bigint,
    private readonly epoch: bigint,
    private readonly limit: number,
    private readonly encodedOnly = false,
  ) {}
  reject() {
    this.failed = true;
  }
  begin(mode: "select" | "structure") {
    this.mode = mode;
    this.tag = undefined;
    this.complete = false;
    this.row = false;
  }
  download(section: string, size: number, encoding: string, charset?: string) {
    this.mode = "download";
    this.tag = undefined;
    this.complete = false;
    this.row = false;
    this.expected = { section: section.toUpperCase(), size, encoding, charset };
    this.header = undefined;
    this.validated = false;
    this.offset = 0;
    this.eof = false;
    this.raw = [];
    this.headers = false;
    this.sawStructure = false;
  }
  observe = (
    response: ReceivingResponse,
    request?: { tag: string; command: string; sent: boolean },
  ) => {
    if (this.failed || response.nullBytesRemoved)
      throw new Error("Rejected content protocol evidence");
    const command = this.mode === "select" ? "EXAMINE" : "UID FETCH";
    if (!request?.sent || request.command !== command) return;
    if (this.tag !== request.tag) {
      if (this.tag && !this.complete)
        throw new Error("Incomplete previous content command");
      this.tag = request.tag;
      this.complete = false;
      this.row = false;
    }
    const attrs = response.attributes ?? [];
    for (const t of attrs) {
      if (
        t &&
        !Array.isArray(t) &&
        t.section &&
        atom(t.section[0]).toUpperCase() === "UIDVALIDITY"
      ) {
        const epoch = integer(t.section[1], 4294967295);
        if (this.mode === "select") {
          if (this.selectedEpoch !== undefined)
            throw new Error("Duplicate selected epoch");
          this.selectedEpoch = epoch;
        } else if (BigInt(epoch) !== this.epoch)
          throw new Error("Content epoch changed");
      }
    }
    if (response.tag === "*" && attrs[0]?.value === "FETCH") {
      if (
        this.mode === "select" ||
        this.row ||
        !/^[1-9][0-9]*$/.test(response.command ?? "")
      )
        throw new Error("Unexpected content FETCH");
      const fields = attrs[1];
      if (!Array.isArray(fields) || fields.length % 2)
        throw new Error("Malformed content FETCH");
      const seen = new Set<string>();
      let uid: number | undefined,
        body = false,
        gotStructure = false;
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i],
          value = fields[i + 1],
          name = atom(key).toUpperCase();
        const section = key && !Array.isArray(key) ? key.section : undefined;
        const identity =
          name +
          (section ? ":" + section.map(atom).join(".").toUpperCase() : "");
        if (seen.has(identity)) throw new Error("Duplicate content field");
        seen.add(identity);
        if (name === "UID") uid = integer(value, 4294967295);
        else if (name === "BODYSTRUCTURE") {
          structure(value);
          gotStructure = true;
        } else if (name === "BODY" && section && this.mode === "download") {
          const part = section.map(atom).join(".").toUpperCase();
          if (
            !value ||
            Array.isArray(value) ||
            value.type !== "LITERAL" ||
            !Buffer.isBuffer(value.value)
          )
            throw new Error("Missing content literal");
          const bytes = value.value;
          if (part === "HEADER" || part.endsWith(".MIME")) {
            const expectedHeader =
              this.expected!.section === "TEXT"
                ? "HEADER"
                : this.expected!.section + ".MIME";
            if (
              part !== expectedHeader ||
              this.headers ||
              this.offset ||
              bytes.length > CONTENT_LIMITS.header ||
              key?.partial
            )
              throw new Error("Unexpected MIME header identity");
            const header = bytes.toString("latin1");
            if (
              !header.endsWith("\r\n\r\n") ||
              [
                "content-type",
                "content-transfer-encoding",
                "content-disposition",
              ].some(
                (name) =>
                  (header.match(new RegExp("^" + name + ":", "gim")) ?? [])
                    .length > 1,
              )
            )
              throw new Error("Ambiguous MIME headers");
            this.headers = true;
            this.header = bytes;
          } else {
            if (
              part !== this.expected!.section ||
              this.eof ||
              body ||
              key?.partial?.length !== 1 ||
              key.partial[0] !== this.offset ||
              bytes.length > CONTENT_LIMITS.chunk
            )
              throw new Error("Unexpected content part or offset");
            body = true;
            this.offset += bytes.length;
            this.total += bytes.length;
            if (this.offset > this.expected!.size)
              throw new Error("Content exceeds declared part size");
            if (this.total > this.limit)
              throw new DisplayContentLimitError(this.limit);
            if (!this.encodedOnly) this.raw.push(bytes);
            if (bytes.length < CONTENT_LIMITS.chunk) {
              if (this.offset !== this.expected!.size)
                throw new Error("Short content read");
              this.eof = true;
            }
          }
        } else if (name === "RFC822.SIZE") integer(value);
        else if (name === "MODSEQ") {
          if (!Array.isArray(value) || value.length !== 1)
            throw new Error("Malformed content MODSEQ");
          atom(value[0]);
        } else if (["EMAILID", "X-GM-MSGID"].includes(name)) {
          /* library-requested identity, never used for source assignment */
        } else throw new Error("Unexpected content FETCH field");
      }
      if (uid === undefined || BigInt(uid) !== this.uid)
        throw new Error("Wrong content UID");
      if (
        this.mode === "structure"
          ? !gotStructure || body
          : gotStructure
            ? this.sawStructure || this.offset !== 0 || body
            : !body
      )
        throw new Error("Incomplete content FETCH");
      this.sawStructure ||= gotStructure;
      this.row = true;
    }
    if (response.tag === request.tag) {
      if (
        this.complete ||
        response.command !== "OK" ||
        (this.mode !== "select" && !this.row)
      )
        throw new Error("Unsuccessful content completion");
      this.complete = true;
    } else if (response.tag !== "*")
      throw new Error("Uncorrelated content completion");
  };
  finishCommand() {
    if (
      this.failed ||
      !this.tag ||
      !this.complete ||
      BigInt(this.selectedEpoch ?? 0) !== this.epoch
    )
      throw new Error("Incomplete selected content evidence");
  }
  finish() {
    this.finishCommand();
    if (this.mode === "download" && this.encodedOnly) {
      if (!this.eof || this.offset !== this.expected!.size)
        throw new Error("Attachment lacks complete EOF evidence");
      return BigInt(this.total);
    }
    if (this.mode === "download" && !this.validated) {
      if (!this.headers || !this.eof || this.offset !== this.expected!.size)
        throw new Error("Content lacks complete EOF evidence");
      const bytes = Buffer.concat(this.raw, this.offset),
        encoding = this.expected!.encoding;
      this.raw = [];
      let binary = bytes;
      if (encoding === "base64") {
        const compact = bytes.toString("latin1").replace(/[\r\n\t ]/g, "");
        binary = Buffer.from(compact, "base64");
        if (
          compact.length % 4 !== 0 ||
          /[^A-Za-z0-9+/=]/.test(compact) ||
          !/^[^=]*={0,2}$/.test(compact) ||
          binary.toString("base64") !== compact
        )
          throw new Error("Malformed base64 content");
      } else if (encoding === "quoted-printable") {
        const raw = bytes.toString("latin1");
        if (/=(?![0-9a-f]{2}|\r\n)/i.test(raw))
          throw new Error("Malformed quoted-printable content");
        binary = Buffer.from(
          raw.replace(
            /=\r\n|=([0-9a-f]{2})/gi,
            (_match, hex: string | undefined) =>
              hex ? String.fromCharCode(parseInt(hex, 16)) : "",
          ),
          "latin1",
        );
      } else if (encoding === "7bit" && bytes.some((b) => b > 127))
        throw new Error("Invalid 7bit content");
      // Supplement the existing tolerant MIME decoder with strict validation;
      // only the installed streaming decoder supplies the published text.
      const validator = new TextDecoder(this.expected!.charset ?? "utf-8", {
        fatal: true,
      });
      for (
        let offset = 0;
        offset < binary.length;
        offset += CONTENT_LIMITS.chunk
      )
        validator.decode(
          binary.subarray(offset, offset + CONTENT_LIMITS.chunk),
          { stream: true },
        );
      validator.decode();
      this.validated = true;
    }
    return BigInt(this.total);
  }
  async validateMime(type: string) {
    if (!this.header) throw new Error("Missing display MIME headers");
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(this.header, {
      skipHtmlToText: true,
      skipTextToHtml: true,
    });
    const contentType = parsed.headers.get("content-type");
    if (
      !contentType ||
      typeof contentType !== "object" ||
      !("params" in contentType) ||
      !("value" in contentType)
    )
      throw new Error("Malformed display Content-Type");
    const charset = (value: string | undefined) =>
      value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (
      contentType.value !== type ||
      charset(contentType.params.charset) !== charset(this.expected!.charset)
    )
      throw new Error("MIME headers disagree with selected structure");
  }
}

export async function prepareReceivingContent(
  operation: ReceivingOperation,
  executor: ReceivingExecutor,
) {
  if (
    operation.kind !== "content-slice" ||
    !("account" in operation.identity) ||
    operation.offset !== 0
  )
    throw new Error("Invalid content admission");
  const identity = operation.identity;
  const row = await executor.transaction(
    async (db) => {
      const [row] =
        await db.execute(sql`select c.source_mailbox_id,c.source_configuration_binding,c.source_uid,c.source_uid_validity,
      s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after
      from message_contents c join receiving_mailboxes s on s.mailbox_id=c.source_mailbox_id
      join messages m on m.id=c.message_id where c.message_id=${operation.pendingId}::uuid
      and m.account_id=${identity.account}::uuid and c.source_mailbox_id=${identity.mailbox ?? null}::uuid`);
      if (!row) throw new Error("Missing durable content intent");
      return row;
    },
    {
      deadline: Math.min(operation.deadline, performance.now() + 2000),
      signal: operation.signal,
    },
  );
  let source: PublicationSource = {
    mailbox: String(row.source_mailbox_id),
    configuration: BigInt(row.source_configuration_binding as string),
    state: {
      epoch: BigInt(row.epoch as string),
      revision: BigInt(row.revision as string),
      freshThrough: BigInt(row.fresh_through as string),
      historyBefore: BigInt(row.history_before as string),
      reconcileAfter: BigInt(row.reconcile_after as string),
    },
  };
  const uid = BigInt(row.source_uid as string),
    epoch = BigInt(row.source_uid_validity as string);
  const collector = new ContentCollector(uid, epoch, operation.maxBytes);
  let path: string;
  const handler: ReceivingOperationHandler = {
    preNetwork: async (_operation, context) => {
      const recovered = await context.recover(source);
      if (
        !recovered.authority.activeSource ||
        recovered.authority.configuration !== source.configuration ||
        BigInt(recovered.intent.source_uid as string) !== uid ||
        BigInt(recovered.intent.source_uid_validity as string) !== epoch
      )
        throw new Error("Obsolete content source");
      source = { ...source, state: recovered.state };
      path = recovered.authority.path;
      await context.claim(source);
    },
    execute: async (_operation, context) => {
      await context.client.connect();
      collector.begin("select");
      const selected = await context.client.mailboxOpen(path, {
        readOnly: true,
      });
      collector.finish();
      if (selected.uidValidity !== epoch || selected.path !== path)
        throw new Error("Content SELECT identity changed");
      collector.begin("structure");
      const remote = await context.client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      collector.finish();
      if (!remote || BigInt(remote.uid) !== uid || !remote.bodyStructure)
        throw new Error("Content source disappeared");
      const root = normalizeMimeStructure(remote.bodyStructure),
        parts = selectDisplayParts(root);
      if (!parts.length || parts.length > 2)
        throw new Error("Missing display parts");
      const nodes = new Map<string, RemoteMimePart>();
      const visit = (node: RemoteMimePart) => {
        if (node.part) {
          if (nodes.has(node.part)) throw new Error("Ambiguous MIME part");
          nodes.set(node.part, node);
        }
        node.children.forEach(visit);
      };
      visit(root);
      let declared = 0,
        decoded = 0;
      const bodies: { plainText: string | null; html: string | null } = {
        plainText: null,
        html: null,
      };
      for (const part of parts) {
        const node =
          root.part === null && !root.children.length
            ? root
            : nodes.get(part.part);
        if (!node || node.size === null || !/^(0|[1-9][0-9]*)$/.test(node.size))
          throw new Error("Missing display size");
        const size = Number(node.size),
          encoding = (node.encoding ?? "7bit").toLowerCase();
        if (
          !Number.isSafeInteger(size) ||
          !["7bit", "8bit", "binary", "base64", "quoted-printable"].includes(
            encoding,
          )
        )
          throw new Error("Unsupported display encoding or size");
        if ((declared += size) > operation.maxBytes)
          throw new DisplayContentLimitError(operation.maxBytes);
        const section = node === root ? "TEXT" : part.part;
        collector.download(section, size, encoding, node.parameters.charset);
        const downloaded = await context.client.download(
          String(uid),
          part.part,
          {
            uid: true,
            chunkSize: CONTENT_LIMITS.chunk,
            // Intermediate flowed/charset stages also use this bound. Keep
            // complete bounded input available even when decoding shrinks it;
            // the shared consumer counter enforces the final aggregate limit.
            maxBytes: operation.maxBytes + 1,
          },
        );
        if (!downloaded.content) throw new Error("Display part unavailable");
        const stream = downloaded.content;
        const abort = () =>
          stream.destroy(new Error("Content operation cancelled"));
        context.signal.addEventListener("abort", abort, { once: true });
        try {
          const meta = downloaded.meta;
          const charset = meta.charset?.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (
            meta.contentType !== part.type ||
            meta.filename ||
            meta.disposition === "attachment" ||
            (meta.encoding ?? "7bit").toLowerCase() !== encoding ||
            (charset && !["utf8", "ascii", "usascii"].includes(charset))
          )
            throw new Error("Unsupported or mismatched display metadata");
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            context.assertCurrent();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            decoded += bytes.length;
            if (decoded > operation.maxBytes)
              throw new DisplayContentLimitError(operation.maxBytes);
            if (
              (charset === "ascii" || charset === "usascii") &&
              bytes.some((b) => b > 127)
            )
              throw new Error("Decoded content exceeds policy");
            chunks.push(bytes);
          }
          await finished(stream);
          collector.finish();
          await collector.validateMime(part.type);
          context.assertCurrent();
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          );
          if (text.includes("\0")) throw new Error("Invalid content null byte");
          if (part.type === "text/plain") bodies.plainText = text;
          else bodies.html = text;
        } finally {
          context.signal.removeEventListener("abort", abort);
          stream.destroy();
          await finished(stream).catch(() => undefined);
        }
      }
      const encodedBytes = collector.finish();
      await context.retireSocket();
      await context.publication.contentResult({
        complete: true,
        taggedOk: true,
        streamComplete: true,
        decoded: true,
        eof: true,
        method: "BODY.PEEK",
        origin: 0,
        encodedBytes,
        part: "TEXT",
        epoch,
        uid,
        ...bodies,
        searchText: "",
      });
    },
  };
  return { collector, handler };
}
