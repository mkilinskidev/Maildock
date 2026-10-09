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
    sentCopyMessageId: uuid("sent_copy_message_id"),
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
    foreignKey({
      name: "outgoing_messages_native_sent_fk",
      columns: [table.accountId, table.sentCopyMessageId],
      foreignColumns: [messages.accountId, messages.id],
    }).onDelete("restrict"),

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
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .default("imap")
      .notNull(),
    accountId: uuid("account_id").notNull(),
    sourceAccountId: uuid("source_account_id"),
    gmailAttachmentId: text("gmail_attachment_id"),
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sourceMailboxId: uuid("source_mailbox_id"),
    sourceUidValidity: bigint("source_uid_validity", {
      mode: "bigint",
    }),
    sourceUid: bigint("source_uid", { mode: "bigint" }),
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
    foreignKey({
      name: "message_attachments_message_transport_fk",
      columns: [table.accountId, table.messageId, table.receiveTransport],
      foreignColumns: [
        messages.accountId,
        messages.id,
        messages.receiveTransport,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_attachments_source_transport_fk",
      columns: [
        table.sourceAccountId,
        table.sourceMailboxId,
        table.receiveTransport,
      ],
      foreignColumns: [
        mailboxes.accountId,
        mailboxes.id,
        mailboxes.receiveTransport,
      ],
    }).onDelete("set null"),
    check(
      "message_attachments_locator",
      sql`(${table.receiveTransport} = 'imap' and ${table.sourceUid} is not null and ${table.sourceUid} > 0 and ${table.sourceUidValidity} is not null and ${table.sourceUidValidity} > 0 and ${table.gmailAttachmentId} is null and ((${table.sourceMailboxId} is null and ${table.sourceAccountId} is null) or (${table.sourceMailboxId} is not null and ${table.sourceAccountId} is not null and ${table.sourceAccountId} = ${table.accountId}))) or (${table.receiveTransport} = 'gmail' and ${table.sourceMailboxId} is null and ${table.sourceAccountId} is null and ${table.sourceUid} is null and ${table.sourceUidValidity} is null and (${table.gmailAttachmentId} is null or length(${table.gmailAttachmentId}) > 0))`,
    ),

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
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .generatedAlwaysAs(
        sql`case when provider_type = 'gmail_smtp' then 'gmail' else 'imap' end`,
      )
      .notNull(),
    workRevision: bigint("work_revision", { mode: "bigint" })
      .default(sql`1`)
      .notNull(),
    imapHost: text("imap_host"),
    imapPort: integer("imap_port"),
    imapSecurity: text("imap_security"),
    imapUsername: text("imap_username"),
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
    uniqueIndex("mail_accounts_transport_unique").on(
      table.id,
      table.receiveTransport,
    ),
    check("mail_accounts_work_revision", sql`${table.workRevision} > 0`),
    check(
      "mail_accounts_receive_identity",
      sql`(${table.providerType} = 'imap_smtp' and (${table.authMethod} = 'password' or (${table.authMethod} = 'oauth2' and ${table.oauthProviderId} is not null and ${table.oauthProviderId} = 'microsoft')) and ${table.imapHost} is not null and length(${table.imapHost}) > 0 and ${table.imapPort} is not null and ${table.imapSecurity} is not null and ${table.imapUsername} is not null and length(${table.imapUsername}) > 0) or (${table.providerType} = 'gmail_smtp' and ${table.authMethod} = 'oauth2' and ${table.oauthProviderId} is not null and ${table.oauthProviderId} = 'google' and ${table.oauthHomeAccountId} is not null and length(${table.oauthHomeAccountId}) > 0 and ${table.imapHost} is null and ${table.imapPort} is null and ${table.imapSecurity} is null and ${table.imapUsername} is null and cardinality(${table.imapCapabilities}) = 0 and not ${table.smtpUsesImapCredentials})`,
    ),

    check("mail_accounts_sort_order", sql`${table.sortOrder} > 0`),
    check(
      "mail_accounts_provider_type",
      sql`${table.providerType} in ('imap_smtp', 'gmail_smtp')`,
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
      sql`(${table.smtpUsesImapCredentials} and ${table.smtpUsername} is null and ${table.smtpPassword} is null) or (not ${table.smtpUsesImapCredentials} and ${table.smtpUsername} is not null and ((${table.authMethod} = 'password' and ${table.smtpPassword} is not null) or (${table.authMethod} = 'oauth2' and ${table.smtpPassword} is null)))`,
    ),
    check(
      "mail_accounts_auth_credential",
      sql`(${table.authMethod} = 'password' and ${table.oauthProviderId} is null and ${table.imapPassword} is not null and ${table.oauthCache} is null and ${table.oauthHomeAccountId} is null and ${table.oauthStatus} is null) or (${table.authMethod} = 'oauth2' and ${table.oauthProviderId} is not null and ${table.imapPassword} is null and ${table.smtpPassword} is null and ${table.oauthCache} is not null and ${table.oauthStatus} is not null and ${table.oauthStatus} in ('connected', 'reconnect_required'))`,
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
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .default("imap")
      .notNull(),
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    viewKind: text("view_kind").default("remote").notNull(),
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
      "mailboxes_transport_locator",
      sql`(${table.receiveTransport} = 'imap' and ${table.viewKind} = 'remote') or (${table.receiveTransport} = 'gmail' and ${table.uidValidity} is null and ${table.uidNext} is null and ${table.highestModseq} is null and ${table.recentSyncUidValidity} is null and ${table.backfillUidValidity} is null and ${table.backfillFrontierUid} is null and ${table.deltaUidValidity} is null and ${table.deltaLastSeenUid} is null and ${table.deltaHighestModseq} is null and ((${table.viewKind} = 'remote' and ${table.providerMailboxId} is not null and length(${table.providerMailboxId}) > 0) or (${table.viewKind} = 'all_mail' and ${table.providerMailboxId} is null)))`,
    ),
    uniqueIndex("mailboxes_gmail_label_unique")
      .on(table.accountId, table.providerMailboxId)
      .where(
        sql`${table.receiveTransport} = 'gmail' and ${table.viewKind} = 'remote'`,
      ),
    uniqueIndex("mailboxes_gmail_virtual_unique")
      .on(table.accountId, table.viewKind)
      .where(
        sql`${table.receiveTransport} = 'gmail' and ${table.viewKind} = 'all_mail'`,
      ),

    uniqueIndex("mailboxes_account_transport_unique").on(
      table.accountId,
      table.id,
      table.receiveTransport,
    ),
    foreignKey({
      name: "mailboxes_account_transport_fk",
      columns: [table.accountId, table.receiveTransport],
      foreignColumns: [mailAccounts.id, mailAccounts.receiveTransport],
    }).onDelete("cascade"),

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
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .default("imap")
      .notNull(),
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    providerHistoryId: text("provider_history_id"),
    remoteMissingAt: timestamp("remote_missing_at", { withTimezone: true }),
    inventoryGeneration: bigint("inventory_generation", { mode: "bigint" }),
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
    check(
      "messages_native_identity",
      sql`(${table.receiveTransport} = 'imap' and ${table.providerThreadId} is null and ${table.providerHistoryId} is null and ${table.inventoryGeneration} is null and ${table.remoteMissingAt} is null) or (${table.receiveTransport} = 'gmail' and ${table.providerMessageId} is not null and length(${table.providerMessageId}) > 0 and (${table.providerThreadId} is null or length(${table.providerThreadId}) > 0) and (${table.providerHistoryId} is null or ${table.providerHistoryId} ~ '^[0-9]+$') and (${table.inventoryGeneration} is null or ${table.inventoryGeneration} > 0))`,
    ),
    uniqueIndex("messages_gmail_identity_unique")
      .on(table.accountId, table.providerMessageId)
      .where(sql`${table.receiveTransport} = 'gmail'`),

    uniqueIndex("messages_account_transport_unique").on(
      table.accountId,
      table.id,
      table.receiveTransport,
    ),
    foreignKey({
      name: "messages_account_transport_fk",
      columns: [table.accountId, table.receiveTransport],
      foreignColumns: [mailAccounts.id, mailAccounts.receiveTransport],
    }).onDelete("cascade"),

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
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .default("imap")
      .notNull(),
    accountId: uuid("account_id").notNull(),
    id: uuid("id").primaryKey(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    uidValidity: bigint("uid_validity", { mode: "bigint" }),
    uid: bigint("uid", { mode: "bigint" }),
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
    uniqueIndex("mailbox_messages_placement_transport_unique").on(
      table.accountId,
      table.id,
      table.messageId,
      table.mailboxId,
      table.receiveTransport,
    ),
    foreignKey({
      name: "mailbox_messages_mailbox_transport_fk",
      columns: [table.accountId, table.mailboxId, table.receiveTransport],
      foreignColumns: [
        mailboxes.accountId,
        mailboxes.id,
        mailboxes.receiveTransport,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailbox_messages_message_transport_fk",
      columns: [table.accountId, table.messageId, table.receiveTransport],
      foreignColumns: [
        messages.accountId,
        messages.id,
        messages.receiveTransport,
      ],
    }).onDelete("cascade"),
    check(
      "mailbox_messages_locator",
      sql`(${table.receiveTransport} = 'imap' and ${table.uid} is not null and ${table.uid} > 0 and ${table.uidValidity} is not null and ${table.uidValidity} > 0 and (${table.modseq} is null or ${table.modseq} > 0)) or (${table.receiveTransport} = 'gmail' and ${table.uid} is null and ${table.uidValidity} is null and ${table.modseq} is null)`,
    ),
    uniqueIndex("mailbox_messages_gmail_membership_unique")
      .on(table.mailboxId, table.messageId)
      .where(sql`${table.receiveTransport} = 'gmail'`),

    uniqueIndex("mailbox_messages_remote_identity_unique")
      .on(table.mailboxId, table.uidValidity, table.uid)
      .where(sql`${table.receiveTransport} = 'imap'`),
    index("mailbox_messages_mailbox_idx").on(table.mailboxId),
    index("mailbox_messages_message_idx").on(table.messageId),
  ],
);

export const notificationEvents = pgTable(
  "notification_events",
  {
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .default("imap")
      .notNull(),
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
    uidValidity: bigint("uid_validity", { mode: "bigint" }),
    uid: bigint("uid", { mode: "bigint" }),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "notification_events_message_transport_fk",
      columns: [table.accountId, table.messageId, table.receiveTransport],
      foreignColumns: [
        messages.accountId,
        messages.id,
        messages.receiveTransport,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_events_mailbox_transport_fk",
      columns: [table.accountId, table.mailboxId, table.receiveTransport],
      foreignColumns: [
        mailboxes.accountId,
        mailboxes.id,
        mailboxes.receiveTransport,
      ],
    }).onDelete("cascade"),
    check(
      "notification_events_locator",
      sql`(${table.receiveTransport} = 'imap' and ${table.uid} is not null and ${table.uid} > 0 and ${table.uidValidity} is not null and ${table.uidValidity} > 0) or (${table.receiveTransport} = 'gmail' and ${table.uid} is null and ${table.uidValidity} is null)`,
    ),
    uniqueIndex("notification_events_gmail_identity_unique")
      .on(table.accountId, table.messageId)
      .where(sql`${table.receiveTransport} = 'gmail'`),

    uniqueIndex("notification_events_remote_identity")
      .on(table.mailboxId, table.uidValidity, table.uid)
      .where(sql`${table.receiveTransport} = 'imap'`),
    index("notification_events_created_idx").on(table.createdAt),
  ],
);

