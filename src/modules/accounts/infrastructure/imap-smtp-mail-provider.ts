import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ListResponse,
  type MessageAddressObject,
  type MessageEnvelopeObject,
  type MessageStructureObject,
} from "imapflow";
import nodemailer from "nodemailer";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import {
  MailProviderOperationError,
  MailboxEpochChangedError,
  relevantImapCapabilities,
  type ConnectionFailureCategory,
  type DisplayContentRequest,
  type DisplayContentResult,
  type ConnectionReport,
  type MailboxDiscoveryResult,
  type MailProvider,
  type ProtocolConnectionResult,
  type ProviderAccount,
  type ProviderConnection,
  type ProviderImapAccount,
  type RemoteMailbox,
  type RelevantImapCapability,
  type RemoteAddress,
  type RemoteEnvelope,
  type RemoteMessageMetadata,
  type RemoteMimePart,
  type RecentMailboxSyncRequest,
  type RecentMailboxSyncResult,
  type RecentMailboxSyncSink,
  type DeltaMailboxSyncSink,
  type BackfillMailboxSyncRequest,
  type BackfillMailboxSyncSink,
} from "../domain/mail-provider";

const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 15_000;

type ImapClient = {
  connect(): Promise<unknown>;
  list(options?: {
    statusQuery?: {
      messages?: boolean;
      unseen?: boolean;
      uidNext?: boolean;
      uidValidity?: boolean;
      highestModseq?: boolean;
    };
  }): Promise<ListResponse[]>;
  capabilities: Map<string, boolean | number>;
  enabled: Set<string>;
  logout(): Promise<unknown>;
  close(): void;
  mailboxOpen(
    path: string,
    options: { readOnly: boolean },
  ): Promise<{
    uidValidity: bigint;
    uidNext?: number;
    exists?: number;
    highestModseq?: bigint;
    noModseq?: boolean;
  }>;
  status?(
    path: string,
    query: {
      messages: true;
      unseen: true;
      uidNext: true;
      highestModseq?: boolean;
    },
  ): Promise<
    | {
        messages?: number;
        unseen?: number;
        uidNext?: number;
        highestModseq?: bigint;
      }
    | false
  >;
  mailboxClose(): Promise<boolean>;
  download(
    range: number,
    part: string,
    options: { uid: true; maxBytes: number },
  ): Promise<{
    meta: {
      charset?: string;
      contentType?: string;
      disposition?: string | false;
      filename?: string;
    };
    content: Readable;
  }>;
  search(
    query: { since: Date },
    options: { uid: true },
  ): Promise<number[] | false | undefined>;
  fetch(
    range: string,
    query: Readonly<{
      uid: true;
      flags: true;
      envelope?: true;
      bodyStructure?: true;
      internalDate?: true;
      size?: true;
      modseq?: true;
      emailId?: true;
    }>,
    options: { uid: true; changedSince?: bigint },
  ): AsyncGenerator<FetchMessageObject, false | void, undefined>;
};
type SmtpTransport = {
  verify(): Promise<unknown>;
  close(): void;
};

export type ProtocolClientFactories = Readonly<{
  createImap(options: ImapFlowOptions): ImapClient;
  createSmtp(options: SMTPTransport.Options): SmtpTransport;
}>;

const defaultFactories: ProtocolClientFactories = {
  createImap: (options) => new ImapFlow(options),
  createSmtp: (options) => nodemailer.createTransport(options),
};

export function imapOptions(connection: ProviderConnection): ImapFlowOptions {
  const starttls = connection.security === "starttls";
  return {
    host: connection.host,
    port: connection.port,
    secure: !starttls,
    doSTARTTLS: starttls,
    auth:
      connection.credential.kind === "password"
        ? { user: connection.username, pass: connection.credential.password }
        : {
            user: connection.username,
            accessToken: connection.credential.accessToken,
          },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableAutoIdle: true,
    logger: false,
    tls: { rejectUnauthorized: true, servername: connection.host },
  };
}

