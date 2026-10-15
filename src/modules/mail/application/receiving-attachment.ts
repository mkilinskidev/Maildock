import { sql } from "drizzle-orm";
import type { BlobStorage } from "../../../shared/application/blob-storage";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import { normalizeMimeStructure } from "../../accounts/infrastructure/imap-smtp-mail-provider";
import { discoverAttachments } from "../domain/attachments";
import {
  RECEIVING_ATTACHMENT_BYTES,
  RECEIVING_ATTACHMENT_ENCODED_BYTES,
  RECEIVING_ATTACHMENT_CHUNK,
} from "../domain/receiving-attachment-limits";
import { ContentCollector } from "./receiving-content";
import type { PublicationSource } from "./receiving-publication";
import type {
  ReceivingOperation,
  ReceivingOperationHandler,
} from "./receiving-operation";

/** Strict continuous transfer decoder. At most one window and three carry bytes;
 * no charset/flowed conversion is permitted for downloadable binary attachments. */
export class AttachmentDecoder {
  private carry = "";
  private padded = false;
  constructor(private readonly encoding: string) {
    if (
      !["base64", "quoted-printable", "7bit", "8bit", "binary"].includes(
        encoding,
      )
    )
      throw new Error("Unsupported attachment encoding");
  }
  decode(bytes: Buffer): Buffer {
    if (bytes.length > RECEIVING_ATTACHMENT_CHUNK)
      throw new Error("Attachment decoder window exceeded");
    if (this.encoding === "base64") {
      const text =
        this.carry + bytes.toString("latin1").replace(/[\r\n\t ]/g, "");
      if (/[^A-Za-z0-9+/=]/.test(text) || (this.padded && text.length))
        throw new Error("Malformed attachment base64");
      const length = text.length - (text.length % 4);
      const complete = text.slice(0, length);
      this.carry = text.slice(length);
      const decoded = Buffer.from(complete, "base64");
      if (decoded.toString("base64") !== complete)
        throw new Error("Noncanonical attachment base64");
      this.padded ||= complete.includes("=");
      if (this.padded && this.carry)
        throw new Error("Data after attachment padding");
      return decoded;
    }
    if (this.encoding === "quoted-printable") {
      const text = this.carry + bytes.toString("latin1");
      this.carry = "";
      const output = Buffer.allocUnsafe(text.length);
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== "=") {
          output[n++] = text.charCodeAt(i);
          continue;
        }
        if (i + 2 >= text.length) {
          this.carry = text.slice(i);
          break;
        }
        const pair = text.slice(i + 1, i + 3);
        if (pair !== "\r\n" && !/^[0-9a-f]{2}$/i.test(pair))
          throw new Error("Malformed attachment quoted-printable");
        if (pair !== "\r\n") output[n++] = parseInt(pair, 16);
        i += 2;
      }
      return output.subarray(0, n);
    }
    if (this.encoding === "7bit" && bytes.some((byte) => byte > 127))
      throw new Error("Invalid attachment 7bit");
    return bytes;
  }
  finish() {
    if (this.carry) throw new Error("Incomplete attachment transfer encoding");
  }
}

