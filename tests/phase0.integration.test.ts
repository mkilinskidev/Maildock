import { ApplicationEventService } from "@/modules/diagnostics/application/application-event-service";
import { applicationEvents } from "@/shared/infrastructure/database/schema";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  initializeOwner,
  InstanceAlreadyInitializedError,
  isInstanceInitialized,
} from "@/modules/auth/application/instance-auth";
import { checkOwnerApiAccess } from "@/modules/auth/application/api-access-check";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import {
  MailProviderOperationError,
  type MailProvider,
  type RemoteMailbox,
  type RemoteMessageMetadata,
} from "@/modules/accounts/domain/mail-provider";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MailboxDiscoveryService } from "@/modules/mail/application/mailbox-discovery-service";
import {
  MessageService,
  MailboxNotSynchronizableError,
} from "@/modules/mail/application/message-service";
import {
  MessageContentService,
  MessagePlacementNotFoundError,
} from "@/modules/mail/application/message-content-service";
import { PgBossMailboxDiscoveryScheduler } from "@/modules/mail/infrastructure/mailbox-discovery-jobs";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { getValidSession } from "@/modules/auth/application/session-validation";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { JobRuntime } from "@/modules/jobs/infrastructure/job-runtime";
import { checkReadiness } from "@/modules/platform/infrastructure/readiness";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  createDatabase,
  type Database,
} from "@/shared/infrastructure/database/database";
import {
  account,
  instanceState,
  loginThrottle,
  mailAccounts,
  mailboxes,
  messages,
  mailboxMessages,
  messageContents,
  rateLimit,
  session,
  user,
  verification,
} from "@/shared/infrastructure/database/schema";
import pino from "pino";

const unusedRecentSync: MailProvider["synchronizeRecentMailbox"] = async () => {
  throw new Error("Recent synchronization is not expected in this test.");
};

