import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  readVerifiedBlob,
  type BlobStorage,
  type StoredBlob,
} from "../../../shared/application/blob-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "../../../shared/application/attachment-limits";
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

/** Completed decoder evidence; transfer/decoding is owned by R11/R12. */
export type CompletedRead = Readonly<{
  complete: true;
  taggedOk: true;
  streamComplete: true;
  decoded: true;
  eof: true;
  method: "BODY.PEEK";
  origin: 0;
  encodedBytes: bigint;
  part: string;
  epoch: bigint;
  uid: bigint;
}>;

const encode = (value: unknown) =>
  JSON.stringify(value, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );

/** Isolated SQL capability API. A successful claim is durable before wire work.
 * Unresolved outcomes require recover() before considering further execution.
 */
export class ReceivingPublication {
  constructor(
    private readonly executor: Pick<ReceivingExecutor, "transaction">,
    private readonly storage?: BlobStorage,
  ) {}

  async contentResult(
    owner: ReceivingOwner,
    source: PublicationSource,
    intent: string,
    attempt: string,
    evidence: CompletedRead &
      Readonly<{
        plainText: string | null;
        html: string | null;
        searchText: string;
      }>,
    options: Options,
  ) {
    const payload = encode(evidence);
    if (Buffer.byteLength(payload, "utf8") > 2 * 1024 * 1024)
      throw Error("Completed content evidence exceeds the publication bound");
    const captured = JSON.parse(payload) as Record<string, unknown>;
    const capturedOwner = { ...owner },
      capturedSource = { ...source, state: { ...source.state } },
      capturedOptions = { ...options };
    // Content-only parsing is outside SQL and need not load in STORE/election processes.
    const [{ EMAIL_HTML_POLICY, sanitizeEmailHtml }, { searchBodyText }] =
      await Promise.all([
        import("../infrastructure/sanitize-email-html"),
        import("../infrastructure/search-body-text"),
      ]);
    const sanitized =
      captured.html === null
        ? null
        : sanitizeEmailHtml(captured.html as string);
    delete captured.html;
    const completed = encode({
      ...captured,
      searchText: searchBodyText(
        captured.plainText as string | null,
        sanitized?.html ?? null,
      ),
      sanitizedHtml: sanitized?.html ?? null,
      remoteContentBlocked: sanitized?.remoteContentBlocked ?? false,
      policyVersion: EMAIL_HTML_POLICY,
      sanitized: true,
    });
    return this.cacheResult(
      "content",
      capturedOwner,
      capturedSource,
      intent,
      attempt,
      completed,
      capturedOptions,
    );
  }

  async attachmentResult(
    owner: ReceivingOwner,
    source: PublicationSource,
    intent: string,
    attempt: string,
    evidence: CompletedRead & Readonly<{ blob: StoredBlob }>,
    options: Options,
  ) {
    // Capture caller-owned data before the first await. Verification must never hold SQL locks.
    const actor = { ...owner },
      capturedSource = { ...source, state: { ...source.state } },
      capturedOptions = { ...options };
    const captured = JSON.parse(encode(evidence)) as Record<string, unknown>;
    const blob = { ...evidence.blob };
    delete captured.blob;
    if (!this.storage || !(await this.storage.exists(blob.key)))
      throw new Error("Finalized blob is missing");
    await readVerifiedBlob(
      this.storage,
      blob,
      DEFAULT_ATTACHMENT_LIMITS.maxAttachmentBytes,
    );
    if (!(await this.storage.exists(blob.key)))
      throw new Error("Finalized blob disappeared");
    const completed = encode({
      ...captured,
      stored: true,
      storageKey: blob.key,
      size: blob.size,
      sha256: blob.sha256,
    });
    return this.cacheResult(
      "attachment",
      actor,
      capturedSource,
      intent,
      attempt,
      completed,
      capturedOptions,
    );
  }

  private cacheResult(
    kind: "content" | "attachment",
    owner: ReceivingOwner,
    source: PublicationSource,
    intent: string,
    attempt: string,
    completed: string,
    options: Options,
  ) {
    const actor = owner.actor,
      term = owner.generation,
      mailbox = source.mailbox,
      binding = source.configuration,
      expected = encode(source.state);
    return this.executor.transaction(
      async (db) => {
        if (kind === "content")
          await db.execute(
            sql`select maildock_receiving_content_result(${actor}::uuid,${term}::bigint,${mailbox}::uuid,${expected}::jsonb,${binding}::bigint,${intent}::uuid,${attempt}::uuid,${completed}::jsonb)`,
          );
        else
          await db.execute(
            sql`select maildock_receiving_attachment_result(${actor}::uuid,${term}::bigint,${mailbox}::uuid,${expected}::jsonb,${binding}::bigint,${intent}::uuid,${attempt}::uuid,${completed}::jsonb)`,
          );
      },
      {
        ...options,
        deadline: Math.min(options.deadline, performance.now() + 2000),
      },
    );
  }

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
    attemptId = randomUUID(),
  ): Promise<Attempt> {
    const actor = owner.actor,
      term = owner.generation,
      mailbox = source.mailbox,
      binding = source.configuration,
      expected = encode(source.state),
      attempt = attemptId;
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
  ): Promise<{
    state: ReceivingState;
    intent: Record<string, unknown>;
    authority: {
      configuration: bigint;
      lifecycle: bigint;
      activeSource: boolean;
      path: string;
    };
  }> {
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
        const [authority] = await db.execute(sql`
          select a.configuration_version,a.receiving_lifecycle_version,b.remote_path,
            maildock_receiving_active_source(a.id,b.id,${value.intent.message_id as string}::uuid,
              ${value.intent.source_uid_validity as string}::bigint,${value.intent.source_uid as string}::bigint,
              ${value.intent.source_configuration_binding as string}::bigint) as active_source
          from mailboxes b join mail_accounts a on a.id=b.account_id where b.id=${mailbox}::uuid`);
        if (!authority) throw new Error("Missing recovery account identity");
        return {
          authority: {
            configuration: BigInt(authority.configuration_version as string),
            lifecycle: BigInt(authority.receiving_lifecycle_version as string),
            activeSource: authority.active_source === true,
            path: authority.remote_path as string,
          },
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
