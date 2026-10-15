import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  mailboxes,
  mailboxRoles,
} from "../../../shared/infrastructure/database/schema";
import { resolveMappedMailbox } from "./mailbox-role-service";
import type { ReceivingResponse, ReceivingToken } from "imapflow";
import {
  readVerifiedBlob,
  type BlobStorage,
} from "../../../shared/application/blob-storage";
import type { ReceivingOwner } from "../../../shared/infrastructure/database/receiving-authority";
import {
  ReceivingUnresolvedError,
  type ReceivingExecutor,
} from "../../../shared/infrastructure/database/receiving-executor";
import { DEFAULT_ATTACHMENT_LIMITS } from "../domain/attachments";
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
    throw Error("Malformed Sent evidence");
  return t.value;
};
const uid = (t: Token) => {
  const value = atom(t);
  if (!/^[1-9][0-9]{0,9}$/.test(value) || BigInt(value) > 4294967295n)
    throw Error("Invalid Sent UID");
  return BigInt(value);
};

/** Raw correlated evidence; normalized library return values are insufficient. */
export class SentCopyCollector {
  private command = "";
  private tag?: string;
  private complete = false;
  private epoch?: bigint;
  private mapping?: { epoch: bigint; uid: bigint };
  private matches: bigint[] = [];
  private searched = false;
  private body?: Buffer;
  private flags?: string[];
  private modseq: bigint | null = null;
  private requestedUid?: bigint;
  private rejected = false;
  begin(
    command: "EXAMINE" | "APPEND" | "UID SEARCH" | "UID FETCH",
    requestedUid?: bigint,
  ) {
    this.command = command;
    this.tag = undefined;
    this.complete = false;
    this.mapping = undefined;
    this.matches = [];
    this.searched = false;
    this.body = undefined;
    this.flags = undefined;
    this.modseq = null;
    this.requestedUid = requestedUid;
    if (command === "EXAMINE") this.epoch = undefined;
  }
  reject() {
    this.rejected = true;
  }
  observe = (
    r: ReceivingResponse,
    request?: { tag: string; command: string; sent: boolean },
  ) => {
    if (this.rejected || r.nullBytesRemoved)
      throw Error("Rejected Sent protocol evidence");
    if (!request?.sent || request.command !== this.command) return;
    if (this.tag && this.tag !== request.tag)
      throw Error("Changed Sent command tag");
    this.tag = request.tag;
    for (const t of r.attributes ?? []) {
      if (!t || Array.isArray(t) || !t.section) continue;
      const name = atom(t.section[0]).toUpperCase();
      if (name === "UIDVALIDITY") {
        if (this.epoch !== undefined) throw Error("Duplicate Sent epoch");
        this.epoch = uid(t.section[1]);
      }
      if (name === "APPENDUID") {
        if (
          this.command !== "APPEND" ||
          this.mapping ||
          t.section.length !== 3 ||
          r.tag !== request.tag ||
          r.command !== "OK"
        )
          throw Error("Invalid APPENDUID evidence");
        this.mapping = { epoch: uid(t.section[1]), uid: uid(t.section[2]) };
      }
    }
    if (r.tag === "*" && r.command === "SEARCH") {
      if (this.command !== "UID SEARCH" || this.searched)
        throw Error("Ambiguous Sent search");
      this.searched = true;
      this.matches = (r.attributes ?? []).map(uid);
      if (this.matches.length > 2) throw Error("Sent lookup is ambiguous");
    }
    if (r.tag === "*" && r.attributes?.[0]?.value === "FETCH") {
      const fields = r.attributes[1];
      if (this.command !== "UID FETCH" || this.body || !Array.isArray(fields))
        throw Error("Unexpected Sent FETCH");
      let foundUid: bigint | undefined, body: Buffer | undefined;
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i],
          value = fields[i + 1];
        if (atom(key).toUpperCase() === "UID") {
          if (foundUid) throw Error("Duplicate Sent UID");
          foundUid = uid(value);
        } else if (
          atom(key).toUpperCase() === "BODY" &&
          key &&
          !Array.isArray(key) &&
          key.section?.length === 0
        ) {
          if (
            body ||
            !value ||
            Array.isArray(value) ||
            !Buffer.isBuffer(value.value)
          )
            throw Error("Invalid Sent MIME evidence");
          body = value.value;
        } else if (atom(key).toUpperCase() === "FLAGS") {
          if (this.flags || !Array.isArray(value) || value.length > 128)
            throw Error("Invalid Sent flags");
          this.flags = value.map(atom);
          if (new Set(this.flags).size !== this.flags.length)
            throw Error("Duplicate Sent flag");
        } else if (atom(key).toUpperCase() === "MODSEQ") {
          if (
            this.modseq !== null ||
            !Array.isArray(value) ||
            value.length !== 1 ||
            !/^[1-9][0-9]{0,18}$/.test(atom(value[0])) ||
            BigInt(atom(value[0])) > 9223372036854775807n
          )
            throw Error("Invalid Sent MODSEQ");
          this.modseq = BigInt(atom(value[0]));
        } else throw Error("Unexpected Sent FETCH field");
      }
      if (foundUid !== this.requestedUid || !body)
        throw Error("Sent source identity mismatch");
      this.body = body;
    }
    if (r.tag === request.tag) {
      if (this.complete || r.command !== "OK")
        throw Error("Unsuccessful Sent completion");
      this.complete = true;
    } else if (r.tag !== "*" && r.tag !== "+")
      throw Error("Uncorrelated Sent completion");
  };
  finish() {
    if (
      this.rejected ||
      !this.tag ||
      !this.complete ||
      (this.command === "UID SEARCH" && !this.searched)
    )
      throw Error("Incomplete Sent evidence");
    return {
      epoch: this.epoch,
      mapping: this.mapping,
      matches: this.matches,
      body: this.body,
      flags: this.flags,
      modseq: this.modseq,
    };
  }
}

