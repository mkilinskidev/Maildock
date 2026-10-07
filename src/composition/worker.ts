import { JobRuntime } from "../modules/jobs/infrastructure/job-runtime.js";
import { getConfig } from "../shared/infrastructure/config/config.js";
import { createLogger } from "../shared/infrastructure/logging/logger.js";
import { createWorkerDatabase } from "../shared/infrastructure/database/database-worker.js";
import { AesGcmSecretEncryption } from "../shared/infrastructure/crypto/aes-gcm-secret-encryption.js";
import { AccountsService } from "../modules/accounts/application/accounts-service.js";
import { MicrosoftOAuthService } from "../modules/accounts/infrastructure/microsoft-oauth.js";
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

export function createWorkerComposition() {
  const config = getConfig();
  const logger = createLogger(config);
  const database = createWorkerDatabase(config);
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
    new MicrosoftOAuthService(database.db, encryption, config),
  );
  const mailboxes = new MailboxService(database.db);
  const jobs = new JobRuntime(config, logger);
  const recentSyncScheduler = {
    schedule: async (accountId: string, mailboxId: string) =>
      (await jobs.boss.send(
        MAILBOX_RECENT_SYNC_QUEUE,
        { version: 1, accountId, mailboxId },
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
  );
  const withMailboxLock = createMailboxLock(database.client);
  return {
    config,
    logger,
    database,
    jobs,
    withMailboxLock,
    delta: new DeltaSyncService(
      database.db,
      accounts,
      provider,
      messages,
      config.messageFetchBatchSize,
      logger,
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
    ),
  };
}
