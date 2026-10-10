import { reseedNativeAccountFixture } from "./native-account-fixture";
import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { mailAccounts } from "@/shared/infrastructure/database/schema";
import {
  AccountsService,
  MailAccountNotFoundError,
} from "@/modules/accounts/application/accounts-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";

let container: StartedTestContainer;
let database: ReturnType<typeof createDatabase>;
let service: AccountsService;
const legacy = [1, 2, 3].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);
beforeAll(async () => {
  container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "ordering",
      POSTGRES_USER: "maildock",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  database = createDatabase({
    databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/ordering`,
    databasePoolSize: 4,
  });
  const migrations = readMigrationFiles({ migrationsFolder: "db/migrations" });
  for (const migration of migrations.slice(0, 27))
    for (const statement of migration.sql)
      await database.client.unsafe(statement);
  // Insert out of timestamp order, including an old tie with undefined ordering.
  for (const index of [2, 1, 0]) {
    const created =
      index === 2 ? "2025-02-01T00:00:00Z" : "2025-01-01T00:00:00Z";
    await database.client`INSERT INTO mail_accounts (id, display_name, email, imap_host, imap_port, imap_security, imap_username, imap_password, smtp_host, smtp_port, smtp_security, created_at)
      VALUES (${legacy[index]}, 'Existing', 'owner@example.com', 'imap.test', 993, 'tls', 'owner', '{}', 'smtp.test', 465, 'tls', ${created})`;
  }
  for (const migration of migrations.slice(27, 36))
    await database.client.begin(async (tx) => {
      for (const statement of migration.sql) await tx.unsafe(statement);
    });
  await reseedNativeAccountFixture(database, migrations[36]);
  for (const migration of migrations.slice(37))
    await database.client.begin(async (tx) => {
      for (const statement of migration.sql) await tx.unsafe(statement);
    });
  service = new AccountsService(
    database.db,
    new AesGcmSecretEncryption("v1", {
      v1: Buffer.alloc(32, 9).toString("base64"),
    }),
    {} as MailProvider,
  );
});
afterAll(async () => {
  if (database) await database.client.end();
  if (container) await container.stop();
});
const ids = async () => (await service.list()).map((account) => account.id);
it("migrates in creation order with deterministic ties and exposes persisted positions", async () => {
  expect(await ids()).toEqual(legacy);
  expect((await service.list()).map((account) => account.sortOrder)).toEqual([
    1, 2, 3,
  ]);
});
it("moves adjacent accounts immediately without changing other account data", async () => {
  const before = await database.db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, legacy[0]));
  expect(
    (await service.move(legacy[0], "down")).map((account) => account.id),
  ).toEqual([legacy[1], legacy[0], legacy[2]]);
  expect(await ids()).toEqual([legacy[1], legacy[0], legacy[2]]);
  const after = await database.db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, legacy[0]));
  expect(after[0]).toEqual({ ...before[0], sortOrder: 2 });
  await service.move(legacy[0], "up");
});
it("handles boundaries, deleted accounts and serializes simultaneous relative moves", async () => {
  await service.move(legacy[0], "up");
  await service.move(legacy[2], "down");
  expect(await ids()).toEqual(legacy);
  await expect(service.move(randomUUID(), "up")).rejects.toBeInstanceOf(
    MailAccountNotFoundError,
  );
  await Promise.all([
    service.move(legacy[0], "down"),
    service.move(legacy[0], "down"),
  ]);
  expect(await ids()).toEqual([legacy[1], legacy[2], legacy[0]]);
});
it("appends simultaneous new manual and OAuth accounts after reordered existing accounts", async () => {
  const before = await ids();
  const create = (oauth: boolean) =>
    database.db
      .insert(mailAccounts)
      .values({
        id: randomUUID(),
        displayName: "New",
        email: "new@example.com",
        imapHost: "imap.test",
        imapPort: 993,
        imapSecurity: "tls",
        imapUsername: "new",
        imapPassword: oauth
          ? null
          : {
              version: 1,
              algorithm: "AES-256-GCM",
              keyId: "v1",
              iv: "iv",
              authTag: "tag",
              ciphertext: "cipher",
            },
        smtpHost: "smtp.test",
        smtpPort: 465,
        smtpSecurity: "tls",
        authMethod: oauth ? "oauth2" : "password",
        oauthProviderId: oauth ? "microsoft" : null,
        oauthCache: oauth
          ? {
              version: 1,
              algorithm: "AES-256-GCM",
              keyId: "v1",
              iv: "iv",
              authTag: "tag",
              ciphertext: "cipher",
            }
          : null,
        oauthHomeAccountId: oauth ? "home" : null,
        oauthStatus: oauth ? "connected" : null,
      })
      .returning();
  const added = (await Promise.all([create(false), create(true)])).flat();
  expect(added.every((account) => account.sortOrder > 3)).toBe(true);
  expect(new Set(added.map((account) => account.sortOrder)).size).toBe(2);
  expect((await ids()).slice(0, 3)).toEqual(before);
  expect((await ids()).slice(3)).toEqual(
    added.sort((a, b) => a.sortOrder - b.sortOrder).map((a) => a.id),
  );
});

it("initializes an empty installation so its first new account receives position 1", async () => {
  await database.client.unsafe("CREATE DATABASE ordering_empty");
  const empty = createDatabase({
    databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/ordering_empty`,
    databasePoolSize: 1,
  });
  try {
    for (const migration of readMigrationFiles({
      migrationsFolder: "db/migrations",
    }))
      await empty.client.begin(async (tx) => {
        for (const statement of migration.sql) await tx.unsafe(statement);
      });
    const [account] = await empty.db
      .insert(mailAccounts)
      .values({
        id: randomUUID(),
        displayName: "First",
        email: "first@test",
        imapHost: "imap.test",
        imapPort: 993,
        imapSecurity: "tls",
        imapUsername: "first",
        imapPassword: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyId: "v1",
          iv: "iv",
          authTag: "tag",
          ciphertext: "cipher",
        },
        smtpHost: "smtp.test",
        smtpPort: 465,
        smtpSecurity: "tls",
      })
      .returning();
    expect(account.sortOrder).toBe(1);
  } finally {
    await empty.client.end();
  }
});
