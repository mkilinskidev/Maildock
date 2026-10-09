import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  instanceState,
  mailAccounts,
  mailboxes,
  mailboxMessages,
  notificationEvents,
} from "../../../shared/infrastructure/database/schema";
import {
  defaultNotificationPreferences,
  matchesNotificationPreferences,
  notificationPreferencesSchema,
  type NotificationPreferences,
} from "../domain/notifications";

export class NotificationService {
  constructor(private readonly db: Database) {}

  async preferences(): Promise<NotificationPreferences> {
    const [row] = await this.db
      .select()
      .from(instanceState)
      .where(eq(instanceState.id, 1));
    return notificationPreferencesSchema.parse(
      row?.notificationPreferences ?? defaultNotificationPreferences,
    );
  }

  async setPreferences(value: NotificationPreferences) {
    const preferences = notificationPreferencesSchema.parse(value);
    await this.db.transaction(async (tx) => {
      await tx.insert(instanceState).values({ id: 1 }).onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(instanceState)
        .where(eq(instanceState.id, 1))
        .for("update");
      await tx
        .update(instanceState)
        .set({
          notificationPreferences: preferences,
          // Changes never turn previously excluded mail into a new arrival.
          notificationCheckpoint: state.notificationSequence,
          updatedAt: new Date(),
        })
        .where(eq(instanceState.id, 1));
    });
  }

  async consume(start = false) {
    return this.db.transaction(async (tx) => {
      await tx.insert(instanceState).values({ id: 1 }).onConflictDoNothing();
      // Shared owner checkpoint also arbitrates simultaneous tabs. Event writers
      // take this same lock, so sequence order is transaction commit order.
      const [state] = await tx
        .select()
        .from(instanceState)
        .where(eq(instanceState.id, 1))
        .for("update");
      const preferences = notificationPreferencesSchema.parse(
        state.notificationPreferences,
      );
      await tx
        .delete(notificationEvents)
        .where(
          lt(notificationEvents.createdAt, sql`now() - interval '7 days'`),
        );
      if (start) {
        await tx
          .update(instanceState)
          .set({ notificationCheckpoint: state.notificationSequence })
          .where(eq(instanceState.id, 1));
        return { preferences, events: [] };
      }
      const rows = await tx
        .select()
        .from(notificationEvents)
        .where(gt(notificationEvents.sequence, state.notificationCheckpoint))
        .orderBy(notificationEvents.sequence)
        .limit(50);
      const events = [];
      for (const row of rows) {
        if (
          row.receiveTransport !== "imap" ||
          row.uid === null ||
          row.uidValidity === null
        )
          continue;
        const [context] = await tx
          .select({
            enabled: mailAccounts.enabled,
            accountName: mailAccounts.displayName,
            remotePath: mailboxes.remotePath,
            specialUse: mailboxes.specialUse,
          })
          .from(mailboxes)
          .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
          .innerJoin(
            mailboxMessages,
            and(
              eq(mailboxMessages.mailboxId, mailboxes.id),
              eq(mailboxMessages.messageId, row.messageId),
              eq(mailboxMessages.uidValidity, row.uidValidity),
              eq(mailboxMessages.uid, row.uid),
            ),
          )
          .where(
            and(
              eq(mailboxes.id, row.mailboxId),
              eq(mailboxes.accountId, row.accountId),
              eq(mailboxes.lifecycleStatus, "active"),
              eq(mailboxes.uidValidity, row.uidValidity),
            ),
          );
        if (
          !context?.enabled ||
          !matchesNotificationPreferences(
            preferences,
            row.accountId,
            context.remotePath.toUpperCase() === "INBOX" ||
              context.specialUse.includes("\\Inbox"),
          )
        )
          continue;
        // Long browser suspensions must not cause a burst of stale notifications.
        if (Date.now() - row.createdAt.valueOf() > 120_000) continue;
        events.push({
          id: row.sequence.toString(),
          accountId: row.accountId,
          mailboxId: row.mailboxId,
          messageId: row.messageId,
          sender: row.sender,
          subject: row.subject,
          accountName: context.accountName,
        });
      }
      await tx
        .update(instanceState)
        .set({
          notificationCheckpoint:
            rows.at(-1)?.sequence ?? state.notificationSequence,
        })
        .where(eq(instanceState.id, 1));
      return { preferences, events };
    });
  }
}
