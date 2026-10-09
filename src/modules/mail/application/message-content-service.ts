import {
  withPerformance,
  measureStage,
  beginStage,
} from "../../../shared/infrastructure/logging/performance";
import { and, eq, ne, or, isNotNull, gt, inArray, sql } from "drizzle-orm";
import {
  persistAttachmentMetadata,
  listAttachmentMetadata,
} from "./attachment-metadata";
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
import { selectDisplayParts } from "../domain/display-parts";
import {
  EMAIL_HTML_POLICY,
  sanitizeEmailHtml,
} from "../infrastructure/sanitize-email-html";
import type { ContentScheduler } from "./content-scheduler";
import { searchBodyText } from "../infrastructure/search-body-text";

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

  private recoveryCursor?: string;

  /** Cursor pages bound maintenance work and revisit live jobs without age guesses. */
  async recoverPending(scheduler: ContentScheduler) {
    if (!scheduler.state) return;
    const rows = await this.database
      .select({
        messageId: messageContents.messageId,
        updatedAt: messageContents.updatedAt,
        accountId: mailboxes.accountId,
        mailboxId: mailboxes.id,
      })
      .from(messageContents)
      .innerJoin(
        mailboxMessages,
        eq(mailboxMessages.messageId, messageContents.messageId),
      )
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId))
      .where(
        and(
          inArray(messageContents.status, ["pending", "fetching"]),
          this.recoveryCursor
            ? gt(messageContents.messageId, this.recoveryCursor)
            : undefined,
        ),
      )
      .orderBy(messageContents.messageId)
      .limit(100);
    this.recoveryCursor =
      rows.length === 100 ? rows.at(-1)!.messageId : undefined;
    for (const row of rows) {
      const state = await scheduler.state(
        row.mailboxId,
        row.messageId,
        row.updatedAt,
      );
      if (state === "missing")
        await scheduler.schedule(row.accountId, row.mailboxId, row.messageId);
      else if (state === "terminal")
        await this.database
          .update(messageContents)
          .set({
            status: "failed",
            error:
              "Content fetch ended without cached content. Retry download.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(messageContents.messageId, row.messageId),
              eq(messageContents.updatedAt, row.updatedAt),
              inArray(messageContents.status, ["pending", "fetching"]),
            ),
          );
    }
  }

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
    await persistAttachmentMetadata(
      this.database,
      messageId,
      mailboxId,
      placement.uidValidity,
      placement.uid,
      message.mimeStructure,
    );
    let status = content?.status ?? "not_fetched";
    if (
      content?.status === "ready" &&
      content.sanitizedHtml !== null &&
      content.policyVersion !== EMAIL_HTML_POLICY &&
      this.scheduler
    )
      status = "not_fetched";
    let retrying = false;
    if (
      this.scheduler?.state &&
      ["pending", "fetching", "failed"].includes(status)
    ) {
      const durable = await this.scheduler.state(
        mailboxId,
        messageId,
        status === "pending" ? content?.updatedAt : undefined,
      );
      retrying = durable === "retrying";
      if (durable === "pending" || durable === "retrying") status = "pending";
      else if (durable === "fetching") status = "fetching";
      else if (durable === "terminal") status = "failed";
      else if (status === "pending" || status === "fetching") {
        // Repair only missing jobs, never active jobs based on their age.
        await this.request(accountId, mailboxId, messageId);
        status = "pending";
      }
    }
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
      attachments: await listAttachmentMetadata(this.database, messageId),
      content: {
        status,
        retrying,
        plainText: content?.plainText ?? null,
        sanitizedHtml:
          content?.status === "ready" ? content.sanitizedHtml : null,
        remoteContentBlocked: content?.remoteContentBlocked ?? false,
        error:
          status === "failed"
            ? (content?.error ??
              "Content fetch failed. Retry loading the message content.")
            : null,
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
      row.content?.status === "ready" &&
      (row.content.sanitizedHtml === null ||
        row.content.policyVersion === EMAIL_HTML_POLICY)
    )
      return false;
    if (!this.scheduler) throw new Error("Content scheduler is unavailable.");
    if (this.scheduler.state) {
      const durable = await this.scheduler.state(
        mailboxId,
        messageId,
        row.content?.status === "pending" ? row.content.updatedAt : undefined,
      );
      if (["pending", "retrying", "fetching"].includes(durable)) return false;
    } else if (
      row.content?.status === "pending" ||
      row.content?.status === "fetching"
    )
      return false;
    const now = sql<Date>`clock_timestamp()`;
    await this.database
      .insert(messageContents)
      .values({ messageId, status: "pending", updatedAt: now })
      .onConflictDoUpdate({
        target: messageContents.messageId,
        set: { status: "pending", error: null, updatedAt: now },
        setWhere: or(
          ne(messageContents.status, "ready"),
          and(
            isNotNull(messageContents.sanitizedHtml),
            sql<boolean>`${messageContents.policyVersion} IS DISTINCT FROM ${EMAIL_HTML_POLICY}`,
          ),
        ),
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

  async run(
    accountId: string,
    mailboxId: string,
    messageId: string,
    attempt?: number,
  ) {
    return withPerformance(
      "content",
      () => this.runImpl(accountId, mailboxId, messageId),
      attempt,
    );
  }
  private async runImpl(
    accountId: string,
    mailboxId: string,
    messageId: string,
  ) {
    if (!this.accounts || !this.provider || !this.config)
      throw new Error("Content worker dependencies are unavailable.");
    try {
      const row = await this.placement(accountId, mailboxId, messageId);
      if (
        row.content?.status === "ready" &&
        (row.content.sanitizedHtml === null ||
          row.content.policyVersion === EMAIL_HTML_POLICY)
      )
        return;
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
      const finishMime = beginStage("mime_discovery");
      const parts = selectDisplayParts(row.message.mimeStructure);
      finishMime();
      if (parts.length === 0)
        throw new MessageContentUnavailableError(
          "No display text part is available.",
        );
      await this.database
        .update(messageContents)
        .set({
          status: "fetching",
          error: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(messageContents.messageId, messageId),
            or(
              ne(messageContents.status, "ready"),
              and(
                isNotNull(messageContents.sanitizedHtml),
                sql<boolean>`${messageContents.policyVersion} IS DISTINCT FROM ${EMAIL_HTML_POLICY}`,
              ),
            ),
          ),
        )
        .returning({ id: messageContents.messageId });
      // Another attempt may have filled the cache after our placement read.
      const fresh = await this.placement(accountId, mailboxId, messageId);
      if (
        fresh.content?.status === "ready" &&
        (fresh.content.sanitizedHtml === null ||
          fresh.content.policyVersion === EMAIL_HTML_POLICY)
      )
        return;
      const account = await measureStage("credentials", () =>
        this.accounts!.getProviderImapAccountForWork(accountId),
      );
      const result = await this.provider.fetchMessageContent(account, {
        remotePath: row.mailbox.remotePath,
        uid: row.placement.uid.toString(),
        expectedUidValidity: row.placement.uidValidity.toString(),
        parts,
        maxPartBytes: this.config.maxMessageTextPartBytes,
      });
      const finishSanitize = beginStage("sanitization");
      let html: string | null = null;
      let blocked = false;
      try {
        if (result.html !== null) {
          try {
            const sanitized = sanitizeEmailHtml(result.html);
            html = sanitized.html || null;
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
      } catch (error) {
        finishSanitize(true);
        throw error;
      }
      finishSanitize();
      await measureStage("persistence", () =>
        this.database
          .update(messageContents)
          .set({
            status: "ready",
            plainText: result.plainText,
            searchText: searchBodyText(result.plainText, html),
            sanitizedHtml: html,
            remoteContentBlocked: blocked,
            policyVersion: EMAIL_HTML_POLICY,
            error: null,
            fetchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(messageContents.messageId, messageId),
              or(
                ne(messageContents.status, "ready"),
                and(
                  isNotNull(messageContents.sanitizedHtml),
                  sql<boolean>`${messageContents.policyVersion} IS DISTINCT FROM ${EMAIL_HTML_POLICY}`,
                ),
              ),
            ),
          ),
      );
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
      if (error instanceof MailProviderOperationError) throw error;
      throw new Error(reason);
    }
  }
}
