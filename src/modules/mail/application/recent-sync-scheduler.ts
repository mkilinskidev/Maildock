export interface RecentSyncScheduler {
  schedule(accountId: string, mailboxId: string): Promise<boolean>;
}
