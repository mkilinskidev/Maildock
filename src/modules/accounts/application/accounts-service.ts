import { credentialAvailability } from "../domain/credential-availability";
import { randomUUID } from "node:crypto";
import type { CredentialBudget } from "../infrastructure/oauth-refresh";
import type { ImapDiagnostics } from "../../mail/infrastructure/receiving-diagnostic-rpc";
import { diagnosticUnavailable } from "../../mail/infrastructure/receiving-diagnostic-rpc";
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
  removalStatus: "active" | "removing";
  sentCopyPolicy: SentCopyPolicy;
  providerType: "imap_smtp";
  authMethod: "password" | "oauth2";
  oauthProviderId?: string | null;
  oauthProviderName?: string | null;
  oauthAuthorizationPath?: string | null;
  oauthStatus: "connected" | "reconnect_required" | null;
  credentialAvailability?: ReturnType<typeof credentialAvailability>;
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
    removalStatus: row.removalRequestedAt ? "removing" : "active",
    sentCopyPolicy: row.sentCopyPolicy as SentCopyPolicy,
    providerType: "imap_smtp",
    authMethod: row.authMethod as "password" | "oauth2",
    oauthProviderId: row.oauthProviderId,
    oauthProviderName: definition?.name ?? row.oauthProviderId,
    oauthAuthorizationPath: definition?.authorizationPath ?? null,
    oauthStatus: row.oauthStatus as MailAccountView["oauthStatus"],
    credentialAvailability: credentialAvailability(row),
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
    private readonly diagnostics?: ImapDiagnostics,
    private readonly smtpDiagnostics?: {
      testSmtp: (
        connection: ProviderAccount["smtp"],
        signal?: AbortSignal,
      ) => Promise<ConnectionReport["smtp"]>;
    },
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
    const updated = await this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, id))
        .for("update");
      if (!current) throw new MailAccountNotFoundError();
      if (current.authMethod !== "password")
        throw new MailAccountNotFoundError();
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

      const [updated] = await transaction
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
          imapPassword:
            parsed.imap.password &&
            parsed.imap.password !==
              this.encryption.decrypt(
                current.imapPassword,
                accountCredentialContext(id, "imap"),
              )
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
      return updated;
    });
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
      .set({ enabled, updatedAt: new Date() })
      .where(eq(mailAccounts.id, id))
      .returning();
    if (!updated) throw new MailAccountNotFoundError();
    if (enabled) await this.scheduleDiscovery(id);
    return enabled ? this.get(id) : toView(updated, this.oauth);
  }

  async delete(id: string): Promise<{ status: "removed" | "removing" }> {
    z.uuid().parse(id);
    await this.getRow(id);
    const result = await this.removalTransaction(
      sql`select maildock_account_remove_start(${id}::uuid) as removed`,
    );
    return { status: result.removed === true ? "removed" : "removing" };
  }

  /** One bounded local-only transaction; missing accounts are settled queue no-ops. */
  async cleanupRemoval(id: string): Promise<number> {
    z.uuid().parse(id);
    const result = await this.removalTransaction(
      sql`select maildock_account_remove_batch(${id}::uuid) as affected`,
    );
    return Number(result.affected);
  }

  private async removalTransaction(statement: ReturnType<typeof sql>) {
    return this.database.transaction(async (transaction) => {
      // Set before the function statement: PostgreSQL statement_timeout does not
      // start a new timer when set inside the currently executing function.
      await transaction.execute(sql`set local statement_timeout='2000ms'`);
      await transaction.execute(sql`set local lock_timeout='1000ms'`);
      await transaction.execute(
        sql`set local idle_in_transaction_session_timeout='2000ms'`,
      );
      const [result] = await transaction.execute(statement);
      return result;
    });
  }

  /** Keyset repair of existing terminal account rows, independent of queue delivery. */
  async repairRemovals(
    enqueue: (id: string) => Promise<unknown>,
  ): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const rows = await this.database.execute(sql`select id from mail_accounts
        where removal_requested_at is not null and (${after}::uuid is null or id>${after}::uuid)
        order by id limit 32`);
      for (const row of rows) await enqueue(row.id as string);
      if (rows.length < 32) return;
      after = rows.at(-1)!.id as string;
    }
  }

  async testUnsaved(
    input: CreateAccountInput,
    signal?: AbortSignal,
  ): Promise<ConnectionReport> {
    const parsed = createAccountInputSchema.parse(input);
    const account = this.providerInputFromSubmitted(parsed);
    const [imap, smtp] = await Promise.all([
      this.diagnostics?.test({
        identity: { ephemeral: randomUUID() },
        connection: account.imap,
        signal,
      }) ?? Promise.resolve(diagnosticUnavailable),
      this.smtpDiagnostics?.testSmtp(account.smtp, signal) ??
        Promise.resolve(diagnosticUnavailable),
    ]);
    return { imap, smtp };
  }

  async testExisting(
    id: string,
    input?: UpdateAccountInput,
    signal?: AbortSignal,
  ): Promise<ConnectionReport> {
    const row = await this.getRow(id);
    if (!row.enabled || row.removalRequestedAt)
      throw new DisabledMailAccountError();
    if (input && row.authMethod !== "password")
      throw new MailAccountNotFoundError();
    const edited = input
      ? this.providerInputFromEdit(row, updateAccountInputSchema.parse(input))
      : undefined;
    // IMAP resolution belongs to the elected worker. SMTP resolves independently
    // so an owner outage cannot disable sending or its connection test.
    const imapTask =
      this.diagnostics?.test({
        identity: {
          account: id,
          configurationVersion: row.configurationVersion,
          receivingLifecycleVersion: row.receivingLifecycleVersion,
        },
        connection: edited?.imap,
        signal,
      }) ?? Promise.resolve(diagnosticUnavailable);
    const runSmtp = async () => {
      try {
        const account = edited ?? (await this.providerInputFromRow(row));
        return (
          (await this.smtpDiagnostics?.testSmtp(account.smtp, signal)) ??
          diagnosticUnavailable
        );
      } catch {
        return {
          success: false,
          category: "authentication_rejected",
          message: "SMTP credentials unavailable. Reconnect the account.",
        } as const;
      }
    };
    // Web and worker have separate refresh coalescers. Finish the IMAP grant
    // acquisition first so a normal saved OAuth test does not race its own SMTP
    // refresh across processes. Unavailable IMAP still proceeds to SMTP.
    const smtpTask =
      row.authMethod === "oauth2" ? imapTask.then(runSmtp) : runSmtp();
    const [imap, smtp] = await Promise.all([imapTask, smtpTask]);
    // Edited tests never publish status for the persisted configuration.
    if (!input && !signal?.aborted) {
      await this.database
        .update(mailAccounts)
        .set({
          smtpStatus: smtp.success ? "success" : "error",
          smtpError: smtp.success ? null : smtp.message,
          // IMAP status is written only inside the elected, fenced handler.
          connectionStatus: sql`case when ${imap.success} and ${mailAccounts.imapStatus}='success' and ${smtp.success} then 'verified' else 'error' end`,
          ...(imap.success && smtp.success
            ? { lastSuccessfulConnectionTestAt: new Date() }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mailAccounts.id, id),
            eq(mailAccounts.enabled, true),
            eq(mailAccounts.configurationVersion, row.configurationVersion),
            eq(
              mailAccounts.receivingLifecycleVersion,
              row.receivingLifecycleVersion,
            ),
            eq(mailAccounts.smtpHost, row.smtpHost),
            eq(mailAccounts.smtpPort, row.smtpPort),
            eq(mailAccounts.smtpSecurity, row.smtpSecurity),
            eq(
              mailAccounts.smtpUsesImapCredentials,
              row.smtpUsesImapCredentials,
            ),
            sql`${mailAccounts.smtpUsername} is not distinct from ${row.smtpUsername}`,
            sql`${mailAccounts.smtpPassword} is not distinct from ${row.smtpPassword ? JSON.stringify(row.smtpPassword) : null}::jsonb`,
          ),
        );
      await this.events?.record(
        imap.success && smtp.success
          ? "account.connected"
          : "account.connection_failed",
        {
          accountId: id,
          details: {
            category: !imap.success
              ? imap.category
              : !smtp.success
                ? smtp.category
                : undefined,
          },
        },
      );
    }
    return { imap, smtp };
  }

  async resolveReceivingConnection(id: string, budget: CredentialBudget) {
    const row = await this.getRow(id);
    if (
      !row.enabled ||
      row.removalRequestedAt ||
      row.configurationVersion !== budget.configurationVersion ||
      row.receivingLifecycleVersion !== budget.receivingLifecycleVersion
    )
      throw new DisabledMailAccountError();
    const credential = await this.resolveCredential(row, budget);
    const current = await this.getRow(id);
    if (
      !current.enabled ||
      current.removalRequestedAt ||
      current.configurationVersion !== row.configurationVersion ||
      current.receivingLifecycleVersion !== row.receivingLifecycleVersion ||
      current.oauthStatus === "reconnect_required" ||
      budget.signal?.aborted ||
      performance.now() >= budget.deadline
    )
      throw new DisabledMailAccountError();
    return {
      host: row.imapHost,
      port: row.imapPort,
      security: row.imapSecurity as "tls" | "starttls",
      username: row.imapUsername,
      credential,
    };
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

  async getProviderSmtpAccountForWork(id: string) {
    const row = await this.getRow(id);
    if (!row.enabled) throw new DisabledMailAccountError();
    if (
      !row.smtpHost ||
      (row.authMethod === "oauth2" && row.oauthStatus !== "connected")
    )
      throw new Error("The sending account is not configured.");
    const account = await this.providerInputFromRow(row);
    return { accountId: account.accountId, smtp: account.smtp };
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
    await this.database
      .update(mailAccounts)
      .set({
        mailboxDiscoveryStatus: "pending",
        mailboxDiscoveryError: null,
        mailboxDiscoveryRequestedAt: now,
        updatedAt: now,
      })
      .where(eq(mailAccounts.id, id));
    try {
      await this.discoveryScheduler.schedule(id);
    } catch {
      /* The elected heartbeat rediscovers the committed request. */
    }
  }

  private async resolveCredential(
    row: AccountRow,
    budget?: CredentialBudget,
  ): Promise<ProviderAccount["imap"]["credential"]> {
    if (row.authMethod === "oauth2") {
      if (!this.oauth)
        throw new Error("OAuth credential resolver is unavailable.");
      return {
        kind: "oauth2",
        accessToken: await this.oauth.get(row.oauthProviderId).accessToken(
          row.id,
          budget ?? {
            deadline: performance.now() + 10_000,
            configurationVersion: row.configurationVersion,
            receivingLifecycleVersion: row.receivingLifecycleVersion,
          },
        ),
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
