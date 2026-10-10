import { assertImapPublication } from "../infrastructure/receive-publication-fence";
import {
  MailTransportRouter,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxRoles,
  mailboxMessages,
  messageCommands,
  messages,
} from "../../../shared/infrastructure/database/schema";
import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
  type MailProvider,
  type RemoteMutationRequest,
} from "../../accounts/domain/mail-provider";
import { resolveMappedMailbox } from "./mailbox-role-service";
import { GmailMessageCommands } from "./gmail-message-commands";

export type MessageAction = RemoteMutationRequest["action"] | "move";
const moveActions = new Set<MessageAction>(["archive", "trash"]);
export class MessageCommandUnavailableError extends Error {}

export class MessageCommandService {
  constructor(
    private readonly database: Database,
    private readonly enqueue: (id: string) => Promise<void>,
    private readonly reconcile: (
      accountId: string,
      mailboxId: string,
    ) => Promise<void>,
    private readonly accounts?: AccountsService,
    private readonly provider?: MailProvider,
    private readonly gmail?: GmailMessageCommands,
  ) {}

  async create(
    accountId: string,
    mailboxId: string,
    messageId: string,
    action: MessageAction,
    destinationMailboxId?: string,
  ) {
    const [owner] = await this.database
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId));
    if (owner?.receiveTransport === "gmail")
      return (
        this.gmail ?? new GmailMessageCommands(this.database, this.enqueue)
      ).create(accountId, mailboxId, messageId, action, destinationMailboxId);
    if (action === "move")
      throw new MessageCommandUnavailableError(
        "This move operation requires a native Gmail account.",
      );
    const command = await this.database.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, accountId))
        .limit(1);
      if (account) new MailTransportRouter().requireImap(account);
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(
          and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
        )
        .limit(1);
      if (
        !account?.enabled ||
        !mailbox?.selectable ||
        mailbox.lifecycleStatus !== "active" ||
        mailbox.uidValidity === null ||
        mailbox.recentSyncUidValidity !== mailbox.uidValidity
      )
        throw new MessageCommandUnavailableError(
          "This mailbox is not ready for message actions.",
        );
      const [placement] = await tx
        .select()
        .from(mailboxMessages)
        .innerJoin(messages, eq(messages.id, mailboxMessages.messageId))
        .where(
          and(
            eq(mailboxMessages.mailboxId, mailboxId),
            eq(mailboxMessages.messageId, messageId),
            eq(messages.accountId, accountId),
            eq(mailboxMessages.uidValidity, mailbox.uidValidity),
          ),
        )
        .limit(1);
      if (!placement)
        throw new MessageCommandUnavailableError(
          "Message is no longer in this mailbox.",
        );
      const active = await tx
        .select({ id: messageCommands.id })
        .from(messageCommands)
        .where(
          and(
            eq(messageCommands.placementId, placement.mailbox_messages.id),
            inArray(messageCommands.status, ["pending", "executing"]),
          ),
        )
        .limit(1);
      if (active.length || placement.mailbox_messages.actionHidden)
        throw new MessageCommandUnavailableError(
          "A message action is already in progress.",
        );
      let destination: typeof mailbox | undefined;
      if (moveActions.has(action)) {
        const [mapping] = await tx
          .select()
          .from(mailboxRoles)
          .where(
            and(
              eq(mailboxRoles.accountId, accountId),
              eq(mailboxRoles.role, action),
            ),
          )
          .limit(1);
        const candidates = await tx
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.accountId, accountId));
        const resolved = resolveMappedMailbox(
          accountId,
          action as "archive" | "trash",
          mapping,
          candidates,
        );
        destination =
          account.imapCapabilities.includes("MOVE") &&
          resolved?.id !== mailboxId
            ? (resolved ?? undefined)
            : undefined;
        if (!destination)
          throw new MessageCommandUnavailableError(
            "The configured system mailbox or IMAP MOVE is unavailable.",
          );
      }
      const originalFlags = placement.mailbox_messages.flags;
      const flag =
        action === "mark_read" || action === "mark_unread"
          ? "\\Seen"
          : "\\Flagged";
      const add = action === "mark_read" || action === "flag";
      const flags = moveActions.has(action)
        ? originalFlags
        : add
          ? [...new Set([...originalFlags, flag])]
          : originalFlags.filter((value) => value !== flag);
      await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, messageId))
        .for("update");
      const [lastIntent] = await tx
        .select({
          sequence: sql<string>`coalesce(max(${messageCommands.intentSequence}), 0)::text`,
        })
        .from(messageCommands)
        .where(
          and(
            eq(messageCommands.accountId, accountId),
            eq(messageCommands.messageId, messageId),
          ),
        );
      const intentSequence = BigInt(lastIntent.sequence) + 1n;
      const id = randomUUID();
      const now = new Date();
      await tx.insert(messageCommands).values({
        id,
        accountId,
        accountRevision: account.workRevision,
        intentSequence,
        mailboxId,
        placementId: placement.mailbox_messages.id,
        messageId,
        action,
        sourcePath: mailbox.remotePath,
        sourceUidValidity: mailbox.uidValidity,
        sourceUid: placement.mailbox_messages.uid,
        destinationMailboxId: destination?.id,
        destinationPath: destination?.remotePath,
        originalFlags,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(mailboxMessages)
        .set({ flags, actionHidden: moveActions.has(action), updatedAt: now })
        .where(eq(mailboxMessages.id, placement.mailbox_messages.id));
      return { id, status: "pending" as const };
    });
    // A failed enqueue leaves a durable pending command for the worker poller.
    await this.enqueue(command.id).catch(() => undefined);
    return command;
  }

  async status(accountId: string, ids: readonly string[]) {
    if (!ids.length) return [];
    return this.database
      .select({
        id: messageCommands.id,
        status: messageCommands.status,
        error: messageCommands.error,
        completedAt: messageCommands.completedAt,
      })
      .from(messageCommands)
      .where(
        and(
          eq(messageCommands.accountId, accountId),
          inArray(messageCommands.id, [...ids]),
        ),
      );
  }

  async pendingIds() {
    const rows = await this.database
      .select({ id: messageCommands.id })
      .from(messageCommands)
      .where(inArray(messageCommands.status, ["pending", "executing"]))
      .orderBy(desc(messageCommands.createdAt))
      .limit(100);
    return rows.map((row) => row.id);
  }

  async mailboxId(id: string) {
    const [row] = await this.database
      .select({
        mailboxId: messageCommands.mailboxId,
        transport: messageCommands.receiveTransport,
      })
      .from(messageCommands)
      .where(eq(messageCommands.id, id))
      .limit(1);
    return row?.transport === "gmail" ? undefined : row?.mailboxId;
  }

  async run(id: string) {
    const [native] = await this.database
      .select()
      .from(messageCommands)
      .where(eq(messageCommands.id, id));
    if (native?.receiveTransport === "gmail") {
      if (!this.gmail) throw new Error("Gmail commands are unavailable.");
      return this.gmail.run(id);
    }
    if (!this.accounts || !this.provider?.mutateMessage)
      throw new Error("Message mutation provider is unavailable.");
    const [initial] = await this.database
      .select()
      .from(messageCommands)
      .where(eq(messageCommands.id, id))
      .limit(1);
    if (
      !initial ||
      initial.status === "failed" ||
      initial.status === "succeeded"
    )
      return;
    if (
      moveActions.has(initial.action as MessageAction) &&
      initial.status === "executing"
    ) {
      await this.fail(
        initial,
        "Move outcome is uncertain; the mailbox is being reconciled.",
      );
      return;
    }
    const [accountRow] = await this.database
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, initial.accountId))
      .limit(1);
    if (accountRow)
      new MailTransportRouter().requireImap(
        accountRow,
        initial.accountRevision.toString(),
      );
    const [mailbox] = await this.database
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, initial.mailboxId))
      .limit(1);
    if (
      !accountRow?.enabled ||
      !mailbox?.selectable ||
      mailbox.lifecycleStatus !== "active"
    ) {
      await this.fail(initial, "Account or mailbox is unavailable.");
      return;
    }
    if (
      mailbox.uidValidity !== initial.sourceUidValidity ||
      mailbox.remotePath !== initial.sourcePath
    ) {
      await this.fail(
        initial,
        "Mailbox identity changed before the action ran.",
      );
      return;
    }
    if (moveActions.has(initial.action as MessageAction)) {
      const [mapping] = await this.database
        .select()
        .from(mailboxRoles)
        .where(
          and(
            eq(mailboxRoles.accountId, initial.accountId),
            eq(mailboxRoles.role, initial.action),
          ),
        )
        .limit(1);
      const candidates = await this.database
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.accountId, initial.accountId));
      const target = resolveMappedMailbox(
        initial.accountId,
        initial.action as "archive" | "trash",
        mapping,
        candidates,
      );
      if (
        !target ||
        target.id === initial.mailboxId ||
        target.id !== initial.destinationMailboxId ||
        target.remotePath !== initial.destinationPath
      ) {
        await this.fail(
          initial,
          "Configured system mailbox changed before the action ran.",
        );
        return;
      }
    }
    const [placement] = await this.database
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.id, initial.placementId ?? ""))
      .limit(1);
    if (
      !placement ||
      placement.uid !== initial.sourceUid ||
      placement.uidValidity !== initial.sourceUidValidity
    ) {
      await this.fail(
        initial,
        "Message placement changed before the action ran.",
      );
      return;
    }
    await this.database
      .update(messageCommands)
      .set({
        status: "executing",
        attempts: sql`${messageCommands.attempts} + 1`,
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(messageCommands.id, id));
    try {
      const account = await this.accounts.getProviderImapAccountForWork(
        initial.accountId,
        initial.accountRevision.toString(),
      );
      const result = await this.provider.mutateMessage(account, {
        sourcePath: initial.sourcePath!,
        uidValidity: initial.sourceUidValidity!.toString(),
        uid: initial.sourceUid!.toString(),
        action: initial.action as RemoteMutationRequest["action"],
        ...(initial.destinationPath
          ? { destinationPath: initial.destinationPath }
          : {}),
        ...(placement.modseq ? { modseq: placement.modseq.toString() } : {}),
      });
      if (result.outcome !== "applied") {
        await this.fail(
          initial,
          result.outcome === "source_missing"
            ? "Message was no longer present on the server."
            : "Message changed on the server; please retry.",
        );
        return;
      }
      await this.database.transaction(async (tx) => {
        await assertImapPublication(
          tx,
          initial.accountId,
          initial.accountRevision.toString(),
        );
        await tx
          .update(messageCommands)
          .set({
            status: "succeeded",
            error: null,
            destinationUidValidity: result.destinationUidValidity
              ? BigInt(result.destinationUidValidity)
              : null,
            destinationUid: result.destinationUid
              ? BigInt(result.destinationUid)
              : null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(messageCommands.id, id));
        if (moveActions.has(initial.action as MessageAction))
          await tx
            .delete(mailboxMessages)
            .where(eq(mailboxMessages.id, placement.id));
      });
      await this.reconcile(initial.accountId, initial.mailboxId).catch(
        () => undefined,
      );
      if (initial.destinationMailboxId)
        await this.reconcile(
          initial.accountId,
          initial.destinationMailboxId,
        ).catch(() => undefined);
    } catch (error) {
      if (error instanceof StaleAccountWorkError) throw error;
      const [current] = await this.database
        .select({ status: messageCommands.status })
        .from(messageCommands)
        .where(eq(messageCommands.id, id))
        .limit(1);
      if (current?.status === "succeeded") return;
      if (error instanceof MailboxEpochChangedError) {
        await this.fail(
          initial,
          "Mailbox UIDVALIDITY changed; action was cancelled.",
        );
      } else if (moveActions.has(initial.action as MessageAction)) {
        await this.fail(
          initial,
          "Move outcome is uncertain; the mailbox is being reconciled.",
        );
      } else if (initial.attempts >= 3) {
        await this.fail(
          initial,
          error instanceof MailProviderOperationError
            ? error.message
            : "Message action failed.",
        );
      } else {
        throw error;
      }
    }
  }

  private async fail(
    command: typeof messageCommands.$inferSelect,
    error: string,
  ) {
    await this.database.transaction(async (tx) => {
      await tx
        .update(messageCommands)
        .set({
          status: "failed",
          error,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(messageCommands.id, command.id));
      if (command.placementId)
        await tx
          .update(mailboxMessages)
          .set({
            flags: command.originalFlags,
            actionHidden: false,
            updatedAt: new Date(),
          })
          .where(eq(mailboxMessages.id, command.placementId));
    });
    await this.reconcile(command.accountId, command.mailboxId).catch(
      () => undefined,
    );
    if (command.destinationMailboxId)
      await this.reconcile(
        command.accountId,
        command.destinationMailboxId,
      ).catch(() => undefined);
  }
}