export function smtpOptions(
  connection: ProviderConnection,
): SMTPTransport.Options {
  const starttls = connection.security === "starttls";
  return {
    host: connection.host,
    port: connection.port,
    secure: !starttls,
    requireTLS: starttls,
    ignoreTLS: false,
    auth:
      connection.credential.kind === "password"
        ? { user: connection.username, pass: connection.credential.password }
        : {
            type: "OAuth2",
            user: connection.username,
            accessToken: connection.credential.accessToken,
          },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true, servername: connection.host },
  };
}

function sanitizeError(
  error: unknown,
  protocol: "IMAP" | "SMTP",
): Exclude<ProtocolConnectionResult, { success: true }> {
  const candidate = error as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  const code =
    typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
  const message =
    typeof candidate?.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  let category: ConnectionFailureCategory = "internal_error";

  if (code === "EAUTH" || /auth|credential|login|password/.test(message)) {
    category = "authentication_rejected";
  } else if (/starttls/.test(message)) {
    category = "starttls_unavailable";
  } else if (
    [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(code) ||
    /certificate|tls|ssl/.test(message)
  ) {
    category = "tls_certificate_failure";
  } else if (code === "ETIMEDOUT" || /timed? out|timeout/.test(message)) {
    category = "connection_timeout";
  } else if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ].includes(code)
  ) {
    category = "dns_or_host_unreachable";
  } else if (protocol === "SMTP") {
    category = "verification_failed";
  }

  const descriptions: Record<ConnectionFailureCategory, string> = {
    dns_or_host_unreachable: "DNS lookup failed or the host is unreachable.",
    connection_timeout: "The connection timed out.",
    tls_certificate_failure: "TLS certificate validation failed.",
    authentication_rejected: `${protocol} authentication was rejected.`,
    starttls_unavailable: `${protocol} did not provide the required STARTTLS upgrade.`,
    verification_failed: "SMTP verification failed.",
    internal_error: `${protocol} connection failed.`,
  };
  if (
    protocol === "SMTP" &&
    category === "authentication_rejected" &&
    /5\.7\.139|smtpclientauthentication is disabled|smtp auth (?:is )?disabled/.test(
      message,
    )
  ) {
    return {
      success: false,
      category,
      message:
        "SMTP AUTH is disabled for this mailbox or tenant. Ask the mail administrator to enable authenticated SMTP.",
    };
  }
  return { success: false, category, message: descriptions[category] };
}

const STANDARD_SPECIAL_USE = new Set([
  "\\All",
  "\\Archive",
  "\\Drafts",
  "\\Flagged",
  "\\Junk",
  "\\Sent",
  "\\Trash",
]);

function decimal(value: number | bigint | undefined): string | undefined {
  return value === undefined ? undefined : value.toString(10);
}

export function normalizeMailbox(mailbox: ListResponse): RemoteMailbox {
  const attributes = [...mailbox.flags].sort();
  const specialUse = attributes.filter((attribute) =>
    STANDARD_SPECIAL_USE.has(attribute),
  );
  // INBOX is protocol-defined by its case-insensitive path, not guessed from a
  // localized display name. Other ImapFlow name heuristics are deliberately ignored.
  if (mailbox.path.toUpperCase() === "INBOX") specialUse.unshift("\\Inbox");
  if (
    mailbox.specialUseSource === "extension" &&
    mailbox.specialUse &&
    !specialUse.includes(mailbox.specialUse)
  ) {
    specialUse.push(mailbox.specialUse);
  }

  return {
    remotePath: mailbox.path,
    name: mailbox.name,
    delimiter: mailbox.delimiter || null,
    attributes,
    selectable:
      !mailbox.flags.has("\\Noselect") && !mailbox.flags.has("\\NonExistent"),
    specialUse,
    // ImapFlow intentionally reports true when no subscription source answers,
    // so only a reported false can be represented as reliable here.
    ...(mailbox.subscribed === false ? { subscribed: false } : {}),
    ...(mailbox.status?.messages === undefined
      ? {}
      : { messageCount: decimal(mailbox.status.messages) }),
    ...(mailbox.status?.unseen === undefined
      ? {}
      : { unseenCount: decimal(mailbox.status.unseen) }),
    ...(mailbox.status?.uidValidity === undefined
      ? {}
      : { uidValidity: decimal(mailbox.status.uidValidity) }),
    ...(mailbox.status?.uidNext === undefined
      ? {}
      : { uidNext: decimal(mailbox.status.uidNext) }),
    ...(mailbox.status?.highestModseq === undefined
      ? {}
      : { highestModseq: decimal(mailbox.status.highestModseq) }),
  };
}

