import { configureReceivingDiagnostics } from "../shared/infrastructure/logging/receiving-diagnostics";
import { ReceivingDiagnosticServer } from "../modules/mail/infrastructure/receiving-diagnostic-rpc";
import { createOAuthComposition } from "../modules/accounts/infrastructure/oauth-composition";
import { receivingCredentialBindings } from "../modules/accounts/infrastructure/receiving-credentials";
import { ApplicationEventService } from "../modules/diagnostics/application/application-event-service";
import { LocalBlobStorage } from "../shared/infrastructure/storage/local-blob-storage";
import { JobRuntime } from "../modules/jobs/infrastructure/job-runtime";
import { getConfig } from "../shared/infrastructure/config/config";
import { createLogger } from "../shared/infrastructure/logging/logger";
import { createWorkerDatabase } from "../shared/infrastructure/database/database-worker";
import { AesGcmSecretEncryption } from "../shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { AccountsService } from "../modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "../modules/accounts/infrastructure/imap-smtp-mail-provider";
import { OutgoingMessageService } from "../modules/mail/application/outgoing-message-service";
import { createOutgoingLock } from "../modules/mail/infrastructure/outgoing-lock";
import { enqueueSentCopy } from "../modules/mail/infrastructure/sent-copy-jobs";
import {
  enqueueOutgoing,
  OutgoingPoller,
} from "../modules/mail/infrastructure/outgoing-jobs";
import { ReceivingWorker } from "./receiving-worker";

export function createWorkerComposition() {
  const config = getConfig();
  const logger = createLogger(config);
  configureReceivingDiagnostics(logger);
  const database = createWorkerDatabase(config);
  const events = new ApplicationEventService(database.db, logger);
  // The legacy provider remains only for the independent SMTP pipeline.
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
  );
  const jobs = new JobRuntime(config, logger);
  const blobStorage = new LocalBlobStorage(config.attachmentsPath);
  const receiving = new ReceivingWorker({
    config,
    logger,
    blobStorage,
    credentials: receivingCredentialBindings(accounts),
  });
  const diagnosticRpc = new ReceivingDiagnosticServer(
    {
      endpoint: config.diagnosticEndpoint,
      authSecret: config.authSecret,
      encryption,
    },
    () => receiving.owner,
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
  return {
    config,
    logger,
    database,
    events,
    accounts,
    jobs,
    receiving,
    diagnosticRpc,
    outgoing,
    outgoingPoller: new OutgoingPoller(outgoing),
  };
}
