// Stage 3: cooperative preemption of an already running history backfill.
// Never uses DATABASE_URL or TEST_DATABASE_URL: a disposable PostgreSQL
// container with its own pg-boss, the real mailbox advisory lock, the real
// IMAP provider over a fake ImapFlow client, the real BackfillSyncService and
// the real MessageService.persistBatch transaction. No network, no real IMAP.
import { randomUUID } from "node:crypto";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss, type Job } from "pg-boss";
import type { FetchMessageObject } from "imapflow";
import type { Logger } from "pino";
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
  messageAttachments,
  messageCommands,
  messages,
} from "@/shared/infrastructure/database/schema";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type {
  ProviderImapAccount,
  RemoteMailbox,
} from "@/modules/accounts/domain/mail-provider";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MessageService } from "@/modules/mail/application/message-service";
import { BackfillSyncService } from "@/modules/mail/application/backfill-sync-service";
import {
  BackfillPoller,
  enqueueBackfill,
  registerBackfillWorker,
  MAILBOX_BACKFILL_SYNC_QUEUE as BACKFILL,
} from "@/modules/mail/infrastructure/backfill-sync-jobs";
import {
  enqueueDelta,
  MAILBOX_DELTA_SYNC_QUEUE as DELTA,
} from "@/modules/mail/infrastructure/delta-sync-jobs";
import { MAILBOX_RECENT_SYNC_QUEUE as RECENT } from "@/modules/mail/infrastructure/recent-sync-jobs";
import {
  ensureContentQueue,
  MESSAGE_CONTENT_QUEUE as CONTENT,
} from "@/modules/mail/infrastructure/content-jobs";
import {
  ATTACHMENT_QUEUE as ATTACHMENT,
  ensureAttachmentQueue,
} from "@/modules/mail/infrastructure/attachment-jobs";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
import { interactiveFetchWaiting } from "@/modules/mail/infrastructure/sync-admission";

type Handler = (jobs: Job<unknown>[]) => Promise<void>;
type Account = { id: string; box: Record<string, string> };

const PATHS = ["INBOX", "Archive"];
/** One job covers 10 UIDs in sub-batches of 3: [8,10] [5,7] [2,4] [1,1]. */
const CHUNK = 10;
const SUB_BATCH = 3;

const imapAccount: ProviderImapAccount = {
  accountId: "00000000-0000-4000-8000-000000000001",
  imap: {
    host: "imap.invalid",
    port: 993,
    security: "tls",
    username: "fixture",
    credential: { kind: "password", password: "fixture" },
  },
};

