import { getTableColumns } from "drizzle-orm";
import type { Database } from "@/shared/infrastructure/database/database";
import type postgres from "postgres";
import type { MigrationMeta } from "drizzle-orm/migrator";
import {
  mailAccounts,
  oauthAuthorizationStates,
  oauthProviderConfigs,
} from "@/shared/infrastructure/database/schema";

/** Only synthetic IMAP accounts in dedicated testcontainers databases. Historical
 * migrations are verified first; the P1 DDL then runs empty, and the same fixture
 * values are reseeded for current application regression checks. No upgrade path
 * for real installations, received mail, Gmail records or blobs is provided. */
export async function reseedNativeAccountFixture(
  database: { db: Database; client: postgres.Sql },
  migration: MigrationMeta,
) {
  const rows = await database.client`select * from mail_accounts`;
  if (rows.some((row) => row.provider_type !== "imap_smtp"))
    throw new Error("Expected synthetic IMAP accounts only.");
  const states =
    await database.client`select * from oauth_authorization_states`;
  if (states.some((row) => row.provider_id !== "microsoft"))
    throw new Error("Historical OAuth provider attribution regression.");
  await database.client`delete from oauth_authorization_states`;
  const configs = await database.client`select * from oauth_provider_configs`;
  await database.client`delete from oauth_provider_configs`;
  await database.client`delete from mail_accounts`;
  await database.client.begin(async (tx) => {
    for (const statement of migration.sql) await tx.unsafe(statement);
  });
  for (const row of rows) {
    const values = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_match, letter: string) =>
          letter.toUpperCase(),
        ),
        value,
      ]),
    );
    for (const [key, column] of Object.entries(getTableColumns(mailAccounts)))
      if (
        column.dataType === "date" &&
        values[key] !== null &&
        values[key] !== undefined
      )
        values[key] = new Date(values[key] as string);
    await database.db
      .insert(mailAccounts)
      .values(values as typeof mailAccounts.$inferInsert);
  }
  const values = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_match, letter: string) =>
          letter.toUpperCase(),
        ),
        key.endsWith("_at") && value !== null
          ? new Date(value as string)
          : value,
      ]),
    );
  for (const row of states)
    await database.db
      .insert(oauthAuthorizationStates)
      .values(values(row) as typeof oauthAuthorizationStates.$inferInsert);
  for (const row of configs)
    await database.db
      .insert(oauthProviderConfigs)
      .values(values(row) as typeof oauthProviderConfigs.$inferInsert);
}