describe("Phase 0 PostgreSQL foundations", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let db: Database;
  let config: AppConfig;
  let attachmentsPath: string;

  beforeAll(async () => {
    let databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_test",
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
      databaseUrl = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_test`;
    }
    attachmentsPath = await mkdtemp(path.join(tmpdir(), "maildock-test-"));
    config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: attachmentsPath,
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    db = database.db;
    await migrate(db, { migrationsFolder: "db/migrations" });
  });

  beforeEach(async () => {
    await db.delete(mailAccounts);
    await db.delete(session);
    await db.delete(account);
    await db.delete(user);
    await db.delete(verification);
    await db.delete(rateLimit);
    await db.delete(loginThrottle);
    await db.update(instanceState).set({
      initializedAt: null,
      passwordAlgorithm: null,
      passwordParameters: null,
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (attachmentsPath)
      await rm(attachmentsPath, { recursive: true, force: true });
  });

  it("allows setup while uninitialized and creates exactly one owner", async () => {
    expect(await isInstanceInitialized(db)).toBe(false);
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    expect(await isInstanceInitialized(db)).toBe(true);
    expect(await db.select().from(user)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it("rejects setup after initialization", async () => {
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    await expect(
      initializeOwner(db, {
        username: "another",
        password: "another sufficiently long password",
      }),
    ).rejects.toBeInstanceOf(InstanceAlreadyInitializedError);
    expect(await db.select().from(user)).toHaveLength(1);
  });

  it("serializes concurrent setup so only one owner can be created", async () => {
    const results = await Promise.allSettled([
      initializeOwner(db, {
        username: "first",
        password: "first sufficiently long password",
      }),
      initializeOwner(db, {
        username: "second",
        password: "second sufficiently long password",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await db.select().from(user)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it("rejects an unauthenticated request and accepts an authenticated session", async () => {
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    const testAuth = createAuth(config, db);
    expect(await getValidSession(testAuth, new Headers())).toBeNull();

    const loginResponse = await testAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          username: "owner",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    expect(loginResponse.status).toBe(200);
    const setCookie = loginResponse.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookie = setCookie?.split(";")[0] ?? "";
    expect(
      await getValidSession(testAuth, new Headers({ cookie })),
    ).not.toBeNull();

    const logoutResponse = await testAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          cookie,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(logoutResponse.status).toBe(200);
    expect(await getValidSession(testAuth, new Headers({ cookie }))).toBeNull();
  });

  it("reports readiness only when migrations, database, and attachment storage are available", async () => {
    await mkdir(attachmentsPath, { recursive: true });
    expect(await checkReadiness({ config, query: database.client })).toBe(true);
    await database.client.end();
    expect(await checkReadiness({ config, query: database.client })).toBe(
      false,
    );
    database = createDatabase(config);
    db = database.db;
  });

  it("starts pg-boss, processes a probe job, and shuts down gracefully", async () => {
    const jobs = new JobRuntime(config, pino({ level: "silent" }));
    await jobs.start();
    const queue = `maildock-test-${Date.now()}`;
    await jobs.boss.createQueue(queue);

    const completed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Probe job timed out.")),
        20_000,
      );
      void jobs.boss.work<{ value: string }>(queue, async (batch) => {
        const job = batch[0];
        if (!job) throw new Error("Probe worker received an empty batch.");
        clearTimeout(timeout);
        resolve(job.data.value);
      });
    });

    await jobs.boss.send(queue, { value: "ok" });
    await expect(completed).resolves.toBe("ok");
    await jobs.stop();
  });

  it("stores encrypted account credentials, preserves or replaces them deliberately, and never returns them", async () => {
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      synchronizeRecentMailbox: unusedRecentSync,
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
    };
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    const service = new AccountsService(db, encryption, provider);
    const id = "00000000-0000-4000-8000-000000000011";
    const created = await service.create({
      id,
      displayName: "Primary",
      email: "owner@example.test",
      enabled: false,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        password: "plain-imap-password",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: false,
        username: "sender",
        password: "plain-smtp-password",
      },
    });

    expect(created.enabled).toBe(false);
    expect(JSON.stringify(created)).not.toContain("plain-imap-password");
    expect(JSON.stringify(created)).not.toContain("plain-smtp-password");
    const [stored] = await db.select().from(mailAccounts);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain("plain-imap-password");
    expect(JSON.stringify(stored)).not.toContain("plain-smtp-password");
    expect(stored?.imapPassword).toMatchObject({
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: "v1",
    });
    const originalImapEnvelope = stored?.imapPassword;
    const originalSmtpEnvelope = stored?.smtpPassword;

    await service.update(id, {
      displayName: "Renamed",
      email: "owner@example.test",
      enabled: true,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: false,
        username: "sender",
      },
    });
    const [preserved] = await db.select().from(mailAccounts);
    expect(preserved?.imapPassword).toEqual(originalImapEnvelope);
    expect(preserved?.smtpPassword).toEqual(originalSmtpEnvelope);

    const updated = await service.update(id, {
      displayName: "Renamed",
      email: "owner@example.test",
      enabled: true,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        password: "new-imap-password",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: false,
        username: "sender",
        password: "new-smtp-password",
      },
    });
    const [replaced] = await db.select().from(mailAccounts);
    expect(replaced?.imapPassword).not.toEqual(originalImapEnvelope);
    expect(replaced?.smtpPassword).not.toEqual(originalSmtpEnvelope);
    expect(JSON.stringify(updated)).not.toContain("new-imap-password");
    expect(JSON.stringify(updated)).not.toContain("new-smtp-password");
  });

  it("records separate connection outcomes and deletes an account", async () => {
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      synchronizeRecentMailbox: unusedRecentSync,
      testConnection: async () => ({
        imap: { success: true },
        smtp: {
          success: false,
          category: "authentication_rejected",
          message: "SMTP authentication was rejected.",
        },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
    };
    const service = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    const id = "00000000-0000-4000-8000-000000000012";
    await service.create({
      id,
      displayName: "Primary",
      email: "owner@example.test",
      enabled: true,
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
        port: 587,
        security: "starttls",
        useImapCredentials: true,
      },
    });
    const report = await service.testExisting(id);
    expect(report.imap.success).toBe(true);
    expect(report.smtp.success).toBe(false);
    expect((await service.get(id)).connectionStatus).toBe("error");
    await service.delete(id);
    await expect(service.get(id)).rejects.toThrow("Mail account not found");
  });

  it("schedules initial discovery after account persistence", async () => {
    const scheduled: string[] = [];
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      synchronizeRecentMailbox: unusedRecentSync,
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
    };
    const service = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
      {
        schedule: async (accountId) => {
          scheduled.push(accountId);
          return true;
        },
      },
    );
    const id = "00000000-0000-4000-8000-000000000020";
    const created = await service.create({
      id,
      displayName: "Scheduled",
      email: "scheduled@example.test",
      enabled: true,
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
    expect(scheduled).toEqual([id]);
    expect(created.mailboxDiscovery.status).toBe("pending");
  });

  it("keeps active path identity idempotent but gives recreated paths new UUIDs", async () => {
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      synchronizeRecentMailbox: unusedRecentSync,
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
    };
    const accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    const createAccount = async (id: string, email: string) =>
      accounts.create({
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
    const firstAccount = "00000000-0000-4000-8000-000000000021";
    const secondAccount = "00000000-0000-4000-8000-000000000022";
    await createAccount(firstAccount, "one@example.test");
    await createAccount(secondAccount, "two@example.test");
    const service = new MailboxService(db);
    const remote = (
      path: string,
      overrides: Partial<RemoteMailbox> = {},
    ): RemoteMailbox => ({
      remotePath: path,
      name: path.split(".").at(-1)!,
      delimiter: ".",
      attributes: [],
      selectable: true,
      specialUse: [],
      ...overrides,
    });

    const initialRemote = [
      remote("INBOX", {
        specialUse: ["\\Inbox"],
        uidValidity: "10",
        messageCount: "5",
      }),
      remote("Archive.2025", { messageCount: "3", uidValidity: "77" }),
      remote("Stable", { providerMailboxId: "object-1" }),
      remote("OldPath", { uidValidity: "44" }),
    ];
    await service.reconcile(firstAccount, initialRemote);
    const first = await service.listForAccount(firstAccount, true);
    expect(first).toHaveLength(4);
    const inboxId = first.find((item) => item.remotePath === "INBOX")!.id;
    const stableId = first.find((item) => item.remotePath === "Stable")!.id;
    const originalArchiveId = first.find(
      (item) => item.remotePath === "Archive.2025",
    )!.id;
    const oldPathId = first.find((item) => item.remotePath === "OldPath")!.id;

    await service.reconcile(firstAccount, initialRemote);
    const repeated = await service.listForAccount(firstAccount, true);
    expect(repeated).toHaveLength(4);
    expect(repeated.find((item) => item.remotePath === "INBOX")?.id).toBe(
      inboxId,
    );
    expect(
      repeated.find((item) => item.remotePath === "Archive.2025")?.id,
    ).toBe(originalArchiveId);

    await service.reconcile(firstAccount, [
      remote("INBOX", {
        specialUse: ["\\Inbox"],
        uidValidity: "11",
        messageCount: "8",
      }),
      remote("Archive.2026", { messageCount: "4" }),
      remote("RenamedStable", { providerMailboxId: "object-1" }),
      remote("NewPath", { uidValidity: "44" }),
    ]);
    const second = await service.listForAccount(firstAccount, true);
    expect(second.find((item) => item.remotePath === "INBOX")).toMatchObject({
      id: inboxId,
      messageCount: "8",
      uidValidity: "11",
      uidValidityChangeCount: 1,
    });
    expect(second.find((item) => item.remotePath === "RenamedStable")?.id).toBe(
      stableId,
    );
    expect(
      second.find((item) => item.remotePath === "Archive.2025")
        ?.lifecycleStatus,
    ).toBe("missing");
    expect(
      second.find((item) => item.remotePath === "OldPath")?.lifecycleStatus,
    ).toBe("missing");
    expect(second.find((item) => item.remotePath === "NewPath")?.id).not.toBe(
      oldPathId,
    );
    expect(
      second.find((item) => item.remotePath === "NewPath")?.uidValidity,
    ).toBe("44");
    const [oldPathAfterMissing] = await db
      .select({ updatedAt: mailboxes.updatedAt })
      .from(mailboxes)
      .where(eq(mailboxes.id, oldPathId));

    const recreatedRemote = [
      remote("INBOX", { uidValidity: "11" }),
      remote("Archive.2025", { uidValidity: "77" }),
      remote("Archive.2026"),
      remote("NewPath"),
    ];
    await service.reconcile(firstAccount, recreatedRemote);
    const afterSameUidValidity = await service.listForAccount(
      firstAccount,
      true,
    );
    const archiveRows = afterSameUidValidity.filter(
      (item) => item.remotePath === "Archive.2025",
    );
    expect(archiveRows).toHaveLength(2);
    expect(archiveRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: originalArchiveId,
          lifecycleStatus: "missing",
          uidValidity: "77",
        }),
        expect.objectContaining({
          lifecycleStatus: "active",
          uidValidity: "77",
        }),
      ]),
    );
    const recreatedArchiveId = archiveRows.find(
      (item) => item.lifecycleStatus === "active",
    )!.id;
    expect(recreatedArchiveId).not.toBe(originalArchiveId);

    await service.reconcile(firstAccount, recreatedRemote);
    const repeatedRecreation = await service.listForAccount(firstAccount, true);
    expect(
      repeatedRecreation.filter((item) => item.remotePath === "Archive.2025"),
    ).toHaveLength(2);
    expect(
      repeatedRecreation.find(
        (item) =>
          item.remotePath === "Archive.2025" &&
          item.lifecycleStatus === "active",
      )?.id,
    ).toBe(recreatedArchiveId);
    const [oldPathStillMissing] = await db
      .select({ updatedAt: mailboxes.updatedAt })
      .from(mailboxes)
      .where(eq(mailboxes.id, oldPathId));
    expect(oldPathStillMissing?.updatedAt).toEqual(
      oldPathAfterMissing?.updatedAt,
    );

    await service.reconcile(firstAccount, [
      ...recreatedRemote,
      remote("StableAgain", { providerMailboxId: "object-1" }),
    ]);
    expect(
      (await service.listForAccount(firstAccount, true)).find(
        (item) => item.remotePath === "StableAgain",
      ),
    ).toMatchObject({ id: stableId, lifecycleStatus: "active" });

    await service.reconcile(
      firstAccount,
      recreatedRemote.filter((item) => item.remotePath !== "Archive.2025"),
    );
    await service.reconcile(firstAccount, [
      ...recreatedRemote.filter((item) => item.remotePath !== "Archive.2025"),
      remote("Archive.2025", { uidValidity: "78" }),
    ]);
    const afterDifferentUidValidity = (
      await service.listForAccount(firstAccount, true)
    ).filter((item) => item.remotePath === "Archive.2025");
    expect(afterDifferentUidValidity).toHaveLength(3);
    const activeArchive = afterDifferentUidValidity.find(
      (item) => item.lifecycleStatus === "active",
    );
    expect(activeArchive).toMatchObject({ uidValidity: "78" });
    expect(activeArchive?.id).not.toBe(originalArchiveId);
    expect(activeArchive?.id).not.toBe(recreatedArchiveId);

    const duplicateAt = new Date();
    await expect(
      db.insert(mailboxes).values({
        id: "00000000-0000-4000-8000-000000000099",
        accountId: firstAccount,
        remotePath: "Archive.2025",
        name: "2025",
        delimiter: ".",
        attributes: [],
        specialUse: [],
        selectable: true,
        lifecycleStatus: "active",
        firstDiscoveredAt: duplicateAt,
        lastDiscoveredAt: duplicateAt,
        createdAt: duplicateAt,
        updatedAt: duplicateAt,
      }),
    ).rejects.toThrow();
    expect(
      await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.accountId, firstAccount),
            eq(mailboxes.remotePath, "Archive.2025"),
            eq(mailboxes.lifecycleStatus, "active"),
          ),
        ),
    ).toHaveLength(1);

    await service.reconcile(secondAccount, [remote("INBOX")]);
    expect(await service.listForAccount(secondAccount)).toHaveLength(1);
    expect(
      (await service.listForAccount(firstAccount)).some(
        (item) => item.remotePath === "INBOX",
      ),
    ).toBe(true);
  });

  it("retains mailbox data after failure, rejects disabled work, and can retry", async () => {
    let attempt = 0;
    let providerCalls = 0;
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      synchronizeRecentMailbox: unusedRecentSync,
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => {
        providerCalls += 1;
        attempt += 1;
        if (attempt === 1) {
          throw new MailProviderOperationError({
            success: false,
            category: "connection_timeout",
            message: "The connection timed out.",
          });
        }
        return {
          capabilities: ["IDLE"],
          mailboxes: [
            {
              remotePath: "INBOX",
              name: "INBOX",
              delimiter: "/",
              attributes: [],
              selectable: true,
              specialUse: ["\\Inbox"],
            },
          ],
        };
      },
    };
    const accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    const id = "00000000-0000-4000-8000-000000000023";
    await accounts.create({
      id,
      displayName: "Retry",
      email: "retry@example.test",
      enabled: true,
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
    const mailboxService = new MailboxService(db);
    await mailboxService.reconcile(id, [
      {
        remotePath: "Known",
        name: "Known",
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: [],
      },
    ]);
    const discovery = new MailboxDiscoveryService(
      db,
      accounts,
      provider,
      mailboxService,
    );
    await expect(discovery.run(id)).rejects.toThrow();
    expect(await mailboxService.listForAccount(id)).toHaveLength(1);
    expect((await accounts.get(id)).mailboxDiscovery).toMatchObject({
      status: "failed",
      error: "The connection timed out.",
    });
    await discovery.run(id);
    expect(await mailboxService.listForAccount(id)).toHaveLength(1);
    expect((await accounts.get(id)).mailboxDiscovery).toMatchObject({
      status: "success",
      capabilities: ["IDLE"],
    });

    await accounts.setEnabled(id, false);
    await expect(discovery.run(id)).rejects.toThrow(
      "Disabled mail accounts cannot run provider work",
    );
    expect(providerCalls).toBe(2);
  });

  it("deduplicates queued discovery requests per account", async () => {
    const scheduler = new PgBossMailboxDiscoveryScheduler(config);
    try {
      const id = "00000000-0000-4000-8000-000000000024";
      expect(await scheduler.schedule(id)).toBe(true);
      expect(await scheduler.schedule(id)).toBe(false);
    } finally {
      await scheduler.stop();
    }
  });

  it("requires an authenticated owner and valid origin for deletion mutations", async () => {
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    const testAuth = createAuth(config, db);
    const unauthenticated = await checkOwnerApiAccess(
      testAuth,
      config,
      new Request("http://localhost:3000/api/accounts/id", {
        method: "DELETE",
        headers: { Origin: config.appOrigin },
      }),
      true,
    );
    expect(unauthenticated?.status).toBe(401);

    const login = await testAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: config.appOrigin,
        },
        body: JSON.stringify({
          username: "owner",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const wrongOrigin = await checkOwnerApiAccess(
      testAuth,
      config,
      new Request("http://localhost:3000/api/accounts/id", {
        method: "DELETE",
        headers: { cookie, Origin: "http://evil.test" },
      }),
      true,
    );
    expect(wrongOrigin?.status).toBe(403);
    const authorized = await checkOwnerApiAccess(
      testAuth,
      config,
      new Request("http://localhost:3000/api/accounts/id", {
        method: "DELETE",
        headers: { cookie, Origin: config.appOrigin },
      }),
      true,
    );
    expect(authorized).toBeNull();
  });

  it("persists recent metadata idempotently without Message-ID deduplication and handles UIDVALIDITY changes", async () => {
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    const baseMetadata = (
      uid: string,
      flags: readonly string[] = ["custom"],
    ): RemoteMessageMetadata => ({
      uid,
      modseq: "9007199254740993",
      internalDate: "2026-09-20T10:00:00.000Z",
      size: "1234",
      flags,
      envelope: {
        messageId: "same@example.test",
        subject: "Metadata only",
        from: [{ name: "Ania", address: "ania@example.test" }],
        sender: [],
        replyTo: [],
        to: [],
        cc: [],
        bcc: [],
      },
      mimeStructure: {
        part: "1",
        type: "application/pdf",
        disposition: "attachment",
        filename: "invoice.pdf",
        encoding: "base64",
        size: "99",
        contentId: null,
        parameters: {},
        dispositionParameters: { filename: "invoice.pdf" },
        children: [],
      },
      hasAttachments: true,
    });
    let epoch = "10";
    let providerCalls = 0;
    let failAfterCommittedBatch = false;
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
      synchronizeRecentMailbox: async (_account, request, sink) => {
        providerCalls += 1;
        expect(request.batchSize).toBe(config.messageFetchBatchSize);
        await sink.selected(epoch);
        await sink.batch([
          baseMetadata(
            "1",
            providerCalls === 1
              ? ["\\Seen", "custom"]
              : ["\\Flagged", "custom"],
          ),
          baseMetadata("2"),
        ]);
        if (failAfterCommittedBatch) {
          await sink.batch([baseMetadata("3")]);
          throw new Error("simulated later batch failure");
        }
        return { uidValidity: epoch, messageCount: 2 };
      },
    };
    const accounts = new AccountsService(db, encryption, provider);
    const accountId = "00000000-0000-4000-8000-000000000031";
    await accounts.create({
      id: accountId,
      displayName: "Messages",
      email: "messages@example.test",
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
    await db
      .update(mailAccounts)
      .set({ enabled: true })
      .where(eq(mailAccounts.id, accountId));
    const mailboxService = new MailboxService(db);
    await mailboxService.reconcile(accountId, [
      {
        remotePath: "INBOX",
        name: "INBOX",
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: ["\\Inbox"],
        uidValidity: "10",
      },
    ]);
    const mailbox = (await mailboxService.listForAccount(accountId))[0]!;
    const service = new MessageService(
      db,
      accounts,
      provider,
      config,
      undefined,
      undefined,
      undefined,
      new ApplicationEventService(db),
    );

    await service.runRecentSync(accountId, mailbox.id);
    expect(
      (
        await db
          .select()
          .from(applicationEvents)
          .where(eq(applicationEvents.accountId, accountId))
      ).map((e) => e.event),
    ).toContain("mail.recent_sync_completed");
    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await db.select().from(mailboxMessages)).toHaveLength(2);
    const firstPage = await service.list(accountId, mailbox.id, 1);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await service.list(
      accountId,
      mailbox.id,
      1,
      firstPage.nextCursor!,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    const listedMessages = (await service.list(accountId, mailbox.id)).items;
    expect(listedMessages.every((item) => item.hasAttachments)).toBe(true);
    expect(listedMessages.map((item) => item.seen).sort()).toEqual([
      false,
      true,
    ]);

    await service.runRecentSync(accountId, mailbox.id);
    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await db.select().from(mailboxMessages)).toHaveLength(2);
    const updatedPage = await service.list(accountId, mailbox.id);
    expect(updatedPage.items.some((item) => item.flagged)).toBe(true);
    expect(updatedPage.items.every((item) => !item.seen)).toBe(true);
    const storedPlacements = await db.select().from(mailboxMessages);
    expect(storedPlacements[0]?.modseq).toBe(9_007_199_254_740_993n);
    expect(storedPlacements.flatMap((item) => item.flags)).toContain("custom");

    failAfterCommittedBatch = true;
    await expect(service.runRecentSync(accountId, mailbox.id)).rejects.toThrow(
      "simulated later batch failure",
    );
    expect(
      (
        await db
          .select()
          .from(applicationEvents)
          .where(eq(applicationEvents.accountId, accountId))
      ).map((e) => e.event),
    ).toContain("mail.recent_sync_failed");
    expect(await db.select().from(mailboxMessages)).toHaveLength(3);
    expect((await mailboxService.listForAccount(accountId))[0]).toMatchObject({
      recentSync: { status: "failed" },
    });
    failAfterCommittedBatch = false;

    epoch = "11";
    await service.runRecentSync(accountId, mailbox.id);
    const currentPlacements = await db.select().from(mailboxMessages);
    expect(currentPlacements).toHaveLength(2);
    expect(currentPlacements.every((item) => item.uidValidity === 11n)).toBe(
      true,
    );
    expect(await db.select().from(messages)).toHaveLength(5);
    expect(providerCalls).toBe(4);
    expect((await mailboxService.listForAccount(accountId))[0]).toMatchObject({
      uidValidity: "11",
      uidValidityChangeCount: 1,
      recentSync: { status: "success", messageCount: 2 },
    });
    await db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    await expect(service.runRecentSync(accountId, mailbox.id)).rejects.toThrow(
      "Disabled mail accounts cannot run provider work",
    );
    expect(providerCalls).toBe(4);
  });

  it("rejects non-selectable recent sync before provider work", async () => {
    let providerCalls = 0;
    const provider: MailProvider = {
      fetchMessageContent: async () => ({ plainText: null, html: null }),
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
      synchronizeRecentMailbox: async () => {
        providerCalls += 1;
        return { uidValidity: "1", messageCount: 0 };
      },
    };
    const accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    const accountId = "00000000-0000-4000-8000-000000000032";
    await accounts.create({
      id: accountId,
      displayName: "Container",
      email: "container@example.test",
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
    await db
      .update(mailAccounts)
      .set({ enabled: true })
      .where(eq(mailAccounts.id, accountId));
    const mailboxService = new MailboxService(db);
    await mailboxService.reconcile(accountId, [
      {
        remotePath: "Folder",
        name: "Folder",
        delimiter: "/",
        attributes: ["\\Noselect"],
        selectable: false,
        specialUse: [],
      },
    ]);
    const mailbox = (await mailboxService.listForAccount(accountId))[0]!;
    await expect(
      new MessageService(db, accounts, provider, config).runRecentSync(
        accountId,
        mailbox.id,
      ),
    ).rejects.toBeInstanceOf(MailboxNotSynchronizableError);
    expect(providerCalls).toBe(0);
  });
  it("fetches display content asynchronously through local state and keeps it offline", async () => {
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    let downloads = 0;
    let fail = false;
    const provider: MailProvider = {
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
      synchronizeRecentMailbox: unusedRecentSync,
      fetchMessageContent: async (_account, request) => {
        downloads++;
        expect(request).toMatchObject({
          expectedUidValidity: "5",
          parts: [{ part: "1", type: "text/html" }],
        });
        if (fail) throw new Error("server password=secret");
        return {
          plainText: null,
          html: '<p>Hello</p><img src="https://tracker.example/x">',
        };
      },
    };
    const accounts = new AccountsService(db, encryption, provider);
    const accountId = "00000000-0000-4000-8000-000000000081";
    await accounts.create({
      id: accountId,
      displayName: "Content",
      email: "content@example.test",
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
    await db
      .update(mailAccounts)
      .set({ enabled: true })
      .where(eq(mailAccounts.id, accountId));
    const mailService = new MailboxService(db);
    await mailService.reconcile(accountId, [
      {
        remotePath: "INBOX",
        name: "INBOX",
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: ["\\Inbox"],
        uidValidity: "5",
      },
    ]);
    const mailbox = (await mailService.listForAccount(accountId))[0]!;
    await db
      .update(mailboxes)
      .set({ recentSyncUidValidity: 5n })
      .where(eq(mailboxes.id, mailbox.id));
    const metadata: RemoteMessageMetadata = {
      uid: "42",
      internalDate: "2026-09-20T10:00:00.000Z",
      size: "100",
      flags: [],
      envelope: {
        subject: "Content",
        from: [{ address: "sender@example.test" }],
        sender: [],
        replyTo: [],
        to: [],
        cc: [],
        bcc: [],
      },
      mimeStructure: {
        part: "1",
        type: "text/html",
        disposition: null,
        filename: null,
        encoding: "quoted-printable",
        size: "100",
        contentId: null,
        parameters: { charset: "utf-8" },
        dispositionParameters: {},
        children: [],
      },
      hasAttachments: false,
    };
    await new MessageService(db).persistBatch(accountId, mailbox.id, 5n, [
      metadata,
    ]);
    const message = (await db.select().from(messages))[0]!;
    let scheduled = 0;
    const service = new MessageContentService(
      db,
      {
        schedule: async () => {
          scheduled++;
          return true;
        },
      },
      accounts,
      provider,
      config,
    );
    expect(
      (await service.detail(accountId, mailbox.id, message.id)).content.status,
    ).toBe("not_fetched");
    expect(downloads).toBe(0);
    expect(await service.request(accountId, mailbox.id, message.id)).toBe(true);
    expect(
      (await service.detail(accountId, mailbox.id, message.id)).content.status,
    ).toBe("pending");
    expect(await service.request(accountId, mailbox.id, message.id)).toBe(
      false,
    );
    expect(scheduled).toBe(1);
    await service.run(accountId, mailbox.id, message.id);
    const ready = await service.detail(accountId, mailbox.id, message.id);
    expect(ready.content).toMatchObject({
      status: "ready",
      remoteContentBlocked: true,
    });
    expect(ready.content.sanitizedHtml).toContain("Hello");
    expect(ready.content.sanitizedHtml).not.toMatch(/\ssrc=["\']https?:/);
    expect((await db.select().from(messageContents))[0]?.sanitizedHtml).toBe(
      ready.content.sanitizedHtml,
    );
    expect(await service.request(accountId, mailbox.id, message.id)).toBe(
      false,
    );
    fail = true;
    await service.run(accountId, mailbox.id, message.id);
    expect(downloads).toBe(1);
    expect(
      (await service.detail(accountId, mailbox.id, message.id)).content.status,
    ).toBe("ready");
    await new MessageService(db).persistBatch(accountId, mailbox.id, 5n, [
      { ...metadata, uid: "43" },
    ]);
    const second = (await db.select().from(mailboxMessages)).find(
      (item) => item.uid === 43n,
    )!;
    expect(await service.request(accountId, mailbox.id, second.messageId)).toBe(
      true,
    );
    await expect(
      service.run(accountId, mailbox.id, second.messageId),
    ).rejects.toThrow("Message content could not be fetched.");
    const failed = await service.detail(
      accountId,
      mailbox.id,
      second.messageId,
    );
    expect(failed.content.status).toBe("failed");
    expect(failed.content.error).not.toContain("password");
    fail = false;
    expect(await service.request(accountId, mailbox.id, second.messageId)).toBe(
      true,
    );
    await service.run(accountId, mailbox.id, second.messageId);
    expect(
      (await service.detail(accountId, mailbox.id, second.messageId)).content
        .status,
    ).toBe("ready");
    await new MessageService(db).persistBatch(accountId, mailbox.id, 5n, [
      { ...metadata, uid: "44" },
    ]);
    const third = (await db.select().from(mailboxMessages)).find(
      (item) => item.uid === 44n,
    )!;
    await db
      .update(mailboxes)
      .set({ recentSyncUidValidity: 6n })
      .where(eq(mailboxes.id, mailbox.id));
    expect(await service.request(accountId, mailbox.id, third.messageId)).toBe(
      true,
    );
    const beforeStale = downloads;
    await expect(
      service.run(accountId, mailbox.id, third.messageId),
    ).rejects.toThrow("Mailbox UIDVALIDITY changed");
    expect(downloads).toBe(beforeStale);
    expect(
      (await service.detail(accountId, mailbox.id, third.messageId)).content
        .status,
    ).toBe("failed");
    await expect(
      service.detail(
        accountId,
        mailbox.id,
        "00000000-0000-4000-8000-000000000099",
      ),
    ).rejects.toBeInstanceOf(MessagePlacementNotFoundError);
    await db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    await expect(
      service.request(accountId, mailbox.id, third.messageId),
    ).rejects.toThrow("disabled");
    expect(
      (await service.detail(accountId, mailbox.id, message.id)).content.status,
    ).toBe("ready");
  });
});
