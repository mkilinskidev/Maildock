import type { TransportSecurity } from "./account";

export type ProviderConnection = Readonly<{
  host: string;
  port: number;
  security: TransportSecurity;
  username: string;
  credential:
    | Readonly<{ kind: "password"; password: string }>
    | Readonly<{ kind: "oauth2"; accessToken: string }>;
}>;

export type ProviderAccount = Readonly<{
  accountId: string;
  imap: ProviderConnection;
  smtp: ProviderConnection;
}>;

export type ProviderImapAccount = Pick<ProviderAccount, "accountId" | "imap"> &
  Readonly<{
    oauthProviderId?: string | null;
    signal?: AbortSignal;
  }>;

export type ConnectionFailureCategory =
  | "dns_or_host_unreachable"
  | "connection_timeout"
  | "tls_certificate_failure"
  | "authentication_rejected"
  | "starttls_unavailable"
  | "verification_failed"
  | "server_rejected"
  | "server_unavailable"
  | "connection_lost"
  | "mailbox_unavailable"
  | "internal_error";

/** The step of a mailbox synchronization that was running when it failed. */
export const syncPhases = [
  "connect",
  "open_mailbox",
  "search",
  "fetch",
  "flags",
  "status",
  "save",
] as const;
export type SyncPhase = (typeof syncPhases)[number];

/**
 * Fixed protocol tokens describing a provider failure. They never carry server
 * response text, command arguments or exception messages.
 */
export type ProviderFailureDiagnostics = Readonly<{
  imapSessionId?: string;
  phase?: SyncPhase;
  imapStatus?: "NO" | "BAD";
  imapResponseCode?: string;
  errorCode?: string;
}>;

export type ProtocolConnectionResult =
  | Readonly<{ success: true }>
  | Readonly<{
      success: false;
      category: ConnectionFailureCategory;
      message: string;
    }>;

export type ConnectionReport = Readonly<{
  imap: ProtocolConnectionResult;
  smtp: ProtocolConnectionResult;
}>;

export class MailProviderOperationError extends Error {
  readonly category: ConnectionFailureCategory;
  readonly diagnostics: ProviderFailureDiagnostics;

  constructor(
    failure: Exclude<ProtocolConnectionResult, { success: true }>,
    diagnostics: ProviderFailureDiagnostics = {},
  ) {
    super(failure.message);
    this.name = "MailProviderOperationError";
    this.category = failure.category;
    this.diagnostics = diagnostics;
  }
}

export class MailboxEpochChangedError extends Error {
  constructor() {
    super(
      "Mailbox UIDVALIDITY changed; recent metadata rebuild was scheduled.",
    );
  }
}

export const relevantImapCapabilities = [
  "IMAP4REV2",
  "IDLE",
  "CONDSTORE",
  "QRESYNC",
  "MOVE",
  "UIDPLUS",
  "SPECIAL-USE",
  "LIST-EXTENDED",
  "LIST-STATUS",
  "OBJECTID",
] as const;

export type RelevantImapCapability = (typeof relevantImapCapabilities)[number];

/** Provider-neutral mailbox metadata. Integer observations use decimal strings
 * so protocol-sized values never cross the boundary as unsafe JS numbers. */
export type RemoteMailbox = Readonly<{
  remotePath: string;
  name: string;
  delimiter: string | null;
  attributes: readonly string[];
  selectable: boolean;
  specialUse: readonly string[];
  subscribed?: boolean;
  providerMailboxId?: string;
  messageCount?: string;
  unseenCount?: string;
  uidValidity?: string;
  uidNext?: string;
  highestModseq?: string;
}>;

export type MailboxDiscoveryResult = Readonly<{
  mailboxes: readonly RemoteMailbox[];
  capabilities: readonly RelevantImapCapability[];
}>;

export type RemoteAddress = Readonly<{ name?: string; address?: string }>;
export type RemoteEnvelope = Readonly<{
  date?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  from: readonly RemoteAddress[];
  sender: readonly RemoteAddress[];
  replyTo: readonly RemoteAddress[];
  to: readonly RemoteAddress[];
  cc: readonly RemoteAddress[];
  bcc: readonly RemoteAddress[];
}>;

export type RemoteMimePart = Readonly<{
  part: string | null;
  type: string;
  disposition: string | null;
  filename: string | null;
  encoding: string | null;
  size: string | null;
  contentId: string | null;
  parameters: Readonly<Record<string, string>>;
  dispositionParameters: Readonly<Record<string, string>>;
  children: readonly RemoteMimePart[];
}>;

export type RemoteMessageMetadata = Readonly<{
  uid: string;
  modseq?: string;
  providerEmailId?: string;
  internalDate: string;
  size: string;
  flags: readonly string[];
  envelope: RemoteEnvelope;
  mimeStructure?: RemoteMimePart;
  hasAttachments: boolean;
}>;

export type RecentMailboxSyncRequest = Readonly<{
  remotePath: string;
  cutoff: Date;
  batchSize: number;
}>;

export type RecentMailboxSyncSink = Readonly<{
  selected(uidValidity: string): Promise<void>;
  batch(messages: readonly RemoteMessageMetadata[]): Promise<void>;
}>;

export type RecentMailboxSyncResult = Readonly<{
  uidValidity: string;
  messageCount: number;
}>;

