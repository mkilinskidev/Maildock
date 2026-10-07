import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

import { AccountsService } from "@/modules/accounts/application/accounts-service";
import type {
  BackfillMailboxSyncSink,
  MailProvider,
  RemoteMessageMetadata,
} from "@/modules/accounts/domain/mail-provider";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MessageService } from "@/modules/mail/application/message-service";
import { BackfillSyncService } from "@/modules/mail/application/backfill-sync-service";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
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

const accountId = "00000000-0000-4000-8000-0000000000a1";
function metadata(uid: number): RemoteMessageMetadata {
  return {
    uid: String(uid),
    internalDate: "2025-01-01T00:00:00Z",
    size: "1",
    flags: [],
    envelope: {
      subject: `Old ${uid}`,
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

describe("Phase 1G persisted backfill", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let db: Database;
  let accounts: AccountsService;
  let service: BackfillSyncService;
  let messagesService: MessageService;
  let remote: number[];
  let epoch: string;
  let fail = false;
  let requestedRecent = 0;
  let requestedBackfill = 0;

  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_phase1g",
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
      url = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_phase1g`;
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
    db = database.db;
    await migrate(db, { migrationsFolder: "db/migrations" });
    const provider: MailProvider = {
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
      listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
      synchronizeRecentMailbox: async (_account, _request, sink) => {
        await sink.selected(epoch);
        await sink.batch([]);
        return { uidValidity: epoch, messageCount: 0 };
      },
      synchronizeBackfillMailbox: async (
        _account,
        request,
        sink: BackfillMailboxSyncSink,
      ) => {
        const frontier =
          request.frontier === null ? 10n : BigInt(request.frontier);
        await sink.selected(epoch, frontier.toString());
        if (frontier === 0n) {
          await sink.chunk([], "0");
          return;
        }
        const lower =
          frontier - BigInt(request.chunkSize) + 1n > 1n
            ? frontier - BigInt(request.chunkSize) + 1n
            : 1n;
        if (fail) throw new Error("fetch failed");
        await sink.chunk(
          remote
            .filter((uid) => BigInt(uid) >= lower && BigInt(uid) <= frontier)
            .map(metadata),
          (lower - 1n).toString(),
        );
      },
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
    messagesService = new MessageService(
      db,
      accounts,
      provider,
      config,
      {
        schedule: async () => {
          requestedRecent++;
          return true;
        },
      },
      undefined,
      {
        schedule: async () => {
          requestedBackfill++;
          return true;
        },
      },
    );
    service = new BackfillSyncService(
      db,
      accounts,
      provider,
      messagesService,
      4,
    );
  });

  beforeEach(async () => {
    await db.delete(mailAccounts);
    remote = [1, 9];
    epoch = "10";
    fail = false;
    requestedRecent = 0;
    requestedBackfill = 0;
    await accounts.create({
      id: accountId,
      displayName: "Phase 1G",
      email: "phase1g@example.test",
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
    await db
      .update(mailboxes)
      .set({
        recentSyncStatus: "success",
        recentSyncUidValidity: 10n,
        recentSyncMessageCount: 0,
      })
      .where(eq(mailboxes.accountId, accountId));
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });
  async function mailbox() {
    return (await db.select().from(mailboxes))[0]!;
  }
  async function uids() {
    return (await db.select().from(mailboxMessages))
      .map((row) => row.uid)
      .sort((a, b) => Number(a - b));
  }
  async function run() {
    return service.run(accountId, (await mailbox()).id);
  }

  it("commits sparse history progressively, retries idempotently, and completes", async () => {
    expect(await run()).toBe("6");
    expect(await uids()).toEqual([9n]);
    expect(
      (await new MailboxService(db).listForAccount(accountId))[0]
        ?.synchronizedMessageCount,
    ).toBe("1");
    expect((await mailbox()).backfillFrontierUid).toBe(6n);
    expect(await run()).toBe("2");
    expect(await uids()).toEqual([9n]);
    fail = true;
    await expect(run()).rejects.toThrow("fetch failed");
    expect((await mailbox()).backfillFrontierUid).toBe(2n);
    fail = false;
    expect(await run()).toBeNull();
    expect(await uids()).toEqual([1n, 9n]);
    expect(
      (await new MailboxService(db).listForAccount(accountId))[0]
        ?.synchronizedMessageCount,
    ).toBe("2");
    expect((await mailbox()).backfillStatus).toBe("complete");
    expect(await run()).toBeNull();
    expect(await uids()).toEqual([1n, 9n]);
  });

  it("schedules after recent initialization and rolls back an uncheckpointed batch", async () => {
    const id = (await mailbox()).id;
    await messagesService.runRecentSync(accountId, id);
    expect(requestedBackfill).toBe(1);
    expect((await mailbox()).backfillStatus).toBe("pending");
    await expect(
      messagesService.persistBatch(
        accountId,
        id,
        10n,
        [metadata(3)],
        undefined,
        { frontier: 99n, nextFrontier: 0n },
      ),
    ).rejects.toThrow("checkpoint changed");
    expect(await uids()).toEqual([]);
  });

  it("completes an empty mailbox and stops for disabled or missing mailboxes", async () => {
    remote = [];
    await run();
    await run();
    await run();
    expect((await mailbox()).backfillStatus).toBe("complete");
    await db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    expect(await run()).toBeNull();
    await db
      .update(mailAccounts)
      .set({ enabled: true })
      .where(eq(mailAccounts.id, accountId));
    await db
      .update(mailboxes)
      .set({ lifecycleStatus: "missing", backfillStatus: "pending" });
    expect(await run()).toBeNull();
  });

  it("invalidates an old epoch and requests recent recovery", async () => {
    await run();
    epoch = "11";
    expect(await run()).toBeNull();
    expect(requestedRecent).toBe(1);
    expect((await mailbox()).backfillStatus).toBe("not_started");
  });

  it("uses the shared mailbox advisory lock for delta and backfill", async () => {
    const withLock = createMailboxLock(database.client);
    const id = (await mailbox()).id;
    let release!: () => void;
    let entered!: () => void;
    const active = withLock(id, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await new Promise<void>((resolve) => {
      entered = resolve;
    });
    await expect(
      withLock(id, async () => {
        await service.run(accountId, id);
      }),
    ).rejects.toThrow("Mailbox sync is already running.");
    release();
    await active;
    expect(
      await withLock(id, async () => {
        await service.run(accountId, id);
      }),
    ).toBeUndefined();
  });
});
