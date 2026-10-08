import { relations, sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgSequence,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
  customType,
} from "drizzle-orm/pg-core";
import type { EncryptedEnvelope } from "../../application/secret-encryption.js";
import type { OutgoingAddress } from "../../../modules/mail/domain/outgoing-message";
import type { RichDocument } from "../../../modules/mail/domain/rich-document";

export const outgoingMessages = pgTable(
  "outgoing_messages",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "restrict" }),
    from: jsonb("from").$type<OutgoingAddress>().notNull(),
    to: jsonb("to").$type<OutgoingAddress[]>().notNull(),
    cc: jsonb("cc").$type<OutgoingAddress[]>().notNull(),
    bcc: jsonb("bcc").$type<OutgoingAddress[]>().notNull(),
    subject: text("subject").notNull(),
    plainText: text("plain_text").notNull(),
    richDocument: jsonb("rich_document").$type<RichDocument>(),
    html: text("html"),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    references: jsonb("references").$type<string[]>().default([]).notNull(),
    mimeBase64: text("mime_base64"),
    mimeBlobId: uuid("mime_blob_id").references(() => blobs.id, {
      onDelete: "restrict",
    }),
    status: text("status").default("queued").notNull(),
    sentCopyPolicy: text("sent_copy_policy").default("server").notNull(),
    sentCopyStatus: text("sent_copy_status").default("not_required").notNull(),
    sentCopyError: text("sent_copy_error"),
    sentCopyMailboxId: uuid("sent_copy_mailbox_id").references(
      () => mailboxes.id,
      { onDelete: "set null" },
    ),
    sentCopyPath: text("sent_copy_path"),
    sentCopyUidValidity: bigint("sent_copy_uid_validity", { mode: "bigint" }),
    sentCopyUid: bigint("sent_copy_uid", { mode: "bigint" }),
    sentCopyStartedAt: timestamp("sent_copy_started_at", {
      withTimezone: true,
    }),
    sentCopySavedAt: timestamp("sent_copy_saved_at", { withTimezone: true }),
    sentCopySyncPending: boolean("sent_copy_sync_pending")
      .default(false)
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    error: text("error"),
    acceptedCount: integer("accepted_count"),
    rejectedCount: integer("rejected_count"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    smtpAcceptedAt: timestamp("smtp_accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "outgoing_messages_mime_source",
      sql`(${table.mimeBlobId} is not null and ${table.mimeBase64} is null) or (${table.mimeBlobId} is null and ${table.mimeBase64} is not null)`,
    ),
    check(
      "outgoing_messages_sent_copy_policy",
      sql`${table.sentCopyPolicy} in ('server', 'maildock')`,
    ),
    check(
      "outgoing_messages_sent_copy_status",
      sql`${table.sentCopyStatus} in ('not_required', 'pending', 'saving', 'saved', 'failed', 'uncertain')`,
    ),
    check(
      "outgoing_messages_sent_copy_delivery",
      sql`${table.sentCopyStatus} = 'not_required' or (${table.status} = 'sent' and ${table.sentCopyPolicy} = 'maildock')`,
    ),
    check(
      "outgoing_messages_sent_copy_sync",
      sql`not ${table.sentCopySyncPending} or ${table.sentCopyStatus} = 'saved'`,
    ),
    index("outgoing_messages_sent_copy_pending_idx").on(
      table.sentCopyStatus,
      table.sentCopySyncPending,
    ),
    check(
      "outgoing_messages_status",
      sql`${table.status} in ('queued', 'sending', 'sent', 'failed', 'uncertain')`,
    ),
    check("outgoing_messages_attempts", sql`${table.attempts} between 0 and 3`),
    check(
      "outgoing_messages_mime_size",
      sql`octet_length(${table.mimeBase64}) <= 1333336`,
    ),
    check(
      "outgoing_messages_recipients",
      sql`jsonb_array_length(${table.to}) + jsonb_array_length(${table.cc}) + jsonb_array_length(${table.bcc}) between 1 and 100`,
    ),
    uniqueIndex("outgoing_messages_message_id_unique").on(table.messageId),
    index("outgoing_messages_pending_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

/** Registry provides integrity and a conservative reference-aware GC seam.
 * Physical orphan objects may outlive DB failures; no age-based blob deletion. */
export const blobs = pgTable(
  "blobs",
  {
    id: uuid("id").primaryKey(),
    storageKey: text("storage_key").notNull().unique(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("blobs_size", sql`${table.size} >= 0`),
    check("blobs_sha256", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sourceMailboxId: uuid("source_mailbox_id").references(() => mailboxes.id, {
      onDelete: "set null",
    }),
    sourceUidValidity: bigint("source_uid_validity", {
      mode: "bigint",
    }).notNull(),
    sourceUid: bigint("source_uid", { mode: "bigint" }).notNull(),
    partId: text("part_id").notNull(),
    filename: text("filename"),
    contentType: text("content_type").notNull(),
    disposition: text("disposition"),
    contentId: text("content_id"),
    inline: boolean("inline").notNull(),
    visible: boolean("visible").notNull(),
    declaredSize: bigint("declared_size", { mode: "bigint" }),
    blobId: uuid("blob_id").references(() => blobs.id, {
      onDelete: "restrict",
    }),
    status: text("status").default("not_fetched").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("message_attachments_part_unique").on(
      table.messageId,
      table.partId,
    ),
    index("message_attachments_pending_idx").on(table.status),
    check(
      "message_attachments_status",
      sql`${table.status} in ('not_fetched', 'pending', 'fetching', 'ready', 'failed')`,
    ),
    check(
      "message_attachments_ready",
      sql`(${table.status} = 'ready') = (${table.blobId} is not null)`,
    ),
  ],
);

export const stagedAttachments = pgTable(
  "staged_attachments",
  {
    id: uuid("id").primaryKey(),
    draftId: uuid("draft_id"),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "restrict" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    status: text("status").default("ready").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "staged_attachments_status",
      sql`${table.status} in ('ready', 'removed', 'consumed')`,
    ),
    index("staged_attachments_expiry_idx").on(table.expiresAt),
  ],
);

export const outgoingMessageAttachments = pgTable(
  "outgoing_message_attachments",
  {
    outgoingMessageId: uuid("outgoing_message_id")
      .notNull()
      .references(() => outgoingMessages.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    resourceId: uuid("resource_id"),
    contentId: text("content_id"),
    inline: boolean("inline").default(false).notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "restrict" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.outgoingMessageId, table.position] }),
    check("outgoing_attachment_position", sql`${table.position} >= 0`),
  ],
);

export const instanceState = pgTable(
  "instance_state",
  {
    id: integer("id").primaryKey(),
    initializedAt: timestamp("initialized_at", { withTimezone: true }),
    bootstrapSecretDigest: text("bootstrap_secret_digest"),
    bootstrapExpiresAt: timestamp("bootstrap_expires_at", {
      withTimezone: true,
    }),
    ownerUserId: text("owner_user_id").references(() => user.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    passwordAlgorithm: text("password_algorithm"),
    conversationView: boolean("conversation_view").default(false).notNull(),
    notificationPreferences: jsonb("notification_preferences")
      .$type<
        import("../../../modules/mail/domain/notifications").NotificationPreferences
      >()
      .default({
        enabled: false,
        folders: "inbox",
        accountIds: null,
        backgroundOnly: true,
      })
      .notNull(),
    notificationSequence: bigint("notification_sequence", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    notificationCheckpoint: bigint("notification_checkpoint", {
      mode: "bigint",
    })
      .default(sql`0`)
      .notNull(),
    autoRead: jsonb("auto_read")
      .$type<{ mode: "immediately" | "after" | "manually"; seconds: number }>()
      .default({ mode: "after", seconds: 2 })
      .notNull(),
    passwordParameters: jsonb("password_parameters").$type<
      Record<string, number>
    >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("instance_state_singleton", sql`${table.id} = 1`),
    check(
      "instance_state_bootstrap",
      sql`(${table.bootstrapSecretDigest} is null and ${table.bootstrapExpiresAt} is null) or (${table.bootstrapSecretDigest} is not null and ${table.bootstrapSecretDigest} ~ '^[0-9a-f]{64}$' and ((${table.initializedAt} is null and ${table.ownerUserId} is null and ${table.bootstrapExpiresAt} is not null) or (${table.initializedAt} is not null and ${table.ownerUserId} is not null and ${table.bootstrapExpiresAt} is null)))`,
    ),
    check(
      "instance_state_owner_binding",
      sql`(${table.initializedAt} is null and ${table.ownerUserId} is null) or (${table.initializedAt} is not null and ${table.ownerUserId} is not null and length(trim(${table.ownerUserId})) > 0 and ${table.ownerUserId} = trim(${table.ownerUserId}))`,
    ),
  ],
);

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    username: text("username"),
    displayUsername: text("display_username"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_email_unique").on(table.email),
    uniqueIndex("user_username_unique").on(table.username),
  ],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    // Explicit verification is required by Maildock, including direct inserts.
    verified: boolean("verified").default(false).notNull(),
    failedVerificationCount: integer("failed_verification_count")
      .default(0)
      .notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("two_factor_user_id_unique").on(table.userId),
    index("two_factor_secret_idx").on(table.secret),
  ],
);

// A pending replacement remains here after expiry to block bootstrap fallback.
// It authorizes only enrollment of this exact factor, never login or business.
export const mfaReplacement = pgTable("mfa_replacement", {
  ownerUserId: text("owner_user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  factorId: text("factor_id").notNull(),
  tokenDigest: text("token_digest").notNull(),
  failedAttempts: integer("failed_attempts").default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Explicit offline restore receipt; ordinary startup never runs maintenance.
export const recoveryMaintenance = pgTable(
  "recovery_maintenance",
  {
    id: integer("id").primaryKey(),
    receiptId: uuid("receipt_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    factorId: text("factor_id").notNull(),
    recoveryCodesDigest: text("recovery_codes_digest").notNull(),
    status: text("status").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("recovery_maintenance_id_check", sql`${table.id} = 1`),
    check(
      "recovery_maintenance_status_check",
      sql`${table.status} in ('verified', 'pending_mfa')`,
    ),
  ],
);

// Host-authorized recovery persists until verified enrollment, not cookie expiry.
export const ownerRecovery = pgTable(
  "owner_recovery",
  {
    id: integer("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    generationId: uuid("generation_id").notNull(),
    factorId: text("factor_id")
      .notNull()
      .references(() => twoFactor.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    tokenDigest: text("token_digest"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
  },
  (table) => [
    check("owner_recovery_singleton", sql`${table.id} = 1`),
    check(
      "owner_recovery_attempts",
      sql`${table.failedAttempts} between 0 and 5`,
    ),
    check(
      "owner_recovery_token",
      sql`(${table.tokenDigest} is null and ${table.expiresAt} is null) or (${table.tokenDigest} ~ '^[0-9a-f]{64}$' and ${table.tokenDigest} is not null and ${table.expiresAt} is not null)`,
    ),
  ],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
    }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("session_token_unique").on(table.token),
    index("session_user_id_idx").on(table.userId),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const authAdmission = pgTable(
  "auth_admission",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "auth_admission_key",
      sql`${table.key} in ('work:password', 'work:mfa', 'work:management', 'manage:password', 'manage:factor')`,
    ),
    check("auth_admission_count", sql`${table.count} between 1 and 31`),
  ],
);

export const loginThrottle = pgTable("login_throttle", {
  key: text("key").primaryKey(),
  failureCount: integer("failure_count").default(0).notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const mailAccountOrderSequence = pgSequence("mail_account_order_seq", {
  maxValue: 2147483647,
  startWith: 1,
});

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey(),
    sortOrder: integer("sort_order")
      .default(sql`nextval('mail_account_order_seq')`)
      .notNull(),
    displayName: text("display_name").notNull(),
    senderDisplayName: text("sender_display_name").default("").notNull(),
    email: text("email").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    sentCopyPolicy: text("sent_copy_policy").default("server").notNull(),
    providerType: text("provider_type").default("imap_smtp").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecurity: text("imap_security").notNull(),
    imapUsername: text("imap_username").notNull(),
    imapPassword: jsonb("imap_password").$type<EncryptedEnvelope>(),
    authMethod: text("auth_method").default("password").notNull(),
    oauthProviderId: text("oauth_provider_id"),
    oauthCache: jsonb("oauth_cache").$type<EncryptedEnvelope>(),
    oauthHomeAccountId: text("oauth_home_account_id"),
    oauthStatus: text("oauth_status"),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecurity: text("smtp_security").notNull(),
    smtpUsesImapCredentials: boolean("smtp_uses_imap_credentials")
      .default(true)
      .notNull(),
    smtpUsername: text("smtp_username"),
    smtpPassword: jsonb("smtp_password").$type<EncryptedEnvelope>(),
    connectionStatus: text("connection_status").default("unverified").notNull(),
    imapStatus: text("imap_status").default("untested").notNull(),
    imapError: text("imap_error"),
    smtpStatus: text("smtp_status").default("untested").notNull(),
    smtpError: text("smtp_error"),
    lastSuccessfulConnectionTestAt: timestamp(
      "last_successful_connection_test_at",
      { withTimezone: true },
    ),
    mailboxDiscoveryStatus: text("mailbox_discovery_status")
      .default("not_started")
      .notNull(),
    mailboxDiscoveryError: text("mailbox_discovery_error"),
    mailboxDiscoveryRequestedAt: timestamp("mailbox_discovery_requested_at", {
      withTimezone: true,
    }),
    mailboxDiscoveryStartedAt: timestamp("mailbox_discovery_started_at", {
      withTimezone: true,
    }),
    lastSuccessfulMailboxDiscoveryAt: timestamp(
      "last_successful_mailbox_discovery_at",
      { withTimezone: true },
    ),
    imapCapabilities: text("imap_capabilities").array().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("mail_accounts_sort_order", sql`${table.sortOrder} > 0`),
    check(
      "mail_accounts_provider_type",
      sql`${table.providerType} = 'imap_smtp'`,
    ),
    check(
      "mail_accounts_sent_copy_policy",
      sql`${table.sentCopyPolicy} in ('server', 'maildock')`,
    ),
    check(
      "mail_accounts_imap_port",
      sql`${table.imapPort} between 1 and 65535`,
    ),
    check(
      "mail_accounts_smtp_port",
      sql`${table.smtpPort} between 1 and 65535`,
    ),
    check(
      "mail_accounts_imap_security",
      sql`${table.imapSecurity} in ('tls', 'starttls')`,
    ),
    check(
      "mail_accounts_smtp_security",
      sql`${table.smtpSecurity} in ('tls', 'starttls')`,
    ),
    check(
      "mail_accounts_connection_status",
      sql`${table.connectionStatus} in ('unverified', 'verified', 'error')`,
    ),
    check(
      "mail_accounts_imap_status",
      sql`${table.imapStatus} in ('untested', 'success', 'error')`,
    ),
    check(
      "mail_accounts_smtp_status",
      sql`${table.smtpStatus} in ('untested', 'success', 'error')`,
    ),
    check(
      "mail_accounts_mailbox_discovery_status",
      sql`${table.mailboxDiscoveryStatus} in ('not_started', 'pending', 'running', 'success', 'failed')`,
    ),
    check(
      "mail_accounts_smtp_credentials",
      sql`(${table.smtpUsesImapCredentials} and ${table.smtpUsername} is null and ${table.smtpPassword} is null) or (not ${table.smtpUsesImapCredentials} and ${table.smtpUsername} is not null and ${table.smtpPassword} is not null)`,
    ),
    check(
      "mail_accounts_auth_credential",
      sql`(${table.authMethod} = 'password' and ${table.oauthProviderId} is null and ${table.imapPassword} is not null and ${table.oauthCache} is null and ${table.oauthHomeAccountId} is null and ${table.oauthStatus} is null) or (${table.authMethod} = 'oauth2' and ${table.oauthProviderId} is not null and ${table.imapPassword} is null and ${table.smtpPassword} is null and ${table.oauthCache} is not null and ${table.oauthStatus} in ('connected', 'reconnect_required'))`,
    ),
    index("mail_accounts_enabled_idx").on(table.enabled),
    index("mail_accounts_email_idx").on(table.email),
  ],
);

export const oauthProviderConfigs = pgTable("oauth_provider_configs", {
  providerId: text("provider_id").primaryKey(),
  enabled: boolean("enabled").default(true).notNull(),
  clientId: text("client_id").notNull(),
  encryptedClientSecret: jsonb(
    "encrypted_client_secret",
  ).$type<EncryptedEnvelope>(),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .default({})
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const oauthAuthorizationStates = pgTable("oauth_authorization_states", {
  providerId: text("provider_id").notNull(),
  stateHash: text("state_hash").primaryKey(),
  sessionId: text("session_id").notNull(),
  codeVerifier: jsonb("code_verifier").$type<EncryptedEnvelope>().notNull(),
  accountId: uuid("account_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    remotePath: text("remote_path").notNull(),
    name: text("name").notNull(),
    delimiter: text("delimiter"),
    attributes: text("attributes").array().default([]).notNull(),
    specialUse: text("special_use").array().default([]).notNull(),
    selectable: boolean("selectable").notNull(),
    subscribed: boolean("subscribed"),
    providerMailboxId: text("provider_mailbox_id"),
    uidValidity: bigint("uid_validity", { mode: "bigint" }),
    uidNext: bigint("uid_next", { mode: "bigint" }),
    highestModseq: bigint("highest_modseq", { mode: "bigint" }),
    reportedMessageCount: bigint("reported_message_count", { mode: "bigint" }),
    reportedUnseenCount: bigint("reported_unseen_count", { mode: "bigint" }),
    lifecycleStatus: text("lifecycle_status").default("active").notNull(),
    firstDiscoveredAt: timestamp("first_discovered_at", {
      withTimezone: true,
    }).notNull(),
    lastDiscoveredAt: timestamp("last_discovered_at", {
      withTimezone: true,
    }).notNull(),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    uidValidityChangedAt: timestamp("uid_validity_changed_at", {
      withTimezone: true,
    }),
    uidValidityChangeCount: integer("uid_validity_change_count")
      .default(0)
      .notNull(),
    recentSyncStatus: text("recent_sync_status")
      .default("not_started")
      .notNull(),
    recentSyncRequestedAt: timestamp("recent_sync_requested_at", {
      withTimezone: true,
    }),
    recentSyncStartedAt: timestamp("recent_sync_started_at", {
      withTimezone: true,
    }),
    recentSyncCompletedAt: timestamp("recent_sync_completed_at", {
      withTimezone: true,
    }),
    recentSyncError: text("recent_sync_error"),
    recentSyncCutoff: timestamp("recent_sync_cutoff", { withTimezone: true }),
    recentSyncMessageCount: integer("recent_sync_message_count")
      .default(0)
      .notNull(),
    recentSyncUidValidity: bigint("recent_sync_uid_validity", {
      mode: "bigint",
    }),
    lastSuccessfulRecentSyncAt: timestamp("last_successful_recent_sync_at", {
      withTimezone: true,
    }),
    backfillUidValidity: bigint("backfill_uid_validity", { mode: "bigint" }),
    backfillFrontierUid: bigint("backfill_frontier_uid", { mode: "bigint" }),
    backfillStatus: text("backfill_status").default("not_started").notNull(),
    backfillError: text("backfill_error"),
    backfillCompletedAt: timestamp("backfill_completed_at", {
      withTimezone: true,
    }),
    deltaUidValidity: bigint("delta_uid_validity", { mode: "bigint" }),
    deltaLastSeenUid: bigint("delta_last_seen_uid", { mode: "bigint" }),
    deltaHighestModseq: bigint("delta_highest_modseq", { mode: "bigint" }),
    deltaSyncStatus: text("delta_sync_status").default("not_started").notNull(),
    deltaSyncError: text("delta_sync_error"),
    deltaSyncStartedAt: timestamp("delta_sync_started_at", {
      withTimezone: true,
    }),
    deltaSyncCompletedAt: timestamp("delta_sync_completed_at", {
      withTimezone: true,
    }),
    lastSuccessfulDeltaSyncAt: timestamp("last_successful_delta_sync_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "mailboxes_lifecycle_status",
      sql`${table.lifecycleStatus} in ('active', 'missing')`,
    ),
    check(
      "mailboxes_recent_sync_status",
      sql`${table.recentSyncStatus} in ('not_started', 'pending', 'running', 'success', 'failed')`,
    ),
    check(
      "mailboxes_delta_sync_status",
      sql`${table.deltaSyncStatus} in ('not_started', 'pending', 'running', 'success', 'failed')`,
    ),
    check(
      "mailboxes_backfill_status",
      sql`${table.backfillStatus} in ('not_started', 'pending', 'running', 'complete', 'failed')`,
    ),
    index("mailboxes_account_idx").on(table.accountId),
    index("mailboxes_account_path_idx").on(table.accountId, table.remotePath),
    uniqueIndex("mailboxes_account_provider_id_unique")
      .on(table.accountId, table.providerMailboxId)
      .where(sql`${table.providerMailboxId} is not null`),
    uniqueIndex("mailboxes_active_account_path_without_provider_id_unique")
      .on(table.accountId, table.remotePath)
      .where(
        sql`${table.providerMailboxId} is null and ${table.lifecycleStatus} = 'active'`,
      ),
  ],
);

export const mailboxRoles = pgTable(
  "mailbox_roles",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.role] }),
    check(
      "mailbox_roles_role",
      sql`${table.role} in ('archive', 'trash', 'sent', 'drafts', 'junk')`,
    ),
    check(
      "mailbox_roles_source",
      sql`${table.source} in ('special_use', 'manual')`,
    ),
    index("mailbox_roles_mailbox_idx").on(table.mailboxId),
  ],
);

export type MailAddress = Readonly<{ name?: string; address?: string }>;
export type MimePart = Readonly<{
  part: string | null;
  type: string;
  disposition: string | null;
  filename: string | null;
  encoding: string | null;
  size: string | null;
  contentId: string | null;
  parameters: Readonly<Record<string, string>>;
  dispositionParameters: Readonly<Record<string, string>>;
  children: readonly MimePart[];
}>;

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id"),
    rfcMessageId: text("rfc_message_id"),
    subject: text("subject"),
    searchBody: text("search_body").default("").notNull(),
    searchVector: customType<{ data: string }>({ dataType: () => "tsvector" })(
      "search_vector",
    ).generatedAlwaysAs(
      sql`public.maildock_search_vector(subject, "from", sender, "to", cc, search_body)`,
    ),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    size: bigint("size", { mode: "bigint" }).notNull(),
    from: jsonb("from").$type<readonly MailAddress[]>().default([]).notNull(),
    sender: jsonb("sender")
      .$type<readonly MailAddress[]>()
      .default([])
      .notNull(),
    replyTo: jsonb("reply_to")
      .$type<readonly MailAddress[]>()
      .default([])
      .notNull(),
    to: jsonb("to").$type<readonly MailAddress[]>().default([]).notNull(),
    cc: jsonb("cc").$type<readonly MailAddress[]>().default([]).notNull(),
    bcc: jsonb("bcc").$type<readonly MailAddress[]>().default([]).notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    mimeStructure: jsonb("mime_structure").$type<MimePart>(),
    hasAttachments: boolean("has_attachments").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("messages_search_gin_idx").using("gin", table.searchVector),
    index("messages_account_internal_date_idx").on(
      table.accountId,
      table.internalDate,
    ),
    uniqueIndex("messages_account_id_unique").on(table.accountId, table.id),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    mergedInto: uuid("merged_into"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("conversations_account_id_unique").on(t.accountId, t.id),
    foreignKey({
      columns: [t.accountId, t.mergedInto],
      foreignColumns: [t.accountId, t.id],
    }),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    messageId: uuid("message_id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    normalizedMessageId: text("normalized_message_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.conversationId],
      foreignColumns: [conversations.accountId, conversations.id],
    }),
    foreignKey({
      columns: [t.accountId, t.messageId],
      foreignColumns: [messages.accountId, messages.id],
    }).onDelete("cascade"),
    index("conversation_members_group_idx").on(t.accountId, t.conversationId),
    index("conversation_members_header_idx").on(
      t.accountId,
      t.normalizedMessageId,
    ),
  ],
);

export const conversationReferences = pgTable(
  "conversation_references",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    headerId: text("header_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.headerId] }),
    foreignKey({
      columns: [t.accountId, t.conversationId],
      foreignColumns: [conversations.accountId, conversations.id],
    }),
    index("conversation_references_group_idx").on(
      t.accountId,
      t.conversationId,
    ),
  ],
);

export const mailboxMessages = pgTable(
  "mailbox_messages",
  {
    id: uuid("id").primaryKey(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    uidValidity: bigint("uid_validity", { mode: "bigint" }).notNull(),
    uid: bigint("uid", { mode: "bigint" }).notNull(),
    modseq: bigint("modseq", { mode: "bigint" }),
    flags: text("flags").array().default([]).notNull(),
    actionHidden: boolean("action_hidden").default(false).notNull(),
    firstSynchronizedAt: timestamp("first_synchronized_at", {
      withTimezone: true,
    }).notNull(),
    lastSynchronizedAt: timestamp("last_synchronized_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("mailbox_messages_remote_identity_unique").on(
      table.mailboxId,
      table.uidValidity,
      table.uid,
    ),
    index("mailbox_messages_mailbox_idx").on(table.mailboxId),
    index("mailbox_messages_message_idx").on(table.messageId),
  ],
);

export const notificationEvents = pgTable(
  "notification_events",
  {
    sequence: bigint("sequence", { mode: "bigint" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    uidValidity: bigint("uid_validity", { mode: "bigint" }).notNull(),
    uid: bigint("uid", { mode: "bigint" }).notNull(),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("notification_events_remote_identity").on(
      t.mailboxId,
      t.uidValidity,
      t.uid,
    ),
    index("notification_events_created_idx").on(t.createdAt),
  ],
);

export const messageContents = pgTable(
  "message_contents",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    status: text("status").default("not_fetched").notNull(),
    plainText: text("plain_text"),
    searchText: text("search_text"),
    sanitizedHtml: text("sanitized_html"),
    remoteContentBlocked: boolean("remote_content_blocked")
      .default(false)
      .notNull(),
    policyVersion: text("policy_version"),
    error: text("error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "message_contents_status",
      sql`${table.status} in ('not_fetched', 'pending', 'fetching', 'ready', 'failed')`,
    ),
  ],
);

export const messageCommands = pgTable(
  "message_commands",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    placementId: uuid("placement_id").references(() => mailboxMessages.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    status: text("status").default("pending").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceUidValidity: bigint("source_uid_validity", {
      mode: "bigint",
    }).notNull(),
    sourceUid: bigint("source_uid", { mode: "bigint" }).notNull(),
    destinationMailboxId: uuid("destination_mailbox_id").references(
      () => mailboxes.id,
      { onDelete: "set null" },
    ),
    destinationPath: text("destination_path"),
    destinationUidValidity: bigint("destination_uid_validity", {
      mode: "bigint",
    }),
    destinationUid: bigint("destination_uid", { mode: "bigint" }),
    originalFlags: text("original_flags").array().default([]).notNull(),
    error: text("error"),
    attempts: integer("attempts").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "message_commands_action",
      sql`${table.action} in ('mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'trash')`,
    ),
    check(
      "message_commands_status",
      sql`${table.status} in ('pending', 'executing', 'succeeded', 'failed')`,
    ),
    index("message_commands_placement_status_idx").on(
      table.placementId,
      table.status,
    ),
    index("message_commands_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const mailAccountRelations = relations(mailAccounts, ({ many }) => ({
  mailboxes: many(mailboxes),
}));

export const mailboxRelations = relations(mailboxes, ({ one }) => ({
  account: one(mailAccounts, {
    fields: [mailboxes.accountId],
    references: [mailAccounts.id],
  }),
}));

export const messageRelations = relations(messages, ({ one, many }) => ({
  account: one(mailAccounts, {
    fields: [messages.accountId],
    references: [mailAccounts.id],
  }),
  placements: many(mailboxMessages),
}));

export const mailboxMessageRelations = relations(
  mailboxMessages,
  ({ one }) => ({
    mailbox: one(mailboxes, {
      fields: [mailboxMessages.mailboxId],
      references: [mailboxes.id],
    }),
    message: one(messages, {
      fields: [mailboxMessages.messageId],
      references: [messages.id],
    }),
  }),
);

export const schema = {
  outgoingMessages,
  instanceState,
  user,
  twoFactor,
  session,
  account,
  verification,
  rateLimit,
  authAdmission,
  loginThrottle,
  mailAccounts,
  oauthAuthorizationStates,
  oauthProviderConfigs,
  mailboxes,
  mailboxRoles,
  messages,
  conversations,
  conversationMembers,
  conversationReferences,
  mailboxMessages,
  messageContents,
  messageCommands,
  userRelations,
  sessionRelations,
  accountRelations,
  mailAccountRelations,
  mailboxRelations,
  messageRelations,
  mailboxMessageRelations,
};

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "restrict" }),
    composeMode: text("compose_mode").notNull(),
    source:
      jsonb("source").$type<
        import("../../../modules/mail/domain/compose-source").SourceContext
      >(),
    to: text("to").default("").notNull(),
    cc: text("cc").default("").notNull(),
    bcc: text("bcc").default("").notNull(),
    subject: text("subject").default("").notNull(),
    plainText: text("plain_text").default("").notNull(),
    richDocument: jsonb("rich_document").$type<RichDocument>(),
    revision: integer("revision").default(1).notNull(),
    status: text("status").default("active").notNull(),
    outgoingMessageId: uuid("outgoing_message_id").references(
      () => outgoingMessages.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "drafts_mode",
      sql`${t.composeMode} in ('new', 'reply', 'reply_all', 'forward')`,
    ),
    check("drafts_status", sql`${t.status} in ('active', 'consumed')`),
    check("drafts_revision", sql`${t.revision} > 0`),
    check(
      "drafts_handoff",
      sql`(${t.status} = 'consumed') = (${t.outgoingMessageId} is not null)`,
    ),
    check(
      "drafts_source",
      sql`(${t.composeMode} = 'new' and ${t.source} is null) or (${t.composeMode} <> 'new' and ${t.source} is not null and ${t.source}->>'mode' = ${t.composeMode})`,
    ),
    index("drafts_active_updated_idx").on(t.status, t.updatedAt),
  ],
);
export const draftAttachments = pgTable(
  "draft_attachments",
  {
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    kind: text("kind").notNull(),
    inline: boolean("inline").default(false).notNull(),
    contentId: text("content_id"),
    blobId: uuid("blob_id").references(() => blobs.id, {
      onDelete: "restrict",
    }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.id] }),
    uniqueIndex("draft_attachments_position").on(t.draftId, t.position),
    check("draft_attachments_kind", sql`${t.kind} in ('staged', 'incoming')`),
    index("draft_attachments_blob_idx").on(t.blobId),
  ],
);

