import { eq, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { instanceState } from "../../../shared/infrastructure/database/schema";
import type { MessageListItem, MessagePage } from "./message-service";

export type ConversationMessage = MessageListItem & {
  mailboxId: string | null;
  to: readonly { name?: string; address?: string }[];
  cc: readonly { name?: string; address?: string }[];
  plainText: string | null;
  sanitizedHtml: string | null;
  contentStatus: string;
};

export class ConversationService {
  constructor(private readonly database: Database) {}

  async enabled(): Promise<boolean> {
    const [settings] = await this.database
      .select({ enabled: instanceState.conversationView })
      .from(instanceState)
      .where(eq(instanceState.id, 1));
    return settings?.enabled ?? false;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.database
      .insert(instanceState)
      .values({ id: 1, conversationView: enabled })
      .onConflictDoUpdate({
        target: instanceState.id,
        set: { conversationView: enabled, updatedAt: new Date() },
      });
  }

  async list(
    accountId: string,
    mailboxId: string,
    pageSize: number,
    cursor?: string,
    allInboxes = false,
  ): Promise<MessagePage> {
    let after: [string, string] | undefined;
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 2 ||
          typeof parsed[0] !== "string" ||
          typeof parsed[1] !== "string" ||
          Number.isNaN(Date.parse(parsed[0])) ||
          !/^[0-9a-f-]{36}$/i.test(parsed[1])
        )
          throw Error();
        after = [parsed[0], parsed[1]];
      } catch {
        throw Error("Invalid cursor.");
      }
    }
    const limit = Math.min(Math.max(pageSize, 1), 100);
    const rows = await this.database.execute(sql`
      WITH relevant AS (
        SELECT m.*, a.display_name AS account_name, cm.conversation_id, p.flags, p.mailbox_id,
          row_number() OVER (PARTITION BY m.account_id, cm.conversation_id ORDER BY m.internal_date DESC, m.id DESC) AS rank,
          count(*) OVER (PARTITION BY m.account_id, cm.conversation_id)::int AS message_count,
          bool_and(p.flags @> ARRAY['\\Seen']::text[]) OVER (PARTITION BY m.account_id, cm.conversation_id) AS seen
        FROM mailbox_messages p JOIN messages m ON m.id = p.message_id
        JOIN conversation_members cm ON cm.message_id = m.id AND cm.account_id = m.account_id
        JOIN mailboxes b ON b.id = p.mailbox_id AND b.account_id = m.account_id
        JOIN mail_accounts a ON a.id = m.account_id
        WHERE ${allInboxes ? sql`a.enabled AND b.selectable AND b.lifecycle_status = 'active' AND upper(b.remote_path) = 'INBOX'` : sql`p.mailbox_id = ${mailboxId}::uuid AND m.account_id = ${accountId}::uuid`} AND NOT p.action_hidden
      ) SELECT relevant.*, (SELECT count(*)::int FROM conversation_members members
        WHERE members.account_id = relevant.account_id AND members.conversation_id = relevant.conversation_id) AS conversation_message_count
        FROM relevant WHERE rank = 1
        ${after ? sql`AND (internal_date, id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
      ORDER BY internal_date DESC, id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: String(r.id),
        accountId: String(r.account_id),
        ...(allInboxes ? { accountName: String(r.account_name) } : {}),
        mailboxId: String(r.mailbox_id),
        conversationId: String(r.conversation_id),
        messageCount: Number(r.message_count),
        conversationMessageCount: Number(r.conversation_message_count),
        subject: r.subject as string | null,
        from: r.from as MessageListItem["from"],
        date: new Date(r.internal_date as string).toISOString(),
        seen: Boolean(r.seen),
        flagged: (r.flags as string[]).includes("\\Flagged"),
        size: String(r.size),
        hasAttachments: Boolean(r.has_attachments),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify([
                new Date(last.internal_date as string).toISOString(),
                last.id,
              ]),
            ).toString("base64url")
          : null,
    };
  }

  async open(
    accountId: string,
    conversationId: string,
    metadataOnly = false,
    preferredMailboxId?: string,
  ): Promise<ConversationMessage[]> {
    // One query for metadata and cached content, including all account mailboxes.
    // A preferred visible placement identifies the exact action/content endpoint.
    const rows = await this.database.execute(sql`
      SELECT m.id, m.subject, m."from", m."to", m.cc, m.sent_at, m.internal_date, m.size, m.has_attachments,
        p.mailbox_id, p.flags,
        ${metadataOnly ? sql`NULL::text AS content_status, NULL::text AS plain_text, NULL::text AS sanitized_html` : sql`c.status AS content_status, c.plain_text, c.sanitized_html`}
      FROM conversation_members cm JOIN messages m ON m.id = cm.message_id
      LEFT JOIN LATERAL (
        SELECT p.mailbox_id, p.flags FROM mailbox_messages p JOIN mailboxes b ON b.id = p.mailbox_id
        WHERE p.message_id = m.id AND NOT p.action_hidden AND b.account_id = ${accountId}::uuid
        AND b.lifecycle_status = 'active' AND b.selectable
        ORDER BY ${preferredMailboxId ? sql`(p.mailbox_id = ${preferredMailboxId}::uuid) DESC,` : sql``} p.mailbox_id LIMIT 1
      ) p ON true
      ${metadataOnly ? sql`` : sql`LEFT JOIN message_contents c ON c.message_id = m.id`}
      WHERE cm.account_id = ${accountId}::uuid AND m.account_id = ${accountId}::uuid
        AND cm.conversation_id = coalesce(
          (SELECT coalesce(merged_into, id) FROM conversations WHERE id = ${conversationId}::uuid AND account_id = ${accountId}::uuid), ${conversationId}::uuid)
      ORDER BY coalesce(m.sent_at, m.internal_date), m.id`);
    return rows.map((r) => ({
      id: String(r.id),
      subject: r.subject as string | null,
      from: r.from as MessageListItem["from"],
      date: new Date((r.sent_at ?? r.internal_date) as string).toISOString(),
      seen: ((r.flags ?? []) as string[]).includes("\\Seen"),
      flagged: ((r.flags ?? []) as string[]).includes("\\Flagged"),
      size: String(r.size),
      hasAttachments: Boolean(r.has_attachments),
      mailboxId: r.mailbox_id as string | null,
      to: r.to as ConversationMessage["to"],
      cc: r.cc as ConversationMessage["cc"],
      contentStatus: String(r.content_status ?? "not_fetched"),
      plainText:
        r.content_status === "ready" ? (r.plain_text as string | null) : null,
      sanitizedHtml:
        r.content_status === "ready"
          ? (r.sanitized_html as string | null)
          : null,
    }));
  }
}
