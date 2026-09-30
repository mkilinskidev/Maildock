import { eq } from "drizzle-orm";

import {
  DisabledMailAccountError,
  type AccountsService,
} from "../../accounts/application/accounts-service";
import {
  MailProviderOperationError,
  type MailProvider,
} from "../../accounts/domain/mail-provider";
import type { Database } from "../../../shared/infrastructure/database/database";
import { MicrosoftAuthorizationError } from "../../accounts/infrastructure/microsoft-oauth";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";
import type { MailboxService } from "./mailbox-service";
import type { MessageService } from "./message-service";

function sanitizedDiscoveryError(error: unknown): string {
  if (error instanceof MicrosoftAuthorizationError) return error.message;
  if (error instanceof DisabledMailAccountError) return error.message;
  if (error instanceof MailProviderOperationError) return error.message;
  return "Mailbox discovery failed.";
}

export class MailboxDiscoveryService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly provider: MailProvider,
    private readonly mailboxes: MailboxService,
    private readonly messages?: MessageService,
  ) {}

  async run(accountId: string): Promise<void> {
    const startedAt = new Date();
    await this.database
      .update(mailAccounts)
      .set({
        mailboxDiscoveryStatus: "running",
        mailboxDiscoveryError: null,
        mailboxDiscoveryStartedAt: startedAt,
        updatedAt: startedAt,
      })
      .where(eq(mailAccounts.id, accountId));

    try {
      const account =
        await this.accounts.getProviderImapAccountForWork(accountId);
      const result = await this.provider.listMailboxes(account);
      const observedAt = new Date();
      await this.mailboxes.reconcile(accountId, result.mailboxes, observedAt);
      await this.database
        .update(mailAccounts)
        .set({
          mailboxDiscoveryStatus: "success",
          mailboxDiscoveryError: null,
          lastSuccessfulMailboxDiscoveryAt: observedAt,
          imapCapabilities: [...result.capabilities],
          updatedAt: observedAt,
        })
        .where(eq(mailAccounts.id, accountId));
      if (this.messages) {
        const selectable = await this.mailboxes.listForAccount(accountId);
        await Promise.allSettled(
          selectable
            .filter((mailbox) => mailbox.selectable)
            .map((mailbox) =>
              this.messages!.requestSync(accountId, mailbox.id),
            ),
        );
      }
    } catch (error) {
      const failedAt = new Date();
      await this.database
        .update(mailAccounts)
        .set({
          mailboxDiscoveryStatus: "failed",
          mailboxDiscoveryError: sanitizedDiscoveryError(error),
          updatedAt: failedAt,
        })
        .where(eq(mailAccounts.id, accountId));
      throw error;
    }
  }
}
