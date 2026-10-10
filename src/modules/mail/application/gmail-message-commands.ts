import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql, lt } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
  messageCommands,
  messages,
  mailboxRoles,
} from "../../../shared/infrastructure/database/schema";
import {
  assertGmailPublication,
  type GmailProvider,
} from "../infrastructure/gmail-provider";
import type { GmailAccountLock } from "../infrastructure/gmail-account-lock";
import { projectGmailMessage } from "../infrastructure/gmail-projector";
import type { MessageAction } from "./message-command-service";
import { MessageCommandUnavailableError } from "./message-command-service";
import { resolveMappedMailbox } from "./mailbox-role-service";
import { StaleAccountWorkError } from "../../accounts/domain/receive-transport";

export class GmailMessageCommands {
  constructor(
    private readonly db: Database,
    private readonly enqueue: (id: string) => Promise<void>,
    private readonly provider?: GmailProvider,
    private readonly lock?: GmailAccountLock,
  ) {}
  async createNative(
    accountId: string,
    nativeId: string,
    action: MessageAction,
    destinationMailboxId?: string,
  ) {
    const [row] = await this.db
      .select({ messageId: messages.id, mailboxId: mailboxMessages.mailboxId })
      .from(messages)
      .innerJoin(mailboxMessages, eq(mailboxMessages.messageId, messages.id))
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId))
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.providerMessageId, nativeId),
          eq(mailboxMessages.actionHidden, false),
          eq(mailboxes.lifecycleStatus, "active"),
        ),
      )
      .orderBy(
        sql`(${mailboxes.providerMailboxId}='INBOX') desc nulls last`,
        mailboxes.id,
      )
      .limit(1);
    if (!row)
      throw new MessageCommandUnavailableError(
        "Gmail message is unavailable in the local cache.",
      );
    return this.create(
      accountId,
      row.mailboxId,
      row.messageId,
      action,
      destinationMailboxId,
    );
  }
  async create(
    accountId: string,
    mailboxId: string,
    messageId: string,
    action: MessageAction,
    destinationMailboxId?: string,
  ) {
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, accountId))
        .for("share");
      if (!account)
        throw new MessageCommandUnavailableError("Account is unavailable.");
      await assertGmailPublication(
        tx,
        accountId,
        account.workRevision.toString(),
      );
      const [message] = await tx
        .select()
        .from(messages)
        .where(
          and(eq(messages.id, messageId), eq(messages.accountId, accountId)),
        )
        .for("update");
      const [placement] = await tx
        .select()
        .from(mailboxMessages)
        .where(
          and(
            eq(mailboxMessages.messageId, messageId),
            eq(mailboxMessages.mailboxId, mailboxId),
          ),
        );
      if (!message || !placement || message.remoteMissingAt)
        throw new MessageCommandUnavailableError("Message is unavailable.");
      const active = await tx
        .select()
        .from(messageCommands)
        .where(
          and(
            eq(messageCommands.messageId, messageId),
            inArray(messageCommands.status, ["pending", "executing"]),
          ),
        )
        .limit(1);
      if (active.length)
        throw new MessageCommandUnavailableError(
          "A message action is already in progress.",
        );
      let destination: typeof mailboxes.$inferSelect | null = null;
      if (action === "move") {
        const [target] = await tx
          .select()
          .from(mailboxes)
          .where(
            and(
              eq(
                mailboxes.id,
                destinationMailboxId ?? "00000000-0000-0000-0000-000000000000",
              ),
              eq(mailboxes.accountId, accountId),
              eq(mailboxes.lifecycleStatus, "active"),
            ),
          );
        if (
          !target?.selectable ||
          target.viewKind === "all_mail" ||
          (!target.providerMailboxId?.startsWith("Label_") &&
            !["INBOX", "TRASH", "SPAM"].includes(
              target.providerMailboxId ?? "",
            ))
        )
          throw new MessageCommandUnavailableError(
            "Select a native Gmail destination label in this account.",
          );
        destination = target;
      }
      if (action === "archive" || action === "trash") {
        const candidates = await tx
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.accountId, accountId));
        const [mapping] = await tx
          .select()
          .from(mailboxRoles)
          .where(
            and(
              eq(mailboxRoles.accountId, accountId),
              eq(mailboxRoles.role, action),
            ),
          );
        destination = resolveMappedMailbox(
          accountId,
          action,
          mapping,
          candidates,
        );
        if (
          !destination ||
          (action === "trash" && destination.providerMailboxId !== "TRASH") ||
          (action === "archive" &&
            destination.viewKind !== "all_mail" &&
            !destination.providerMailboxId?.startsWith("Label_"))
        )
          throw new MessageCommandUnavailableError(
            "Select native Gmail Trash or All Mail/a custom archive label in folder settings.",
          );
      }
      const [last] = await tx
        .select({
          value: sql<string>`coalesce(max(${messageCommands.intentSequence}),0)::text`,
        })
        .from(messageCommands)
        .where(eq(messageCommands.messageId, messageId));
      await tx.insert(messageCommands).values({
        id,
        accountId,
        mailboxId,
        messageId,
        placementId: placement.id,
        receiveTransport: "gmail",
        accountRevision: account.workRevision,
        intentSequence: BigInt(last.value) + 1n,
        action,
        destinationMailboxId: destination?.id,
        originalFlags: placement.flags,
      });
      const flag = action.startsWith("mark_") ? "\\Seen" : "\\Flagged";
      const flags = ["mark_read", "flag"].includes(action)
        ? [...new Set([...placement.flags, flag])]
        : ["mark_unread", "unflag"].includes(action)
          ? placement.flags.filter((f) => f !== flag)
          : placement.flags;
      await tx
        .update(mailboxMessages)
        .set({ flags, updatedAt: new Date() })
        .where(eq(mailboxMessages.messageId, messageId));
      const [inbox] =
        action === "archive"
          ? await tx
              .select({ id: mailboxes.id })
              .from(mailboxes)
              .where(
                and(
                  eq(mailboxes.accountId, accountId),
                  eq(mailboxes.providerMailboxId, "INBOX"),
                ),
              )
          : [];
      if (
        action === "trash" ||
        action === "move" ||
        (action === "archive" && inbox)
      )
        await tx
          .update(mailboxMessages)
          .set({ actionHidden: true })
          .where(
            and(
              eq(mailboxMessages.messageId, messageId),
              action === "archive" || action === "move"
                ? eq(
                    mailboxMessages.mailboxId,
                    action === "archive" ? inbox!.id : mailboxId,
                  )
                : undefined,
            ),
          );
    });
    await this.enqueue(id).catch(() => undefined);
    return { id, status: "pending" as const };
  }
  async run(id: string) {
    if (!this.provider || !this.lock)
      throw new Error("Gmail command worker is unavailable.");
    const [initial] = await this.db
      .select()
      .from(messageCommands)
      .where(eq(messageCommands.id, id));
    if (!initial || !["pending", "executing"].includes(initial.status)) return;
    let lease;
    try {
      lease = await this.provider.lease(
        initial.accountId,
        initial.accountRevision.toString(),
      );
    } catch (error) {
      if (!(error instanceof StaleAccountWorkError)) throw error;
      await this.db
        .update(messageCommands)
        .set({
          status: "failed",
          error: "Account changed or disconnected; Gmail action was cancelled.",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(messageCommands.id, id),
            inArray(messageCommands.status, ["pending", "executing"]),
          ),
        );
      return;
    }
    await this.lock(initial.accountId, async (db) => {
      const [command] = await db
        .select()
        .from(messageCommands)
        .where(eq(messageCommands.id, id));
      if (!command || !["pending", "executing"].includes(command.status))
        return;
      await db.transaction((tx) =>
        assertGmailPublication(tx, command.accountId, lease.revision),
      );
      const prior = await db
        .select()
        .from(messageCommands)
        .where(
          and(
            eq(messageCommands.messageId, command.messageId),
            lt(messageCommands.intentSequence, command.intentSequence),
            inArray(messageCommands.status, ["pending", "executing"]),
          ),
        )
        .limit(1);
      if (prior.length) throw new Error("Earlier Gmail command is pending.");
      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, command.messageId));
      if (!message?.providerMessageId)
        throw new MessageCommandUnavailableError("Message is unavailable.");
      const client = this.provider!.client(db, lease, true);
      await db
        .update(messageCommands)
        .set({
          status: "executing",
          attempts: sql`${messageCommands.attempts}+1`,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(messageCommands.id, id));
      try {
        // Observe first on every retry. Set-label intents and Trash are idempotent.
        const before = await client.message(message.providerMessageId);
        const destination = command.destinationMailboxId
          ? (
              await db
                .select()
                .from(mailboxes)
                .where(eq(mailboxes.id, command.destinationMailboxId))
            )[0]
          : null;
        if (
          command.destinationMailboxId &&
          (!destination || destination.lifecycleStatus !== "active")
        )
          throw new MessageCommandUnavailableError(
            "Gmail destination label is unavailable.",
          );
        const source = (
          await db
            .select()
            .from(mailboxes)
            .where(eq(mailboxes.id, command.mailboxId))
        )[0];
        const add =
          command.action === "mark_unread"
            ? ["UNREAD"]
            : command.action === "flag"
              ? ["STARRED"]
              : ["archive", "move"].includes(command.action) &&
                  destination?.providerMailboxId
                ? [destination.providerMailboxId]
                : [];
        const remove =
          command.action === "mark_read"
            ? ["UNREAD"]
            : command.action === "unflag"
              ? ["STARRED"]
              : command.action === "archive"
                ? ["INBOX"]
                : command.action === "move" &&
                    source?.providerMailboxId &&
                    source.providerMailboxId !== destination?.providerMailboxId
                  ? [source.providerMailboxId]
                  : [];
        const trash =
          command.action === "trash" ||
          (command.action === "move" &&
            destination?.providerMailboxId === "TRASH");
        if (trash) {
          if (!before.labelIds.includes("TRASH"))
            await client.trash(message.providerMessageId);
        } else if (
          add.some((l) => !before.labelIds.includes(l)) ||
          remove.some((l) => before.labelIds.includes(l))
        )
          await client.modify(message.providerMessageId, add, remove);
        const after = await client.message(message.providerMessageId);
        if (
          trash
            ? !after.labelIds.includes("TRASH")
            : add.some((l) => !after.labelIds.includes(l)) ||
              remove.some((l) => after.labelIds.includes(l))
        )
          throw new Error("Gmail command confirmation changed.");
        // Mark terminal and publish confirmed state atomically. This removes the
        // accepted intent's overlay while retaining any later intent.
        await db.transaction(async (tx) => {
          await assertGmailPublication(tx, command.accountId, lease.revision);
          await tx
            .update(messageCommands)
            .set({
              status: "succeeded",
              error: null,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(messageCommands.id, id));
          await projectGmailMessage(
            tx as unknown as Database,
            command.accountId,
            lease.revision,
            message.providerMessageId!,
            after,
          );
        });
      } catch (error) {
        if (command.attempts >= 4) {
          await db.transaction(async (tx) => {
            await assertGmailPublication(tx, command.accountId, lease.revision);
            await tx
              .update(messageCommands)
              .set({
                status: "failed",
                error:
                  "Gmail action could not be confirmed. Refresh and retry.",
                completedAt: new Date(),
              })
              .where(eq(messageCommands.id, id));
            await tx
              .update(mailboxMessages)
              .set({ flags: command.originalFlags, actionHidden: false })
              .where(eq(mailboxMessages.messageId, command.messageId));
          });
        } else throw error;
      }
    });
  }
}
