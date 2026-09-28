import { relations, sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EncryptedEnvelope } from "../../application/secret-encryption.js";

export const instanceState = pgTable(
  "instance_state",
  {
    id: integer("id").primaryKey(),
    initializedAt: timestamp("initialized_at", { withTimezone: true }),
    passwordAlgorithm: text("password_algorithm"),
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
  (table) => [check("instance_state_singleton", sql`${table.id} = 1`)],
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

export const loginThrottle = pgTable("login_throttle", {
  key: text("key").primaryKey(),
  failureCount: integer("failure_count").default(0).notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    providerType: text("provider_type").default("imap_smtp").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecurity: text("imap_security").notNull(),
    imapUsername: text("imap_username").notNull(),
    imapPassword: jsonb("imap_password").$type<EncryptedEnvelope>().notNull(),
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
    check(
      "mail_accounts_provider_type",
      sql`${table.providerType} = 'imap_smtp'`,
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
    index("mail_accounts_enabled_idx").on(table.enabled),
    index("mail_accounts_email_idx").on(table.email),
  ],
);

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
    index("messages_account_internal_date_idx").on(
      table.accountId,
      table.internalDate,
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

export const messageContents = pgTable(
  "message_contents",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    status: text("status").default("not_fetched").notNull(),
    plainText: text("plain_text"),
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
  instanceState,
  user,
  session,
  account,
  verification,
  rateLimit,
  loginThrottle,
  mailAccounts,
  mailboxes,
  messages,
  mailboxMessages,
  messageContents,
  userRelations,
  sessionRelations,
  accountRelations,
  mailAccountRelations,
  mailboxRelations,
  messageRelations,
  mailboxMessageRelations,
};
