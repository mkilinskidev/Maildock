import { and, eq } from "drizzle-orm";

import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
  type MailProvider,
} from "../../accounts/domain/mail-provider";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import type { MessageService } from "./message-service";

export class BackfillSyncService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly provider: MailProvider,
    private readonly messages: MessageService,
    private readonly chunkSize: number,
  ) {}

  async run(accountId: string, mailboxId: string): Promise<string | null> {
    const [row] = await this.database
      .select({ mailbox: mailboxes, enabled: mailAccounts.enabled })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .where(
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
      )
      .limit(1);
    if (
      !row ||
      !row.enabled ||
      !row.mailbox.selectable ||
      row.mailbox.lifecycleStatus !== "active" ||
      row.mailbox.recentSyncStatus !== "success" ||
      row.mailbox.recentSyncUidValidity === null
    )
      return null;
    const mailbox = row.mailbox;
    if (
      mailbox.backfillUidValidity === mailbox.recentSyncUidValidity &&
      mailbox.backfillStatus === "complete"
    )
      return null;
    if (!this.provider.synchronizeBackfillMailbox)
      throw new Error("Backfill provider is unavailable.");
    let frontier: bigint | undefined;
    const epoch = mailbox.recentSyncUidValidity!;
    try {
      const account =
        await this.accounts.getProviderImapAccountForWork(accountId);
      await this.provider.synchronizeBackfillMailbox(
        account,
        {
          remotePath: mailbox.remotePath,
          frontier:
            mailbox.backfillUidValidity === epoch
              ? (mailbox.backfillFrontierUid?.toString() ?? null)
              : null,
          chunkSize: this.chunkSize,
        },
        {
          selected: async (observed, initialFrontier) => {
            if (BigInt(observed) !== epoch)
              throw new MailboxEpochChangedError();
            frontier = BigInt(initialFrontier);
            await this.database
              .update(mailboxes)
              .set({
                backfillUidValidity: epoch,
                backfillFrontierUid: frontier,
                backfillStatus: "running",
                backfillError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(mailboxes.id, mailboxId),
                  eq(mailboxes.recentSyncUidValidity, epoch),
                ),
              );
          },
          chunk: async (batch, nextFrontier) => {
            if (frontier === undefined)
              throw new Error("Mailbox epoch was not selected.");
            await this.messages.persistBatch(
              accountId,
              mailboxId,
              epoch,
              batch,
              undefined,
              {
                frontier,
                nextFrontier: BigInt(nextFrontier),
              },
            );
            frontier = BigInt(nextFrontier);
          },
        },
      );
      return frontier === 0n ? null : (frontier?.toString() ?? null);
    } catch (error) {
      if (error instanceof MailboxEpochChangedError) {
        await this.database
          .update(mailboxes)
          .set({
            backfillUidValidity: null,
            backfillFrontierUid: null,
            backfillStatus: "not_started",
            backfillError: null,
            updatedAt: new Date(),
          })
          .where(eq(mailboxes.id, mailboxId));
        await this.messages.requestRecentSync(accountId, mailboxId);
        return null;
      }
      await this.database
        .update(mailboxes)
        .set({
          backfillStatus: "failed",
          backfillError:
            error instanceof MailProviderOperationError
              ? error.message
              : "Historical message synchronization failed.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailboxes.backfillUidValidity, epoch),
          ),
        );
      throw error;
    }
  }
}
