import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import type {
  MailProvider,
  RemoteMailbox,
} from "@/modules/accounts/domain/mail-provider";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailboxes,
  mailboxRoles,
} from "@/shared/infrastructure/database/schema";

const firstAccount = "00000000-0000-4000-8000-0000000000c1";
const secondAccount = "00000000-0000-4000-8000-0000000000c2";
function remote(
  path: string,
  specialUse: string[] = [],
  providerMailboxId?: string,
): RemoteMailbox {
  return {
    remotePath: path,
    name: path,
    delimiter: "/",
    attributes: [...specialUse],
    specialUse,
    selectable: true,
    ...(providerMailboxId ? { providerMailboxId } : {}),
  };
}

describe("account system mailbox roles", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let mailboxService: MailboxService;
  let roles: MailboxRoleService;
  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_roles",
          POSTGRES_USER: "maildock",
          POSTGRES_PASSWORD: "maildock-test",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        )
        .start();
      url = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_roles`;
    }
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: url,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: process.cwd(),
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    mailboxService = new MailboxService(database.db);
    roles = new MailboxRoleService(database.db);
    const provider: MailProvider = {
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
    };
    const accounts = new AccountsService(
      database.db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    for (const [id, email] of [
      [firstAccount, "first@example.test"],
      [secondAccount, "second@example.test"],
    ])
      await accounts.create({
        id,
        displayName: email,
        email,
        enabled: false,
        providerType: "imap_smtp",
        imap: {
          host: "imap.example.test",
          port: 993,
          security: "tls",
          username: "owner",
          password: "secret",
        },
        smtp: {
          host: "smtp.example.test",
          port: 465,
          security: "tls",
          useImapCredentials: true,
        },
      });
  });
  beforeEach(async () => {
    await database.db.delete(mailboxes);
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });
  async function role(name: "archive" | "trash" | "sent" | "drafts" | "junk") {
    return (await roles.list(firstAccount)).find((item) => item.role === name)!;
  }

  it("autodetects each unambiguous SPECIAL-USE role without modifying remote metadata", async () => {
    await mailboxService.reconcile(firstAccount, [
      remote("Saved", ["\\Archive"]),
      remote("Deleted", ["\\Trash"]),
      remote("Sent", ["\\Sent"]),
      remote("Drafts", ["\\Drafts"]),
      remote("Junk", ["\\Junk"]),
    ]);
    for (const name of ["archive", "trash", "sent", "drafts", "junk"] as const)
      expect(await role(name)).toMatchObject({
        source: "special_use",
        available: true,
      });
    const [saved] = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.remotePath, "Saved"));
    expect(saved?.specialUse).toEqual(["\\Archive"]);
  });

  it("does not guess a role from a localized name or ambiguous SPECIAL-USE", async () => {
    await mailboxService.reconcile(firstAccount, [
      remote("Archiwum"),
      remote("Bin A", ["\\Trash"]),
      remote("Bin B", ["\\Trash"]),
    ]);
    expect(await role("archive")).toMatchObject({
      mailboxId: null,
      available: false,
    });
    expect(await role("trash")).toMatchObject({
      mailboxId: null,
      available: false,
    });
  });

  it("preserves manual mapping through discovery and restores autodetection when cleared", async () => {
    await mailboxService.reconcile(firstAccount, [
      remote("Server archive", ["\\Archive"]),
      remote("Archiwum"),
    ]);
    const [manual] = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.remotePath, "Archiwum"));
    await roles.setManual(firstAccount, "archive", manual!.id);
    expect(await role("archive")).toMatchObject({
      mailboxId: manual!.id,
      source: "manual",
      available: true,
    });
    await mailboxService.reconcile(firstAccount, [
      remote("Server archive", ["\\Archive"]),
      remote("Archiwum"),
    ]);
    expect(await role("archive")).toMatchObject({
      mailboxId: manual!.id,
      source: "manual",
    });
    await roles.clearManual(firstAccount, "archive");
    expect(await role("archive")).toMatchObject({
      mailboxName: "Server archive",
      source: "special_use",
      available: true,
    });
  });

  it("keeps a missing mapping and restores it only when the same local mailbox returns", async () => {
    await mailboxService.reconcile(firstAccount, [
      remote("Saved", ["\\Archive"], "stable-saved"),
    ]);
    const original = await role("archive");
    await mailboxService.reconcile(firstAccount, []);
    expect(await role("archive")).toMatchObject({
      mailboxId: original.mailboxId,
      available: false,
    });
    await mailboxService.reconcile(firstAccount, [
      remote("Saved", ["\\Archive"], "stable-saved"),
    ]);
    expect(await role("archive")).toMatchObject({
      mailboxId: original.mailboxId,
      available: true,
    });
  });

  it("does not inherit a mapping when the same path is recreated with another UUID", async () => {
    await mailboxService.reconcile(firstAccount, [
      remote("Saved", ["\\Archive"], "old-provider-id"),
    ]);
    const original = await role("archive");
    await mailboxService.reconcile(firstAccount, []);
    await mailboxService.reconcile(firstAccount, [
      remote("Saved", ["\\Archive"], "new-provider-id"),
    ]);
    const current = await role("archive");
    expect(current).toMatchObject({
      mailboxId: original.mailboxId,
      available: false,
    });
    const active = (await database.db.select().from(mailboxes)).find(
      (item) => item.lifecycleStatus === "active",
    )!;
    expect(active.id).not.toBe(original.mailboxId);
  });

  it("rejects a mailbox from another account", async () => {
    await mailboxService.reconcile(secondAccount, [remote("Other archive")]);
    const [foreign] = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, secondAccount));
    await expect(
      roles.setManual(firstAccount, "archive", foreign!.id),
    ).rejects.toThrow();
    expect(
      (await database.db.select().from(mailboxRoles)).filter(
        (item) => item.accountId === firstAccount,
      ),
    ).toEqual([]);
  });
});
