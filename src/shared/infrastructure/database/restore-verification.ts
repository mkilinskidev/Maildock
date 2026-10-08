import { createHash } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { symmetricDecrypt } from "better-auth/crypto";
import type { AppConfig } from "../config/config";
import type { Database } from "./database";
import * as schema from "./schema";
import { matchesRecoveryMigrationHistory } from "./recovery-migration-history";
import { LocalBlobStorage } from "../storage/local-blob-storage";
import { readVerifiedBlob } from "../../application/blob-storage";
import { AesGcmSecretEncryption } from "../crypto/aes-gcm-secret-encryption";
import { accountCredentialContext } from "../../../modules/accounts/domain/account";
import { isOwnerUsername } from "../../../modules/auth/domain/owner-username";
import { argon2idParameters } from "../../../modules/auth/infrastructure/password";

export class RecoveryError extends Error {
  constructor(
    readonly category:
      | "recovery_schema"
      | "recovery_owner"
      | "recovery_keys"
      | "recovery_blobs"
      | "recovery_incomplete"
      | "recovery_proof"
      | "recovery_channel"
      | "recovery_offline",
  ) {
    super(
      "Offline recovery refused. Keep writers and ingress stopped; review the matched recovery set.",
    );
    this.name = "RecoveryError";
    this.stack = undefined;
  }
}
export const recoveryDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function verifyRecoverySchema(db: Database) {
  try {
    const expected = readMigrationFiles({ migrationsFolder: "db/migrations" });
    const actual = await db.execute<{ hash: string; created_at: string }>(
      sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
    );
    if (!(await matchesRecoveryMigrationHistory(actual, expected)))
      throw new Error();
    const columns = await db.execute<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(
      sql`select c.relname as table_name, a.attname as column_name,
        case when a.attnotnull then 'NO' else 'YES' end as is_nullable,
        pg_catalog.format_type(a.atttypid,a.atttypmod) as data_type
        from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped`,
    );
    const tables = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableConfig(table as PgTable));
    if (new Set(columns.map((row) => row.table_name)).size !== tables.length)
      throw new Error();
    for (const table of tables) {
      const found = columns.filter((row) => row.table_name === table.name);
      if (
        found.length !== table.columns.length ||
        table.columns.some(
          (column) =>
            !found.some(
              (row) =>
                row.column_name === column.name &&
                row.data_type.replace(/[\s"]/g, "") ===
                  column.getSQLType().replace(/[\s"]/g, "") &&
                (row.is_nullable === "NO") === column.notNull,
            ),
        )
      )
        throw new Error();
    }
    // Later migrations need not redefine search functions. Derive each latest
    // definition from the complete, hash-verified release history, rather than
    // assuming the last migration owns all search definitions.
    const expectedFunctions = new Map<string, string>();
    for (const migration of expected) {
      for (const definition of migration.sql
        .join("\n")
        .matchAll(
          /CREATE(?: OR REPLACE)? FUNCTION public\.(maildock_search_(?:addresses|vector))\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g,
        )) {
        expectedFunctions.set(definition[1], definition[2]);
      }
    }
    const functions = await db.execute<{
      proname: string;
      prosrc: string;
      ok: boolean;
    }>(sql`select p.proname,p.prosrc,
      p.provolatile='i' and p.proparallel='s' and not p.prosecdef and p.proconfig is null
      and p.oid in ('public.maildock_search_addresses(jsonb)'::regprocedure,'public.maildock_search_vector(text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure) as ok
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('maildock_search_addresses','maildock_search_vector')`);
    if (
      expectedFunctions.size !== 2 ||
      functions.length !== 2 ||
      functions.some(
        (row) =>
          !row.ok ||
          expectedFunctions.get(row.proname)?.replaceAll("\r\n", "\n") !==
            row.prosrc.replaceAll("\r\n", "\n"),
      )
    )
      throw new Error();
    const index = await db.execute<{ ok: boolean }>(
      sql`select exists(select from pg_catalog.pg_index i
        join pg_catalog.pg_class c on c.oid=i.indexrelid join pg_catalog.pg_am am on am.oid=c.relam
        join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attname='search_vector'
        where c.oid=to_regclass('public.messages_search_gin_idx') and i.indrelid='public.messages'::regclass
          and am.amname='gin' and i.indisvalid and i.indisready and i.indpred is null and i.indexprs is null
          and i.indkey::text=a.attnum::text and a.attgenerated='s') as ok`,
    );
    if (!index[0]?.ok) throw new Error();
  } catch {
    throw new RecoveryError("recovery_schema");
  }
}

export async function verifyRecoveryState(
  db: Database,
  config: AppConfig,
  expectedOwner: string,
) {
  const states = await db.select().from(schema.instanceState);
  const users = await db.select().from(schema.user);
  const accounts = await db.select().from(schema.account);
  const factors = await db.select().from(schema.twoFactor);
  const replacements = await db.select().from(schema.mfaReplacement);
  const recoveries = await db.select().from(schema.ownerRecovery);
  const state = states[0],
    owner = users[0],
    credential = accounts[0],
    factor = factors[0],
    replacement = replacements[0];
  const ownerRecovery = recoveries[0];
  if (
    states.length !== 1 ||
    state.id !== 1 ||
    !(state.initializedAt instanceof Date) ||
    !Number.isFinite(state.initializedAt.getTime()) ||
    state.ownerUserId !== expectedOwner ||
    users.length !== 1 ||
    owner.id !== expectedOwner ||
    !owner.username ||
    !isOwnerUsername(owner.username) ||
    accounts.length !== 1 ||
    credential.userId !== owner.id ||
    credential.accountId !== owner.id ||
    credential.providerId !== "credential" ||
    !credential.password ||
    !/^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(
      credential.password,
    ) ||
    state.passwordAlgorithm !== "argon2id" ||
    !state.passwordParameters ||
    ["memoryCost", "timeCost", "parallelism", "outputLen"].some(
      (key) =>
        state.passwordParameters?.[key] !==
        argon2idParameters[key as keyof typeof argon2idParameters],
    ) ||
    factors.length !== 1 ||
    factor.userId !== owner.id ||
    !Number.isInteger(factor.failedVerificationCount) ||
    factor.failedVerificationCount < 0 ||
    replacements.length > 1 ||
    recoveries.length > 1 ||
    (replacement && ownerRecovery) ||
    (ownerRecovery &&
      (ownerRecovery.id !== 1 ||
        ownerRecovery.ownerUserId !== owner.id ||
        ownerRecovery.factorId !== factor?.id ||
        state.bootstrapSecretDigest !== null ||
        state.bootstrapExpiresAt !== null))
  )
    throw new RecoveryError("recovery_owner");
  let status: "verified" | "pending_mfa";
  if (
    factor.verified === true &&
    owner.twoFactorEnabled === true &&
    !replacement &&
    !ownerRecovery
  )
    status = "verified";
  else if (
    factor.verified === false &&
    owner.twoFactorEnabled === false &&
    ((replacement?.ownerUserId === owner.id &&
      replacement.factorId === factor.id) ||
      (ownerRecovery?.ownerUserId === owner.id &&
        ownerRecovery.factorId === factor.id))
  )
    status = "pending_mfa";
  else throw new RecoveryError("recovery_owner"); // Initial enrollment retains the bootstrap contract.
  let secret: string;
  try {
    secret = await symmetricDecrypt({
      key: config.authSecret,
      data: factor.secret,
    });
    // Better Auth's default TOTP-secret alphabet includes '-' and '_'.
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) throw new Error();
    const codes: unknown = JSON.parse(
      await symmetricDecrypt({
        key: config.authSecret,
        data: factor.backupCodes,
      }),
    );
    if (
      !Array.isArray(codes) ||
      codes.length > 10 ||
      codes.some(
        (code) =>
          typeof code !== "string" ||
          !/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(code),
      ) ||
      new Set(codes).size !== codes.length
    )
      throw new Error();
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    for (const row of await db.select().from(schema.mailAccounts)) {
      if (row.imapPassword !== null)
        encryption.decrypt(
          row.imapPassword,
          accountCredentialContext(row.id, "imap"),
        );
      if (row.smtpPassword !== null)
        encryption.decrypt(
          row.smtpPassword,
          accountCredentialContext(row.id, "smtp"),
        );
      if (row.oauthCache !== null)
        encryption.decrypt(
          row.oauthCache,
          accountCredentialContext(row.id, "oauth-cache"),
        );
    }
    for (const row of await db.select().from(schema.oauthProviderConfigs))
      if (row.encryptedClientSecret !== null)
        encryption.decrypt(
          row.encryptedClientSecret,
          `maildock:oauth-provider:${row.providerId}:client-secret:v1`,
        );
    for (const row of await db.select().from(schema.oauthAuthorizationStates)) {
      if (!["google", "microsoft"].includes(row.providerId)) throw new Error();
      encryption.decrypt(
        row.codeVerifier,
        `maildock:${row.providerId}-oauth-state:v1`,
      );
    }
  } catch {
    throw new RecoveryError("recovery_keys");
  }
  try {
    const refs = await db.execute<{
      id: string;
      storage_key: string | null;
      size: string | null;
      sha256: string | null;
    }>(sql`
      with refs as (
        select mime_blob_id as id from public.outgoing_messages where mime_blob_id is not null
        union select blob_id from public.message_attachments where blob_id is not null
        union select blob_id from public.staged_attachments
        union select blob_id from public.outgoing_message_attachments
        union select blob_id from public.draft_attachments where blob_id is not null
        union select blob_id from public.signature_resources
      ) select refs.id, b.storage_key, b.size, b.sha256 from refs left join public.blobs b on b.id=refs.id`);
    const storage = new LocalBlobStorage(config.attachmentsPath);
    for (const row of refs) {
      if (
        !row.storage_key ||
        row.size === null ||
        !row.sha256 ||
        !Number.isSafeInteger(Number(row.size))
      )
        throw new Error();
      await readVerifiedBlob(
        storage,
        { key: row.storage_key, size: Number(row.size), sha256: row.sha256 },
        Math.max(config.maxAttachmentBytes, config.maxOutgoingMimeBytes),
      );
    }
    const mismatches = await db.execute(
      sql`select a.blob_id from public.outgoing_message_attachments a join public.blobs b on b.id=a.blob_id where a.size <> b.size or a.sha256 <> b.sha256 limit 1`,
    );
    if (mismatches.length) throw new Error();
  } catch {
    throw new RecoveryError("recovery_blobs");
  }
  return {
    state,
    owner,
    credential,
    factor,
    replacement,
    ownerRecovery,
    secret,
    status,
  };
}

export async function verifyMaintenance(
  db: Database,
  config: AppConfig,
  expectedOwner: string,
  receiptId: string,
) {
  const checked = await verifyRecoveryState(db, config, expectedOwner);
  const rows = await db.select().from(schema.recoveryMaintenance);
  const receipt = rows[0];
  const remaining = await db.execute<{ ok: boolean }>(sql`select
    not exists(select from public.session) and not exists(select from public.verification)
    and not exists(select from public.oauth_authorization_states)
    and not exists(select from public.outgoing_messages where status in ('queued','sending') or sent_copy_status in ('pending','saving'))
    and not exists(select from public.message_commands where status in ('pending','executing')) as ok`);
  if (
    rows.length !== 1 ||
    receipt.receiptId !== receiptId ||
    receipt.ownerUserId !== expectedOwner ||
    receipt.factorId !== checked.factor.id ||
    receipt.recoveryCodesDigest !==
      recoveryDigest(checked.factor.backupCodes) ||
    receipt.status !== checked.status ||
    !remaining[0]?.ok ||
    (checked.status === "pending_mfa" &&
      ((checked.replacement?.expiresAt.getTime() ?? 0) > Date.now() ||
        checked.ownerRecovery?.tokenDigest != null ||
        checked.ownerRecovery?.expiresAt != null))
  )
    throw new RecoveryError("recovery_incomplete");
  return checked.status;
}
