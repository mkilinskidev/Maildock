import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
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
    delta = new DeltaSyncService(db, accounts, provider, messagesService, 2);
  });

  beforeEach(async () => {
    await db.delete(mailAccounts);
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
