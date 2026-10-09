import type postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";

export class NativeReleaseGuardError extends Error {
  constructor() {
    super(
      "Native Gmail release refused a populated legacy Maildock database. Stop this release and provision a separate empty database and blob namespace, or restore the backup with its matched legacy binary. No data was erased.",
    );
    this.name = "NativeReleaseGuardError";
  }
}

/** Read-only, before migrations or application bootstrap. The shipped initial
 * migration inserts an uninitialized singleton; that row alone is not an install. */
export async function assertNativeReleaseCompatible(client: postgres.Sql) {
  const [native] = await client<{ ready: boolean; migrations: boolean }[]>`
    select exists(select from pg_catalog.pg_attribute
      where attrelid=to_regclass('public.mail_accounts') and attname='receive_transport'
      and attgenerated='s' and not attisdropped)
      and to_regclass('public.gmail_account_sync_state') is not null
      and to_regclass('public.gmail_sync_work') is not null as ready,
      to_regclass('drizzle.__drizzle_migrations') is not null as migrations`;
  if (native?.ready && native.migrations) {
    const foundation = readMigrationFiles({
      migrationsFolder: "db/migrations",
    }).find((m) =>
      m.sql.some((statement) =>
        statement.includes('CREATE TABLE "gmail_account_sync_state"'),
      ),
    );
    if (!foundation) throw new NativeReleaseGuardError();
    const [recorded] =
      await client`select exists(select from drizzle.__drizzle_migrations where hash=${foundation.hash} and created_at=${foundation.folderMillis}) as verified`;
    if (recorded?.verified) return;
  }
  const tables = await client<{ name: string }[]>`
    select c.relname as name from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')`;
  for (const table of tables) {
    if (table.name === "instance_state") {
      const [row] =
        await client`select exists(select from public.instance_state where initialized_at is not null) as populated`;
      if (row?.populated) throw new NativeReleaseGuardError();
    } else {
      const [row] =
        await client`select exists(select from ${client(`public.${table.name}`)} limit 1) as populated`;
      if (row?.populated) throw new NativeReleaseGuardError();
    }
  }
}
