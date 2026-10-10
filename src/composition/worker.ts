import { imapJobRevision } from "../modules/mail/infrastructure/receive-job-policy";
import { MailTransportRouter } from "../modules/accounts/domain/receive-transport";
import { GmailProvider } from "../modules/mail/infrastructure/gmail-provider";
import { createGmailAccountLock } from "../modules/mail/infrastructure/gmail-account-lock";
import { GmailSyncService } from "../modules/mail/application/gmail-sync-service";
import { GmailMessageCommands } from "../modules/mail/application/gmail-message-commands";
import {
  enqueueGmail,
  GmailPoller,
} from "../modules/mail/infrastructure/gmail-sync-jobs";
import { bindNativeGmail } from "../modules/mail/infrastructure/gmail-receive-adapter";
import { createOAuthComposition } from "../modules/accounts/infrastructure/oauth-composition";
import { ApplicationEventService } from "../modules/diagnostics/application/application-event-service";
import { LocalBlobStorage } from "../shared/infrastructure/storage/local-blob-storage";
import { AttachmentService } from "../modules/mail/application/attachment-service";
import { createAttachmentLock } from "../modules/mail/infrastructure/attachment-lock";
import {
  enqueueAttachment,
  AttachmentPoller,
} from "../modules/mail/infrastructure/attachment-jobs";
import { JobRuntime } from "../modules/jobs/infrastructure/job-runtime.js";
import { getConfig } from "../shared/infrastructure/config/config.js";
import { createLogger } from "../shared/infrastructure/logging/logger.js";
import { createWorkerDatabase } from "../shared/infrastructure/database/database-worker.js";
import { AesGcmSecretEncryption } from "../shared/infrastructure/crypto/aes-gcm-secret-encryption.js";
import { AccountsService } from "../modules/accounts/application/accounts-service.js";
import { ImapSmtpMailProvider } from "../modules/accounts/infrastructure/imap-smtp-mail-provider.js";
import { MailboxService } from "../modules/mail/application/mailbox-service.js";
import { MailboxDiscoveryService } from "../modules/mail/application/mailbox-discovery-service.js";
import { MessageService } from "../modules/mail/application/message-service.js";
import { MAILBOX_RECENT_SYNC_QUEUE } from "../modules/mail/infrastructure/recent-sync-jobs.js";
import { MessageContentService } from "../modules/mail/application/message-content-service.js";
import { DeltaSyncService } from "../modules/mail/application/delta-sync-service.js";
import { DeltaPoller } from "../modules/mail/infrastructure/delta-sync-jobs.js";
import { enqueueDelta } from "../modules/mail/infrastructure/delta-sync-jobs.js";
import { IdleWatcherManager } from "../modules/mail/infrastructure/idle-watchers.js";
import { createMailboxLock } from "../modules/mail/infrastructure/mailbox-lock.js";
import { BackfillSyncService } from "../modules/mail/application/backfill-sync-service.js";
import {
  BackfillPoller,
  enqueueBackfill,
} from "../modules/mail/infrastructure/backfill-sync-jobs.js";
import { MessageCommandService } from "../modules/mail/application/message-command-service.js";
import { OutgoingMessageService } from "../modules/mail/application/outgoing-message-service.js";
import { createOutgoingLock } from "../modules/mail/infrastructure/outgoing-lock.js";
import { SentCopyService } from "../modules/mail/application/sent-copy-service.js";
import {
  enqueueSentCopy,
  SentCopyPoller,
} from "../modules/mail/infrastructure/sent-copy-jobs.js";
import {
  enqueueOutgoing,
  OutgoingPoller,
} from "../modules/mail/infrastructure/outgoing-jobs.js";
import {
  MessageCommandPoller,
  enqueueMessageCommand,
} from "../modules/mail/infrastructure/message-command-jobs.js";