export function normalizeCapabilities(
  capabilities: Iterable<string>,
  enabled: Iterable<string>,
): RelevantImapCapability[] {
  const available = new Set(
    [...capabilities, ...enabled].map((capability) => capability.toUpperCase()),
  );
  return relevantImapCapabilities.filter((capability) =>
    available.has(capability),
  );
}

function normalizeAddresses(
  addresses?: MessageAddressObject[],
): RemoteAddress[] {
  return (addresses ?? []).map((item) => ({
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.address === "string" ? { address: item.address } : {}),
  }));
}

export function normalizeEnvelope(
  envelope?: MessageEnvelopeObject,
): RemoteEnvelope {
  const parsedDate = envelope?.date ? new Date(envelope.date) : undefined;
  return {
    ...(parsedDate && !Number.isNaN(parsedDate.valueOf())
      ? { date: parsedDate.toISOString() }
      : {}),
    ...(typeof envelope?.subject === "string"
      ? { subject: envelope.subject }
      : {}),
    ...(typeof envelope?.messageId === "string"
      ? { messageId: envelope.messageId }
      : {}),
    ...(typeof envelope?.inReplyTo === "string"
      ? { inReplyTo: envelope.inReplyTo }
      : {}),
    from: normalizeAddresses(envelope?.from),
    sender: normalizeAddresses(envelope?.sender),
    replyTo: normalizeAddresses(envelope?.replyTo),
    to: normalizeAddresses(envelope?.to),
    cc: normalizeAddresses(envelope?.cc),
    bcc: normalizeAddresses(envelope?.bcc),
  };
}

export function normalizeMimeStructure(
  node: MessageStructureObject,
): RemoteMimePart {
  const parameters = { ...(node.parameters ?? {}) };
  const dispositionParameters = { ...(node.dispositionParameters ?? {}) };
  return {
    part: node.part ?? null,
    type: node.type.toLowerCase(),
    disposition: node.disposition?.toLowerCase() ?? null,
    filename: dispositionParameters.filename ?? parameters.name ?? null,
    encoding: node.encoding ?? null,
    size: node.size === undefined ? null : node.size.toString(10),
    contentId: node.id ?? null,
    parameters,
    dispositionParameters,
    children: (node.childNodes ?? []).map(normalizeMimeStructure),
  };
}

export function mimeHasAttachments(node?: RemoteMimePart): boolean {
  if (!node) return false;
  if (node.disposition === "attachment" || node.filename !== null) return true;
  return node.children.some(mimeHasAttachments);
}

export function normalizeMessage(
  message: FetchMessageObject,
): RemoteMessageMetadata {
  if (!message.internalDate || message.size === undefined)
    throw new Error(
      "IMAP metadata response omitted required INTERNALDATE or size.",
    );
  const internalDate = new Date(message.internalDate);
  if (Number.isNaN(internalDate.valueOf()))
    throw new Error("IMAP returned an invalid INTERNALDATE.");
  if (!Number.isSafeInteger(message.uid) || !Number.isSafeInteger(message.size))
    throw new Error(
      "IMAP returned metadata outside JavaScript's safe integer range.",
    );
  const mimeStructure = message.bodyStructure
    ? normalizeMimeStructure(message.bodyStructure)
    : undefined;
  return {
    uid: message.uid.toString(10),
    ...(message.modseq === undefined
      ? {}
      : { modseq: message.modseq.toString(10) }),
    ...(message.emailId ? { providerEmailId: message.emailId } : {}),
    internalDate: internalDate.toISOString(),
    size: message.size.toString(10),
    flags: [...(message.flags ?? [])].sort(),
    envelope: normalizeEnvelope(message.envelope),
    ...(mimeStructure ? { mimeStructure } : {}),
    hasAttachments: mimeHasAttachments(mimeStructure),
  };
}

export class ImapSmtpMailProvider implements MailProvider {
  constructor(
    private readonly factories: ProtocolClientFactories = defaultFactories,
  ) {}

