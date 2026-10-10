import { MailTransportRouter } from "../domain/receive-transport";
import { createOAuthComposition } from "./oauth-composition";
import { ApplicationEventService } from "../../diagnostics/application/application-event-service";
import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { DraftService } from "@/modules/mail/application/draft-service";
import { SignatureService } from "@/modules/mail/application/signature-service";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { PgBossAttachmentScheduler } from "@/modules/mail/infrastructure/attachment-jobs";
import { ComposePreparationService } from "@/modules/mail/application/compose-preparation-service";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { getConfig } from "@/shared/infrastructure/config/config";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
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
import { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";
import { PgBossOutgoingScheduler } from "@/modules/mail/infrastructure/outgoing-jobs";
import { PgBossGmailScheduler } from "../../mail/infrastructure/gmail-sync-jobs";
import { GmailProvider } from "../../mail/infrastructure/gmail-provider";
import { bindNativeGmail } from "../../mail/infrastructure/gmail-receive-adapter";
import { GmailMessageCommands } from "../../mail/application/gmail-message-commands";

export const transportRouter = new MailTransportRouter();
const config = getConfig();
const gmailScheduler = new PgBossGmailScheduler(config);
const outgoingScheduler = new PgBossOutgoingScheduler(config);
export const blobStorage = new LocalBlobStorage(config.attachmentsPath);
const attachmentScheduler = new PgBossAttachmentScheduler(config);
export const attachmentService = new AttachmentService(
  db,
  blobStorage,
  config,
  (id) => attachmentScheduler.enqueue(id),
);
export const outgoingMessageService = new OutgoingMessageService(
  db,
  (id) => outgoingScheduler.enqueue(id),
  undefined,
  undefined,
  undefined,
  undefined,
  blobStorage,
  config,
);
const encryption = new AesGcmSecretEncryption(
  config.credentialsEncryption.activeKeyId,
  config.credentialsEncryption.keys,
);
const oauth = createOAuthComposition(db, encryption, config);
export const microsoftOAuth = oauth.microsoft;
export const oauthProviders = oauth.registry;
export const oauthProviderConfigs = oauth.configurations;

export const accountsService = new AccountsService(
  db,
  encryption,
  new ImapSmtpMailProvider(),
  new PgBossMailboxDiscoveryScheduler(config),
  oauthProviders,
  new ApplicationEventService(db, createLogger(config)),
  transportRouter,
  {
    schedule: (id) => gmailScheduler.schedule(id),
    test: async (id) => {
      const { client } = await gmailProvider.interactive(id);
      await client.profile();
    },
  },
);
export const gmailProvider = new GmailProvider(
  db,
  accountsService,
  undefined,
  undefined,
  Math.ceil(
    (Math.max(config.maxAttachmentBytes, config.maxMessageTextPartBytes) * 4) /
      3,
  ) + 1048576,
);
bindNativeGmail(
  transportRouter,
  gmailProvider,
  (accountId) => gmailScheduler.schedule(accountId),
  config,
  async (locator, request) => {
    if (!request) throw new Error("Gmail mutation intent is required.");
    return new GmailMessageCommands(db, (id) =>
      commandScheduler.enqueue(id),
    ).createNative(
      locator.accountId,
      locator.messageId,
      request.action,
      request.destinationMailboxId,
    );
  },
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
  undefined,
  undefined,
  gmailScheduler,
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

export const composePreparationService = new ComposePreparationService(
  db,
  messageContentService,
  attachmentService,
);

export const draftService = new DraftService(db);
export const signatureService = new SignatureService(db, attachmentService);