describe("cooperative backfill preemption with isolated PostgreSQL and pg-boss", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let lock: ReturnType<typeof createMailboxLock>;
  let service: BackfillSyncService;
  let handler: Handler;
  let a: Account;
  let b: Account;

  // Fake IMAP server state, reset per test.
  let remote: number[];
  let uidValidity: bigint;
  let log: string[];
  let fetches: number;
  let searches: number;
  let onFetch: (n: number) => Promise<void>;
  let onSearch: (n: number) => Promise<void>;
  let failFetch: number | null;
  let failGate: boolean;
  let failSend: boolean;
  let recentRequests: number;
  let logged: { level: string; fields: Record<string, unknown> }[];

  const factory: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {
        log.push("connect");
      },
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity, uidNext: 11 }),
      mailboxClose: async () => {
        log.push("close");
        return true;
      },
      logout: async () => {
        log.push("logout");
      },
      close: () => undefined,
      download: async () => {
        throw new Error("body download forbidden");
      },
      search: async (query) => {
        const range = (query as unknown as { uid: string }).uid;
        if (range.includes(":")) {
          searches++;
          await onSearch(searches);
          const [low, high] = range.split(":").map(Number);
          return remote.filter((uid) => uid >= low! && uid <= high!);
        }
        return [];
      },
      fetch: async function* (range) {
        fetches++;
        log.push(`fetch ${range}`);
        await onFetch(fetches);
        let sent = 0;
        for (const uid of range.split(",").map(Number)) {
          if (failFetch === fetches && sent === 1)
            throw new Error("socket reset");
          sent++;
          yield {
            seq: uid,
            uid,
            flags: new Set(),
            internalDate: new Date("2020-01-01"),
            size: 1,
            envelope: { subject: `History ${uid}` },
          } as FetchMessageObject;
        }
      },
    }),
    createSmtp: () => ({
      verify: async () => undefined,
      close: () => undefined,
    }),
  };

  const logger = {
    info: (fields: Record<string, unknown>) =>
      logged.push({ level: "info", fields }),
    debug: (fields: Record<string, unknown>) =>
      logged.push({ level: "debug", fields }),
  } as unknown as Logger;

  // Real pg-boss except work(), captured so the test drives each claim.
  const proxy = {
    createQueue: (...args: Parameters<PgBoss["createQueue"]>) =>
      boss.createQueue(...args),
    getDb: () => boss.getDb(),
    findJobs: async (...args: Parameters<PgBoss["findJobs"]>) => {
      if (failGate && (args[0] === RECENT || args[0] === DELTA))
        throw new Error("gate unavailable");
      return boss.findJobs(...args);
    },
    send: async (...args: Parameters<PgBoss["send"]>) => {
      if (failSend && args[0] === BACKFILL) throw new Error("send failed");
      return boss.send(...args);
    },
    work: async (_queue: string, _options: unknown, work: Handler) => {
      handler = work;
    },
  } as unknown as PgBoss;

  const sql = (text: string, values: unknown[] = []) =>
    boss.getDb().executeSql(text, values);

  /** One claim, completed or failed exactly like boss.work. */
  const step = async (): Promise<"completed" | "failed" | null> => {
    const [job] = await boss.fetch(BACKFILL, {
      batchSize: 1,
      includeMetadata: true,
    });
    if (!job) return null;
    try {
      await handler([job]);
      await boss.complete(BACKFILL, job.id);
      return "completed";
    } catch {
      await boss.fail(BACKFILL, job.id);
      return "failed";
    }
  };
  const live = async (key: string) =>
    (await boss.findJobs(BACKFILL, { key })).filter((job) =>
      ["created", "retry", "active"].includes(job.state),
    );
  const allLive = async () =>
    (
      await sql(
        `SELECT singleton_key, state FROM pgboss.job
          WHERE name = $1 AND state IN ('created', 'retry', 'active')
          ORDER BY singleton_key`,
        [BACKFILL],
      )
    ).rows as { singleton_key: string; state: string }[];
  const makeReady = () =>
    sql(
      `UPDATE pgboss.job SET start_after = now()
        WHERE name = $1 AND state IN ('created', 'retry')`,
      [BACKFILL],
    );
  const mailbox = async (id: string) =>
    (
      await database.db.select().from(mailboxes).where(eq(mailboxes.id, id))
    )[0]!;
  const uids = async (id: string) =>
    (
      await database.db
        .select({ uid: mailboxMessages.uid })
        .from(mailboxMessages)
        .where(eq(mailboxMessages.mailboxId, id))
    )
      .map((row) => Number(row.uid))
      .sort((x, y) => x - y);
  const lockIsFree = (id: string) => lock(id, async () => undefined);
  const yieldEvents = () =>
    logged.filter((entry) => entry.fields.event === "mail.backfill_yielded");

  const seedMessage = async (account: Account) => {
    const id = randomUUID();
    await database.db.insert(messages).values({
      id,
      accountId: account.id,
      internalDate: new Date(),
      size: 1n,
    });
    return id;
  };
  const seedCommand = async (account: Account, mailboxId: string) => {
    const id = randomUUID();
    await database.db.insert(messageCommands).values({
      id,
      accountId: account.id,
      mailboxId,
      messageId: await seedMessage(account),
      action: "mark_read",
      status: "pending",
      sourcePath: "INBOX",
      sourceUidValidity: 7n,
      sourceUid: 1n,
    });
    return id;
  };
  /** As PgBossContentScheduler: one key per message on the stately queue. */
  const sendContent = async (account: Account, options: object = {}) => {
    const messageId = randomUUID();
    const id = await boss.send(
      CONTENT,
      {
        version: 1,
        accountId: account.id,
        mailboxId: account.box.INBOX,
        messageId,
      },
      { singletonKey: `${account.box.INBOX}:${messageId}`, ...options },
    );
    expect(id).not.toBeNull();
    return id;
  };
  const sendAttachment = async (account: Account) => {
    const id = randomUUID();
    await database.db.insert(messageAttachments).values({
      id,
      messageId: await seedMessage(account),
      sourceMailboxId: account.box.INBOX,
      sourceUidValidity: 7n,
      sourceUid: 3n,
      partId: "2",
      contentType: "image/png",
      contentId: "logo",
      inline: true,
      visible: false,
    });
    return boss.send(ATTACHMENT, { attachmentId: id });
  };

  const remoteMailbox = (remotePath: string): RemoteMailbox => ({
    remotePath,
    name: remotePath,
    delimiter: "/",
    attributes: [],
    specialUse: [],
    selectable: true,
  });
  const createAccount = async (): Promise<Account> => {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Fixture",
      email: `${id}@example.invalid`,
      imapHost: "imap.invalid",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: { fixture: true } as never,
      smtpHost: "smtp.invalid",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    await new MailboxService(database.db).reconcile(
      id,
      PATHS.map(remoteMailbox),
    );
    const rows = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, id));
    const box: Record<string, string> = {};
    for (const row of rows) box[row.remotePath] = row.id;
    const now = new Date();
    await database.db
      .update(mailboxes)
      .set({
        recentSyncStatus: "success",
        recentSyncUidValidity: 7n,
        uidValidity: 7n,
        recentSyncCompletedAt: now,
        lastSuccessfulRecentSyncAt: now,
        backfillStatus: "pending",
      })
      .where(eq(mailboxes.accountId, id));
    return { id, box };
  };

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "cooperative_backfill_isolated",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const databaseUrl = `postgresql://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/cooperative_backfill_isolated`;
    database = createDatabase({ databaseUrl, databasePoolSize: 10 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    for (const queue of [RECENT, DELTA])
      await boss.createQueue(queue, { policy: "stately" });
    await ensureContentQueue(boss);
    await ensureAttachmentQueue(boss);
    lock = createMailboxLock(database.client);
    const provider = new ImapSmtpMailProvider(factory);
    const accounts = {
      getProviderImapAccountForWork: async () => imapAccount,
    } as unknown as AccountsService;
    const messageService = new MessageService(
      database.db,
      accounts,
      provider,
      { initialSyncDays: 30, messageFetchBatchSize: 150 },
      {
        schedule: async () => {
          recentRequests++;
          return true;
        },
      },
    );
    service = new BackfillSyncService(
      database.db,
      accounts,
      provider,
      messageService,
      CHUNK,
      logger,
      SUB_BATCH,
    );
    await registerBackfillWorker(proxy, service, lock, logger);
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    remote = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    uidValidity = 7n;
    log = [];
    fetches = 0;
    searches = 0;
    onFetch = async () => undefined;
    onSearch = async () => undefined;
    failFetch = null;
    failGate = false;
    failSend = false;
    recentRequests = 0;
    logged = [];
    // Isolated container only: previous scenarios must not leak state.
    await sql("DROP TRIGGER IF EXISTS fixture_fail_uid ON mailbox_messages");
    await database.db.delete(mailAccounts);
    await sql("DELETE FROM pgboss.job WHERE name = ANY($1::text[])", [
      [RECENT, DELTA, BACKFILL, CONTENT, ATTACHMENT],
    ]);
    a = await createAccount();
    b = await createAccount();
  });

  /** Starts INBOX history of account a from the initial key. */
  const startInbox = () => enqueueBackfill(boss, a.id, a.box.INBOX);

  /**
   * The common assertion of every preemption scenario: exactly one FETCH ran,
   * its sub-batch [8,10] is committed with frontier 7, the session ended
   * normally, the lock is free and one delayed successor carries the new key.
   */
  const expectYieldedAfterFirstSubBatch = async (reason: string) => {
    expect(log.filter((line) => line.startsWith("fetch"))).toEqual([
      "fetch 8,9,10",
    ]);
    expect(log.slice(-2)).toEqual(["close", "logout"]);
    expect(await uids(a.box.INBOX)).toEqual([8, 9, 10]);
    const row = await mailbox(a.box.INBOX);
    expect(row.backfillFrontierUid).toBe(7n);
    expect(row.backfillStatus).toBe("pending");
    await expect(lockIsFree(a.box.INBOX)).resolves.toBeUndefined();
    const next = await live(`${a.box.INBOX}:7`);
    expect(next.map((job) => job.state)).toEqual(["created"]);
    expect(next[0]!.startAfter.getTime()).toBeGreaterThan(Date.now());
    expect(next[0]!.priority).toBe(-5);
    expect(yieldEvents().map((entry) => entry.fields.reason)).toEqual([reason]);
  };

  /** Resumes from the durable frontier and finishes the mailbox. */
  const expectResumesToCompletion = async () => {
    log = [];
    await makeReady();
    expect(await step()).toBe("completed");
    expect(log.filter((line) => line.startsWith("fetch"))).toEqual([
      "fetch 5,6,7",
      "fetch 2,3,4",
      "fetch 1",
    ]);
    expect(await uids(a.box.INBOX)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const row = await mailbox(a.box.INBOX);
    expect(row.backfillStatus).toBe("complete");
    expect(row.backfillFrontierUid).toBe(0n);
    expect(await allLive()).toEqual([]);
  };

  describe("preemption", () => {
    it("1. a user command during a history FETCH: the sub-batch commits, no next FETCH, lock released", async () => {
      await startInbox();
      let command = "";
      onFetch = async (n) => {
        if (n === 1) command = await seedCommand(a, a.box.INBOX);
      };
      expect(await step()).toBe("completed");
      await expectYieldedAfterFirstSubBatch("command");
      expect(yieldEvents()[0]!.fields.releaseMs).toEqual(expect.any(Number));
      // The command ran meanwhile; history continues from the frontier.
      await database.db
        .update(messageCommands)
        .set({ status: "succeeded" })
        .where(eq(messageCommands.id, command));
      await expectResumesToCompletion();
    });

    it("2. an INBOX delta during INBOX history yields after the commit", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n === 1) await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
      };
      expect(await step()).toBe("completed");
      await expectYieldedAfterFirstSubBatch("own-fresh");
    });

    it("3. fresh work of another folder of the account yields INBOX history", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n === 1) await enqueueDelta(boss, a.id, a.box.Archive, "poll");
      };
      expect(await step()).toBe("completed");
      await expectYieldedAfterFirstSubBatch("fresh");
    });

    it("3b. other-folder history yields to INBOX fresh the same way", async () => {
      await enqueueBackfill(boss, a.id, a.box.Archive);
      onFetch = async (n) => {
        if (n === 1) await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
      };
      expect(await step()).toBe("completed");
      expect(log.filter((line) => line.startsWith("fetch"))).toHaveLength(1);
      expect((await mailbox(a.box.Archive)).backfillFrontierUid).toBe(7n);
      const next = await live(`${a.box.Archive}:7`);
      expect(next.map((job) => job.priority)).toEqual([-10]);
    });

    it("4. content fetching of the same account yields history", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n === 1) await sendContent(a);
      };
      expect(await step()).toBe("completed");
      await expectYieldedAfterFirstSubBatch("interactive");
    });

    it("5. an active attachment/CID fetch of the same account yields history", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n !== 1) return;
        await sendAttachment(a);
        // Claimed by an attachment worker: active, not just queued.
        const [job] = await boss.fetch(ATTACHMENT);
        expect(job).toBeDefined();
      };
      expect(await step()).toBe("completed");
      await expectYieldedAfterFirstSubBatch("interactive");
    });

    it("6. work of an unrelated account never yields history", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n !== 1) return;
        await seedCommand(b, b.box.INBOX);
        await enqueueDelta(boss, b.id, b.box.INBOX, "idle");
        await enqueueDelta(boss, b.id, b.box.Archive, "poll");
        await sendContent(b);
        await sendAttachment(b);
      };
      expect(await step()).toBe("completed");
      expect(log.filter((line) => line.startsWith("fetch"))).toHaveLength(4);
      expect(await uids(a.box.INBOX)).toHaveLength(10);
      expect((await mailbox(a.box.INBOX)).backfillStatus).toBe("complete");
      expect(yieldEvents()).toEqual([]);
    });

    it("7. a signal right after a check lets at most one more sub-batch run", async () => {
      await startInbox();
      // SEARCH #2 runs right after check #1 answered "continue".
      onSearch = async (n) => {
        if (n === 2) await seedCommand(a, a.box.INBOX);
      };
      expect(await step()).toBe("completed");
      expect(log.filter((line) => line.startsWith("fetch"))).toEqual([
        "fetch 8,9,10",
        "fetch 5,6,7",
      ]);
      expect((await mailbox(a.box.INBOX)).backfillFrontierUid).toBe(4n);
      expect(await live(`${a.box.INBOX}:4`)).toHaveLength(1);
    });

    it("8. an unreadable gate never continues history blind", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n === 1) failGate = true;
      };
      expect(await step()).toBe("completed");
      await expectYieldedAfterFirstSubBatch("gate-error");
      expect((await mailbox(a.box.INBOX)).backfillError).toBeNull();
      failGate = false;
      await expectResumesToCompletion();
    });

    it("the start gate also defers history behind live interactive fetching", async () => {
      await startInbox();
      await sendContent(a);
      expect(await step()).toBe("completed");
      expect(log).toEqual([]);
      expect(await live(`${a.box.INBOX}:initial`)).toHaveLength(1);
    });

    it("interactive work counts only while live: no far retries, stale queue rows or orphans", async () => {
      expect(await interactiveFetchWaiting(boss, a.id)).toBe(false);
      // Far retry / delayed start.
      await sendContent(a, { startAfter: 600 });
      expect(await interactiveFetchWaiting(boss, a.id)).toBe(false);
      // Ready but unclaimed for longer than the waiting bound.
      const id = await sendContent(a);
      await sql(
        `UPDATE pgboss.job SET created_on = now() - interval '1 hour',
                start_after = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );
      expect(await interactiveFetchWaiting(boss, a.id)).toBe(false);
      // Active far beyond the queue expiry: an orphan.
      await sql(
        `UPDATE pgboss.job SET state = 'active',
                started_on = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );
      expect(await interactiveFetchWaiting(boss, a.id)).toBe(false);
      // Durable pending/fetching attachment rows without a job never count.
      await database.db.insert(messageAttachments).values({
        id: randomUUID(),
        messageId: await seedMessage(a),
        sourceUidValidity: 7n,
        sourceUid: 4n,
        partId: "2",
        contentType: "image/png",
        inline: true,
        visible: false,
        status: "fetching",
      });
      expect(await interactiveFetchWaiting(boss, a.id)).toBe(false);
      await sendContent(a);
      expect(await interactiveFetchWaiting(boss, a.id)).toBe(true);
      expect(await interactiveFetchWaiting(boss, b.id)).toBe(false);
    });
  });

  describe("checkpoint", () => {
    it("9/16. the frontier moves only per committed sub-batch; a later FETCH failure keeps earlier ones", async () => {
      await startInbox();
      failFetch = 2;
      expect(await step()).toBe("failed");
      expect(await uids(a.box.INBOX)).toEqual([8, 9, 10]);
      const row = await mailbox(a.box.INBOX);
      // 10. Partially received [5,7] never moved the frontier.
      expect(row.backfillFrontierUid).toBe(7n);
      expect(row.backfillStatus).toBe("failed");
      // pg-boss retry resumes from the durable frontier, not the payload.
      failFetch = null;
      log = [];
      await makeReady();
      expect(await step()).toBe("completed");
      expect(log.filter((line) => line.startsWith("fetch"))[0]).toBe(
        "fetch 5,6,7",
      );
      expect(await uids(a.box.INBOX)).toHaveLength(10);
      expect((await mailbox(a.box.INBOX)).backfillStatus).toBe("complete");
    });

    it("11. a database error rolls back the whole sub-batch and its frontier", async () => {
      await sql(`CREATE OR REPLACE FUNCTION fixture_fail_uid() RETURNS trigger
                 LANGUAGE plpgsql AS $$ BEGIN
                   IF NEW.uid = 5 THEN RAISE EXCEPTION 'fixture db failure'; END IF;
                   RETURN NEW;
                 END $$`);
      await sql(`CREATE TRIGGER fixture_fail_uid BEFORE INSERT ON mailbox_messages
                 FOR EACH ROW EXECUTE FUNCTION fixture_fail_uid()`);
      await startInbox();
      expect(await step()).toBe("failed");
      // 6 and 7 of the failed sub-batch were rolled back with it.
      expect(await uids(a.box.INBOX)).toEqual([8, 9, 10]);
      expect((await mailbox(a.box.INBOX)).backfillFrontierUid).toBe(7n);
      await sql("DROP TRIGGER fixture_fail_uid ON mailbox_messages");
      await makeReady();
      expect(await step()).toBe("completed");
      expect(await uids(a.box.INBOX)).toHaveLength(10);
    });

    it("12. sparse UIDs and empty sub-ranges still advance without skipping", async () => {
      remote = [1, 9];
      await startInbox();
      expect(await step()).toBe("completed");
      expect(log.filter((line) => line.startsWith("fetch"))).toEqual([
        "fetch 9",
        "fetch 1",
      ]);
      expect(await uids(a.box.INBOX)).toEqual([1, 9]);
      expect((await mailbox(a.box.INBOX)).backfillStatus).toBe("complete");
    });

    it("15. UIDVALIDITY change after a yield runs the existing epoch recovery", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n === 1) await seedCommand(a, a.box.INBOX);
      };
      expect(await step()).toBe("completed");
      await database.db.delete(messageCommands);
      uidValidity = 8n;
      log = [];
      await makeReady();
      expect(await step()).toBe("completed");
      expect(log.filter((line) => line.startsWith("fetch"))).toEqual([]);
      const row = await mailbox(a.box.INBOX);
      expect(row.backfillStatus).toBe("not_started");
      expect(row.backfillFrontierUid).toBeNull();
      expect(recentRequests).toBe(1);
      expect(await allLive()).toEqual([]);
    });
  });

  describe("recovery and concurrency", () => {
    it("17. a yield without progress is delayed, not a hot loop", async () => {
      await startInbox();
      await seedCommand(a, a.box.INBOX);
      expect(await step()).toBe("completed");
      expect(log).toEqual([]);
      const [next] = await live(`${a.box.INBOX}:initial`);
      expect(next!.startAfter.getTime()).toBeGreaterThan(Date.now() + 5_000);
      // Not claimable again right away.
      expect(await step()).toBeNull();
    });

    it("18. a crash after the commit, before the enqueue, is resumed by the poller", async () => {
      // The run commits [8,10] and yields; no successor is ever sent.
      const result = await service.run(a.id, a.box.INBOX, async () => true);
      expect(result).toEqual({ outcome: "yielded", frontier: "7" });
      expect(await allLive()).toEqual([]);
      const poller = new BackfillPoller(database.db, boss);
      await poller.start();
      poller.stop();
      expect(
        (await allLive()).filter((job) =>
          job.singleton_key.startsWith(a.box.INBOX),
        ),
      ).toEqual([{ singleton_key: `${a.box.INBOX}:7`, state: "created" }]);
      await sql(
        "DELETE FROM pgboss.job WHERE name = $1 AND singleton_key NOT LIKE $2",
        [BACKFILL, `${a.box.INBOX}:%`],
      );
      await expectResumesToCompletion();
    });

    it("a failed successor send fails the job; retry resumes from the durable frontier", async () => {
      await startInbox();
      onFetch = async (n) => {
        if (n === 1) await seedCommand(a, a.box.INBOX);
      };
      failSend = true;
      expect(await step()).toBe("failed");
      failSend = false;
      const row = await mailbox(a.box.INBOX);
      expect(row.backfillFrontierUid).toBe(7n);
      expect(row.backfillStatus).toBe("pending");
      expect((await allLive()).map((job) => job.state)).toEqual(["retry"]);
      await database.db.delete(messageCommands);
      await expectResumesToCompletion();
    });

    it("19/21. active job + queued successor + poller and retry lose nothing and do not multiply", async () => {
      await startInbox();
      const poller = new BackfillPoller(database.db, boss);
      onFetch = async (n) => {
        if (n !== 1) return;
        // While the job is active the poller sees the selected frontier (10).
        await poller.start();
        poller.stop();
        await poller.start();
        poller.stop();
        await seedCommand(a, a.box.INBOX);
      };
      expect(await step()).toBe("completed");
      await poller.start();
      poller.stop();
      const own = (await allLive()).filter((job) =>
        job.singleton_key.startsWith(a.box.INBOX),
      );
      expect(own).toEqual([
        { singleton_key: `${a.box.INBOX}:10`, state: "created" },
        { singleton_key: `${a.box.INBOX}:7`, state: "created" },
      ]);
      await database.db.delete(messageCommands);
      await sql(
        "DELETE FROM pgboss.job WHERE name = $1 AND singleton_key NOT LIKE $2",
        [BACKFILL, `${a.box.INBOX}:%`],
      );
      await makeReady();
      // Both remaining jobs read the durable frontier: the first finishes the
      // mailbox, the second finds it complete. No UID twice, none skipped.
      expect(await step()).toBe("completed");
      expect(await step()).toBe("completed");
      expect(await step()).toBeNull();
      expect(log.filter((line) => line.startsWith("fetch"))).toHaveLength(4);
      expect(await uids(a.box.INBOX)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect((await mailbox(a.box.INBOX)).backfillStatus).toBe("complete");
    });

    it("20. two workers never process the same mailbox at once", async () => {
      await startInbox();
      await enqueueBackfill(boss, a.id, a.box.INBOX, "10");
      let release!: () => void;
      let second: Promise<"completed" | "failed" | null> | undefined;
      onFetch = async (n) => {
        if (n !== 1) return;
        // The other worker claims the second job while this FETCH runs.
        second = step();
        await second;
        await new Promise<void>((resolve) => (release = resolve));
      };
      const first = step();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(await second).toBe("completed");
      // The busy mailbox deferred the second job without any IMAP work.
      expect(log.filter((line) => line.startsWith("connect"))).toHaveLength(1);
      release();
      expect(await first).toBe("completed");
      expect(log.filter((line) => line.startsWith("connect"))).toHaveLength(1);
      expect(await uids(a.box.INBOX)).toHaveLength(10);
    });
  });

  it("logs only categories, counts, durations and UID bounds", async () => {
    await startInbox();
    onFetch = async (n) => {
      if (n === 2) await seedCommand(a, a.box.INBOX);
    };
    expect(await step()).toBe("completed");
    const allowed = new Set([
      "event",
      "reason",
      "frontier",
      "frontierBefore",
      "frontierAfter",
      "messages",
      "durationMs",
      "releaseMs",
    ]);
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged)
      for (const key of Object.keys(entry.fields))
        expect(allowed).toContain(key);
    const text = JSON.stringify(logged);
    for (const secret of [a.id, a.box.INBOX, "INBOX", "History"])
      expect(text).not.toContain(secret);
    expect(
      logged
        .filter(
          (entry) => entry.fields.event === "mail.backfill_sub_batch_committed",
        )
        .map((entry) => [
          entry.fields.frontierBefore,
          entry.fields.frontierAfter,
        ]),
    ).toEqual([
      ["10", "7"],
      ["7", "4"],
    ]);
  });
});
