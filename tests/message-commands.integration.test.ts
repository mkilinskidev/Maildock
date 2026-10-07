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
  RemoteMutationResult,
} from "@/modules/accounts/domain/mail-provider";
import { MailProviderOperationError } from "@/modules/accounts/domain/mail-provider";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
  messageCommands,
  messages,
} from "@/shared/infrastructure/database/schema";
import { randomUUID } from "node:crypto";

const accountId = "00000000-0000-4000-8000-0000000000b2";
describe("durable message commands", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let service: MessageCommandService;
  let sourceId: string;
  let archiveId: string;
  let trashId: string;
  let messageId: string;
  let calls: string[];
  let outcome: RemoteMutationResult;
  let failProvider: boolean;
  let providerError: Error | undefined;
  let reconciled: string[];
  let queued: string[];
  let lock: ReturnType<typeof createMailboxLock>;
  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_commands",
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
      url = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_commands`;
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
    lock = createMailboxLock(database.client);
    const provider: MailProvider = {
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
      synchronizeRecentMailbox: async () => ({
        uidValidity: "7",
        messageCount: 0,
      }),
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      mutateMessage: async (_account, request) => {
        calls.push(request.action);
        if (providerError) throw providerError;
        if (failProvider) throw Error("provider failure");
        return outcome;
      },
    };
    const accounts = new AccountsService(
      database.db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    service = new MessageCommandService(
      database.db,
      async (id) => {
        queued.push(id);
      },
      async (_account, mailbox) => {
        reconciled.push(mailbox);
      },
      accounts,
      provider,
    );
    await accounts.create({
      id: accountId,
      displayName: "Commands",
      email: "commands@example.test",
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
    const db = database.db;
    await db.delete(mailboxes);
    await db.delete(messages);
    await db
      .update(mailAccounts)
      .set({ enabled: true, imapCapabilities: ["MOVE"] })
      .where(eq(mailAccounts.id, accountId));
    sourceId = randomUUID();
    archiveId = randomUUID();
    trashId = randomUUID();
    messageId = randomUUID();
    const now = new Date();
    await db.insert(mailboxes).values([
      {
        id: sourceId,
        accountId,
        remotePath: "INBOX",
        name: "Inbox",
        selectable: true,
        specialUse: ["\\Inbox"],
        uidValidity: 7n,
        recentSyncUidValidity: 7n,
        recentSyncStatus: "success",
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
      },
      {
        id: archiveId,
        accountId,
        remotePath: "Saved",
        name: "Saved",
        selectable: true,
        specialUse: ["\\Archive"],
        uidValidity: 9n,
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
      },
      {
        id: trashId,
        accountId,
        remotePath: "Bin",
        name: "Bin",
        selectable: true,
        specialUse: ["\\Trash"],
        uidValidity: 10n,
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
      },
    ]);
    await db
      .insert(messages)
      .values({ id: messageId, accountId, internalDate: now, size: 1n });
    await db.insert(mailboxMessages).values({
      id: randomUUID(),
      mailboxId: sourceId,
      messageId,
      uidValidity: 7n,
      uid: 42n,
      flags: [],
      firstSynchronizedAt: now,
      lastSynchronizedAt: now,
    });
    await new MailboxRoleService(db).autodetect(accountId);
    calls = [];
    reconciled = [];
    queued = [];
    outcome = { outcome: "applied" };
    failProvider = false;
    providerError = undefined;
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });
  async function placement() {
    return (await database.db.select().from(mailboxMessages))[0];
  }
  async function command(id: string) {
    return (
      await database.db
        .select()
        .from(messageCommands)
        .where(eq(messageCommands.id, id))
    )[0]!;
  }
  it.each(["mark_read", "mark_unread", "flag", "unflag"] as const)(
    "projects and executes %s",
    async (action) => {
      const created = await service.create(
        accountId,
        sourceId,
        messageId,
        action,
      );
      expect(queued).toEqual([created.id]);
      await service.run(created.id);
      expect((await command(created.id)).status).toBe("succeeded");
      expect(calls).toEqual([action]);
      expect(reconciled).toContain(sourceId);
    },
  );
  it("keeps flag retries idempotent", async () => {
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "flag",
    );
    failProvider = true;
    await expect(service.run(created.id)).rejects.toThrow();
    failProvider = false;
    await service.run(created.id);
    await service.run(created.id);
    expect(calls).toEqual(["flag", "flag"]);
    expect((await command(created.id)).status).toBe("succeeded");
  });
  it("terminates an exhausted conditional conflict once and schedules reconciliation", async () => {
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "mark_read",
    );
    outcome = { outcome: "conflict" };
    await service.run(created.id);
    await service.run(created.id);
    expect(await command(created.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "Message changed on the server; please retry.",
    });
    expect(calls).toEqual(["mark_read"]);
    expect((await placement()).flags).toEqual([]);
    expect(reconciled).toEqual([sourceId]);
  });
  it("retains durable transport retries and never labels protocol errors as conflicts", async () => {
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "mark_read",
    );
    providerError = new MailProviderOperationError({
      success: false,
      category: "internal_error",
      message: "IMAP connection failed.",
    });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(service.run(created.id)).rejects.toBeInstanceOf(
        MailProviderOperationError,
      );
    await service.run(created.id);
    expect(await command(created.id)).toMatchObject({
      status: "failed",
      attempts: 4,
      error: "IMAP connection failed.",
    });
    expect(reconciled).toEqual([sourceId]);
  });
  it("rejects changed UIDVALIDITY and rolls the projection back", async () => {
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "mark_read",
    );
    expect((await placement())?.flags).toContain("\\Seen");
    await database.db
      .update(mailboxes)
      .set({ uidValidity: 8n })
      .where(eq(mailboxes.id, sourceId));
    await service.run(created.id);
    expect((await command(created.id)).status).toBe("failed");
    expect((await placement())?.flags).toEqual([]);
    expect(calls).toEqual([]);
    expect(reconciled).toContain(sourceId);
  });
  it.each(["archive", "trash"] as const)(
    "moves %s and persists UID mapping",
    async (action) => {
      const created = await service.create(
        accountId,
        sourceId,
        messageId,
        action,
      );
      expect((await placement())?.actionHidden).toBe(true);
      outcome = {
        outcome: "applied",
        destinationUidValidity: "9",
        destinationUid: "101",
      };
      await service.run(created.id);
      expect(await command(created.id)).toMatchObject({
        status: "succeeded",
        destinationUidValidity: 9n,
        destinationUid: 101n,
      });
      expect(await placement()).toBeUndefined();
      expect(reconciled).toContain(sourceId);
    },
  );
  it("uses a manual archive role when the mailbox has no SPECIAL-USE", async () => {
    await database.db
      .update(mailboxes)
      .set({ specialUse: [] })
      .where(eq(mailboxes.id, archiveId));
    await new MailboxRoleService(database.db).setManual(
      accountId,
      "archive",
      archiveId,
    );
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "archive",
    );
    expect((await command(created.id)).destinationMailboxId).toBe(archiveId);
    await service.run(created.id);
    expect((await command(created.id)).status).toBe("succeeded");
  });
  it("does not queue Archive when its mapped mailbox is unavailable", async () => {
    await database.db
      .update(mailboxes)
      .set({ lifecycleStatus: "missing" })
      .where(eq(mailboxes.id, archiveId));
    await expect(
      service.create(accountId, sourceId, messageId, "archive"),
    ).rejects.toThrow();
    expect(queued).toEqual([]);
  });
  it("fails an uncertain MOVE replay without repeating it", async () => {
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "archive",
    );
    await database.db
      .update(messageCommands)
      .set({ status: "executing" })
      .where(eq(messageCommands.id, created.id));
    await service.run(created.id);
    expect(calls).toEqual([]);
    expect((await command(created.id)).status).toBe("failed");
    expect((await placement())?.actionHidden).toBe(false);
  });
  it("does not accept source disappearance as MOVE success", async () => {
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "trash",
    );
    outcome = { outcome: "source_missing" };
    await service.run(created.id);
    expect((await command(created.id)).status).toBe("failed");
    expect((await placement())?.actionHidden).toBe(false);
  });
  it("disables missing account/mailbox and restores state after provider failure", async () => {
    await expect(
      service.create(accountId, randomUUID(), messageId, "flag"),
    ).rejects.toThrow();
    await database.db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    await expect(
      service.create(accountId, sourceId, messageId, "flag"),
    ).rejects.toThrow();
    await database.db
      .update(mailAccounts)
      .set({ enabled: true })
      .where(eq(mailAccounts.id, accountId));
    const created = await service.create(
      accountId,
      sourceId,
      messageId,
      "archive",
    );
    failProvider = true;
    await service.run(created.id);
    expect((await command(created.id)).status).toBe("failed");
    expect((await placement())?.actionHidden).toBe(false);
  });
  it("shares the mailbox advisory lock with synchronization", async () => {
    let release!: () => void;
    const held = lock(
      sourceId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(lock(sourceId, async () => {})).rejects.toThrow(
      "already running",
    );
    release();
    await held;
  });
});
