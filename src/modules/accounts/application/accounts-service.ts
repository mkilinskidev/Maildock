import { GmailSyncRepository } from "../../mail/infrastructure/gmail-sync-repository";
import {
  MailTransportRouter,
  GmailReceiveUnsupportedError,
  type ProviderCapabilities,
  type ReceiveDiagnostic,
} from "../domain/receive-transport";
import type { ApplicationEventService } from "../../diagnostics/application/application-event-service";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  accountCredentialContext,
  accountIdentitySchema,
  createAccountInputSchema,
  updateAccountInputSchema,
  sentCopyPolicyUpdateSchema,
  type SentCopyPolicy,
  type CreateAccountInput,
  type UpdateAccountInput,
} from "../domain/account";
import type {
  ConnectionReport,
  MailProvider,
  ProviderAccount,
  ProviderImapAccount,
} from "../domain/mail-provider";
import type { SecretEncryption } from "../../../shared/application/secret-encryption";
import type { MailboxDiscoveryScheduler } from "./mailbox-discovery-scheduler";
import type { Database } from "../../../shared/infrastructure/database/database";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";
import type { OAuthProviderRegistry } from "./oauth-provider-registry";

export class MailAccountNotFoundError extends Error {
  constructor() {
    super("Mail account not found.");
    this.name = "MailAccountNotFoundError";
  }
}

export class DisabledMailAccountError extends Error {
  constructor() {
    super("Disabled mail accounts cannot run provider work.");
    this.name = "DisabledMailAccountError";
  }
}

type AccountRow = typeof mailAccounts.$inferSelect;

export type MailAccountView = Readonly<{
  id: string;
  sortOrder: number;
  displayName: string;
  senderDisplayName: string;
  email: string;
  enabled: boolean;
  sentCopyPolicy: SentCopyPolicy;
  providerType: "imap_smtp" | "gmail_smtp";
  receiveTransport: "imap" | "gmail";
  capabilities: ProviderCapabilities;
  receiveDiagnostic: ReceiveDiagnostic;
  authMethod: "password" | "oauth2";
  oauthProviderId?: string | null;
  oauthProviderName?: string | null;
  oauthAuthorizationPath?: string | null;
  oauthStatus: "connected" | "reconnect_required" | null;
  imap: Readonly<{
    host: string | null;
    port: number | null;
    security: "tls" | "starttls" | null;
    username: string | null;
    hasStoredPassword: boolean;
  }>;
  smtp: Readonly<{
    host: string;
    port: number;
    security: "tls" | "starttls";
    useImapCredentials: boolean;
    username?: string;
    hasStoredPassword: boolean;
  }>;
  connectionStatus: "unverified" | "verified" | "error";
  imapResult: Readonly<{
    status: "untested" | "success" | "error";
    error?: string;
  }>;
  smtpResult: Readonly<{
    status: "untested" | "success" | "error";
    error?: string;
  }>;
  lastSuccessfulConnectionTestAt: string | null;
  mailboxDiscovery: Readonly<{
    status: "not_started" | "pending" | "running" | "success" | "failed";
    error: string | null;
    requestedAt: string | null;
    startedAt: string | null;
    lastSuccessfulAt: string | null;
    capabilities: readonly string[];
  }>;
  createdAt: string;
  updatedAt: string;
}>;

