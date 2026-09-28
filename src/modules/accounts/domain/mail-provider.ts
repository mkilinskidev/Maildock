import type { TransportSecurity } from "./account";

export type ProviderConnection = Readonly<{
  host: string;
  port: number;
  security: TransportSecurity;
  username: string;
  password: string;
}>;

export type ProviderAccount = Readonly<{
  accountId: string;
  imap: ProviderConnection;
  smtp: ProviderConnection;
}>;

export type ProviderImapAccount = Pick<ProviderAccount, "accountId" | "imap">;

export type ConnectionFailureCategory =
  | "dns_or_host_unreachable"
  | "connection_timeout"
  | "tls_certificate_failure"
  | "authentication_rejected"
  | "starttls_unavailable"
  | "verification_failed"
  | "internal_error";

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

  constructor(failure: Exclude<ProtocolConnectionResult, { success: true }>) {
    super(failure.message);
    this.name = "MailProviderOperationError";
    this.category = failure.category;
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

export interface MailProvider {
  testConnection(account: ProviderAccount): Promise<ConnectionReport>;
  listMailboxes(account: ProviderImapAccount): Promise<MailboxDiscoveryResult>;
  synchronizeRecentMailbox(
    account: ProviderImapAccount,
    request: RecentMailboxSyncRequest,
    sink: RecentMailboxSyncSink,
  ): Promise<RecentMailboxSyncResult>;
  fetchMessageContent(
    account: ProviderImapAccount,
    request: DisplayContentRequest,
  ): Promise<DisplayContentResult>;
}
