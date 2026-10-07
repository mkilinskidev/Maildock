import { eq } from "drizzle-orm";
import { JSDOM } from "jsdom";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  messageAttachments,
  messageContents,
} from "../../../shared/infrastructure/database/schema";
import type { AttachmentService } from "./attachment-service";
import type { MessageContentService } from "./message-content-service";
import {
  normalizedSender,
  RemoteContentSenderService,
} from "./remote-content-sender-service";
import {
  normalizeContentId,
  EMAIL_HTML_POLICY,
  sanitizeEmailHtml,
} from "../infrastructure/sanitize-email-html";
import {
  renderEmailDocument,
  SAFE_INLINE_IMAGE_TYPES,
} from "../infrastructure/render-email-document";

export class EmailRenderingService {
  constructor(
    private readonly db: Database,
    private readonly content: MessageContentService,
    private readonly attachments: AttachmentService,
  ) {}
  async render(
    accountId: string,
    mailboxId: string,
    messageId: string,
    options: { loadImages: boolean; trustSender: boolean },
  ) {
    // Placement validates the exact account/mailbox/message relationship. This
    // service is only reached after owner authentication and origin checks.
    const detail = await this.content.detail(accountId, mailboxId, messageId);
    const rules = new RemoteContentSenderService(this.db);
    const sender = normalizedSender(detail.from);
    if (options.trustSender && sender) await rules.trust(sender);
    const trusted = await rules.allowed(sender);
    const allow = trusted || options.loadImages;
    if (
      detail.content.status !== "ready" ||
      !detail.content.sanitizedHtml?.trim()
    )
      return {
        document: null,
        blocked: false,
        trusted,
        sender,
        pending: false,
        inlineFailures: 0,
      };
    const [stored] = await this.db
      .select()
      .from(messageContents)
      .where(eq(messageContents.messageId, messageId));
    // Historical HTML can only use its reduced v1 representation until the
    // selective body refresh completes. Never activate unversioned HTML.
    const html =
      stored?.policyVersion === EMAIL_HTML_POLICY
        ? detail.content.sanitizedHtml
        : sanitizeEmailHtml(detail.content.sanitizedHtml).html;
    const dom = new JSDOM(html);
    const references = new Set(
      [...dom.window.document.querySelectorAll("img[data-maildock-cid]")].map(
        (img) => img.getAttribute("data-maildock-cid")!,
      ),
    );
    dom.window.close();
    const candidates = references.size
      ? await this.db
          .select()
          .from(messageAttachments)
          .where(eq(messageAttachments.messageId, messageId))
      : [];
    const images = new Map<string, string>();
    let pending = false,
      inlineFailures = 0;
    for (const cid of references) {
      const matches = candidates.filter(
        (a) => a.contentId && normalizeContentId(a.contentId) === cid,
      );
      const part = matches.length === 1 ? matches[0] : null;
      if (!part || !SAFE_INLINE_IMAGE_TYPES.has(part.contentType)) {
        inlineFailures++;
        continue;
      }
      if (part.status === "not_fetched") {
        try {
          await this.attachments.request(part.id);
          pending = true;
        } catch {
          inlineFailures++;
        }
      } else if (part.status === "pending" || part.status === "fetching")
        pending = true;
      else if (part.status === "ready") {
        try {
          const resource = await this.attachments.inlineResource(
            messageId,
            part.id,
            cid,
          );
          images.set(
            cid,
            `data:${resource.type};base64,${resource.bytes.toString("base64")}`,
          );
        } catch {
          inlineFailures++;
        }
      } else inlineFailures++;
    }
    return {
      document: renderEmailDocument(html, allow, images),
      blocked: detail.content.remoteContentBlocked && !allow,
      trusted,
      sender,
      pending,
      inlineFailures,
    };
  }
}