  async testConnection(account: ProviderAccount): Promise<ConnectionReport> {
    return {
      imap: await this.testImap(account.imap),
      smtp: await this.testSmtp(account.smtp),
    };
  }

  async listMailboxes(
    account: ProviderImapAccount,
  ): Promise<MailboxDiscoveryResult> {
    const client = this.factories.createImap(imapOptions(account.imap));
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const listed = await client.list({
        statusQuery: {
          messages: true,
          unseen: true,
          uidNext: true,
          uidValidity: true,
          highestModseq: true,
        },
      });
      return {
        capabilities: normalizeCapabilities(
          client.capabilities.keys(),
          client.enabled,
        ),
        mailboxes: listed.map(normalizeMailbox),
      };
    } catch (error) {
      throw new MailProviderOperationError(sanitizeError(error, "IMAP"));
    } finally {
      if (connected) {
        try {
          await client.logout();
        } catch {
          // The discovery result/failure remains authoritative; close below.
        }
      }
      client.close();
    }
  }

  async synchronizeRecentMailbox(
    account: ProviderImapAccount,
    request: RecentMailboxSyncRequest,
    sink: RecentMailboxSyncSink,
  ): Promise<RecentMailboxSyncResult> {
    const client = this.factories.createImap(imapOptions(account.imap));
    let connected = false;
    let selected = false;
    try {
      await client.connect();
      connected = true;
      const mailbox = await client.mailboxOpen(request.remotePath, {
        readOnly: true,
      });
      selected = true;
      const uidValidity = mailbox.uidValidity.toString(10);
      await sink.selected(uidValidity);
      const found = await client.search(
        { since: request.cutoff },
        { uid: true },
      );
      if (found === false || found === undefined)
        throw new Error("Recent UID search failed.");
      const uids = found;
      let messageCount = 0;
      const query = {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
      } as const;
      for (let offset = 0; offset < uids.length; offset += request.batchSize) {
        const uidBatch = uids.slice(offset, offset + request.batchSize);
        const normalized: RemoteMessageMetadata[] = [];
        for await (const message of client.fetch(uidBatch.join(","), query, {
          uid: true,
        })) {
          normalized.push(normalizeMessage(message));
        }
        // The FETCH iterator is fully consumed before the sink can perform database work.
        await sink.batch(normalized);
        messageCount += normalized.length;
      }
      return { uidValidity, messageCount };
    } catch (error) {
      if (
        error instanceof MailProviderOperationError ||
        error instanceof MailboxEpochChangedError
      )
        throw error;
      throw new MailProviderOperationError(sanitizeError(error, "IMAP"));
    } finally {
      if (selected) {
        try {
          await client.mailboxClose();
        } catch {
          /* logout/close remains authoritative */
        }
      }
      if (connected) {
        try {
          await client.logout();
        } catch {
          /* close below */
        }
      }
      client.close();
    }
  }

  async synchronizeBackfillMailbox(
    account: ProviderImapAccount,
    request: BackfillMailboxSyncRequest,
    sink: BackfillMailboxSyncSink,
  ): Promise<void> {
    const client = this.factories.createImap(imapOptions(account.imap));
    let connected = false;
    let selected = false;
    try {
      await client.connect();
      connected = true;
      const mailbox = await client.mailboxOpen(request.remotePath, {
        readOnly: true,
      });
      selected = true;
      if (mailbox.uidNext === undefined)
        throw new Error("Mailbox UIDNEXT is unavailable.");
      const frontier =
        request.frontier === null
          ? BigInt(mailbox.uidNext) - 1n
          : BigInt(request.frontier);
      await sink.selected(mailbox.uidValidity.toString(), frontier.toString());
      if (frontier === 0n) {
        await sink.chunk([], "0");
        return;
      }
      const lower =
        frontier - BigInt(request.chunkSize) + 1n > 1n
          ? frontier - BigInt(request.chunkSize) + 1n
          : 1n;
      const uidSearch = client.search as unknown as (
        query: { uid: string },
        options: { uid: true },
      ) => Promise<number[] | false | undefined>;
      const found = await uidSearch.call(
        client,
        { uid: `${lower}:${frontier}` },
        { uid: true },
      );
      if (found === false || found === undefined)
        throw new Error("Historical UID search failed.");
      const uids = found.filter(
        (uid) => BigInt(uid) >= lower && BigInt(uid) <= frontier,
      );
      const query = {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
        modseq: true,
        emailId: true,
      } as const;
      const messages: RemoteMessageMetadata[] = [];
      if (uids.length) {
        for await (const item of client.fetch(uids.join(","), query, {
          uid: true,
        }))
          messages.push(normalizeMessage(item));
        const fetched = new Set(messages.map((item) => item.uid));
        const missing = uids.filter((uid) => !fetched.has(uid.toString()));
        if (missing.length) {
          const stillPresent = await uidSearch.call(
            client,
            { uid: missing.join(",") },
            { uid: true },
          );
          if (
            stillPresent === false ||
            stillPresent === undefined ||
            stillPresent.length
          )
            throw new Error(
              "Historical UID disappeared during FETCH; retrying range.",
            );
        }
      }
      await sink.chunk(messages, (lower - 1n).toString());
    } catch (error) {
      if (
        error instanceof MailboxEpochChangedError ||
        error instanceof MailProviderOperationError
      )
        throw error;
      throw new MailProviderOperationError(sanitizeError(error, "IMAP"));
    } finally {
      if (selected) {
        try {
          await client.mailboxClose();
        } catch {
          /* close below */
        }
      }
      if (connected) {
        try {
          await client.logout();
        } catch {
          /* close below */
        }
      }
      client.close();
    }
  }

  async synchronizeDeltaMailbox(
    account: ProviderImapAccount,
    remotePath: string,
    batchSize: number,
    sink: DeltaMailboxSyncSink,
  ): Promise<void> {
    const client = this.factories.createImap(imapOptions(account.imap));
    let connected = false;
    let selected = false;
    try {
      await client.connect();
      connected = true;
      const mailbox = await client.mailboxOpen(remotePath, { readOnly: true });
      selected = true;
      const snapshot = await sink.selected(mailbox.uidValidity.toString());
      let lastSeen = BigInt(snapshot.lastSeenUid);
      if (snapshot.emptyBootstrapCutoff) {
        // Preserve the recent-window boundary when Phase 1C found no placements.
        // SELECT's UIDNEXT is a frontier, not evidence that any individual UID exists.
        const frontier = BigInt((mailbox.uidNext ?? 1) - 1);
        const found = await client.search(
          { since: snapshot.emptyBootstrapCutoff },
          { uid: true },
        );
        if (found === false || found === undefined)
          throw new Error("Recent UID search failed.");
        const recent = found
          .filter((uid) => BigInt(uid) <= frontier)
          .sort((a, b) => a - b);
        const query = {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          size: true,
          modseq: true,
          emailId: true,
        } as const;
        for (let offset = 0; offset < recent.length; offset += batchSize) {
          const group = recent.slice(offset, offset + batchSize);
          const messages = [];
          for await (const item of client.fetch(group.join(","), query, {
            uid: true,
          }))
            messages.push(normalizeMessage(item));
          if (messages.length)
            await sink.newBatch(
              messages,
              messages
                .reduce(
                  (max, item) =>
                    BigInt(item.uid) > max ? BigInt(item.uid) : max,
                  lastSeen,
                )
                .toString(),
            );
        }
        await sink.advanceUid(frontier.toString());
        lastSeen = frontier;
      }
      const uidSearch = client.search as unknown as (
        query: { uid: string },
        options: { uid: true },
      ) => Promise<number[] | false | undefined>;
      {
        const found = await uidSearch.call(
          client,
          { uid: `${lastSeen + 1n}:*` },
          { uid: true },
        );
        if (found === false || found === undefined)
          throw new Error("New UID search failed.");
        const uids = found
          .filter((uid) => BigInt(uid) > lastSeen)
          .sort((a, b) => a - b);
        const query = {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          size: true,
          modseq: true,
          emailId: true,
        } as const;
        // An omitted FETCH response must keep the frontier below that UID.
        // Later fetched messages may be saved, but a retry must revisit the gap.
        let firstUnfetched: bigint | undefined;
        for (let offset = 0; offset < uids.length; offset += batchSize) {
          const group = uids.slice(offset, offset + batchSize);
          const messages = [];
          for await (const item of client.fetch(group.join(","), query, {
            uid: true,
          }))
            messages.push(normalizeMessage(item));
          const fetched = new Set(messages.map((item) => item.uid));
          for (const uid of group)
            if (!fetched.has(uid.toString()) && firstUnfetched === undefined)
              firstUnfetched = BigInt(uid);
          if (messages.length) {
            const through = messages.reduce(
              (max, item) =>
                BigInt(item.uid) > max &&
                (firstUnfetched === undefined ||
                  BigInt(item.uid) < firstUnfetched)
                  ? BigInt(item.uid)
                  : max,
              lastSeen,
            );
            await sink.newBatch(messages, through.toString());
            lastSeen = through;
          }
        }
      }
      const condstore =
        (client.capabilities.has("CONDSTORE") ||
          client.enabled.has("CONDSTORE")) &&
        !mailbox.noModseq &&
        mailbox.highestModseq !== undefined;
      if (condstore && snapshot.highestModseq !== null) {
        const changes = [];
        for await (const item of client.fetch(
          "1:*",
          { uid: true, flags: true, modseq: true },
          { uid: true, changedSince: BigInt(snapshot.highestModseq) },
        )) {
          changes.push({
            uid: item.uid.toString(),
            flags: [...(item.flags ?? [])],
            ...(item.modseq === undefined
              ? {}
              : { modseq: item.modseq.toString() }),
          });
          if (changes.length >= batchSize)
            await sink.flagsBatch(changes.splice(0));
        }
        if (changes.length) await sink.flagsBatch(changes);
      } else {
        // Without a valid MODSEQ baseline, reconcile every locally indexed UID.
        for (
          let offset = 0;
          offset < snapshot.localUids.length;
          offset += batchSize
        ) {
          const group = snapshot.localUids.slice(offset, offset + batchSize);
          const changes = [];
          for await (const item of client.fetch(
            group.join(","),
            { uid: true, flags: true, modseq: true },
            { uid: true },
          ))
            changes.push({
              uid: item.uid.toString(),
              flags: [...(item.flags ?? [])],
              ...(item.modseq === undefined
                ? {}
                : { modseq: item.modseq.toString() }),
            });
          if (changes.length) await sink.flagsBatch(changes);
        }
      }
      // SEARCH over known local UIDs is complete evidence for their absence. It never imports history.
      for (
        let offset = 0;
        offset < snapshot.localUids.length;
        offset += batchSize
      ) {
        const group = snapshot.localUids.slice(offset, offset + batchSize);
        const found = await uidSearch.call(
          client,
          { uid: group.join(",") },
          { uid: true },
        );
        if (found === false || found === undefined)
          throw new Error("Known UID reconciliation failed.");
        const present = new Set(found);
        const missing = group.filter((uid) => !present.has(Number(uid)));
        if (missing.length) await sink.removed(missing);
      }
      const status = await client.status?.(remotePath, {
        messages: true,
        unseen: true,
        uidNext: true,
        ...(condstore ? { highestModseq: true } : {}),
      });
      if (status === false)
        throw new Error("Mailbox status observation failed.");
      const observed = status ?? {};
      await sink.completed({
        uidNext: (observed.uidNext ?? mailbox.uidNext ?? 1).toString(),
        messageCount: (observed.messages ?? mailbox.exists ?? 0).toString(),
        unseenCount: observed.unseen?.toString() ?? null,
        // SELECT's MODSEQ predates all queries; a later STATUS could skip a concurrent flag change.
        highestModseq: condstore
          ? (mailbox.highestModseq?.toString() ?? null)
          : null,
        condstore,
      });
    } catch (error) {
      if (
        error instanceof MailProviderOperationError ||
        error instanceof MailboxEpochChangedError
      )
        throw error;
      throw new MailProviderOperationError(sanitizeError(error, "IMAP"));
    } finally {
      if (selected) await client.mailboxClose().catch(() => false);
      if (connected) await client.logout().catch(() => undefined);
      client.close();
    }
  }

  async fetchMessageContent(
    account: ProviderImapAccount,
    request: DisplayContentRequest,
  ): Promise<DisplayContentResult> {
    const client = this.factories.createImap(imapOptions(account.imap));
    let connected = false;
    let selected = false;
    try {
      const uid = Number(request.uid);
      if (!Number.isSafeInteger(uid) || uid < 1)
        throw new Error("Invalid remote UID.");
      await client.connect();
      connected = true;
      const mailbox = await client.mailboxOpen(request.remotePath, {
        readOnly: true,
      });
      selected = true;
      if (mailbox.uidValidity.toString(10) !== request.expectedUidValidity)
        throw new Error("Mailbox UIDVALIDITY changed.");
      const result: { plainText: string | null; html: string | null } = {
        plainText: null,
        html: null,
      };
      for (const selectedPart of request.parts) {
        if (!/^(?:[1-9]\d*)(?:\.[1-9]\d*)*$/.test(selectedPart.part))
          throw new Error("Invalid MIME part.");
        const downloaded = await client.download(uid, selectedPart.part, {
          uid: true,
          maxBytes: request.maxPartBytes + 1,
        });
        if (!downloaded.content)
          throw new Error("Selected MIME part is unavailable.");
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for await (const chunk of downloaded.content) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.length;
            if (length > request.maxPartBytes)
              throw new MailProviderOperationError({
                success: false,
                category: "verification_failed",
                message: "Message text part exceeds the configured size limit.",
              });
            chunks.push(bytes);
          }
        } catch (error) {
          downloaded.content.destroy();
          await finished(downloaded.content).catch(() => undefined);
          throw error;
        }
        if (
          downloaded.meta.contentType &&
          downloaded.meta.contentType !== selectedPart.type
        )
          throw new Error("MIME part type changed.");
        if (
          downloaded.meta.disposition === "attachment" ||
          downloaded.meta.filename
        )
          throw new Error("MIME part is an attachment.");
        // ImapFlow 2.0.6 download() decodes transfer encoding (or accepts
        // server-decoded BINARY) and converts recognized text charsets to UTF-8.
        // On successful conversion it changes meta.charset to "utf-8"; an
        // unsupported charset remains unchanged with unconverted bytes.
        const charset = downloaded.meta.charset
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        if (charset && !["utf8", "ascii", "usascii"].includes(charset))
          throw new MailProviderOperationError({
            success: false,
            category: "verification_failed",
            message: "Unsupported message charset.",
          });
        const bytes = Buffer.concat(chunks);
        if (
          (charset === "ascii" || charset === "usascii") &&
          bytes.some((byte) => byte > 0x7f)
        )
          throw new MailProviderOperationError({
            success: false,
            category: "verification_failed",
            message: "Message text does not match its declared charset.",
          });
        let value: string;
        try {
          // Missing charset is accepted only when the resulting bytes really
          // are UTF-8. Fatal decoding avoids silent replacement characters.
          value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new MailProviderOperationError({
            success: false,
            category: "verification_failed",
            message:
              "Message text is not valid UTF-8 after charset conversion.",
          });
        }
        if (selectedPart.type === "text/plain") result.plainText = value;
        else result.html = value;
      }
      return result;
    } catch (error) {
      if (error instanceof MailProviderOperationError) throw error;
      // Avoid leaking server text, paths, or message data through job failures.
      throw new MailProviderOperationError(sanitizeError(error, "IMAP"));
    } finally {
      if (selected) {
        try {
          await client.mailboxClose();
        } catch {
          /* close below */
        }
      }
      if (connected) {
        try {
          await client.logout();
        } catch {
          /* close below */
        }
      }
      client.close();
    }
  }

  private async testImap(
    connection: ProviderConnection,
  ): Promise<ProtocolConnectionResult> {
    const client = this.factories.createImap(imapOptions(connection));
    try {
      await client.connect();
      await client.logout();
      return { success: true };
    } catch (error) {
      return sanitizeError(error, "IMAP");
    } finally {
      client.close();
    }
  }

  private async testSmtp(
    connection: ProviderConnection,
  ): Promise<ProtocolConnectionResult> {
    const transport = this.factories.createSmtp(smtpOptions(connection));
    try {
      await transport.verify();
      return { success: true };
    } catch (error) {
      return sanitizeError(error, "SMTP");
    } finally {
      transport.close();
    }
  }
}