function toView(
  row: AccountRow,
  oauth?: OAuthProviderRegistry,
): MailAccountView {
  const definition = oauth
    ?.list()
    .find((provider) => provider.id === row.oauthProviderId)
    ?.getDefinition();
  return {
    id: row.id,
    sortOrder: row.sortOrder,
    displayName: row.displayName,
    senderDisplayName: row.senderDisplayName,
    email: row.email,
    enabled: row.enabled,
    sentCopyPolicy: row.sentCopyPolicy as SentCopyPolicy,
    providerType: row.providerType as MailAccountView["providerType"],
    receiveTransport: new MailTransportRouter().resolve(row),
    capabilities: new MailTransportRouter().capabilities(
      row,
      row.imapCapabilities,
    ),
    receiveDiagnostic:
      row.providerType === "gmail_smtp"
        ? new MailTransportRouter().gmail.diagnostic()
        : {
            transport: "imap",
            status: row.imapStatus as ReceiveDiagnostic["status"],
            ...(row.imapError ? { error: row.imapError } : {}),
          },
    authMethod: row.authMethod as "password" | "oauth2",
    oauthProviderId: row.oauthProviderId,
    oauthProviderName: definition?.name ?? row.oauthProviderId,
    oauthAuthorizationPath: definition?.authorizationPath ?? null,
    oauthStatus: row.oauthStatus as MailAccountView["oauthStatus"],
    imap: {
      host: row.imapHost,
      port: row.imapPort,
      security: row.imapSecurity as "tls" | "starttls",
      username: row.imapUsername,
      hasStoredPassword: row.imapPassword !== null,
    },
    smtp: {
      host: row.smtpHost,
      port: row.smtpPort,
      security: row.smtpSecurity as "tls" | "starttls",
      useImapCredentials: row.smtpUsesImapCredentials,
      ...(row.smtpUsername ? { username: row.smtpUsername } : {}),
      hasStoredPassword: row.smtpPassword !== null,
    },
    connectionStatus:
      row.connectionStatus as MailAccountView["connectionStatus"],
    imapResult: {
      status: row.imapStatus as MailAccountView["imapResult"]["status"],
      ...(row.imapError ? { error: row.imapError } : {}),
    },
    smtpResult: {
      status: row.smtpStatus as MailAccountView["smtpResult"]["status"],
      ...(row.smtpError ? { error: row.smtpError } : {}),
    },
    lastSuccessfulConnectionTestAt:
      row.lastSuccessfulConnectionTestAt?.toISOString() ?? null,
    mailboxDiscovery: {
      status:
        row.mailboxDiscoveryStatus as MailAccountView["mailboxDiscovery"]["status"],
      error: row.mailboxDiscoveryError,
      requestedAt: row.mailboxDiscoveryRequestedAt?.toISOString() ?? null,
      startedAt: row.mailboxDiscoveryStartedAt?.toISOString() ?? null,
      lastSuccessfulAt:
        row.lastSuccessfulMailboxDiscoveryAt?.toISOString() ?? null,
      capabilities: row.imapCapabilities,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AccountsService {
  constructor(
    private readonly database: Database,
    private readonly encryption: SecretEncryption,
    private readonly provider: MailProvider,
    private readonly discoveryScheduler?: MailboxDiscoveryScheduler,
    private readonly oauth?: OAuthProviderRegistry,
    private readonly events?: ApplicationEventService,
    readonly transportRouter = new MailTransportRouter(),
  ) {}

  async list(): Promise<MailAccountView[]> {
    const rows = await this.database
      .select()
      .from(mailAccounts)
      .orderBy(mailAccounts.sortOrder, mailAccounts.createdAt, mailAccounts.id);
    return rows.map((row) => toView(row, this.oauth));
  }

  async move(id: string, direction: "up" | "down"): Promise<MailAccountView[]> {
    z.uuid().parse(id);
    z.enum(["up", "down"]).parse(direction);
    return this.database.transaction(async (transaction) => {
      // Serialize relative moves so simultaneous requests use the latest order.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('maildock-account-order'))`,
      );
      const rows = await transaction
        .select()
        .from(mailAccounts)
        .orderBy(
          mailAccounts.sortOrder,
          mailAccounts.createdAt,
          mailAccounts.id,
        )
        .for("update");
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) throw new MailAccountNotFoundError();
      const neighbor = rows[index + (direction === "up" ? -1 : 1)];
      if (neighbor) {
        const current = rows[index];
        await transaction
          .update(mailAccounts)
          .set({ sortOrder: neighbor.sortOrder })
          .where(eq(mailAccounts.id, current.id));
        await transaction
          .update(mailAccounts)
          .set({ sortOrder: current.sortOrder })
          .where(eq(mailAccounts.id, neighbor.id));
      }
      const ordered = await transaction
        .select()
        .from(mailAccounts)
        .orderBy(
          mailAccounts.sortOrder,
          mailAccounts.createdAt,
          mailAccounts.id,
        );
      return ordered.map((row) => toView(row, this.oauth));
    });
  }

  async get(id: string): Promise<MailAccountView> {
    return toView(await this.getRow(id), this.oauth);
  }

  async create(input: CreateAccountInput): Promise<MailAccountView> {
    const parsed = createAccountInputSchema.parse(input);
    const now = new Date();
    const [created] = await this.database
      .insert(mailAccounts)
      .values({
        id: parsed.id,
        displayName: parsed.displayName,
        senderDisplayName: parsed.senderDisplayName ?? parsed.displayName,
        email: parsed.email.toLowerCase(),
        enabled: parsed.enabled,
        sentCopyPolicy: parsed.sentCopyPolicy ?? "server",
        providerType: "imap_smtp",
        imapHost: parsed.imap.host,
        imapPort: parsed.imap.port,
        imapSecurity: parsed.imap.security,
        imapUsername: parsed.imap.username,
        imapPassword: this.encryption.encrypt(
          parsed.imap.password,
          accountCredentialContext(parsed.id, "imap"),
        ),
        smtpHost: parsed.smtp.host,
        smtpPort: parsed.smtp.port,
        smtpSecurity: parsed.smtp.security,
        smtpUsesImapCredentials: parsed.smtp.useImapCredentials,
        smtpUsername: parsed.smtp.useImapCredentials
          ? null
          : parsed.smtp.username,
        smtpPassword: parsed.smtp.useImapCredentials
          ? null
          : this.encryption.encrypt(
              parsed.smtp.password!,
              accountCredentialContext(parsed.id, "smtp"),
            ),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Mail account was not created.");
    if (created.enabled) await this.scheduleDiscovery(created.id);
    return created.enabled ? this.get(created.id) : toView(created, this.oauth);
  }

  async update(
    id: string,
    input: UpdateAccountInput | { sentCopyPolicy: SentCopyPolicy },
  ): Promise<MailAccountView> {
    const policyOnly = sentCopyPolicyUpdateSchema.safeParse(input);
    if (policyOnly.success) {
      await this.getRow(id);
      await this.database
        .update(mailAccounts)
        .set({
          sentCopyPolicy: policyOnly.data.sentCopyPolicy,
          updatedAt: new Date(),
        })
        .where(eq(mailAccounts.id, id));
      return this.get(id);
    }
    const parsed = updateAccountInputSchema.parse(input);
    const current = await this.getRow(id);
    if (current.authMethod !== "password") throw new MailAccountNotFoundError();
    let smtpPassword = current.smtpPassword;
    if (parsed.smtp.useImapCredentials) smtpPassword = null;
    else if (parsed.smtp.password) {
      smtpPassword = this.encryption.encrypt(
        parsed.smtp.password,
        accountCredentialContext(id, "smtp"),
      );
    } else if (current.smtpUsesImapCredentials || !smtpPassword) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["smtp", "password"],
          message: "SMTP password is required.",
        },
      ]);
    }

    const [updated] = await this.database
      .update(mailAccounts)
      .set({
        displayName: parsed.displayName,
        senderDisplayName:
          parsed.senderDisplayName ?? current.senderDisplayName,
        email: parsed.email.toLowerCase(),
        enabled: parsed.enabled,
        sentCopyPolicy: parsed.sentCopyPolicy ?? current.sentCopyPolicy,
        imapHost: parsed.imap.host,
        imapPort: parsed.imap.port,
        imapSecurity: parsed.imap.security,
        imapUsername: parsed.imap.username,
        imapPassword: parsed.imap.password
          ? this.encryption.encrypt(
              parsed.imap.password,
              accountCredentialContext(id, "imap"),
            )
          : current.imapPassword,
        smtpHost: parsed.smtp.host,
        smtpPort: parsed.smtp.port,
        smtpSecurity: parsed.smtp.security,
        smtpUsesImapCredentials: parsed.smtp.useImapCredentials,
        smtpUsername: parsed.smtp.useImapCredentials
          ? null
          : parsed.smtp.username,
        smtpPassword,
        workRevision: sql`${mailAccounts.workRevision} + 1`,
        connectionStatus: "unverified",
        imapStatus: "untested",
        imapError: null,
        smtpStatus: "untested",
        smtpError: null,
        updatedAt: new Date(),
      })
      .where(eq(mailAccounts.id, id))
      .returning();
    if (!updated) throw new MailAccountNotFoundError();
    if (updated.enabled) await this.scheduleDiscovery(updated.id);
    return updated.enabled ? this.get(updated.id) : toView(updated, this.oauth);
  }

  async updateIdentity(
    id: string,
    input: unknown,
    database = this.database,
  ): Promise<void> {
    const parsed = accountIdentitySchema.parse(input);
    const [current] = await database
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, id))
      .for("update");
    if (!current) throw new MailAccountNotFoundError();
    if (
      current.authMethod === "oauth2" &&
      parsed.email.toLowerCase() !== current.email.toLowerCase()
    ) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["email"],
          message: "OAuth mailbox identity is managed by the provider.",
        },
      ]);
    }
    await database
      .update(mailAccounts)
      .set({
        ...parsed,
        email: parsed.email.toLowerCase(),
        updatedAt: new Date(),
      })
      .where(eq(mailAccounts.id, id));
  }

  async setEnabled(id: string, enabled: boolean): Promise<MailAccountView> {
    const [updated] = await this.database
      .update(mailAccounts)
      .set({
        enabled,
        workRevision: sql`${mailAccounts.workRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(mailAccounts.id, id))
      .returning();
    if (!updated) throw new MailAccountNotFoundError();
    if (enabled) await this.scheduleDiscovery(id);
    return enabled ? this.get(id) : toView(updated, this.oauth);
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.database
      .delete(mailAccounts)
      .where(eq(mailAccounts.id, id))
      .returning({ id: mailAccounts.id });
    if (deleted.length === 0) throw new MailAccountNotFoundError();
  }

  async testUnsaved(input: CreateAccountInput): Promise<ConnectionReport> {
    const parsed = createAccountInputSchema.parse(input);
    return this.provider.testConnection(
      this.providerInputFromSubmitted(parsed),
    );
  }

  async testExisting(
    id: string,
    input?: UpdateAccountInput,
  ): Promise<ConnectionReport> {
    const row = await this.getRow(id);
    if (input && row.authMethod !== "password")
      throw new MailAccountNotFoundError();
    if (this.transportRouter.resolve(row) === "gmail") {
      const diagnostic = this.transportRouter.gmail.diagnostic();
      const smtp = await this.getProviderSmtpAccountForWork(id);
      const smtpResult = (await this.provider.testSmtpConnection?.(smtp)) ?? {
        success: false as const,
        category: "internal_error" as const,
        message: "SMTP verification is unavailable.",
      };
      const report: ConnectionReport = {
        imap: {
          success: false,
          category: "verification_failed",
          message: diagnostic.error!,
        },
        smtp: smtpResult,
      };
      await this.database
        .update(mailAccounts)
        .set({
          connectionStatus: "error",
          imapStatus: "error",
          imapError: diagnostic.error,
          smtpStatus: smtpResult.success ? "success" : "error",
          smtpError: smtpResult.success ? null : smtpResult.message,
        })
        .where(
          and(
            eq(mailAccounts.id, id),
            eq(mailAccounts.workRevision, row.workRevision),
          ),
        );
      return report;
    }
    const providerInput = input
      ? this.providerInputFromEdit(row, updateAccountInputSchema.parse(input))
      : await this.providerInputFromRow(row);
    const report = await this.provider.testConnection(providerInput);
    const bothSuccessful = report.imap.success && report.smtp.success;
    await this.database
      .update(mailAccounts)
      .set({
        connectionStatus: bothSuccessful ? "verified" : "error",
        imapStatus: report.imap.success ? "success" : "error",
        imapError: report.imap.success ? null : report.imap.message,
        smtpStatus: report.smtp.success ? "success" : "error",
        smtpError: report.smtp.success ? null : report.smtp.message,
        ...(bothSuccessful
          ? { lastSuccessfulConnectionTestAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(mailAccounts.id, id));
    await this.events?.record(
      bothSuccessful ? "account.connected" : "account.connection_failed",
      {
        accountId: id,
        details: {
          category: !report.imap.success
            ? report.imap.category
            : !report.smtp.success
              ? report.smtp.category
              : undefined,
        },
      },
    );
    return report;
  }

  async requestMailboxDiscovery(id: string): Promise<MailAccountView> {
    const row = await this.getRow(id);
    if (!row.enabled) throw new DisabledMailAccountError();
    await this.scheduleDiscovery(id);
    return this.get(id);
  }

  async getProviderImapAccountForWork(
    id: string,
    expectedRevision?: string,
  ): Promise<ProviderImapAccount> {
    const row = await this.getRow(id);
    if (!row.enabled) throw new DisabledMailAccountError();
    this.transportRouter.requireImap(row, expectedRevision);
    const credential = await this.resolveCredential(row);
    await this.assertWorkRevision(id, row.workRevision.toString());
    return {
      accountId: row.id,
      revision: row.workRevision.toString(),
      imap: {
        host: row.imapHost!,
        port: row.imapPort!,
        security: row.imapSecurity as "tls" | "starttls",
        username: row.imapUsername!,
        credential,
      },
    };
  }

  async getProviderSmtpAccountForWork(id: string) {
    const row = await this.getRow(id);
    if (!row.enabled) throw new DisabledMailAccountError();
    if (
      !row.smtpHost ||
      (row.authMethod === "oauth2" && row.oauthStatus !== "connected")
    )
      throw new Error("The sending account is not configured.");
    this.transportRouter.forWork(row);
    return {
      accountId: row.id,
      smtp: {
        host: row.smtpHost,
        port: row.smtpPort,
        security: row.smtpSecurity as "tls" | "starttls",
        username: row.smtpUsesImapCredentials
          ? row.imapUsername!
          : row.smtpUsername!,
        credential:
          row.authMethod === "oauth2" || row.smtpUsesImapCredentials
            ? await this.resolveCredential(row)
            : {
                kind: "password" as const,
                password: this.encryption.decrypt(
                  row.smtpPassword,
                  accountCredentialContext(row.id, "smtp"),
                ),
              },
      },
    };
  }

  async receiveWorkIdentity(id: string, expectedRevision?: string) {
    const row = await this.getRow(id);
    const transport = this.transportRouter.forWork(row, expectedRevision);
    return {
      accountId: row.id,
      transport,
      revision: row.workRevision.toString(),
    };
  }

  async assertWorkRevision(id: string, revision: string) {
    return this.receiveWorkIdentity(id, revision);
  }

  private async getRow(id: string): Promise<AccountRow> {
    const [row] = await this.database
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, id))
      .limit(1);
    if (!row) throw new MailAccountNotFoundError();
    return row;
  }

  private providerInputFromSubmitted(
    input: CreateAccountInput,
  ): ProviderAccount {
    return {
      accountId: input.id,
      imap: {
        host: input.imap.host,
        port: input.imap.port,
        security: input.imap.security,
        username: input.imap.username,
        credential: { kind: "password", password: input.imap.password },
      },
      smtp: {
        host: input.smtp.host,
        port: input.smtp.port,
        security: input.smtp.security,
        username: input.smtp.useImapCredentials
          ? input.imap.username
          : input.smtp.username!,
        credential: {
          kind: "password",
          password: input.smtp.useImapCredentials
            ? input.imap.password
            : input.smtp.password!,
        },
      },
    };
  }

  private async scheduleDiscovery(id: string): Promise<void> {
    const row = await this.getRow(id);
    this.transportRouter.forWork(row);
    if (this.transportRouter.resolve(row) === "gmail") {
      await new GmailSyncRepository(this.database).blockUnsupported(
        id,
        row.workRevision,
      );
      await this.database
        .update(mailAccounts)
        .set({
          mailboxDiscoveryStatus: "failed",
          mailboxDiscoveryError: new GmailReceiveUnsupportedError().message,
          imapStatus: "error",
          imapError: new GmailReceiveUnsupportedError().message,
        })
        .where(
          and(
            eq(mailAccounts.id, id),
            eq(mailAccounts.workRevision, row.workRevision),
          ),
        );
      return;
    }
    if (!this.discoveryScheduler) return;
    const now = new Date();
    try {
      const scheduled = await this.discoveryScheduler.schedule(id);
      if (scheduled) {
        await this.database
          .update(mailAccounts)
          .set({
            mailboxDiscoveryStatus: "pending",
            mailboxDiscoveryError: null,
            mailboxDiscoveryRequestedAt: now,
            updatedAt: now,
          })
          .where(eq(mailAccounts.id, id));
      } else {
        await this.database
          .update(mailAccounts)
          .set({
            mailboxDiscoveryStatus: "pending",
            mailboxDiscoveryError: null,
            mailboxDiscoveryRequestedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(mailAccounts.id, id),
              eq(mailAccounts.mailboxDiscoveryStatus, "failed"),
            ),
          );
      }
    } catch {
      await this.database
        .update(mailAccounts)
        .set({
          mailboxDiscoveryStatus: "failed",
          mailboxDiscoveryError: "Mailbox discovery could not be scheduled.",
          updatedAt: now,
        })
        .where(eq(mailAccounts.id, id));
    }
  }

  private async resolveCredential(
    row: AccountRow,
  ): Promise<ProviderAccount["imap"]["credential"]> {
    if (row.authMethod === "oauth2") {
      if (!this.oauth)
        throw new Error("OAuth credential resolver is unavailable.");
      return {
        kind: "oauth2",
        accessToken: await this.oauth
          .get(row.oauthProviderId)
          .accessToken(row.id),
      };
    }
    return {
      kind: "password",
      password: this.encryption.decrypt(
        row.imapPassword,
        accountCredentialContext(row.id, "imap"),
      ),
    };
  }

  private async providerInputFromRow(
    row: AccountRow,
  ): Promise<ProviderAccount> {
    this.transportRouter.requireImap(row);
    const imapCredential = await this.resolveCredential(row);
    return {
      accountId: row.id,
      imap: {
        host: row.imapHost!,
        port: row.imapPort!,
        security: row.imapSecurity as "tls" | "starttls",
        username: row.imapUsername!,
        credential: imapCredential,
      },
      smtp: {
        host: row.smtpHost,
        port: row.smtpPort,
        security: row.smtpSecurity as "tls" | "starttls",
        username: row.smtpUsesImapCredentials
          ? row.imapUsername!
          : row.smtpUsername!,
        credential: row.smtpUsesImapCredentials
          ? imapCredential
          : {
              kind: "password",
              password: this.encryption.decrypt(
                row.smtpPassword,
                accountCredentialContext(row.id, "smtp"),
              ),
            },
      },
    };
  }

  private providerInputFromEdit(
    row: AccountRow,
    input: UpdateAccountInput,
  ): ProviderAccount {
    if (
      !input.smtp.useImapCredentials &&
      !input.smtp.password &&
      (row.smtpUsesImapCredentials || !row.smtpPassword)
    ) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["smtp", "password"],
          message: "SMTP password is required.",
        },
      ]);
    }
    const imapPassword =
      input.imap.password ??
      this.encryption.decrypt(
        row.imapPassword,
        accountCredentialContext(row.id, "imap"),
      );
    const smtpPassword = input.smtp.useImapCredentials
      ? imapPassword
      : (input.smtp.password ??
        this.encryption.decrypt(
          row.smtpPassword,
          accountCredentialContext(row.id, "smtp"),
        ));
    return {
      accountId: row.id,
      imap: {
        host: input.imap.host,
        port: input.imap.port,
        security: input.imap.security,
        username: input.imap.username,
        credential: { kind: "password", password: imapPassword },
      },
      smtp: {
        host: input.smtp.host,
        port: input.smtp.port,
        security: input.smtp.security,
        username: input.smtp.useImapCredentials
          ? input.imap.username
          : input.smtp.username!,
        credential: { kind: "password", password: smtpPassword },
      },
    };
  }
}
