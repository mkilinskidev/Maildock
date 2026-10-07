import { MailProviderOperationError } from "@/modules/accounts/domain/mail-provider";
import { ApplicationEventService } from "@/modules/diagnostics/application/application-event-service";
import { applicationEvents } from "@/shared/infrastructure/database/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { NotificationService } from "@/modules/mail/application/notification-service";
import { defaultNotificationPreferences } from "@/modules/mail/domain/notifications";
import { eq, sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PgBoss } from "pg-boss";
import type { Logger } from "pino";

import { AccountsService } from "@/modules/accounts/application/accounts-service";
import type {
  DeltaMailboxSyncSink,
  MailProvider,
  RemoteMessageMetadata,
} from "@/modules/accounts/domain/mail-provider";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { DeltaSyncService } from "@/modules/mail/application/delta-sync-service";
import { DeltaPoller } from "@/modules/mail/infrastructure/delta-sync-jobs";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
import { IdleWatcherManager } from "@/modules/mail/infrastructure/idle-watchers";
import { MessageService } from "@/modules/mail/application/message-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { parseConfig } from "@/shared/infrastructure/config/config";
import {
  createDatabase,
  type Database,
} from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
  notificationEvents,
  instanceState,
  messageCommands,
  outgoingMessages,
} from "@/shared/infrastructure/database/schema";

const accountId = "00000000-0000-4000-8000-0000000000e1";
const cutoff = new Date("2026-09-01T00:00:00Z");

function metadata(
  uid: number,
  flags: string[] = [],
  modseq = "10",
): RemoteMessageMetadata {
  return {
    uid: String(uid),
    modseq,
    internalDate: "2026-09-20T00:00:00Z",
    size: "20",
    flags,
    envelope: {
      subject: `Message ${uid}`,
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
    },
    hasAttachments: false,
  };
}

