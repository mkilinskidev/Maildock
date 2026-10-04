import type { AttachmentService } from "./attachment-service";
import { and, eq } from "drizzle-orm";
import { JSDOM } from "jsdom";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  messages,
} from "../../../shared/infrastructure/database/schema";
import { sourceContext, type ComposePrefill } from "../domain/compose-source";
import {
  derivedBody,
  derivedSubject,
  replyRecipients,
  ReplyUnavailableError,
} from "../domain/reply-forward";
import type { MessageContentService } from "./message-content-service";

export class ComposePreparationService {
  constructor(
    private readonly db: Database,
    private readonly content: MessageContentService,
    private readonly attachments?: AttachmentService,
  ) {}
  async prepare(
    input: unknown,
  ): Promise<
    { status: "pending" } | { status: "ready"; prefill: ComposePrefill }
  > {
    const source = sourceContext.parse(input);
    // The Phase 1D placement lookup enforces account + mailbox + message isolation.
    const detail = await this.content.detail(
      source.accountId,
      source.mailboxId,
      source.messageId,
    );
    const [row] = await this.db
      .select({ message: messages, email: mailAccounts.email })
      .from(messages)
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(
        and(
          eq(messages.id, source.messageId),
          eq(messages.accountId, source.accountId),
        ),
      );
    if (!row)
      throw new ReplyUnavailableError("The source message is unavailable.");
    const recipients =
      source.mode === "forward"
        ? { to: "", cc: "" }
        : replyRecipients(row.message, row.email, source.mode === "reply_all");
    if (detail.content.status === "failed")
      throw new ReplyUnavailableError(
        detail.content.error ??
          "Content fetch failed. Retry loading the message content.",
      );
    if (detail.content.status !== "ready") {
      await this.content.request(
        source.accountId,
        source.mailboxId,
        source.messageId,
      );
      return { status: "pending" };
    }
    let text = detail.content.plainText;
    if (text === null && detail.content.sanitizedHtml !== null) {
      // Parse only locally sanitized HTML, with no resource loader or script execution.
      const dom = new JSDOM(detail.content.sanitizedHtml);
      try {
        dom.window.document
          .querySelectorAll("style")
          .forEach((el) => el.remove());
        dom.window.document
          .querySelectorAll("br")
          .forEach((el) => el.replaceWith("\n"));
        dom.window.document
          .querySelectorAll("p,div,li,tr,blockquote,pre,h1,h2,h3")
          .forEach((el) => el.append("\n"));
        text = dom.window.document.body.textContent ?? "";
      } finally {
        dom.window.close();
      }
    }
    if (text === null)
      throw new ReplyUnavailableError(
        "No usable plain-text content is available.",
      );
    const plainText = derivedBody(row.message, text, source.mode);
    if (plainText.length > 500000)
      throw new ReplyUnavailableError(
        "The quoted message exceeds the composer size limit.",
      );
    const attachments =
      source.mode === "forward"
        ? detail.attachments.filter((a) => a.visible)
        : [];
    for (const attachment of attachments) {
      if (attachment.status === "not_fetched") {
        await this.attachments?.request(attachment.id);
        attachment.status = "pending";
      }
    }
    return {
      status: "ready",
      prefill: {
        accountId: source.accountId,
        source,
        ...recipients,
        subject: derivedSubject(row.message.subject, source.mode),
        plainText,
        attachmentsOmitted:
          source.mode !== "forward" && row.message.hasAttachments,
        attachments,
      },
    };
  }
}
