export interface MailboxDiscoveryScheduler {
  schedule(accountId: string): Promise<boolean>;
}
