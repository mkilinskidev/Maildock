import { and, eq, ne } from "drizzle-orm";
import type { AccountsService } from "../../accounts/application/accounts-service";
import {
  MailProviderOperationError,
  type MailProvider,
} from "../../accounts/domain/mail-provider";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxMessages,
  mailboxes,
  messageContents,
  messages,
} from "../../../shared/infrastructure/database/schema";
import {
  attachmentMetadata,
  selectDisplayParts,
} from "../domain/display-parts";
import {
  EMAIL_HTML_POLICY,
  sanitizeEmailHtml,
} from "../infrastructure/sanitize-email-html";
import type { ContentScheduler } from "./content-scheduler";

export class MessagePlacementNotFoundError extends Error {
  constructor() {
    super("Message is unavailable in this mailbox.");
  }
}
export class MessageContentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class MessageContentService {
  constructor(
    private readonly database: Database,
    private readonly scheduler?: ContentScheduler,
    private readonly accounts?: AccountsService,
    private readonly provider?: MailProvider,
    private readonly config?: Pick<AppConfig, "maxMessageTextPartBytes">,
  ) {}

  private async placement(
    accountId: string,
    mailboxId: string,
    messageId: string,
  ) {
    const [row] = await this.database
      .select({
        account: mailAccounts,
        mailbox: mailboxes,
        placement: mailboxMessages,
        message: messages,
        content: messageContents,
      })
      .from(mailboxMessages)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId))
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .innerJoin(messages, eq(messages.id, mailboxMessages.messageId))
      .leftJoin(messageContents, eq(messageContents.messageId, messages.id))
      .where(
        and(
          eq(mailAccounts.id, accountId),
          eq(mailboxes.id, mailboxId),
          eq(messages.id, messageId),
          eq(messages.accountId, accountId),
        ),
      )
      .limit(1);
    if (!row) throw new MessagePlacementNotFoundError();
    return row;
  }

  async detail(accountId: string, mailboxId: string, messageId: string) {
    const { message, placement, content } = await this.placement(
      accountId,
      mailboxId,
      messageId,
    );
    return {
      id: message.id,
      subject: message.subject,
      sentAt: message.sentAt?.toISOString() ?? null,
      date: message.internalDate.toISOString(),
      from: message.from,
      sender: message.sender,
      replyTo: message.replyTo,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      seen: placement.flags.includes("\\Seen"),
      flagged: placement.flags.includes("\\Flagged"),
      attachments: attachmentMetadata(message.mimeStructure),
      content: {
        status: content?.status ?? "not_fetched",
        plainText: content?.status === "ready" ? content.plainText : null,
        sanitizedHtml:
          content?.status === "ready" ? content.sanitizedHtml : null,
        remoteContentBlocked: content?.remoteContentBlocked ?? false,
        error: content?.status === "failed" ? content.error : null,
      },
    };
  }

  async request(accountId: string, mailboxId: string, messageId: string) {
    const row = await this.placement(accountId, mailboxId, messageId);
    if (!row.account.enabled)
      throw new MessageContentUnavailableError("This account is disabled.");
    if (!row.mailbox.selectable || row.mailbox.lifecycleStatus !== "active")
      throw new MessageContentUnavailableError("This mailbox is unavailable.");
    if (
      row.content?.status === "ready" ||
      row.content?.status === "pending" ||
      row.content?.status === "fetching"
    )
      return false;
    if (!this.scheduler) throw new Error("Content scheduler is unavailable.");
    const now = new Date();
    await this.database
      .insert(messageContents)
      .values({ messageId, status: "pending", updatedAt: now })
      .onConflictDoUpdate({
        target: messageContents.messageId,
        set: { status: "pending", error: null, updatedAt: now },
      });
    try {
      return await this.scheduler.schedule(accountId, mailboxId, messageId);
    } catch {
      await this.database
        .update(messageContents)
        .set({
          status: "failed",
          error: "Content fetch could not be scheduled.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(messageContents.messageId, messageId),
            eq(messageContents.status, "pending"),
          ),
        );
      throw new MessageContentUnavailableError(
        "Content fetch could not be scheduled.",
      );
    }
  }

  async run(accountId: string, mailboxId: string, messageId: string) {
    if (!this.accounts || !this.provider || !this.config)
      throw new Error("Content worker dependencies are unavailable.");
    try {
      const row = await this.placement(accountId, mailboxId, messageId);
      if (row.content?.status === "ready") return;
      if (
        !row.account.enabled ||
        !row.mailbox.selectable ||
        row.mailbox.lifecycleStatus !== "active"
      )
        throw new MessageContentUnavailableError(
          "Account or mailbox is unavailable.",
        );
      if (row.mailbox.recentSyncUidValidity !== row.placement.uidValidity)
        throw new MessageContentUnavailableError(
          "Mailbox UIDVALIDITY changed. Synchronize metadata again.",
        );
      const parts = selectDisplayParts(row.message.mimeStructure);
      if (parts.length === 0)
        throw new MessageContentUnavailableError(
          "No display text part is available.",
        );
      await this.database
        .update(messageContents)
        .set({ status: "fetching", error: null, updatedAt: new Date() })
        .where(eq(messageContents.messageId, messageId));
      const account =
        await this.accounts.getProviderImapAccountForWork(accountId);
      const result = await this.provider.fetchMessageContent(account, {
        remotePath: row.mailbox.remotePath,
        uid: row.placement.uid.toString(),
        expectedUidValidity: row.placement.uidValidity.toString(),
        parts,
        maxPartBytes: this.config.maxMessageTextPartBytes,
      });
      let html: string | null = null;
      let blocked = false;
      if (result.html !== null) {
        try {
          const sanitized = sanitizeEmailHtml(result.html);
          html = sanitized.html;
          blocked = sanitized.remoteContentBlocked;
        } catch {
          if (result.plainText === null)
            throw new MessageContentUnavailableError(
              "Message HTML could not be sanitized.",
            );
        }
      }
      if (html === null && result.plainText === null)
        throw new MessageContentUnavailableError(
          "No display text part is available.",
        );
      if (
        Buffer.byteLength(html ?? "", "utf8") >
        this.config.maxMessageTextPartBytes
      )
        throw new MessageContentUnavailableError(
          "Sanitized message exceeds the configured size limit.",
        );
      await this.database
        .update(messageContents)
        .set({
          status: "ready",
          plainText: result.plainText,
          sanitizedHtml: html,
          remoteContentBlocked: blocked,
          policyVersion: EMAIL_HTML_POLICY,
          error: null,
          fetchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(messageContents.messageId, messageId));
    } catch (error) {
      const reason =
        error instanceof MessageContentUnavailableError ||
        error instanceof MailProviderOperationError
          ? error.message
          : "Message content could not be fetched.";
      await this.database
        .insert(messageContents)
        .values({ messageId, status: "failed", error: reason })
        .onConflictDoUpdate({
          target: messageContents.messageId,
          set: { status: "failed", error: reason, updatedAt: new Date() },
          setWhere: ne(messageContents.status, "ready"),
        });
      throw new Error(reason);
    }
  }
}
