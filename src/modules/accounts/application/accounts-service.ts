import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  accountCredentialContext,
  createAccountInputSchema,
  updateAccountInputSchema,
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
import type { MicrosoftOAuthService } from "../infrastructure/microsoft-oauth";

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
  displayName: string;
  email: string;
  enabled: boolean;
  providerType: "imap_smtp";
  authMethod: "password" | "oauth2";
  oauthStatus: "connected" | "reconnect_required" | null;
  imap: Readonly<{
    host: string;
    port: number;
    security: "tls" | "starttls";
    username: string;
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

function toView(row: AccountRow): MailAccountView {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    enabled: row.enabled,
    providerType: "imap_smtp",
    authMethod: row.authMethod as "password" | "oauth2",
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
    private readonly oauth?: MicrosoftOAuthService,
  ) {}

  async list(): Promise<MailAccountView[]> {
    const rows = await this.database
      .select()
      .from(mailAccounts)
      .orderBy(mailAccounts.createdAt);
    return rows.map(toView);
  }

  async get(id: string): Promise<MailAccountView> {
    return toView(await this.getRow(id));
  }

  async create(input: CreateAccountInput): Promise<MailAccountView> {
    const parsed = createAccountInputSchema.parse(input);
    const now = new Date();
    const [created] = await this.database
      .insert(mailAccounts)
      .values({
        id: parsed.id,
        displayName: parsed.displayName,
        email: parsed.email.toLowerCase(),
        enabled: parsed.enabled,
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
    return created.enabled ? this.get(created.id) : toView(created);
  }

  async update(
    id: string,
    input: UpdateAccountInput,
  ): Promise<MailAccountView> {
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
        email: parsed.email.toLowerCase(),
        enabled: parsed.enabled,
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
    return updated.enabled ? this.get(updated.id) : toView(updated);
  }

  async setEnabled(id: string, enabled: boolean): Promise<MailAccountView> {
    const [updated] = await this.database
      .update(mailAccounts)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(mailAccounts.id, id))
      .returning();
    if (!updated) throw new MailAccountNotFoundError();
    if (enabled) await this.scheduleDiscovery(id);
    return enabled ? this.get(id) : toView(updated);
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
  ): Promise<ProviderImapAccount> {
    const row = await this.getRow(id);
    if (!row.enabled) throw new DisabledMailAccountError();
    return {
      accountId: row.id,
      imap: {
        host: row.imapHost,
        port: row.imapPort,
        security: row.imapSecurity as "tls" | "starttls",
        username: row.imapUsername,
        credential: await this.resolveCredential(row),
      },
    };
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
        accessToken: await this.oauth.accessToken(row.id),
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
    const imapCredential = await this.resolveCredential(row);
    return {
      accountId: row.id,
      imap: {
        host: row.imapHost,
        port: row.imapPort,
        security: row.imapSecurity as "tls" | "starttls",
        username: row.imapUsername,
        credential: imapCredential,
      },
      smtp: {
        host: row.smtpHost,
        port: row.smtpPort,
        security: row.smtpSecurity as "tls" | "starttls",
        username: row.smtpUsesImapCredentials
          ? row.imapUsername
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
