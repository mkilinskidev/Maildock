import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import type { MessageListItem } from "./message-service";

export const MAX_SEARCH_QUERY_LENGTH = 256;
export const SEARCH_PAGE_SIZE = 50;
export type SearchResult = MessageListItem & {
  accountId: string;
  accountName: string;
  mailboxId: string;
  mailboxName: string;
  snippet: string;
};
export type SearchPage = { items: SearchResult[]; hasMore: boolean };

/** Query has no location input and no provider/scheduler dependency. */
export class SearchService {
  constructor(private readonly database: Database) {}

  async search(input: string): Promise<SearchPage> {
    if (input.length > MAX_SEARCH_QUERY_LENGTH || input.includes("\0"))
      throw new Error("Invalid search query.");
    const query = input.trim();
    if (!query) return { items: [], hasMore: false };
    const rows = await this.database.execute<{
      id: string;
      accountId: string;
      accountName: string;
      mailboxId: string;
      mailboxName: string;
      subject: string | null;
      from: MessageListItem["from"];
      date: string;
      seen: boolean;
      flagged: boolean;
      size: string;
      hasAttachments: boolean;
      snippet: string;
    }>(sql`
      WITH q AS (SELECT plainto_tsquery('simple', ${query}) AS terms),
      hits AS MATERIALIZED (
        SELECT m.id, m.internal_date, a.display_name AS account_name, p.mailbox_id, p.mailbox_name, p.flags,
          ts_rank(m.search_vector, q.terms) AS rank
        FROM messages m
        JOIN mail_accounts a ON a.id = m.account_id
        CROSS JOIN q
        JOIN LATERAL (
          SELECT mb.id AS mailbox_id, mb.name AS mailbox_name, mm.flags
          FROM mailbox_messages mm JOIN mailboxes mb ON mb.id = mm.mailbox_id
          WHERE mm.message_id = m.id AND mb.account_id = m.account_id AND NOT mm.action_hidden
          ORDER BY (mb.selectable AND mb.lifecycle_status = 'active') DESC,
            mb.selectable DESC, mb.remote_path COLLATE "C", mb.id, mm.id
          LIMIT 1
        ) p ON true
        WHERE m.search_vector @@ q.terms
        ORDER BY rank DESC, m.internal_date DESC, m.id DESC
        LIMIT ${SEARCH_PAGE_SIZE + 1}
      )
      SELECT m.id, m.account_id AS "accountId", h.account_name AS "accountName",
        h.mailbox_id AS "mailboxId", h.mailbox_name AS "mailboxName", m.subject, m."from",
        m.internal_date::text AS date, '\\Seen' = ANY(h.flags) AS seen,
        '\\Flagged' = ANY(h.flags) AS flagged, m.size::text, m.has_attachments AS "hasAttachments",
        left(CASE WHEN m.search_body <> '' THEN
          replace(replace(ts_headline('simple', m.search_body, q.terms,
            'StartSel=MAILDOCKSTARTMARKER, StopSel=MAILDOCKSTOPMARKER, MaxWords=35, MinWords=15, MaxFragments=1'),
            'MAILDOCKSTARTMARKER', ''), 'MAILDOCKSTOPMARKER', '')
          ELSE coalesce(m.subject, '') END, 320) AS snippet
      FROM hits h JOIN messages m ON m.id = h.id CROSS JOIN q
      ORDER BY h.rank DESC, h.internal_date DESC, h.id DESC
    `);
    return {
      items: Array.from(rows)
        .slice(0, SEARCH_PAGE_SIZE)
        .map((row) => ({
          ...row,
          date: new Date(row.date).toISOString(),
        })),
      hasMore: rows.length > SEARCH_PAGE_SIZE,
    };
  }
}
