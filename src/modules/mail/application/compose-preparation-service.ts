import type { AttachmentService } from "./attachment-service";
import { and, eq } from "drizzle-orm";
import { JSDOM } from "jsdom";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  messages,
  messageAttachments,
} from "../../../shared/infrastructure/database/schema";
import { sourceContext, type ComposePrefill } from "../domain/compose-source";
import {
  derivedBody,
  derivedSubject,
  replyRecipients,
  ReplyUnavailableError,
} from "../domain/reply-forward";
import type { MessageContentService } from "./message-content-service";
import { importRichDom } from "../domain/rich-import";
import {
  plainTextDocument,
  richElement,
  richText,
  safeRichUrl,
  validateRichDocument,
  richResourceIds,
  serializeRichDocument,
  type RichNode,
} from "../domain/rich-document";
import { normalizeContentId } from "../infrastructure/sanitize-email-html";
import { SAFE_INLINE_IMAGE_TYPES } from "../infrastructure/render-email-document";

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
    if (
      detail.content.plainText === null &&
      detail.content.sanitizedHtml === null
    )
      throw new ReplyUnavailableError(
        "No usable message content is available.",
      );
    const text = detail.content.plainText ?? "";
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
    let original = plainTextDocument(text);
    if (detail.content.sanitizedHtml) {
      // Inert local parse: never mount reader HTML or enable a resource loader.
      const dom = new JSDOM(detail.content.sanitizedHtml);
      try {
        const references = [
          ...dom.window.document.querySelectorAll("img[data-maildock-cid]"),
        ].map((img) => img.getAttribute("data-maildock-cid")!);
        const candidates = references.length
          ? await this.db
              .select()
              .from(messageAttachments)
              .where(eq(messageAttachments.messageId, source.messageId))
          : [];
        const cidResources = new Map<string, string>();
        for (const cid of new Set(references)) {
          const matches = candidates.filter(
            (a) => a.contentId && normalizeContentId(a.contentId) === cid,
          );
          const a = matches.length === 1 ? matches[0] : null;
          if (
            !a ||
            !SAFE_INLINE_IMAGE_TYPES.has(a.contentType) ||
            !this.attachments
          )
            continue;
          if (a.status === "not_fetched") {
            await this.attachments.request(a.id);
            return { status: "pending" };
          }
          if (["pending", "fetching"].includes(a.status))
            return { status: "pending" };
          try {
            await this.attachments.inlineResource(source.messageId, a.id, cid);
            cidResources.set(cid, a.id);
            const existing = attachments.find((item) => item.id === a.id);
            if (existing) {
              existing.inline = true;
              existing.visible = false;
            } else
              attachments.push({
                id: a.id,
                filename: a.filename,
                type: a.contentType,
                size: a.declaredSize?.toString() ?? null,
                inline: true,
                visible: false,
                status: "ready",
                error: null,
              });
          } catch {
            /* Invalid/missing CID becomes an explicit placeholder below. */
          }
        }
        original = importRichDom(
          dom.window.document,
          (img): RichNode | null => {
            const cid = img.getAttribute("data-maildock-cid");
            const resourceId = cid ? cidResources.get(cid) : undefined;
            const url = safeRichUrl(
              img.getAttribute("data-maildock-remote") ?? "",
              true,
            );
            const alt = (img.getAttribute("alt") ?? "Quoted image").slice(
              0,
              500,
            );
            return resourceId || url
              ? {
                  type: "maildock-image",
                  version: 1,
                  ...(resourceId ? { resourceId } : { url: url! }),
                  alt,
                  width: 480,
                }
              : richText(`[Image unavailable: ${alt}]`);
          },
        );
      } finally {
        dom.window.close();
      }
    }
    const header = derivedBody(row.message, "", source.mode)
      .replace(/\n> $/, "")
      .trimEnd();
    const richDocument = validateRichDocument({
      version: 1,
      editor: {
        root: richElement("root", [
          richElement("paragraph", []),
          ...plainTextDocument(header.trimStart()).editor.root.children!,
          richElement("quote", original.editor.root.children!),
        ]),
      },
    });
    const plainText = serializeRichDocument(
      richDocument,
      new Map(
        [...richResourceIds(richDocument)].map((id) => [
          id,
          `${id}@maildock.invalid`,
        ]),
      ),
    ).plainText;
    return {
      status: "ready",
      prefill: {
        accountId: source.accountId,
        source,
        ...recipients,
        subject: derivedSubject(row.message.subject, source.mode),
        plainText,
        richDocument,
        attachmentsOmitted:
          source.mode !== "forward" && row.message.hasAttachments,
        attachments,
      },
    };
  }
}
