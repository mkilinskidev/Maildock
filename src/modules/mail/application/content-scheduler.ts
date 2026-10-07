export interface ContentScheduler {
  schedule(
    accountId: string,
    mailboxId: string,
    messageId: string,
  ): Promise<boolean>;
}