export function createWorkerComposition() {
  const transportRouter = new MailTransportRouter();
  const config = getConfig();
  const logger = createLogger(config);
  const database = createWorkerDatabase(config);
  const events = new ApplicationEventService(database.db, logger);
  const provider = new ImapSmtpMailProvider();
  const encryption = new AesGcmSecretEncryption(
    config.credentialsEncryption.activeKeyId,
    config.credentialsEncryption.keys,
  );
  const accounts = new AccountsService(
    database.db,
    encryption,
    provider,
    undefined,
    createOAuthComposition(database.db, encryption, config).registry,
    events,
    transportRouter,
    {
      schedule: (id) => enqueueGmail(jobs.boss, id),
      test: async (id) => {
        const { client } = await gmailProvider.interactive(id);
        await client.profile();
      },
    },
  );
  const mailboxes = new MailboxService(database.db);
  const jobs = new JobRuntime(config, logger);
  const gmailProvider = new GmailProvider(
    database.db,
    accounts,
    undefined,
    undefined,
    Math.ceil(
      (Math.max(config.maxAttachmentBytes, config.maxMessageTextPartBytes) *
        4) /
        3,
    ) + 1048576,
  );
  const gmailLock = createGmailAccountLock(database.client);
  const gmailSync = new GmailSyncService(
    database.db,
    gmailProvider,
    gmailLock,
    config.initialSyncDays,
    logger,
  );
  const gmailCommands = new GmailMessageCommands(
    database.db,
    (id) => enqueueMessageCommand(jobs.boss, id),
    gmailProvider,
    gmailLock,
  );
  bindNativeGmail(
    transportRouter,
    gmailProvider,
    (id, revision) => gmailSync.run(id, revision),
    config,
    async (locator, request) => {
      if (!request) throw new Error("Gmail mutation intent is required.");
      return gmailCommands.createNative(
        locator.accountId,
        locator.messageId,
        request.action,
        request.destinationMailboxId,
      );
    },
  );
  const recentSyncScheduler = {
    schedule: async (accountId: string, mailboxId: string) =>
      (await jobs.boss.send(
        MAILBOX_RECENT_SYNC_QUEUE,
        {
          version: 1,
          accountId,
          mailboxId,
          accountRevision: await imapJobRevision(jobs.boss, accountId),
        },
        { singletonKey: mailboxId, priority: 10 },
      )) !== null,
  };
  const messages = new MessageService(
    database.db,
    accounts,
    provider,
    config,
    recentSyncScheduler,
    {
      schedule: (accountId, mailboxId, reason) =>
        enqueueDelta(jobs.boss, accountId, mailboxId, reason),
    },
    {
      schedule: (accountId, mailboxId) =>
        enqueueBackfill(jobs.boss, accountId, mailboxId),
    },
    events,
    { schedule: (id) => enqueueGmail(jobs.boss, id) },
  );
  const blobStorage = new LocalBlobStorage(config.attachmentsPath);
  const attachments = new AttachmentService(
    database.db,
    blobStorage,
    config,
    (id) => enqueueAttachment(jobs.boss, id),
    accounts,
    provider,
    createAttachmentLock(database.client),
    (accountId, mailboxId) =>
      recentSyncScheduler.schedule(accountId, mailboxId),
    gmailProvider,
  );
  const withMailboxLock = createMailboxLock(database.client);
  const sentCopy = new SentCopyService(
    database.db,
    accounts,
    provider,
    createOutgoingLock(database.client),
    (id) => enqueueSentCopy(jobs.boss, id),
    async (accountId, mailboxId, initial) =>
      initial
        ? recentSyncScheduler.schedule(accountId, mailboxId)
        : enqueueDelta(jobs.boss, accountId, mailboxId, "manual"),
    blobStorage,
    config.maxOutgoingMimeBytes,
  );
  const outgoing = new OutgoingMessageService(
    database.db,
    (id) => enqueueOutgoing(jobs.boss, id),
    accounts,
    provider,
    createOutgoingLock(database.client),
    (id) => enqueueSentCopy(jobs.boss, id),
    blobStorage,
    config,
    events,
  );
  const commands = new MessageCommandService(
    database.db,
    (id) => enqueueMessageCommand(jobs.boss, id),
    async (accountId, mailboxId) => {
      await enqueueDelta(jobs.boss, accountId, mailboxId, "manual");
    },
    accounts,
    provider,
    gmailCommands,
  );
  return {
    gmailSync,
    gmailPoller: new GmailPoller(jobs.boss),
    transportRouter,
    events,
    attachments,
    attachmentPoller: new AttachmentPoller(attachments),
    outgoing,
    sentCopy,
    sentCopyPoller: new SentCopyPoller(sentCopy),
    outgoingPoller: new OutgoingPoller(outgoing),
    config,
    logger,
    database,
    jobs,
    withMailboxLock,
    commands,
    commandPoller: new MessageCommandPoller(jobs.boss, commands),
    delta: new DeltaSyncService(
      database.db,
      accounts,
      provider,
      messages,
      config.messageFetchBatchSize,
      logger,
      events,
    ),
    poller: new DeltaPoller(
      database.db,
      jobs.boss,
      config.mailPollIntervalSeconds,
    ),
    backfill: new BackfillSyncService(
      database.db,
      accounts,
      provider,
      messages,
      config.backfillChunkSize,
    ),
    backfillPoller: new BackfillPoller(database.db, jobs.boss),
    watchers: new IdleWatcherManager(database.db, accounts, jobs.boss, logger),
    mailboxDiscovery: new MailboxDiscoveryService(
      database.db,
      accounts,
      provider,
      mailboxes,
      messages,
    ),
    messages,
    content: new MessageContentService(
      database.db,
      undefined,
      accounts,
      provider,
      config,
      gmailProvider,
    ),
  };
}