export const remoteContentSenders = pgTable("remote_content_senders", {
  address: text("address").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const signatures = pgTable("signatures", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  richDocument: jsonb("rich_document").$type<RichDocument>().notNull(),
  revision: integer("revision").default(1).notNull(),
});
export const signatureResources = pgTable(
  "signature_resources",
  {
    signatureId: uuid("signature_id")
      .notNull()
      .references(() => signatures.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "restrict" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.signatureId, t.id] }),
    index("signature_resources_blob_idx").on(t.blobId),
  ],
);
export const accountSignatureDefaults = pgTable("account_signature_defaults", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => mailAccounts.id, { onDelete: "cascade" }),
  new: uuid("new_signature_id").references(() => signatures.id, {
    onDelete: "set null",
  }),
  reply: uuid("reply_signature_id").references(() => signatures.id, {
    onDelete: "set null",
  }),
  forward: uuid("forward_signature_id").references(() => signatures.id, {
    onDelete: "set null",
  }),
});

export const applicationEvents = pgTable(
  "application_events",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    level: text("level").notNull(),
    area: text("area").notNull(),
    event: text("event")
      .$type<
        import("../../../modules/diagnostics/domain/application-event").ApplicationEventName
      >()
      .notNull(),
    accountId: uuid("account_id").references(() => mailAccounts.id, {
      onDelete: "set null",
    }),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, {
      onDelete: "set null",
    }),
    message: text("message").notNull(),
    details:
      jsonb("details").$type<
        import("../../../modules/diagnostics/domain/application-event").DiagnosticDetails
      >(),
  },
  (t) => [
    check(
      "application_events_level",
      sql`${t.level} in ('info','warning','error')`,
    ),
    check(
      "application_events_area",
      sql`${t.area} in ('system','account','sync','imap','smtp','jobs')`,
    ),
    index("application_events_recent_idx").on(t.createdAt, t.id),
    index("application_events_account_idx").on(t.accountId, t.createdAt, t.id),
  ],
);