export async function prepareReceivingAttachment(
  operation: ReceivingOperation,
  executor: ReceivingExecutor,
  storage: BlobStorage,
) {
  if (
    operation.kind !== "attachment-slice" ||
    !("account" in operation.identity) ||
    operation.offset !== 0
  )
    throw new Error("Invalid attachment admission");
  const identity = operation.identity;
  const row = await executor.transaction(
    async (db) => {
      const [row] = await db.execute(sql`select a.*,m.mime_structure,
      s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after
      from message_attachments a join messages m on m.id=a.message_id
      join receiving_mailboxes s on s.mailbox_id=a.source_mailbox_id
      where a.id=${operation.pendingId}::uuid and m.account_id=${identity.account}::uuid
      and a.source_mailbox_id=${identity.mailbox ?? null}::uuid`);
      if (!row) throw new Error("Missing durable attachment intent");
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
    epoch = BigInt(row.source_uid_validity as string),
    part = String(row.part_id);
  const collector = new ContentCollector(
    uid,
    epoch,
    RECEIVING_ATTACHMENT_ENCODED_BYTES,
    true,
  );
  let path: string;
  const descriptorKeys = [
    "partId",
    "filename",
    "contentType",
    "disposition",
    "contentId",
    "inline",
    "visible",
    "declaredSize",
  ] as const;
  const original = discoverAttachments(
    row.mime_structure as Parameters<typeof discoverAttachments>[0],
  ).filter((p) => p.partId === part);
  if (original.length !== 1)
    throw new Error("Original attachment descriptor unavailable");
  const frozen = original[0];
  const originalNodes: { part: string | null; encoding: string | null }[] = [];
  const visitOriginal = (
    node: NonNullable<Parameters<typeof discoverAttachments>[0]>,
  ) => {
    if (
      node.part === part ||
      (!node.part && !node.children.length && part === "1")
    )
      originalNodes.push(node);
    node.children.forEach(visitOriginal);
  };
  visitOriginal(
    row.mime_structure as NonNullable<
      Parameters<typeof discoverAttachments>[0]
    >,
  );
  if (originalNodes.length !== 1)
    throw new Error("Ambiguous frozen attachment part");
  if (
    frozen.filename !== row.filename ||
    frozen.contentType !== row.content_type ||
    frozen.disposition !== row.disposition ||
    frozen.contentId !== row.content_id ||
    frozen.inline !== row.inline ||
    frozen.visible !== row.visible ||
    frozen.declaredSize?.toString() !== row.declared_size?.toString()
  )
    throw new Error("Conflicting original attachment metadata");
  const handler: ReceivingOperationHandler = {
    preNetwork: async (_op, context) => {
      const recovered = await context.recover(source);
      if (
        !recovered.authority.activeSource ||
        recovered.authority.configuration !== source.configuration ||
        String(recovered.intent.source_uid) !== String(uid) ||
        String(recovered.intent.source_uid_validity) !== String(epoch) ||
        recovered.intent.part_id !== part ||
        recovered.intent.message_id !== row.message_id
      )
        throw new Error("Obsolete attachment source");
      if (
        [
          "filename",
          "content_type",
          "disposition",
          "content_id",
          "declared_size",
          "inline",
          "visible",
        ].some((key) =>
          key === "declared_size" &&
          row[key] !== null &&
          recovered.intent[key] !== null
            ? String(recovered.intent[key]) !== String(row[key])
            : recovered.intent[key] !== row[key],
        )
      )
        throw new Error("Attachment descriptor changed before claim");
      source = { ...source, state: recovered.state };
      path = recovered.authority.path;
      const claimed = await context.claim(source);
      if (claimed.attempt.path !== path || claimed.attempt.part !== part)
        throw new Error("Attachment claim changed its original path or part");
    },
    execute: async (_op, context) => {
      await context.client.connect();
      collector.begin("select");
      const selected = await context.client.mailboxOpen(path, {
        readOnly: true,
      });
      collector.finish();
      if (selected.uidValidity !== epoch || selected.path !== path)
        throw new Error("Attachment selected identity changed");
      collector.begin("structure");
      const remote = await context.client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      collector.finish();
      if (!remote || BigInt(remote.uid) !== uid || !remote.bodyStructure)
        throw new Error("Attachment source unavailable");
      const root = normalizeMimeStructure(remote.bodyStructure);
      const descriptors = discoverAttachments(root).filter(
        (p) => p.partId === part,
      );
      if (
        descriptors.length !== 1 ||
        descriptorKeys.some((key) => descriptors[0][key] !== frozen[key])
      )
        throw new Error("Remote attachment descriptor changed");
      const nodes: (typeof root)[] = [];
      const visit = (node: typeof root) => {
        if (
          node.part === part ||
          (node === root && !node.part && !node.children.length && part === "1")
        )
          nodes.push(node);
        node.children.forEach(visit);
      };
      visit(root);
      if (nodes.length !== 1)
        throw new Error("Ambiguous original attachment part");
      const node = nodes[0],
        encoding = (node.encoding ?? "7bit").toLowerCase();
      if (encoding !== (originalNodes[0].encoding ?? "7bit").toLowerCase())
        throw new Error("Attachment transfer encoding changed");
      const size = Number(frozen.declaredSize);
      if (
        frozen.declaredSize === null ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > RECEIVING_ATTACHMENT_ENCODED_BYTES
      )
        throw new Error("Attachment encoded size exceeds policy");
      const decoder = new AttachmentDecoder(encoding);
      const section = node === root && !root.part ? "TEXT" : part;
      collector.download(section, size, encoding);
      const chunks = async function* () {
        let offset = 0,
          decoded = 0;
        while (true) {
          context.assertCurrent();
          const result = await context.client.fetchOne(
            String(uid),
            {
              uid: true,
              bodyParts: [
                {
                  key: section,
                  start: offset,
                  maxLength: RECEIVING_ATTACHMENT_CHUNK,
                },
              ],
            },
            { uid: true },
          );
          collector.finishCommand();
          const bytes = result && result.bodyParts?.get(section);
          if (!result || BigInt(result.uid) !== uid || !Buffer.isBuffer(bytes))
            throw new Error("Missing attachment slice");
          const output = decoder.decode(bytes);
          decoded += output.length;
          if (
            decoded > Math.min(operation.maxBytes, RECEIVING_ATTACHMENT_BYTES)
          )
            throw new Error("Attachment decoded size exceeds 100 MiB policy");
          offset += bytes.length;
          if (output.length) yield output;
          if (bytes.length < RECEIVING_ATTACHMENT_CHUNK) break;
        }
        decoder.finish();
        collector.finish();
        context.assertCurrent();
      };
      const blob = await storage.put(
        chunks(),
        Math.min(operation.maxBytes, RECEIVING_ATTACHMENT_BYTES),
      );
      context.assertCurrent();
      const encodedBytes = collector.finish();
      await context.retireSocket();
      await context.publication.attachmentResult({
        complete: true,
        taggedOk: true,
        streamComplete: true,
        decoded: true,
        eof: true,
        method: "BODY.PEEK",
        origin: 0,
        encodedBytes,
        part,
        epoch,
        uid,
        blob,
      });
    },
  };
  return { collector, handler };
}
