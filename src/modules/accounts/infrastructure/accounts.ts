import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { getConfig } from "@/shared/infrastructure/config/config";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { MicrosoftOAuthService } from "@/modules/accounts/infrastructure/microsoft-oauth";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { PgBossMailboxDiscoveryScheduler } from "@/modules/mail/infrastructure/mailbox-discovery-jobs";
import { MessageService } from "@/modules/mail/application/message-service";
import { PgBossRecentSyncScheduler } from "@/modules/mail/infrastructure/recent-sync-jobs";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { PgBossContentScheduler } from "@/modules/mail/infrastructure/content-jobs";
import { PgBossDeltaSyncScheduler } from "@/modules/mail/infrastructure/delta-sync-jobs";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { PgBossMessageCommandScheduler } from "@/modules/mail/infrastructure/message-command-jobs";

const config = getConfig();
const encryption = new AesGcmSecretEncryption(
  config.credentialsEncryption.activeKeyId,
  config.credentialsEncryption.keys,
);
export const microsoftOAuth = new MicrosoftOAuthService(db, encryption, config);

export const accountsService = new AccountsService(
  db,
  encryption,
  new ImapSmtpMailProvider(),
  new PgBossMailboxDiscoveryScheduler(config),
  microsoftOAuth,
);

export const mailboxService = new MailboxService(db);
export const mailboxRoleService = new MailboxRoleService(db);
export const messageService = new MessageService(
  db,
  undefined,
  undefined,
  undefined,
  new PgBossRecentSyncScheduler(config),
  new PgBossDeltaSyncScheduler(config),
);
export const messageContentService = new MessageContentService(
  db,
  new PgBossContentScheduler(config),
);
const commandScheduler = new PgBossMessageCommandScheduler(config);
const deltaScheduler = new PgBossDeltaSyncScheduler(config);
export const messageCommandService = new MessageCommandService(
  db,
  (id) => commandScheduler.enqueue(id),
  async (accountId, mailboxId) => {
    await deltaScheduler.schedule(accountId, mailboxId, "manual");
  },
);