export const messageContents = pgTable(
  "message_contents",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    status: text("status").default("not_fetched").notNull(),
    requestGeneration: uuid("request_generation").defaultRandom().notNull(),
    fetchAttempt: uuid("fetch_attempt"),
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
    receiveTransport: text("receive_transport")
      .$type<"imap" | "gmail">()
      .default("imap")
      .notNull(),
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
    accountRevision: bigint("account_revision", { mode: "bigint" })
      .default(sql`1`)
      .notNull(),
    intentSequence: bigint("intent_sequence", { mode: "bigint" })
      .default(sql`1`)
      .notNull(),
    action: text("action").notNull(),
    status: text("status").default("pending").notNull(),
    sourcePath: text("source_path"),
    sourceUidValidity: bigint("source_uid_validity", {
      mode: "bigint",
    }),
    sourceUid: bigint("source_uid", { mode: "bigint" }),
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
    foreignKey({
      name: "message_commands_destination_transport_fk",
      columns: [
        table.accountId,
        table.destinationMailboxId,
        table.receiveTransport,
      ],
      foreignColumns: [
        mailboxes.accountId,
        mailboxes.id,
        mailboxes.receiveTransport,
      ],
    }).onDelete("set null"),
    foreignKey({
      name: "message_commands_placement_transport_fk",
      columns: [
        table.accountId,
        table.placementId,
        table.messageId,
        table.mailboxId,
        table.receiveTransport,
      ],
      foreignColumns: [
        mailboxMessages.accountId,
        mailboxMessages.id,
        mailboxMessages.messageId,
        mailboxMessages.mailboxId,
        mailboxMessages.receiveTransport,
      ],
    }).onDelete("set null"),
    foreignKey({
      name: "message_commands_message_transport_fk",
      columns: [table.accountId, table.messageId, table.receiveTransport],
      foreignColumns: [
        messages.accountId,
        messages.id,
        messages.receiveTransport,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_commands_mailbox_transport_fk",
      columns: [table.accountId, table.mailboxId, table.receiveTransport],
      foreignColumns: [
        mailboxes.accountId,
        mailboxes.id,
        mailboxes.receiveTransport,
      ],
    }).onDelete("cascade"),
    check(
      "message_commands_revision_sequence",
      sql`${table.accountRevision} > 0 and ${table.intentSequence} > 0`,
    ),
    check(
      "message_commands_locator",
      sql`(${table.receiveTransport} = 'imap' and ${table.sourcePath} is not null and length(${table.sourcePath}) > 0 and ${table.sourceUid} is not null and ${table.sourceUid} > 0 and ${table.sourceUidValidity} is not null and ${table.sourceUidValidity} > 0) or (${table.receiveTransport} = 'gmail' and ${table.sourcePath} is null and ${table.sourceUid} is null and ${table.sourceUidValidity} is null and ${table.destinationPath} is null and ${table.destinationUid} is null and ${table.destinationUidValidity} is null)`,
    ),
    index("message_commands_intent_idx").on(
      table.accountId,
      table.messageId,
      table.intentSequence,
    ),

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

export const gmailAccountSyncState = pgTable(
  "gmail_account_sync_state",
  {
    accountId: uuid("account_id").primaryKey(),
    receiveTransport: text("receive_transport").default("gmail").notNull(),
    accountRevision: bigint("account_revision", { mode: "bigint" }).notNull(),
    status: text("status").default("not_started").notNull(),
    recentReady: boolean("recent_ready").default(false).notNull(),
    inventoryComplete: boolean("inventory_complete").default(false).notNull(),
    historyId: text("history_id"),
    baselineHistoryId: text("baseline_history_id"),
    inventoryGeneration: bigint("inventory_generation", { mode: "bigint" })
      .default(sql`1`)
      .notNull(),
    inventoryRunId: uuid("inventory_run_id"),
    inventoryPhase: text("inventory_phase"),
    recentCutoff: timestamp("recent_cutoff", { withTimezone: true }),
    historicalBefore: timestamp("historical_before", { withTimezone: true }),
    inventoryNextPageToken: text("inventory_next_page_token"),
    inventoryPagesComplete: boolean("inventory_pages_complete")
      .default(false)
      .notNull(),
    historyRunId: uuid("history_run_id"),
    historyStartId: text("history_start_id"),
    historyNextPageToken: text("history_next_page_token"),
    historyCandidateId: text("history_candidate_id"),
    historyPagesComplete: boolean("history_pages_complete")
      .default(false)
      .notNull(),
    needsWork: boolean("needs_work").default(true).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    errorCategory: text("error_category"),
    processedCount: bigint("processed_count", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    quotaMinute: bigint("quota_minute", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    quotaCurrentUnits: bigint("quota_current_units", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    quotaPreviousUnits: bigint("quota_previous_units", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      name: "gmail_sync_account_transport_fk",
      columns: [t.accountId, t.receiveTransport],
      foreignColumns: [mailAccounts.id, mailAccounts.receiveTransport],
    }).onDelete("cascade"),
    check("gmail_sync_transport", sql`${t.receiveTransport} = 'gmail'`),
    check(
      "gmail_sync_status",
      sql`${t.status} in ('not_started', 'initializing', 'ready', 'reconcile_required', 'reconciling', 'blocked')`,
    ),
    check(
      "gmail_sync_counters",
      sql`${t.accountRevision} > 0 and ${t.inventoryGeneration} > 0 and ${t.processedCount} >= 0 and ${t.quotaMinute} >= 0 and ${t.quotaCurrentUnits} >= 0 and ${t.quotaPreviousUnits} >= 0`,
    ),
    check(
      "gmail_sync_history_ids",
      sql`(${t.historyId} is null or ${t.historyId} ~ '^[0-9]+$') and (${t.baselineHistoryId} is null or ${t.baselineHistoryId} ~ '^[0-9]+$') and (${t.historyStartId} is null or ${t.historyStartId} ~ '^[0-9]+$') and (${t.historyCandidateId} is null or ${t.historyCandidateId} ~ '^[0-9]+$')`,
    ),
    check(
      "gmail_sync_history_run",
      sql`(${t.historyRunId} is null and ${t.historyStartId} is null and ${t.historyNextPageToken} is null and ${t.historyCandidateId} is null and not ${t.historyPagesComplete}) or (${t.historyRunId} is not null and ${t.historyStartId} is not null and (not ${t.historyPagesComplete} or (${t.historyCandidateId} is not null and ${t.historyNextPageToken} is null)))`,
    ),
    check(
      "gmail_sync_inventory_run",
      sql`(${t.inventoryRunId} is null and ${t.inventoryPhase} is null and ${t.inventoryNextPageToken} is null and not ${t.inventoryPagesComplete}) or (${t.inventoryRunId} is not null and ${t.baselineHistoryId} is not null and ${t.inventoryPhase} is not null and ${t.inventoryPhase} in ('recent', 'historical', 'reconcile') and ${t.recentCutoff} is not null and (not ${t.inventoryPagesComplete} or ${t.inventoryNextPageToken} is null))`,
    ),
    check(
      "gmail_sync_error_category",
      sql`${t.errorCategory} is null or ${t.errorCategory} in ('unsupported', 'authentication', 'api_disabled', 'quota', 'network', 'history_expired', 'invalid_response')`,
    ),
    index("gmail_sync_due_idx").on(t.needsWork, t.nextAttemptAt),
  ],
);

export const gmailSyncWork = pgTable(
  "gmail_sync_work",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => gmailAccountSyncState.accountId, {
        onDelete: "cascade",
      }),
    runId: uuid("run_id").notNull(),
    purpose: text("purpose").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    accountRevision: bigint("account_revision", { mode: "bigint" }).notNull(),
    status: text("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    errorCategory: text("error_category"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountId, t.runId, t.purpose, t.gmailMessageId],
    }),
    check(
      "gmail_work_identity",
      sql`length(${t.gmailMessageId}) > 0 and ${t.accountRevision} > 0`,
    ),
    check("gmail_work_purpose", sql`${t.purpose} in ('inventory', 'history')`),
    check(
      "gmail_work_status",
      sql`${t.status} in ('pending', 'retry', 'complete') and ${t.attempts} between 0 and 100`,
    ),
    check(
      "gmail_work_error",
      sql`${t.errorCategory} is null or ${t.errorCategory} in ('authentication', 'api_disabled', 'quota', 'network', 'invalid_response')`,
    ),
    index("gmail_work_due_idx").on(
      t.accountId,
      t.runId,
      t.status,
      t.nextAttemptAt,
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
