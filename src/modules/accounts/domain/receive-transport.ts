export type ReceiveTransport = "imap" | "gmail";

export type AccountTransportIdentity = Readonly<{
  providerType: string;
  authMethod: string;
  oauthProviderId: string | null;
}>;

export class InvalidAccountTransportError extends Error {
  constructor() {
    super(
      "Invalid account provider, receiving transport or credential combination.",
    );
    this.name = "InvalidAccountTransportError";
  }
}

export class GmailReceiveUnsupportedError extends Error {
  constructor() {
    super(
      "Native Gmail receiving requires its API provider. IMAP receiving is unavailable for Google OAuth accounts.",
    );
    this.name = "GmailReceiveUnsupportedError";
  }
}

export class StaleAccountWorkError extends Error {
  constructor() {
    super(
      "Account work is stale, disabled or disconnected. Request new work after reconnecting.",
    );
    this.name = "StaleAccountWorkError";
  }
}

/** The persisted provider identity is the only routing authority. */
export function resolveReceiveTransport(
  account: AccountTransportIdentity,
): ReceiveTransport {
  if (
    account.providerType === "gmail_smtp" &&
    account.authMethod === "oauth2" &&
    account.oauthProviderId === "google"
  )
    return "gmail";
  if (
    account.providerType === "imap_smtp" &&
    ((account.authMethod === "password" && account.oauthProviderId === null) ||
      (account.authMethod === "oauth2" &&
        account.oauthProviderId === "microsoft"))
  )
    return "imap";
  throw new InvalidAccountTransportError();
}

export function assertAccountWork(
  account: AccountTransportIdentity & {
    enabled: boolean;
    oauthStatus: string | null;
    workRevision: bigint;
  },
  expectedRevision?: string,
): ReceiveTransport {
  const transport = resolveReceiveTransport(account);
  if (
    !account.enabled ||
    (account.authMethod === "oauth2" && account.oauthStatus !== "connected") ||
    (expectedRevision !== undefined &&
      account.workRevision.toString() !== expectedRevision)
  )
    throw new StaleAccountWorkError();
  return transport;
}

export type MessageLocator =
  | Readonly<{
      kind: "imap";
      accountId: string;
      mailboxId: string;
      path: string;
      uidValidity: string;
      uid: string;
    }>
  | Readonly<{ kind: "gmail"; accountId: string; messageId: string }>;
export type PartLocator =
  | Readonly<{
      kind: "imap";
      message: Extract<MessageLocator, { kind: "imap" }>;
      section: string;
    }>
  | Readonly<{
      kind: "gmail";
      message: Extract<MessageLocator, { kind: "gmail" }>;
      partId: string;
      attachmentId?: string;
    }>;

export type ReceiveProviderIdentity =
  | Readonly<{ kind: "imap"; provider: "password" | "microsoft" }>
  | Readonly<{ kind: "gmail"; provider: "google" }>;

export function resolveReceiveProvider(
  account: AccountTransportIdentity,
): ReceiveProviderIdentity {
  const transport = resolveReceiveTransport(account);
  return transport === "gmail"
    ? { kind: "gmail", provider: "google" }
    : {
        kind: "imap",
        provider: account.authMethod === "password" ? "password" : "microsoft",
      };
}

export type ProviderCapabilities = Readonly<{
  receiveTransport: ReceiveTransport;
  messageActions: boolean;
  moveMessages: boolean;
  serverManagedSent: boolean;
  remoteDrafts: false;
}>;
export function receiveCapabilities(
  account: AccountTransportIdentity,
  imapCapabilities: readonly string[] = [],
): ProviderCapabilities {
  const receiveTransport = resolveReceiveTransport(account);
  return {
    receiveTransport,
    messageActions: true,
    moveMessages:
      receiveTransport === "gmail" || imapCapabilities.includes("MOVE"),
    serverManagedSent: receiveTransport === "gmail",
    remoteDrafts: false,
  };
}

export type ReceiveDiagnostic = Readonly<{
  transport: ReceiveTransport;
  status: "untested" | "success" | "error";
  error?: string;
}>;

/** Fail-closed boundary for compositions missing native dependencies. */
export class UnsupportedGmailReceiveAdapter {
  async synchronize(_accountId: string, _revision: string): Promise<never> {
    void _accountId;
    void _revision;
    throw new GmailReceiveUnsupportedError();
  }
  async content(
    _locator: Extract<MessageLocator, { kind: "gmail" }>,
  ): Promise<never> {
    void _locator;
    throw new GmailReceiveUnsupportedError();
  }
  async attachment(
    _locator: Extract<PartLocator, { kind: "gmail" }>,
  ): Promise<never> {
    void _locator;
    throw new GmailReceiveUnsupportedError();
  }
  async mutate(
    _locator: Extract<MessageLocator, { kind: "gmail" }>,
  ): Promise<never> {
    void _locator;
    throw new GmailReceiveUnsupportedError();
  }
  diagnostic(): ReceiveDiagnostic {
    return {
      transport: "gmail",
      status: "error",
      error: new GmailReceiveUnsupportedError().message,
    };
  }
}

export class MailTransportRouter {
  gmail: GmailReceiveAdapter = new UnsupportedGmailReceiveAdapter();
  bindGmail(adapter: GmailReceiveAdapter) {
    this.gmail = adapter;
  }
  resolve = resolveReceiveTransport;
  identity = resolveReceiveProvider;
  capabilities = receiveCapabilities;
  forWork = assertAccountWork;
  requireImap(
    account: Parameters<typeof assertAccountWork>[0],
    revision?: string,
  ): void {
    if (this.forWork(account, revision) !== "imap")
      throw new GmailReceiveUnsupportedError();
  }
}

export interface GmailReceiveAdapter {
  synchronize(accountId: string, revision: string): Promise<unknown>;
  content(
    locator: Extract<MessageLocator, { kind: "gmail" }>,
  ): Promise<unknown>;
  attachment(
    locator: Extract<PartLocator, { kind: "gmail" }>,
  ): Promise<unknown>;
  mutate(
    locator: Extract<MessageLocator, { kind: "gmail" }>,
    request?: {
      action:
        | "mark_read"
        | "mark_unread"
        | "flag"
        | "unflag"
        | "archive"
        | "trash"
        | "move";
      destinationMailboxId?: string;
    },
  ): Promise<unknown>;
  diagnostic(): ReceiveDiagnostic;
}
