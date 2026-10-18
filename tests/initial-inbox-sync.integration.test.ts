// Never uses DATABASE_URL or TEST_DATABASE_URL. Only a newly created disposable DB.
import { randomUUID } from "node:crypto";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss } from "pg-boss";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
} from "@/shared/infrastructure/database/schema";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MailboxDiscoveryService } from "@/modules/mail/application/mailbox-discovery-service";
import { MessageService } from "@/modules/mail/application/message-service";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import type {
  MailProvider,
  RecentMailboxSyncSink,
  RemoteMailbox,
} from "@/modules/accounts/domain/mail-provider";
import {
  enqueueRecent,
  registerRecentSyncWorker,
  MAILBOX_RECENT_SYNC_QUEUE as queue,
} from "@/modules/mail/infrastructure/recent-sync-jobs";
import {
  DeltaPoller,
  ensureDeltaQueue,
} from "@/modules/mail/infrastructure/delta-sync-jobs";

describe("initial INBOX with isolated PostgreSQL, pg-boss and fake IMAP", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let accountId: string;
  let service: MessageService;
  let accounts: AccountsService;
  let provider: MailProvider;
  let handler: (batch: { data: unknown }[]) => Promise<void>;
  let listing: RemoteMailbox[];
  let starts: string[];
  let sync: (sink: RecentMailboxSyncSink) => Promise<void>;
  const remote = (remotePath: string, selectable = true): RemoteMailbox => ({
    remotePath,
    name: remotePath === "INBOX" ? "Misleading display name" : "INBOX",
    delimiter: "/",
    attributes: [],
    specialUse: [],
    selectable,
  });
  const payload = (mailboxId: string) => [
    { data: { version: 1, accountId, mailboxId } },
  ];
  const rows = () =>
    database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, accountId));
  const box = async (path: string) =>
    (await rows()).find((row) => row.remotePath === path)!;
  const write = async (
    path: string,
    values: Partial<typeof mailboxes.$inferInsert>,
  ) =>
    database.db
      .update(mailboxes)
      .set(values)
      .where(eq(mailboxes.id, (await box(path)).id));
  const jobList = (id: string) => boss.findJobs(queue, { key: id });
  const makeService = (
    schedule = (account: string, mailbox: string) =>
      enqueueRecent(boss, account, mailbox),
  ) =>
    new MessageService(
      database.db,
      accounts,
      provider,
      { initialSyncDays: 30, messageFetchBatchSize: 150 },
      { schedule },
    );
  const discover = () =>
    new MailboxDiscoveryService(
      database.db,
      accounts,
      provider,
      new MailboxService(database.db),
      service,
    ).run(accountId);

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "inbox_isolated",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const databaseUrl = `postgresql://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/inbox_isolated`;
    database = createDatabase({ databaseUrl, databasePoolSize: 5 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    await ensureDeltaQueue(boss);
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    accountId = randomUUID();
    starts = [];
    listing = [remote("Archive"), remote("INBOX")];
    sync = async (sink) => {
      await sink.selected("7");
    };
    accounts = {
      getProviderImapAccountForWork: async () => {
        const [account] = await database.db
          .select()
          .from(mailAccounts)
          .where(eq(mailAccounts.id, accountId));
        if (!account.enabled) throw new Error("Disabled fixture account");
        return {
          accountId,
          imap: {
            host: "imap.invalid",
            port: 993,
            security: "tls",
            username: "fixture",
            credential: { kind: "password", password: "fixture" },
          },
        };
      },
    } as unknown as AccountsService;
    provider = {
      testConnection: async () => {
        throw new Error("Forbidden fixture connection test");
      },
      fetchMessageContent: async () => {
        throw new Error("Forbidden fixture body fetch");
      },
      listMailboxes: async () => ({ mailboxes: listing, capabilities: [] }),
      synchronizeRecentMailbox: async (_account, request, sink) => {
        starts.push(request.remotePath);
        await sync(sink);
        return { uidValidity: "7", messageCount: 0 };
      },
    };
    await database.db.insert(mailAccounts).values({
      id: accountId,
      displayName: "Fixture",
      email: "fixture@example.invalid",
      imapHost: "imap.invalid",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: { fixture: true } as never,
      smtpHost: "smtp.invalid",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    service = makeService();
    // Capture the real worker handler without starting background consumers.
    await registerRecentSyncWorker(
      {
        createQueue: (...args: Parameters<PgBoss["createQueue"]>) =>
          boss.createQueue(...args),
        getDb: () => boss.getDb(),
        findJobs: (...args: Parameters<PgBoss["findJobs"]>) =>
          boss.findJobs(...args),
        send: (...args: Parameters<PgBoss["send"]>) => boss.send(...args),
        work: async (
          _name: string,
          _options: unknown,
          callback: typeof handler,
        ) => {
          // Direct calls stand for a worker that claimed this mailbox's queued
          // job; otherwise it would still look like waiting INBOX-first work.
          handler = async (batch) => {
            const { mailboxId } = batch[0].data as { mailboxId: string };
            await boss.getDb().executeSql(
              `UPDATE pgboss.job SET state = 'completed', completed_on = now()
                  WHERE name = $1 AND singleton_key = $2
                    AND state IN ('created', 'retry')`,
              [queue, mailboxId],
            );
            return callback(batch);
          };
        },
      } as unknown as PgBoss,
      service,
      2,
    );
  });

  it("enqueues INBOX first even when listed last; prevents another concurrent IMAP start until its first attempt ends", async () => {
    const enqueued: string[] = [];
    service = makeService(async (account, id) => {
      enqueued.push(id);
      return enqueueRecent(boss, account, id);
    });
    await discover();
    const inbox = await box("INBOX");
    const archive = await box("Archive");
    expect(enqueued).toEqual([inbox.id, archive.id]);
    expect((await jobList(inbox.id))[0].priority).toBe(20);
    expect((await jobList(archive.id))[0].priority).toBe(10);
    await handler(payload(archive.id));
    expect(starts).toEqual([]);
    let release!: () => void;
    sync = async (sink) => {
      await sink.selected("7");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const running = handler(payload(inbox.id));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await handler(payload(archive.id));
    expect(starts).toEqual(["INBOX"]);
    release();
    await running;
    sync = async (sink) => {
      await sink.selected("7");
    };
    await handler(payload(archive.id));
    expect(starts).toEqual(["INBOX", "Archive"]);
  });

  it.each([
    "empty",
    "failed",
    "missing",
    "nonselectable",
    "absent",
    "disabled",
  ])("releases other folders for %s INBOX/account", async (kind) => {
    if (kind === "absent") listing = [remote("Archive")];
    if (kind === "nonselectable")
      listing = [remote("Archive"), remote("INBOX", false)];
    await discover();
    const archive = await box("Archive");
    if (kind === "missing")
      await write("INBOX", { lifecycleStatus: "missing" });
    if (kind === "disabled")
      await database.db
        .update(mailAccounts)
        .set({ enabled: false })
        .where(eq(mailAccounts.id, accountId));
    if (kind === "empty" || kind === "failed") {
      if (kind === "failed")
        sync = async () => {
          throw new Error("fixture failure");
        };
      if (kind === "failed")
        await expect(
          handler(payload((await box("INBOX")).id)),
        ).rejects.toThrow();
      else await handler(payload((await box("INBOX")).id));
    }
    expect(await service.shouldDeferInitialRecent(accountId, archive.id)).toBe(
      false,
    );
    if (kind !== "disabled") {
      sync = async (sink) => {
        await sink.selected("7");
      };
      await handler(payload(archive.id));
      expect(starts).toContain("Archive");
    }
  });

  it.each(["pending", "running"])(
    "uses a fixed deadline after restart and repeated %s requests",
    async (status) => {
      await discover();
      const archive = await box("Archive");
      await write("INBOX", {
        recentSyncStatus: status,
        firstDiscoveredAt: new Date(Date.now() - 30_000),
      });
      const restarted = makeService();
      expect(
        await restarted.shouldDeferInitialRecent(accountId, archive.id),
      ).toBe(true);
      await restarted.requestRecentSync(accountId, (await box("INBOX")).id);
      await write("INBOX", {
        firstDiscoveredAt: new Date(Date.now() - 61_000),
        recentSyncStartedAt: new Date(),
        recentSyncRequestedAt: new Date(),
      });
      expect(
        await makeService().shouldDeferInitialRecent(accountId, archive.id),
      ).toBe(false);
      // A slot claimed the INBOX job: running INBOX no longer blocks admission
      // once the initial deadline passed (a ready, unclaimed one would).
      await boss.getDb().executeSql(
        `UPDATE pgboss.job SET state = 'active', started_on = now()
            WHERE name = $1 AND singleton_key = $2 AND state = 'created'`,
        [queue, (await box("INBOX")).id],
      );
      await handler(payload(archive.id));
      expect(starts).toEqual(["Archive"]);
    },
  );

  it("does not restore protection when a failed first attempt enters retry", async () => {
    await discover();
    await write("INBOX", {
      recentSyncStatus: "running",
      recentSyncCompletedAt: new Date(),
    });
    expect(
      await service.shouldDeferInitialRecent(
        accountId,
        (await box("Archive")).id,
      ),
    ).toBe(false);
  });

  it("reports enqueue failures, schedules remaining folders and repairs missing jobs without duplicates", async () => {
    service = makeService(async () => {
      throw new Error("fixture enqueue unavailable");
    });
    await expect(discover()).rejects.toThrow("scheduling failed");
    expect(
      (await rows()).every((row) => row.recentSyncStatus === "failed"),
    ).toBe(true);
    const poller = new DeltaPoller(database.db, boss, 300);
    await poller.start();
    poller.stop();
    await poller.start();
    poller.stop();
    for (const row of await rows())
      expect(await jobList(row.id)).toHaveLength(1);
    expect(
      await service.shouldDeferInitialRecent(
        accountId,
        (await box("Archive")).id,
      ),
    ).toBe(false);
  });

  it("never overwrites fast worker success or running state after producer enqueue", async () => {
    await new MailboxService(database.db).reconcile(accountId, listing);
    const inbox = await box("INBOX");
    for (const state of ["running", "success"] as const) {
      await write("INBOX", { recentSyncStatus: "not_started" });
      const fast = makeService(async () => {
        if (state === "success")
          await service.runRecentSync(accountId, inbox.id);
        else await write("INBOX", { recentSyncStatus: "running" });
        return true;
      });
      await fast.requestRecentSync(accountId, inbox.id);
      expect((await box("INBOX")).recentSyncStatus).toBe(state);
    }
  });

  it("does not overwrite worker success when enqueue subsequently rejects", async () => {
    await new MailboxService(database.db).reconcile(accountId, listing);
    const inbox = await box("INBOX");
    const fast = makeService(async () => {
      await service.runRecentSync(accountId, inbox.id);
      throw new Error("fixture enqueue response lost");
    });
    await expect(fast.requestRecentSync(accountId, inbox.id)).rejects.toThrow();
    expect((await box("INBOX")).recentSyncStatus).toBe("success");
  });

  it("fails the current job if a durable deferred successor cannot be committed", async () => {
    await new MailboxService(database.db).reconcile(accountId, listing);
    const id = (await box("Archive")).id;
    await enqueueRecent(boss, accountId, id);
    const [job] = await jobList(id);
    await boss
      .getDb()
      .executeSql(
        "UPDATE pgboss.job SET state = 'active', started_on = now() WHERE name = $1 AND id = $2",
        [queue, job.id],
      );
    const send = vi
      .spyOn(boss, "send")
      .mockRejectedValueOnce(new Error("fixture send failure"));
    try {
      await expect(handler(payload(id))).rejects.toThrow("Maildock job failed");
    } finally {
      send.mockRestore();
    }
    expect(starts).toEqual([]);
    await boss.fail(queue, job.id);
    expect((await jobList(id))[0].state).toBe("retry");
    expect(await enqueueRecent(boss, accountId, id, "repair")).toBe(false);
  });

  it("repairs orphaned running initial sync after worker restart without extending protection", async () => {
    await new MailboxService(database.db).reconcile(accountId, listing);
    await write("INBOX", {
      recentSyncStatus: "running",
      firstDiscoveredAt: new Date(Date.now() - 61_000),
    });
    const poller = new DeltaPoller(database.db, boss, 300);
    await poller.start();
    poller.stop();
    const inbox = await box("INBOX");
    expect(await jobList(inbox.id)).toHaveLength(1);
    expect(
      await makeService().shouldDeferInitialRecent(
        accountId,
        (await box("Archive")).id,
      ),
    ).toBe(false);
  });

  it("commits the first batch while the fake provider still runs and keeps it after a later failure", async () => {
    await new MailboxService(database.db).reconcile(accountId, listing);
    const inbox = await box("INBOX");
    let release!: () => void;
    sync = async (sink) => {
      await sink.selected("7");
      await sink.batch([
        {
          uid: "99",
          internalDate: new Date().toISOString(),
          size: "1",
          flags: [],
          envelope: {
            subject: "Fixture first batch",
            from: [],
            sender: [],
            replyTo: [],
            to: [],
            cc: [],
            bcc: [],
          },
          hasAttachments: false,
        },
      ]);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("fixture later batch failure");
    };
    const running = service.runRecentSync(accountId, inbox.id);
    const failure = expect(running).rejects.toThrow(
      "fixture later batch failure",
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await box("INBOX")).recentSyncStatus).toBe("running");
    expect((await service.list(accountId, inbox.id, 50)).items).toHaveLength(1);
    release();
    await failure;
    expect(
      await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.mailboxId, inbox.id)),
    ).toHaveLength(1);
  });

  it("coalesces producers, preserves retry and commits a deferred successor before acknowledging active work", async () => {
    await new MailboxService(database.db).reconcile(accountId, listing);
    const id = (await box("Archive")).id;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enqueueRecent(boss, accountId, id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const active = (
      await boss.fetch<{ mailboxId: string }>(queue, { batchSize: 1000 })
    ).find((job) => job.data.mailboxId === id)!;
    expect(active).toBeDefined();
    expect(await enqueueRecent(boss, accountId, id, "repair")).toBe(false);
    await handler(payload(id));
    const jobs = await jobList(id);
    expect(jobs.filter((job) => job.state === "created")).toHaveLength(1);
    expect(
      new Date(
        jobs.find((job) => job.state === "created")!.startAfter,
      ).getTime(),
    ).toBeGreaterThan(Date.now());
    await boss.fail(queue, active.id);
    const retry = (await jobList(id)).find((job) => job.state === "retry")!;
    expect(retry).toBeDefined();
    expect(await enqueueRecent(boss, accountId, id)).toBe(false);
    expect((await jobList(id)).find((job) => job.id === retry.id)).toEqual(
      retry,
    );
  });
});