/** Opt-in R13 registry descriptor. Production composition remains R16. */
export async function prepareReceivingSentCopy(input: {
  operation: ReceivingOperation;
  owner: ReceivingOwner;
  lifecycle: bigint | undefined;
  executor: Pick<ReceivingExecutor, "transaction">;
  storage: BlobStorage;
  assertCurrent(): void;
}) {
  const { operation, owner, executor, storage } = input;
  if (
    !("account" in operation.identity) ||
    !("pendingId" in operation) ||
    !["append", "exact-lookup"].includes(operation.kind) ||
    input.lifecycle === undefined
  )
    throw Error("Invalid Sent admission");
  const identity = operation.identity,
    intent = operation.pendingId;
  const options = () => ({
    deadline: Math.min(operation.deadline, performance.now() + 2000),
    signal: operation.signal,
  });
  const publication = new ReceivingBoundedPublication(executor);
  const pendingFailure = (
    reason: "destination_unavailable" | "mime_unavailable",
  ) =>
    executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_append_pending_failure(${owner.actor}::uuid,${owner.generation}::bigint,${identity.account}::uuid,${identity.configurationVersion}::bigint,${input.lifecycle}::bigint,${intent}::uuid,${reason})`,
      );
    }, options());
  const row = await executor.transaction(async (db) => {
    const [r] =
      await db.execute(sql`select o.*,b.remote_path,b.selectable,b.lifecycle_status,
      s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after,
      s.configuration_binding,bl.storage_key,bl.size,bl.sha256
      from outgoing_messages o
      left join mailbox_roles role on role.account_id=o.account_id and role.role='sent'
      join mailboxes b on b.id=case when o.receiving_attempt is null then role.mailbox_id else o.sent_copy_mailbox_id end
      join receiving_mailboxes s on s.mailbox_id=b.id
      left join blobs bl on bl.id=o.mime_blob_id
      where o.id=${intent}::uuid and o.account_id=${identity.account}::uuid and b.id=${identity.mailbox ?? null}::uuid`);
    if (r && !r.receiving_attempt) {
      const [mapping] = await db
        .select()
        .from(mailboxRoles)
        .where(
          and(
            eq(mailboxRoles.accountId, identity.account),
            eq(mailboxRoles.role, "sent"),
          ),
        );
      const candidates = await db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.accountId, identity.account));
      if (
        resolveMappedMailbox(identity.account, "sent", mapping, candidates)
          ?.id !== identity.mailbox
      )
        return undefined;
    }
    return r;
  }, options());
  if (
    !row ||
    row.status !== "sent" ||
    row.sent_copy_policy !== "maildock" ||
    !row.selectable ||
    row.lifecycle_status !== "active" ||
    BigInt(row.configuration_binding as string) !==
      identity.configurationVersion
  ) {
    if (operation.kind === "append")
      await pendingFailure("destination_unavailable");
    throw Error("Sent destination unavailable; owned Sent SELECT required");
  }
  let authority: DataAuthority = {
    owner,
    account: identity.account,
    configuration: identity.configurationVersion,
    lifecycle: input.lifecycle,
    scopes: [
      {
        mailbox: identity.mailbox!,
        path: String(row.remote_path),
        configuration: identity.configurationVersion,
        state: {
          epoch: BigInt(row.epoch as string),
          revision: BigInt(row.revision as string),
          freshThrough: BigInt(row.fresh_through as string),
          historyBefore: BigInt(row.history_before as string),
          reconcileAfter: BigInt(row.reconcile_after as string),
        },
      },
    ],
  };
  const limit = DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes;
  let mime: Buffer;
  try {
    if (row.mime_blob_id) {
      mime = await readVerifiedBlob(
        storage,
        {
          key: String(row.storage_key),
          size: Number(row.size),
          sha256: String(row.sha256),
        },
        limit,
        operation.signal,
      );
    } else {
      const encoded = row.mime_base64;
      if (
        typeof encoded !== "string" ||
        encoded.length > Math.ceil(limit / 3) * 4
      )
        throw Error("Sent MIME exceeds policy");
      mime = Buffer.from(encoded, "base64");
      if (mime.length > limit || mime.toString("base64") !== encoded)
        throw Error("Invalid immutable Sent MIME");
    }
  } catch (error) {
    if (
      operation.kind === "append" &&
      !row.receiving_attempt &&
      row.sent_copy_status === "pending"
    )
      await pendingFailure("mime_unavailable");
    throw error;
  }
  if (
    operation.kind === "append" &&
    (row.receiving_attempt ||
      row.sent_copy_status !== "pending" ||
      operation.mimeBytes !== mime.length)
  )
    throw Error("Sent APPEND cannot replay an existing attempt");
  const lookup = operation.kind === "exact-lookup";
  const attempt = lookup
    ? String((row.receiving_attempt as Record<string, unknown> | null)?.id)
    : randomUUID();
  if (!lookup) {
    await executor.transaction(async (db) => {
      await db.execute(
        sql`update outgoing_messages set sent_copy_mailbox_id=${identity.mailbox}::uuid,sent_copy_path=${authority.scopes[0].path} where id=${intent}::uuid and sent_copy_status='pending' and receiving_attempt is null`,
      );
    }, options());
  }
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
          sql`select maildock_receiving_append_resume(${owner.actor}::uuid,${owner.generation}::bigint,${identity.account}::uuid,${identity.configurationVersion}::bigint,${input.lifecycle}::bigint,${scopes}::jsonb,${intent}::uuid)`,
        );
      }, options());
    else
      await publication.claim(authority, "append", intent, options(), attempt);
  } catch (error) {
    if (!(error instanceof ReceivingUnresolvedError)) throw error;
  }
  const legacyDigest =
    typeof row.mime_base64 === "string"
      ? createHash("sha256").update(row.mime_base64).digest("hex")
      : null;
  const reload = async () => {
    const recovered = await publication.recover(
      authority,
      "append",
      intent,
      options(),
    );
    const scope = (
      recovered.scope.scopes as { state: { revision: string } }[]
    )[0];
    const marker = recovered.intent.receiving_attempt as Record<
      string,
      unknown
    >;
    if (
      !marker ||
      marker.id !== attempt ||
      marker.actor !== owner.actor ||
      marker.generation !== String(owner.generation) ||
      marker.messageId !== row.message_id ||
      marker.mimeBlob !== row.mime_blob_id ||
      marker.mimeDigest !== row.sha256 ||
      marker.mimeSha256 !== legacyDigest
    )
      throw Error("Sent claim acknowledgement is unresolved");
    authority = {
      ...authority,
      scopes: [
        {
          ...authority.scopes[0],
          state: {
            ...authority.scopes[0].state,
            revision: BigInt(scope.state.revision),
          },
        },
      ],
    };
    return recovered.intent;
  };
  const prepared = await reload();
  const marker = prepared.receiving_attempt as Record<string, unknown>;
  const previous = row.receiving_attempt as Record<string, unknown> | null;
  if (
    marker.phase !==
      (lookup
        ? row.sent_copy_status === "saved"
          ? previous?.phase
          : "reconciling"
        : "claimed") ||
    (lookup && marker.observations !== Number(previous?.observations ?? 0) + 1)
  )
    throw Error("Sent preparation COMMIT is unresolved");
  input.assertCurrent();
  const collector = new SentCopyCollector();
  let settled = false,
    mutated = false;
  const settle = async (work: () => Promise<void>, phase: string) => {
    try {
      await work();
      settled = true;
    } catch (error) {
      const r = await reload();
      if ((r.receiving_attempt as Record<string, unknown>).phase === phase) {
        settled = true;
        return;
      }
      if (!(error instanceof ReceivingUnresolvedError)) throw error;
      await work();
      settled = true;
    }
  };
  const fail = async () => {
    if (settled || (lookup && row.sent_copy_status === "saved")) return;
    await settle(
      () =>
        publication.fail(
          authority,
          "append",
          intent,
          attempt,
          mutated || lookup
            ? "uncertain_remote_execution"
            : "failed_before_execution",
          options(),
        ),
      mutated || lookup
        ? "uncertain_remote_execution"
        : "failed_before_execution",
    );
  };
  return {
    collector,
    mimeBytes: mime.length,
    authorize(path: unknown, bytes: unknown) {
      if (
        lookup ||
        mutated ||
        path !== authority.scopes[0].path ||
        bytes !== mime
      )
        throw Error("Sent mutation differs from immutable claim");
      mutated = true;
    },
    fail,
    async execute(
      _operation: ReceivingOperation,
      context: ReceivingOperationContext,
    ) {
      await context.client.connect();
      collector.begin("EXAMINE");
      const selected = await context.client.mailboxOpen(
        authority.scopes[0].path,
        { readOnly: true },
      );
      const epoch = authority.scopes[0].state.epoch;
      if (collector.finish().epoch !== epoch || selected.uidValidity !== epoch)
        throw Error("Sent selected epoch changed");
      let destinationUid: bigint | null = null;
      let verifiedFlags: string[] | undefined;
      let verifiedModseq: bigint | null = null;
      if (!lookup) {
        collector.begin("APPEND");
        await context.client.append(
          authority.scopes[0].path,
          mime,
          ["\\Seen"],
          new Date(String(row.smtp_accepted_at ?? row.created_at)),
        );
        const evidence = collector.finish();
        if (evidence.mapping && evidence.mapping.epoch !== epoch)
          throw Error("APPENDUID epoch differs from selected destination");
        destinationUid = evidence.mapping?.uid ?? null;
      } else {
        collector.begin("UID SEARCH");
        await context.client.search(
          { header: { "message-id": String(row.message_id) } },
          { uid: true },
        );
        const matches = collector.finish().matches;
        // A Message-ID alone never proves identity, including a single match.
        if (
          matches.length === 1 &&
          (!row.sent_copy_uid ||
            BigInt(row.sent_copy_uid as string) === matches[0])
        ) {
          collector.begin("UID FETCH", matches[0]);
          await context.client.fetchOne(
            String(matches[0]),
            { uid: true, source: true, flags: true },
            { uid: true },
          );
          const body = collector.finish().body;
          verifiedFlags = collector.finish().flags;
          verifiedModseq = collector.finish().modseq;
          if (
            body &&
            body.length === mime.length &&
            createHash("sha256").update(body).digest("hex") ===
              createHash("sha256").update(mime).digest("hex")
          )
            destinationUid = matches[0];
        }
      }
      await context.retireSocket();
      if (lookup && destinationUid === null) {
        if (row.sent_copy_status !== "saved") {
          // Resume adopted the UUID; failure settlement must retain uncertainty.
          await publication.fail(
            authority,
            "append",
            intent,
            attempt,
            "uncertain_remote_execution",
            options(),
          );
        }
        settled = true;
        return;
      }
      let linked:
        { id: string; flags: string[]; modseq: bigint | null } | undefined;
      if (lookup && destinationUid !== null && verifiedFlags) {
        linked = await executor.transaction(async (db) => {
          const [existing] =
            await db.execute(sql`select m.id,p.flags,p.modseq from mailbox_messages p join messages m on m.id=p.message_id
            where p.mailbox_id=${identity.mailbox}::uuid and p.uid_validity=${epoch}::bigint and p.uid=${destinationUid}::bigint
            and m.rfc_message_id=${String(row.message_id)} and maildock_receiving_active_source(${identity.account}::uuid,p.mailbox_id,m.id,p.uid_validity,p.uid,${identity.configurationVersion}::bigint)`);
          if (
            !existing ||
            (existing.modseq === null
              ? null
              : BigInt(existing.modseq as string)) !== verifiedModseq ||
            JSON.stringify(existing.flags) !== JSON.stringify(verifiedFlags)
          )
            return undefined;
          return {
            id: String(existing.id),
            flags: verifiedFlags!,
            modseq: verifiedModseq,
          };
        }, options());
      }
      await settle(
        () =>
          publication.appendResult(
            authority,
            intent,
            attempt,
            {
              kind: lookup ? "lookup" : "append",
              complete: true,
              taggedOk: true,
              destinationEpoch: destinationUid === null ? null : epoch,
              destinationUid,
              message: linked?.id ?? null,
              flags: linked?.flags ?? ["\\Seen"],
              modseq: linked?.modseq ?? null,
              ...(!lookup ? { accepted: true } : {}),
            },
            options(),
          ),
        linked
          ? "succeeded"
          : destinationUid === null
            ? "awaiting_uid"
            : "awaiting_metadata",
      );
    },
  };
}
