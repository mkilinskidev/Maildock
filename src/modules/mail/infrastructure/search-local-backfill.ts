import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { messageContents } from "../../../shared/infrastructure/database/schema";
import { searchBodyText } from "./search-body-text";

/** Resumable bounded LOCAL conversion, never a provider/content-fetch backfill. */
export async function initializeLocalSearchBodies(database: Database) {
  // Receiving results derive search text in their source-fenced publication.
  // Startup has no receiving authority and must never rewrite those cache rows,
  // including pending/failed requests left behind by an interrupted operation.
  const legacy = sql`not maildock_receiving_account_enrolled((select account_id from messages where id=${messageContents.messageId}))`;
  for (;;) {
    const rows = await database
      .select()
      .from(messageContents)
      .where(and(isNull(messageContents.searchText), legacy))
      .limit(100);
    if (!rows.length) return;
    for (const row of rows) {
      await database
        .update(messageContents)
        .set({ searchText: searchBodyText(row.plainText, row.sanitizedHtml) })
        .where(
          and(
            eq(messageContents.messageId, row.messageId),
            isNull(messageContents.searchText),
            legacy,
            sql`${messageContents.plainText} IS NOT DISTINCT FROM ${row.plainText}`,
            sql`${messageContents.sanitizedHtml} IS NOT DISTINCT FROM ${row.sanitizedHtml}`,
          ),
        );
    }
  }
}