export type BackfillMailboxSyncRequest = Readonly<{
  remotePath: string;
  frontier: string | null;
  /** UIDs covered by one call (one job). */
  chunkSize: number;
  /**
   * UIDs per SEARCH + FETCH + verify + chunk() unit inside the call, newest
   * first; defaults to chunkSize (a single unit).
   */
  subBatchSize?: number;
}>;

export type BackfillMailboxSyncSink = Readonly<{
  selected(uidValidity: string, initialFrontier: string): Promise<void>;
  chunk(
    messages: readonly RemoteMessageMetadata[],
    nextFrontier: string,
  ): Promise<void>;
  /**
   * Asked only at a safe boundary: the previous FETCH is drained and its
   * chunk() committed, and more UIDs of this call remain. true ends the call
   * normally (no further FETCH, regular mailbox close and logout).
   */
  shouldYield?(): Promise<boolean>;
}>;

export type RemoteFlagDelta = Readonly<{
  uid: string;
  flags: readonly string[];
  modseq?: string;
}>;

export type DeltaMailboxSnapshot = Readonly<{
  lastSeenUid: string;
  highestModseq: string | null;
  localUids: readonly string[];
  emptyBootstrapCutoff?: Date;
}>;

export type DeltaMailboxSyncSink = Readonly<{
  selected(uidValidity: string): Promise<DeltaMailboxSnapshot>;
  advanceUid(uid: string): Promise<void>;
  newBatch(
    messages: readonly RemoteMessageMetadata[],
    throughUid: string,
  ): Promise<void>;
  flagsBatch(changes: readonly RemoteFlagDelta[]): Promise<void>;
  removed(uids: readonly string[]): Promise<void>;
  completed(
    observation: Readonly<{
      uidNext: string;
      messageCount: string;
      unseenCount: string | null;
      highestModseq: string | null;
      condstore: boolean;
    }>,
  ): Promise<void>;
}>;

export type DisplayContentRequest = Readonly<{
  remotePath: string;
  uid: string;
  expectedUidValidity: string;
  parts: readonly Readonly<{
    part: string;
    type: "text/plain" | "text/html";
  }>[];
  maxPartBytes: number;
}>;
export type DisplayContentResult = Readonly<{
  plainText: string | null;
  html: string | null;
}>;

export type RemoteMutationRequest = Readonly<{
  sourcePath: string;
  uidValidity: string;
  uid: string;
  action: "mark_read" | "mark_unread" | "flag" | "unflag" | "archive" | "trash";
  destinationPath?: string;
  modseq?: string;
}>;
export type RemoteMutationResult = Readonly<{
  outcome: "applied" | "source_missing" | "conflict";
  destinationUidValidity?: string;
  destinationUid?: string;
}>;

export interface MailProvider {
  /** Adapter retains the connection until the streaming consumer has finished. */
  fetchAttachment?<T>(
    account: ProviderImapAccount,
    request: Readonly<{
      remotePath: string;
      uid: string;
      expectedUidValidity: string;
      partId: string;
      maxBytes: number;
    }>,
    consume: (bytes: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<T>;
  appendMessage?(
    account: ProviderImapAccount,
    request: SentCopyAppendRequest,
    mime: Buffer,
  ): Promise<SentCopyAppendResult>;
  findSentCopy?(
    account: ProviderImapAccount,
    remotePath: string,
    messageId: string,
  ): Promise<SentCopyLookupResult>;
  deliverMessage?(
    account: Pick<ProviderAccount, "accountId" | "smtp">,
    envelope: Readonly<{ from: string; to: string[] }>,
    mime: Buffer,
  ): Promise<SmtpDeliveryResult>;
  testConnection(account: ProviderAccount): Promise<ConnectionReport>;
  listMailboxes(account: ProviderImapAccount): Promise<MailboxDiscoveryResult>;
  synchronizeRecentMailbox(
    account: ProviderImapAccount,
    request: RecentMailboxSyncRequest,
    sink: RecentMailboxSyncSink,
  ): Promise<RecentMailboxSyncResult>;
  synchronizeBackfillMailbox?(
    account: ProviderImapAccount,
    request: BackfillMailboxSyncRequest,
    sink: BackfillMailboxSyncSink,
  ): Promise<void>;
  synchronizeDeltaMailbox?(
    account: ProviderImapAccount,
    remotePath: string,
    batchSize: number,
    sink: DeltaMailboxSyncSink,
  ): Promise<void>;
  fetchMessageContent(
    account: ProviderImapAccount,
    request: DisplayContentRequest,
  ): Promise<DisplayContentResult>;
  mutateMessage?(
    account: ProviderImapAccount,
    request: RemoteMutationRequest,
  ): Promise<RemoteMutationResult>;
}

export type SmtpDeliveryResult =
  | { outcome: "accepted"; acceptedCount: number; rejectedCount: number }
  | { outcome: "definite_failure"; retryable: boolean; message: string }
  | { outcome: "uncertain" };

export type SentCopyAppendRequest = Readonly<{
  remotePath: string;
  flags: string[];
  internalDate: Date;
}>;
export type SentCopyIdentity = Readonly<{ uidValidity?: string; uid?: string }>;
export type SentCopyAppendResult =
  | ({ outcome: "saved" } & SentCopyIdentity)
  | { outcome: "failed" | "uncertain" };
export type SentCopyLookupResult =
  | ({ outcome: "found" } & SentCopyIdentity)
  | { outcome: "not_found" | "uncertain" };