describe("Phase 1E persisted delta state", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let db: Database;
  let accounts: AccountsService;
  let messagesService: MessageService;
  let delta: DeltaSyncService;
  let events: ApplicationEventService;
  const operationalLogger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
  let runProvider: (sink: DeltaMailboxSyncSink) => Promise<void>;
  let recentRequests: string[];

  beforeAll(async () => {
    let databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_phase1e",
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
      databaseUrl = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_phase1e`;
    }
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: "D:/Projects/JS/Maildock/.test-attachments",
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    db = database.db;
    await migrate(db, { migrationsFolder: "db/migrations" });
    const provider: MailProvider = {
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
      synchronizeRecentMailbox: async () => {
        throw new Error("unexpected recent sync");
      },
      synchronizeDeltaMailbox: async (_account, _path, _batchSize, sink) =>
        runProvider(sink),
      fetchMessageContent: async () => {
        throw new Error("body fetch forbidden");
      },
    };
    accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    recentRequests = [];
    messagesService = new MessageService(db, accounts, provider, config, {
      schedule: async (_account, mailbox) => {
        recentRequests.push(mailbox);
        return true;
      },
    });
    events = new ApplicationEventService(db, operationalLogger);
    delta = new DeltaSyncService(
      db,
      accounts,
      provider,
      messagesService,
      2,
      operationalLogger,
      events,
    );
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(applicationEvents);
    await db.delete(outgoingMessages);
    await db.delete(mailAccounts);
    await db.delete(instanceState);
    recentRequests.length = 0;
    await accounts.create({
      id: accountId,
      displayName: "Phase 1E",
      email: "phase1e@example.test",
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
    await new MailboxService(db).reconcile(accountId, [
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
    const [mailbox] = await db.select().from(mailboxes);
    await db
      .update(mailboxes)
      .set({
        recentSyncStatus: "success",
        recentSyncUidValidity: 10n,
        recentSyncCutoff: cutoff,
        recentSyncMessageCount: 1,
      })
      .where(eq(mailboxes.id, mailbox!.id));
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.completed({
        uidNext: "1",
        messageCount: "0",
        unseenCount: "0",
        highestModseq: null,
        condstore: false,
      });
    };
  });

  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });

  async function mailbox() {
    return (await db.select().from(mailboxes))[0]!;
  }
  async function placements() {
    return (await db.select().from(mailboxMessages)).sort((a, b) =>
      Number(a.uid - b.uid),
    );
  }
  async function seed(
    uid: number,
    epoch = 10n,
    flags: string[] = [],
    modseq = 10n,
  ) {
    await messagesService.persistBatch(accountId, (await mailbox()).id, epoch, [
      metadata(uid, flags, String(modseq)),
    ]);
  }
  async function sync() {
    await delta.run(accountId, (await mailbox()).id, "poll");
  }

  async function arrive(uid: number, boxId?: string, remote = metadata(uid)) {
    boxId ??= (await mailbox()).id;
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.newBatch([remote], String(uid));
    };
    await delta.run(accountId, boxId, "poll");
  }
  async function extraBox() {
    const id = randomUUID();
    await db.insert(mailboxes).values({
      id,
      accountId,
      remotePath: "Archive",
      name: "Archive",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
      uidValidity: 10n,
      recentSyncStatus: "success",
      recentSyncUidValidity: 10n,
      recentSyncMessageCount: 1,
      deltaUidValidity: 10n,
    });
    return id;
  }
  it("F11 polling logs use opaque IDs without persisting successful polls", async () => {
    await sync();
    expect(operationalLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mail.delta_sync_completed",
        accountId,
        mailboxId: (await mailbox()).id,
        reason: "poll",
        newCount: 0,
      }),
      expect.any(String),
    );
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
    expect(
      JSON.stringify(vi.mocked(operationalLogger.info).mock.calls),
    ).not.toMatch(
      /accountName|accountEmail|mailboxPath|phase1e@example.test|Phase 1E|INBOX/,
    );
  });
  it("F11 persists owner-facing failures while Pino omits mail labels", async () => {
    runProvider = async () => {
      throw Error("password=DO_NOT_PERSIST");
    };
    await expect(sync()).rejects.toThrow("DO_NOT_PERSIST");
    expect(operationalLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        mailboxId: (await mailbox()).id,
        category: "internal_error",
      }),
      expect.any(String),
    );
    const rows = await db.select().from(applicationEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("mail.sync_failed");
    expect(JSON.stringify(rows)).not.toContain("DO_NOT_PERSIST");
    await expect(sync()).rejects.toThrow("DO_NOT_PERSIST");
    expect(await db.select().from(applicationEvents)).toHaveLength(1);
  });
  it("Phase 3F retains existing authentication categories without persisting exception messages", async () => {
    runProvider = async () => {
      throw new MailProviderOperationError({
        success: false,
        category: "authentication_rejected",
        message: "SECRET_SERVER_PAYLOAD",
      });
    };
    await expect(sync()).rejects.toThrow("SECRET_SERVER_PAYLOAD");
    const rows = await db.select().from(applicationEvents);
    expect(rows[0].details?.category).toBe("authentication_rejected");
    expect(rows[0].message).toBe("Mailbox synchronization failed");
    expect(JSON.stringify(rows)).not.toContain("SECRET_SERVER_PAYLOAD");
  });
  it("Phase 3F keeps mail operations working when event persistence fails", async () => {
    const broken = new ApplicationEventService(
      {
        insert: () => {
          throw Error("database unavailable");
        },
        delete: () => {
          throw Error();
        },
      } as unknown as Database,
      operationalLogger,
    );
    const boxId = (await mailbox()).id;
    runProvider = async (sink) => {
      await sink.selected("11");
    };
    const failingDiagnostics = new DeltaSyncService(
      db,
      accounts,
      {} as MailProvider,
      messagesService,
      2,
      operationalLogger,
      broken,
    );
    await expect(
      failingDiagnostics.run(accountId, boxId, "poll"),
    ).rejects.toThrow("Delta provider is unavailable");
    // A UIDVALIDITY reset is a recoverable successful operation even if diagnostics fail.
    const epochDelta = new DeltaSyncService(
      db,
      accounts,
      {
        synchronizeDeltaMailbox: async (_a, _p, _n, sink) => runProvider(sink),
      } as MailProvider,
      messagesService,
      2,
      operationalLogger,
      broken,
    );
    await expect(
      epochDelta.run(accountId, boxId, "poll"),
    ).resolves.toBeUndefined();
    expect(recentRequests).toContain(boxId);
  });
  it("Phase 3F records epoch reset and applies retention, filters, safe serialization and bounded cursors", async () => {
    runProvider = async (sink) => {
      await sink.selected("11");
    };
    await sync();
    expect((await db.select().from(applicationEvents))[0].event).toBe(
      "mail.epoch_reset",
    );
    await db.delete(applicationEvents);
    await events.record("mail.sent", { accountId });
    await events.record("mail.sync_failed", {
      accountId,
      details: {
        category: "authentication_rejected",
        password: "SECRET",
        stack: "SECRET",
      } as never,
    });
    await db.insert(applicationEvents).values({
      id: randomUUID(),
      createdAt: new Date(Date.now() - 31 * 86400_000),
      level: "info",
      area: "smtp",
      event: "mail.sent",
      message: "Outgoing message sent",
    });
    await events.cleanup();
    expect(await db.select().from(applicationEvents)).toHaveLength(2);
    const filtered = await events.list({
      accountId,
      area: "sync",
      level: "error",
      limit: 1,
    });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].accountName).toBe("Phase 1E");
    expect(JSON.stringify(filtered)).not.toContain("SECRET");
    const first = await events.list({ limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await events.list({ limit: 1, cursor: first.nextCursor! });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].id).not.toBe(first.events[0].id);
    expect(second.nextCursor).toBeNull();
    expect(first.events[0].createdAt >= second.events[0].createdAt).toBe(true);
  });

  it("Phase 3F bounds retained history to the most recent ten thousand events", async () => {
    await db.execute(sql`insert into application_events (id, created_at, level, area, event, message)
      select gen_random_uuid(), now() - n * interval '1 millisecond', 'info', 'smtp', 'mail.sent', 'Outgoing message sent'
      from generate_series(1, 10001) as n`);
    const newest = await events.list({ limit: 1 });
    await events.cleanup();
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(applicationEvents);
    expect(count.count).toBe(10000);
    expect((await events.list({ limit: 1 })).events[0].id).toBe(
      newest.events[0].id,
    );
  });
  it("Phase 3E publishes only actual delta inserts, never recent/backfill, duplicate observations, flags or removals", async () => {
    await seed(1);
    const box = await mailbox();
    await db
      .update(mailboxes)
      .set({ backfillUidValidity: 10n, backfillFrontierUid: 1n })
      .where(eq(mailboxes.id, box.id));
    await messagesService.persistBatch(
      accountId,
      box.id,
      10n,
      [metadata(2)],
      undefined,
      { frontier: 1n, nextFrontier: 0n },
    );
    expect(await db.select().from(notificationEvents)).toEqual([]);
    await arrive(3);
    await arrive(3);
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.flagsBatch([{ uid: "3", flags: ["\\Seen"] }]);
      await sink.removed(["3"]);
    };
    await sync();
    const events = await db.select().from(notificationEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId,
      mailboxId: box.id,
      uidValidity: 10n,
      uid: 3n,
      subject: "Message 3",
    });
    expect(events[0]).not.toHaveProperty("plainText");
    expect(events[0]).not.toHaveProperty("snippet");
  });
  it("Phase 3E excludes empty recent-window bootstrap and only publishes arrivals beyond its frontier", async () => {
    const box = await mailbox();
    await db
      .update(mailboxes)
      .set({ recentSyncMessageCount: 0 })
      .where(eq(mailboxes.id, box.id));
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.newBatch([metadata(20)], "20");
      await sink.advanceUid("30");
      await sink.newBatch([metadata(31)], "31");
    };
    await sync();
    expect(
      (await db.select().from(notificationEvents)).map((e) => e.uid),
    ).toEqual([31n]);
  });
  it("Phase 3E never publishes before recent sync success or across UIDVALIDITY reset", async () => {
    const box = await mailbox();
    await db
      .update(mailboxes)
      .set({ recentSyncStatus: "pending" })
      .where(eq(mailboxes.id, box.id));
    await arrive(1);
    expect(await db.select().from(notificationEvents)).toEqual([]);
    await db
      .update(mailboxes)
      .set({ recentSyncStatus: "success" })
      .where(eq(mailboxes.id, box.id));
    runProvider = async (sink) => {
      await sink.selected("11");
      await sink.newBatch([metadata(2)], "2");
    };
    await sync();
    expect(await db.select().from(notificationEvents)).toEqual([]);
  });
  it("Phase 3E commits no event on metadata rollback and serializes duplicate persistence", async () => {
    const box = await mailbox();
    await db
      .update(mailboxes)
      .set({ deltaUidValidity: 10n })
      .where(eq(mailboxes.id, box.id));
    await expect(
      messagesService.persistBatch(
        accountId,
        box.id,
        10n,
        [metadata(1), { ...metadata(2), size: "invalid" }],
        2n,
        undefined,
        true,
      ),
    ).rejects.toThrow();
    expect(await db.select().from(notificationEvents)).toEqual([]);
    await Promise.all(
      [1, 2].map(() =>
        messagesService.persistBatch(
          accountId,
          box.id,
          10n,
          [metadata(1)],
          1n,
          undefined,
          true,
        ),
      ),
    );
    expect(await db.select().from(notificationEvents)).toHaveLength(1);
    expect(await placements()).toHaveLength(1);
  });
  it("Phase 3E suppresses known and uncertain Maildock move reconciliation and outgoing/Sent copies", async () => {
    await seed(1);
    const source = (await placements())[0];
    const boxId = await extraBox();
    await db.insert(messageCommands).values({
      id: randomUUID(),
      accountId,
      mailboxId: source.mailboxId,
      messageId: source.messageId,
      action: "archive",
      sourcePath: "INBOX",
      sourceUidValidity: 10n,
      sourceUid: 1n,
      destinationMailboxId: boxId,
      destinationPath: "Archive",
      destinationUidValidity: 10n,
      destinationUid: 5n,
      startedAt: new Date(),
      status: "succeeded",
    });
    await arrive(5, boxId);
    await db.insert(messageCommands).values({
      id: randomUUID(),
      accountId,
      mailboxId: source.mailboxId,
      messageId: source.messageId,
      action: "archive",
      sourcePath: "INBOX",
      sourceUidValidity: 10n,
      sourceUid: 1n,
      destinationMailboxId: boxId,
      destinationPath: "Archive",
      startedAt: new Date(),
      status: "failed",
    });
    await arrive(6, boxId, { ...metadata(1), uid: "6" });
    const sentId = "<maildock-outgoing@example.test>";
    await db.insert(outgoingMessages).values({
      id: randomUUID(),
      accountId,
      from: { address: "owner@example.test" },
      to: [{ address: "other@example.test" }],
      cc: [],
      bcc: [],
      subject: "Sent",
      plainText: "Private body",
      messageId: sentId,
      mimeBase64: "AA==",
    });
    await arrive(7, boxId, {
      ...metadata(7),
      envelope: { ...metadata(7).envelope, messageId: sentId },
    });
    expect(await db.select().from(notificationEvents)).toEqual([]);
    await arrive(8, boxId);
    expect(
      (await db.select().from(notificationEvents)).map((e) => e.uid),
    ).toEqual([8n]);
  });
  it("Phase 3E filters Inbox/all-folder and account preferences while durably consuming excluded and disabled events", async () => {
    const service = new NotificationService(db);
    expect(await service.preferences()).toEqual(defaultNotificationPreferences);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
    });
    const inbox = await mailbox();
    const archive = await extraBox();
    await arrive(1, inbox.id);
    await arrive(2, archive);
    expect((await service.consume()).events.map((e) => e.mailboxId)).toEqual([
      inbox.id,
    ]);
    expect((await new NotificationService(db).consume()).events).toEqual([]);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
      folders: "all",
    });
    await arrive(3, archive);
    expect((await service.consume()).events).toHaveLength(1);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
      folders: "all",
      accountIds: [],
    });
    await arrive(4, archive);
    expect((await service.consume()).events).toEqual([]);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
      accountIds: [accountId],
    });
    await arrive(5, inbox.id);
    expect((await service.consume()).events).toHaveLength(1);
    await service.setPreferences(defaultNotificationPreferences);
    await arrive(6, inbox.id);
    expect((await service.consume()).events).toEqual([]);
  });
  it("Phase 3E skips closed-tab history on start, arbitrates tabs, ignores stale/removed placements and cleans retention", async () => {
    const service = new NotificationService(db);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
    });
    await arrive(1);
    expect((await service.consume(true)).events).toEqual([]);
    expect((await service.consume()).events).toEqual([]);
    await arrive(2);
    const claims = await Promise.all([
      service.consume(),
      new NotificationService(db).consume(),
    ]);
    expect(claims.flatMap((c) => c.events)).toHaveLength(1);
    await arrive(3);
    await db.delete(mailboxMessages).where(eq(mailboxMessages.uid, 3n));
    expect((await service.consume()).events).toEqual([]);
    await arrive(4);
    await db
      .update(notificationEvents)
      .set({ createdAt: new Date(Date.now() - 180_000) });
    expect((await service.consume()).events).toEqual([]);
    await db
      .update(notificationEvents)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
    await service.consume();
    expect(await db.select().from(notificationEvents)).toEqual([]);
  });
  it("Phase 3E preserves account isolation for identical mailbox UIDs and excludes disabled accounts", async () => {
    const secondAccount = randomUUID();
    const [owner] = await db.select().from(mailAccounts);
    await db.insert(mailAccounts).values({
      ...owner,
      id: secondAccount,
      email: "second@example.test",
      displayName: "Second",
    });
    const firstBox = await mailbox();
    const secondBox = randomUUID();
    await db.insert(mailboxes).values({
      ...firstBox,
      id: secondBox,
      accountId: secondAccount,
      deltaUidValidity: 10n,
    });
    const service = new NotificationService(db);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
      accountIds: [accountId],
    });
    await arrive(1, firstBox.id);
    await messagesService.persistBatch(
      secondAccount,
      secondBox,
      10n,
      [metadata(1)],
      1n,
      undefined,
      true,
    );
    expect(await db.select().from(notificationEvents)).toHaveLength(2);
    expect((await service.consume()).events.map((e) => e.accountId)).toEqual([
      accountId,
    ]);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
    });
    await messagesService.persistBatch(
      secondAccount,
      secondBox,
      10n,
      [metadata(2)],
      2n,
      undefined,
      true,
    );
    await db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, secondAccount));
    expect((await service.consume()).events).toEqual([]);
    await expect(
      messagesService.persistBatch(
        accountId,
        secondBox,
        10n,
        [metadata(3)],
        3n,
        undefined,
        true,
      ),
    ).rejects.toThrow("Mailbox not found");
  });
  it("Phase 3E drains bounded batches without losing the remaining checkpoint range", async () => {
    const box = await mailbox();
    const service = new NotificationService(db);
    await service.setPreferences({
      ...defaultNotificationPreferences,
      enabled: true,
    });
    await db
      .update(mailboxes)
      .set({ deltaUidValidity: 10n })
      .where(eq(mailboxes.id, box.id));
    await messagesService.persistBatch(
      accountId,
      box.id,
      10n,
      Array.from({ length: 60 }, (_, i) => metadata(i + 1)),
      60n,
      undefined,
      true,
    );
    const first = await service.consume();
    const second = await new NotificationService(db).consume();
    expect(first.events).toHaveLength(50);
    expect(second.events).toHaveLength(10);
    expect(
      new Set([...first.events, ...second.events].map((e) => e.id)).size,
    ).toBe(60);
    expect((await service.consume()).events).toEqual([]);
  });

  it("bootstraps maximum local UID only from the current epoch and checkpoints a committed batch", async () => {
    await seed(3);
    await seed(9);
    await seed(100, 9n);
    let snapshot:
      Awaited<ReturnType<DeltaMailboxSyncSink["selected"]>> | undefined;
    runProvider = async (sink) => {
      snapshot = await sink.selected("10");
      await sink.newBatch([metadata(10)], "10");
      await sink.completed({
        uidNext: "11",
        messageCount: "3",
        unseenCount: "0",
        highestModseq: null,
        condstore: false,
      });
    };
    await sync();
    expect(snapshot).toMatchObject({ lastSeenUid: "9", localUids: ["3", "9"] });
    expect((await mailbox()).deltaLastSeenUid).toBe(10n);
    expect(
      (await placements()).map((row) => [row.uidValidity, row.uid]),
    ).toEqual([
      [10n, 3n],
      [10n, 9n],
      [10n, 10n],
      [9n, 100n],
    ]);
    expect((await mailbox()).deltaSyncStatus).toBe("success");
  });

  it("keeps an empty bootstrap uncheckpointed until the final frontier and repeats after a crash", async () => {
    await db
      .update(mailboxes)
      .set({ recentSyncMessageCount: 0 })
      .where(eq(mailboxes.id, (await mailbox()).id));
    const snapshots: unknown[] = [];
    runProvider = async (sink) => {
      snapshots.push(await sink.selected("10"));
      await sink.newBatch([metadata(50)], "50");
      throw new Error("crash before frontier");
    };
    await expect(sync()).rejects.toThrow("crash before frontier");
    expect((await mailbox()).deltaLastSeenUid).toBeNull();
    expect((await placements()).map((row) => row.uid)).toEqual([50n]);
    runProvider = async (sink) => {
      snapshots.push(await sink.selected("10"));
      await sink.newBatch([metadata(50)], "50");
      await sink.advanceUid("70");
      await sink.completed({
        uidNext: "71",
        messageCount: "1",
        unseenCount: "0",
        highestModseq: null,
        condstore: false,
      });
    };
    await sync();
    expect(snapshots).toEqual([
      {
        lastSeenUid: "0",
        highestModseq: null,
        localUids: [],
        emptyBootstrapCutoff: cutoff,
      },
      {
        lastSeenUid: "50",
        highestModseq: null,
        localUids: ["50"],
        emptyBootstrapCutoff: cutoff,
      },
    ]);
    expect((await placements()).map((row) => row.uid)).toEqual([50n]);
    expect((await mailbox()).deltaLastSeenUid).toBe(70n);
  });

  it("resets UIDVALIDITY, removes old placements, and requests a recent rebuild", async () => {
    await seed(8);
    await db
      .update(mailboxes)
      .set({
        deltaUidValidity: 10n,
        deltaLastSeenUid: 8n,
        deltaHighestModseq: 20n,
      })
      .where(eq(mailboxes.id, (await mailbox()).id));
    const attempted = vi.fn();
    runProvider = async (sink) => {
      await sink.selected("11");
      attempted();
    };
    await sync();
    expect(attempted).not.toHaveBeenCalled();
    expect(await placements()).toEqual([]);
    expect(await mailbox()).toMatchObject({
      uidValidity: 11n,
      recentSyncUidValidity: 11n,
      deltaUidValidity: null,
      deltaLastSeenUid: null,
      deltaHighestModseq: null,
      recentSyncStatus: "pending",
    });
    expect(recentRequests).toEqual([(await mailbox()).id]);
    await seed(8, 11n, ["\\Flagged"]);
    expect(
      (await placements()).map((row) => [row.uidValidity, row.uid, row.flags]),
    ).toEqual([[11n, 8n, ["\\Flagged"]]]);
  });

  it("persists added and removed Seen, Flagged, and custom flags while rejecting stale MODSEQ", async () => {
    await seed(1, 10n, ["\\Seen"], 10n);
    await seed(2, 10n, ["\\Seen", "custom"], 30n);
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.flagsBatch([
        { uid: "1", flags: ["\\Flagged", "custom"], modseq: "20" },
        { uid: "2", flags: ["\\Flagged"], modseq: "20" },
      ]);
      await sink.completed({
        uidNext: "3",
        messageCount: "2",
        unseenCount: "1",
        highestModseq: "40",
        condstore: true,
      });
    };
    await sync();
    expect((await placements()).map((row) => [row.flags, row.modseq])).toEqual([
      [["\\Flagged", "custom"], 20n],
      [["\\Seen", "custom"], 30n],
    ]);
    expect((await mailbox()).deltaHighestModseq).toBe(40n);
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.flagsBatch([
        { uid: "1", flags: ["\\Seen", "\\Flagged", "custom"], modseq: "41" },
      ]);
      throw new Error("later provider failure");
    };
    await expect(sync()).rejects.toThrow();
    expect((await placements())[0]?.flags).toEqual([
      "\\Seen",
      "\\Flagged",
      "custom",
    ]);
    expect((await mailbox()).deltaHighestModseq).toBe(40n);
    expect((await mailbox()).deltaSyncStatus).toBe("failed");
  });

  it("leaves prior state on provider failure and retries a committed batch idempotently", async () => {
    await seed(1);
    await db
      .update(mailboxes)
      .set({ deltaUidValidity: 10n, deltaLastSeenUid: 1n })
      .where(eq(mailboxes.id, (await mailbox()).id));
    runProvider = async (sink) => {
      await sink.selected("10");
      throw new Error("provider unavailable");
    };
    await expect(sync()).rejects.toThrow();
    expect((await placements()).map((row) => row.uid)).toEqual([1n]);
    expect((await mailbox()).deltaLastSeenUid).toBe(1n);
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.newBatch([metadata(2)], "2");
      throw new Error("later batch failed");
    };
    await expect(sync()).rejects.toThrow();
    expect((await mailbox()).deltaLastSeenUid).toBe(2n);
    expect((await placements()).map((row) => row.uid)).toEqual([1n, 2n]);
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.newBatch([metadata(2)], "2");
      await sink.completed({
        uidNext: "3",
        messageCount: "2",
        unseenCount: "0",
        highestModseq: null,
        condstore: false,
      });
    };
    await sync();
    expect((await placements()).map((row) => row.uid)).toEqual([1n, 2n]);
    expect((await mailbox()).deltaSyncStatus).toBe("success");
    expect((await mailbox()).deltaLastSeenUid).toBe(2n);
  });

  it("rolls back a failed metadata batch together with its UID checkpoint", async () => {
    await seed(1);
    await db
      .update(mailboxes)
      .set({ deltaUidValidity: 10n, deltaLastSeenUid: 1n })
      .where(eq(mailboxes.id, (await mailbox()).id));
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.newBatch(
        [metadata(2), { ...metadata(3), uid: "invalid" }],
        "3",
      );
    };
    await expect(sync()).rejects.toThrow();
    expect((await placements()).map((row) => row.uid)).toEqual([1n]);
    expect((await mailbox()).deltaLastSeenUid).toBe(1n);
    expect((await mailbox()).deltaSyncStatus).toBe("failed");
  });

  it("removes only confirmed known placements", async () => {
    await seed(1);
    await seed(2);
    await seed(3);
    runProvider = async (sink) => {
      await sink.selected("10");
      await sink.removed(["2"]);
      await sink.completed({
        uidNext: "4",
        messageCount: "2",
        unseenCount: "0",
        highestModseq: null,
        condstore: false,
      });
    };
    await sync();
    expect((await placements()).map((row) => row.uid)).toEqual([1n, 3n]);
  });

  it("polls only enabled, initialized, selectable, active mailboxes", async () => {
    const service = new MailboxService(db);
    await service.reconcile(accountId, [
      {
        remotePath: "INBOX",
        name: "INBOX",
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: ["\\Inbox"],
      },
      {
        remotePath: "Archive",
        name: "Archive",
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: [],
      },
      {
        remotePath: "Container",
        name: "Container",
        delimiter: "/",
        attributes: [],
        selectable: false,
        specialUse: [],
      },
      {
        remotePath: "Old",
        name: "Old",
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: [],
      },
    ]);
    const rows = await db.select().from(mailboxes);
    const archive = rows.find((row) => row.remotePath === "Archive")!;
    const old = rows.find((row) => row.remotePath === "Old")!;
    await db
      .update(mailboxes)
      .set({ recentSyncStatus: "success", lifecycleStatus: "missing" })
      .where(eq(mailboxes.id, old.id));
    const sent: string[] = [];
    const boss = {
      getDb: () => ({
        beginTransaction: async () => ({
          db: { executeSql: async () => ({ rows: [] }) },
          commit: async () => {},
          rollback: async () => {},
        }),
      }),
      findJobs: async () => [],
      send: async (_queue: string, data: { mailboxId: string }) => {
        sent.push(data.mailboxId);
        return "job";
      },
    } as unknown as PgBoss;
    const poller = new DeltaPoller(db, boss, 60);
    await poller.start();
    poller.stop();
    expect(sent).toEqual([rows.find((row) => row.remotePath === "INBOX")!.id]);
    await db
      .update(mailboxes)
      .set({ recentSyncStatus: "success" })
      .where(eq(mailboxes.id, archive.id));
    await db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    sent.length = 0;
    await poller.start();
    poller.stop();
    expect(sent).toEqual([]);
  });

  it("starts no watcher for disabled, nonselectable, missing, or uninitialized mailboxes", async () => {
    await db
      .update(mailAccounts)
      .set({ imapCapabilities: ["IDLE"] })
      .where(eq(mailAccounts.id, accountId));
    const id = (await mailbox()).id;
    const noClient = vi.fn(() => {
      throw new Error("ineligible mailbox opened a client");
    });
    const boss = { send: async () => "job" } as unknown as PgBoss;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const check = async () => {
      const manager = new IdleWatcherManager(
        db,
        accounts,
        boss,
        logger,
        noClient,
      );
      await manager.start();
      await manager.stop();
      expect(noClient).not.toHaveBeenCalled();
    };
    await db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    await check();
    await db
      .update(mailAccounts)
      .set({ enabled: true })
      .where(eq(mailAccounts.id, accountId));
    await db
      .update(mailboxes)
      .set({ selectable: false })
      .where(eq(mailboxes.id, id));
    await check();
    await db
      .update(mailboxes)
      .set({ selectable: true, lifecycleStatus: "missing" })
      .where(eq(mailboxes.id, id));
    await check();
    await db
      .update(mailboxes)
      .set({ lifecycleStatus: "active", recentSyncStatus: "not_started" })
      .where(eq(mailboxes.id, id));
    await check();
  });

  it("serializes recent and delta work through the shared advisory lock namespace", async () => {
    const withLock = createMailboxLock(database.client);
    const id = (await mailbox()).id;
    let release!: () => void;
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = withLock(id, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await hasEntered;
    await expect(
      withLock(id, async () => {
        throw new Error("must not enter");
      }),
    ).rejects.toThrow("Mailbox sync is already running.");
    release();
    await running;
    const resumed = vi.fn();
    await withLock(id, async () => {
      resumed();
    });
    expect(resumed).toHaveBeenCalledOnce();
  });
});
