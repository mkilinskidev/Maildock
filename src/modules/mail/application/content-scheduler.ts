export interface ContentScheduler {
  /** Authoritative durable state, including delayed retries and active work. */
  state?(
    mailboxId: string,
    messageId: string,
    pendingSince?: Date,
  ): Promise<"pending" | "retrying" | "fetching" | "terminal" | "missing">;
  schedule(
    accountId: string,
    mailboxId: string,
    messageId: string,
  ): Promise<boolean>;
}
