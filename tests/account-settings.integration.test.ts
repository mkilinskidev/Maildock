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
import {
  mailAccounts,
  mailboxes,
  signatures,
  accountSignatureDefaults,
} from "@/shared/infrastructure/database/schema";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { AccountSettingsService } from "@/modules/accounts/application/account-settings-service";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import type { AttachmentService } from "@/modules/mail/application/attachment-service";
import { plainTextDocument } from "@/modules/mail/domain/rich-document";

let container: StartedTestContainer;
let database: ReturnType<typeof createDatabase>;
let accounts: AccountsService;
let settings: AccountSettingsService;
const legacyId = randomUUID();
beforeAll(async () => {
  container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "settings",
      POSTGRES_USER: "maildock",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  database = createDatabase({
    databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/settings`,
    databasePoolSize: 4,
  });
  const migrations = readMigrationFiles({ migrationsFolder: "db/migrations" });
  for (const migration of migrations.slice(0, 22))
    for (const statement of migration.sql)
      await database.client.unsafe(statement);
  await database.client`INSERT INTO mail_accounts (id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) VALUES (${legacyId},'Legacy Sender','legacy@example.com','imap.example.com',993,'tls','legacy','{}','smtp.example.com',465,'tls')`;
  for (const migration of migrations.slice(22, -1))
    await database.client.begin(async (tx) => {
      for (const statement of migration.sql) await tx.unsafe(statement);
    });
  await reseedNativeAccountFixture(database, migrations.at(-1)!);
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 9).toString("base64"),
  });
  accounts = new AccountsService(database.db, encryption, {
    testConnection: async () => ({
      imap: { success: true },
      smtp: { success: true },
    }),
    listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
    synchronizeRecentMailbox: async () => ({
      uidValidity: "1",
      messageCount: 0,
    }),
    fetchMessageContent: async () => ({ plainText: null, html: null }),
  } satisfies MailProvider);
  settings = new AccountSettingsService(
    database.db,
    accounts,
    {} as AttachmentService,
  );
});
afterAll(async () => {
  if (database) await database.client.end();
  if (container) await container.stop();
});
async function create() {
  return accounts.create({
    id: randomUUID(),
    displayName: "DPoczta",
    senderDisplayName: "Mateusz Kiliński",
    email: "hello@mkilinski.dev",
    enabled: true,
    providerType: "imap_smtp",
    imap: {
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "hello",
      password: "private-imap-secret",
    },
    smtp: {
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      useImapCredentials: false,
      username: "smtp-user",
      password: "private-smtp-secret",
    },
  });
}
const identity = {
  displayName: "Local label",
  senderDisplayName: "Human Sender",
  email: "hello@mkilinski.dev",
};
const defaults = { new: null, reply: null, forward: null };
it("migrates existing sender behavior and preserves independent names on legacy updates", async () => {
  expect(await accounts.get(legacyId)).toMatchObject({
    displayName: "Legacy Sender",
    senderDisplayName: "Legacy Sender",
  });
  const account = await create();
  await accounts.update(account.id, {
    displayName: "Renamed label",
    email: account.email,
    enabled: true,
    providerType: "imap_smtp",
    imap: {
      ...account.imap,
      host: account.imap.host!,
      port: account.imap.port!,
      security: account.imap.security!,
      username: account.imap.username!,
    },
    smtp: account.smtp,
  });
  expect(await accounts.get(account.id)).toMatchObject({
    displayName: "Renamed label",
    senderDisplayName: "Mateusz Kiliński",
  });
  expect(JSON.stringify(await accounts.get(account.id))).not.toContain(
    "private-imap-secret",
  );
  const [row] = await database.db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, account.id));
  expect(JSON.stringify(row.imapPassword)).not.toContain("private-imap-secret");
  expect(JSON.stringify(row.smtpPassword)).not.toContain("private-smtp-secret");
  expect(
    (await accounts.getProviderImapAccountForWork(account.id)).imap.credential,
  ).toMatchObject({ password: "private-imap-secret" });
});
it("saves identity, folder roles and defaults together and rolls back foreign folders or missing signatures", async () => {
  const a = await create(),
    b = await create();
  const boxId = randomUUID(),
    foreignId = randomUUID(),
    signatureId = randomUUID();
  for (const [id, accountId] of [
    [boxId, a.id],
    [foreignId, b.id],
  ])
    await database.db.insert(mailboxes).values({
      id,
      accountId,
      remotePath: "Sent",
      name: "Sent",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
  await database.db.insert(signatures).values({
    id: signatureId,
    name: "Work",
    richDocument: plainTextDocument("Regards"),
  });
  await settings.saveGeneral(a.id, {
    identity,
    folders: {
      sent: boxId,
      drafts: boxId,
      archive: boxId,
      junk: boxId,
      trash: boxId,
    },
    signatures: { new: signatureId, reply: signatureId, forward: signatureId },
  });
  expect(await accounts.get(a.id)).toMatchObject(identity);
  const roles = new MailboxRoleService(database.db);
  expect(
    (await roles.list(a.id)).every(
      (role) => role.mailboxId === boxId && role.available,
    ),
  ).toBe(true);
  expect(
    (await roles.list(b.id)).every((role) => role.mailboxId === null),
  ).toBe(true);
  expect(
    (
      await database.db
        .select()
        .from(accountSignatureDefaults)
        .where(eq(accountSignatureDefaults.accountId, a.id))
    )[0],
  ).toMatchObject({
    new: signatureId,
    reply: signatureId,
    forward: signatureId,
  });
  await expect(
    settings.saveGeneral(a.id, {
      identity: { ...identity, displayName: "Must rollback" },
      folders: { sent: foreignId },
      signatures: defaults,
    }),
  ).rejects.toThrow();
  await expect(
    settings.saveGeneral(a.id, {
      identity: { ...identity, displayName: "Must rollback" },
      folders: { sent: null },
      signatures: { ...defaults, new: randomUUID() },
    }),
  ).rejects.toThrow();
  expect((await accounts.get(a.id)).displayName).toBe("Local label");
  expect(
    (await roles.list(a.id)).find((r) => r.role === "sent")?.mailboxId,
  ).toBe(boxId);
  await settings.saveGeneral(a.id, {
    identity,
    folders: { sent: null },
    signatures: defaults,
  });
  expect(
    (await roles.list(a.id)).find((r) => r.role === "sent")?.source,
  ).toBeNull();
});
it("allows Microsoft local/sender labels but rejects editing the OAuth email or injecting headers", async () => {
  const a = await create();
  await database.db
    .update(mailAccounts)
    .set({
      authMethod: "oauth2",
      oauthProviderId: "microsoft",
      oauthStatus: "connected",
      oauthHomeAccountId: "test-provider-identity",
      oauthCache: { test: "encrypted-fixture" } as never,
      imapPassword: null,
      smtpPassword: null,
      smtpUsesImapCredentials: true,
      smtpUsername: null,
    })
    .where(eq(mailAccounts.id, a.id));
  await settings.saveGeneral(a.id, {
    identity,
    folders: {},
    signatures: defaults,
  });
  expect(await accounts.get(a.id)).toMatchObject({
    ...identity,
    authMethod: "oauth2",
  });
  await expect(
    settings.saveGeneral(a.id, {
      identity: { ...identity, email: "forged@example.com" },
      folders: {},
      signatures: defaults,
    }),
  ).rejects.toThrow();
  await expect(
    settings.saveGeneral(a.id, {
      identity: {
        ...identity,
        senderDisplayName: "Sender\r\nBcc: stolen@example.com",
      },
      folders: {},
      signatures: defaults,
    }),
  ).rejects.toThrow();
  expect(await accounts.get(a.id)).toMatchObject(identity);
  expect(await accounts.get(a.id)).not.toHaveProperty("oauthCache");
});
