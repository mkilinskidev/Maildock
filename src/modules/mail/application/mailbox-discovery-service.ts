import { StaleAccountWorkError } from "../../accounts/domain/receive-transport";
import { assertImapPublication } from "../infrastructure/receive-publication-fence";
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
import { OAuthAuthorizationError } from "../../accounts/domain/oauth-mail-provider";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";
import type { MailboxService } from "./mailbox-service";
import type { MessageService } from "./message-service";

function sanitizedDiscoveryError(error: unknown): string {
  if (error instanceof OAuthAuthorizationError) return error.message;
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

  async run(accountId: string, expectedRevision?: string): Promise<void> {
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
      const account = await this.accounts.getProviderImapAccountForWork(
        accountId,
        expectedRevision,
      );
      const result = await this.provider.listMailboxes(account);
      const observedAt = new Date();
      await this.mailboxes.reconcile(
        accountId,
        result.mailboxes,
        observedAt,
        account.revision,
      );
      await this.database.transaction(async (tx) => {
        await assertImapPublication(tx, accountId, account.revision);
        await tx
          .update(mailAccounts)
          .set({
            mailboxDiscoveryStatus: "success",
            mailboxDiscoveryError: null,
            lastSuccessfulMailboxDiscoveryAt: observedAt,
            imapCapabilities: [...result.capabilities],
            updatedAt: observedAt,
          })
          .where(eq(mailAccounts.id, accountId));
      });
      if (this.messages) {
        const selectable = await this.mailboxes.listForAccount(accountId);
        const inboxes = selectable.filter(
          (mailbox) =>
            mailbox.selectable && mailbox.remotePath.toUpperCase() === "INBOX",
        );
        await Promise.allSettled(
          inboxes.map((mailbox) =>
            this.messages!.requestSync(accountId, mailbox.id),
          ),
        );
        await Promise.allSettled(
          selectable
            .filter(
              (mailbox) => mailbox.selectable && !inboxes.includes(mailbox),
            )
            .map((mailbox) =>
              this.messages!.requestSync(accountId, mailbox.id),
            ),
        );
      }
    } catch (error) {
      if (error instanceof StaleAccountWorkError) throw error;
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
