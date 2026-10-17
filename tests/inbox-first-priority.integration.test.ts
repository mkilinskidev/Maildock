// INBOX-first execution order across recent, delta and backfill queues.
// Never uses DATABASE_URL or TEST_DATABASE_URL: a disposable PostgreSQL
// container, its own pg-boss and fake providers only. Workers are driven
// deterministically through the real pg-boss fetch (priority, startAfter,
// retry, stately) and the real mailbox advisory lock.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss, type Job } from "pg-boss";
import type { ImapFlow } from "imapflow";
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
} from "@/shared/infrastructure/database/schema";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MessageService } from "@/modules/mail/application/message-service";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import type { RemoteMailbox } from "@/modules/accounts/domain/mail-provider";
import type { DeltaSyncService } from "@/modules/mail/application/delta-sync-service";
import type { BackfillSyncService } from "@/modules/mail/application/backfill-sync-service";
import type { MessageCommandService } from "@/modules/mail/application/message-command-service";
import type { MessageContentService } from "@/modules/mail/application/message-content-service";
import {
  enqueueRecent,
  registerRecentSyncWorker,
  MAILBOX_RECENT_SYNC_QUEUE as RECENT,
} from "@/modules/mail/infrastructure/recent-sync-jobs";
import {
  DeltaPoller,
  enqueueDelta,
  registerDeltaWorker,
  MAILBOX_DELTA_SYNC_QUEUE as DELTA,
} from "@/modules/mail/infrastructure/delta-sync-jobs";
import {
  enqueueBackfill,
  registerBackfillWorker,
  MAILBOX_BACKFILL_SYNC_QUEUE as BACKFILL,
} from "@/modules/mail/infrastructure/backfill-sync-jobs";
import {
  enqueueMessageCommand,
  registerMessageCommandWorker,
  MESSAGE_COMMAND_QUEUE as COMMAND,
} from "@/modules/mail/infrastructure/message-command-jobs";
import {
  registerContentWorker,
  MESSAGE_CONTENT_QUEUE as CONTENT,
} from "@/modules/mail/infrastructure/content-jobs";
import { IdleWatcherManager } from "@/modules/mail/infrastructure/idle-watchers";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
import { higherPriorityWorkWaiting } from "@/modules/mail/infrastructure/sync-admission";

type Handler = (jobs: Job<unknown>[]) => Promise<void>;
type Registration = {
  queue: string;
  options: { minPriority?: number; localConcurrency?: number };
  handler: Handler;
};
type Account = { id: string; box: Record<string, string> };

const PATHS = ["Archive", "INBOX", "Sent", "Spam"];

describe("INBOX-first execution priority with isolated PostgreSQL and pg-boss", () => {
  let container: StartedTestContainer;
  let databaseUrl: string;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let lock: ReturnType<typeof createMailboxLock>;
  let registrations: Registration[];
  let runs: string[];
  let paths: Map<string, string>;
  let hooks: Map<string, () => Promise<void>>;
  let continuation: Map<string, string>;
  let failOnce: Set<string>;
  let a: Account;
  let b: Account;

  const remote = (remotePath: string): RemoteMailbox => ({
    remotePath,
    // Display names deliberately disagree with the canonical path.
    name: remotePath === "INBOX" ? "Misleading" : "INBOX",
    delimiter: "/",
    attributes: [],
    specialUse: [],
    selectable: true,
  });

  const record = async (kind: string, mailboxId: string) => {
    const label = `${kind}:${paths.get(mailboxId)}`;
    runs.push(label);
    if (failOnce.delete(label)) throw new Error("Fixture failure");
    await hooks.get(label)?.();
  };
  const recentService = {
    shouldDeferInitialRecent: async () => false,
    runRecentSync: (_account: string, mailboxId: string) =>
      record("recent", mailboxId),
  } as unknown as MessageService;
  const deltaService = {
    run: (_account: string, mailboxId: string) => record("delta", mailboxId),
  } as unknown as DeltaSyncService;
  const backfillService = {
    run: async (_account: string, mailboxId: string) => {
      await record("backfill", mailboxId);
      return continuation.get(mailboxId) ?? null;
    },
  } as unknown as BackfillSyncService;

  // Proxy: real pg-boss for everything except work(), which is captured so the
  // test decides when each slot claims its next job.
  const capturing = () =>
    ({
      createQueue: (...args: Parameters<PgBoss["createQueue"]>) =>
        boss.createQueue(...args),
      getDb: () => boss.getDb(),
      findJobs: (...args: Parameters<PgBoss["findJobs"]>) =>
        boss.findJobs(...args),
      send: (...args: Parameters<PgBoss["send"]>) => boss.send(...args),
      work: async (
        queue: string,
        options: Registration["options"],
        handler: Handler,
      ) => {
        registrations.push({ queue, options, handler });
      },
    }) as unknown as PgBoss;

  const register = async () => {
    registrations = [];
    const proxy = capturing();
    await registerRecentSyncWorker(proxy, recentService, 2, lock);
    await registerDeltaWorker(proxy, deltaService, 2, lock);
    await registerBackfillWorker(proxy, backfillService, lock);
  };

  /** One claim by one slot, then complete/fail exactly like boss.work. */
  const step = async (
    queue: string,
    lane: "general" | "inbox" = "general",
  ): Promise<string | null> => {
    const registration = registrations.find(
      (item) =>
        item.queue === queue &&
        (lane === "inbox") === (item.options.minPriority !== undefined),
    );
    if (!registration) throw new Error(`No ${lane} slot for ${queue}`);
    const [job] = await boss.fetch(queue, {
      batchSize: 1,
      includeMetadata: true,
      ...(registration.options.minPriority === undefined
        ? {}
        : { minPriority: registration.options.minPriority }),
    });
    if (!job) return null;
    try {
      await registration.handler([job]);
      await boss.complete(queue, job.id);
    } catch {
      await boss.fail(queue, job.id);
    }
    return paths.get((job.data as { mailboxId: string }).mailboxId) ?? null;
  };

  const jobs = (queue: string, key: string) => boss.findJobs(queue, { key });
  const live = async (queue: string, key: string) =>
    (await jobs(queue, key)).filter((job) =>
      ["created", "retry", "active"].includes(job.state),
    );
  const sql = (text: string, values: unknown[] = []) =>
    boss.getDb().executeSql(text, values);
  /** Fast-forward startAfter of queued jobs instead of sleeping. */
  const makeReady = (queue: string, key: string) =>
    sql(
      `UPDATE pgboss.job SET start_after = now()
        WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry')`,
      [queue, key],
    );

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
    await new MailboxService(database.db).reconcile(id, PATHS.map(remote));
    const rows = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, id));
    const box: Record<string, string> = {};
    for (const row of rows) {
      box[row.remotePath] = row.id;
      paths.set(row.id, row.remotePath);
    }
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
        POSTGRES_DB: "inbox_priority_isolated",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    databaseUrl = `postgresql://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/inbox_priority_isolated`;
    database = createDatabase({ databaseUrl, databasePoolSize: 10 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    lock = createMailboxLock(database.client);
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    runs = [];
    paths = new Map();
    hooks = new Map();
    continuation = new Map();
    failOnce = new Set();
    // Isolated container only: previous scenarios must not leak queued work.
    await database.db.update(mailAccounts).set({ enabled: false });
    a = await createAccount();
    b = await createAccount();
    await register();
    await sql("DELETE FROM pgboss.job WHERE name = ANY($1::text[])", [
      [RECENT, DELTA, BACKFILL, COMMAND, CONTENT],
    ]);
  });

  it("1. picks a ready INBOX delta before many earlier deltas of other folders", async () => {
    for (const path of ["Archive", "Sent", "Spam"])
      await enqueueDelta(boss, a.id, a.box[path], "poll");
    await enqueueDelta(boss, a.id, a.box.INBOX, "poll");
    expect(await step(DELTA)).toBe("INBOX");
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual(["delta:INBOX", "delta:Archive"]);
  });

  it("reserves one delta slot for INBOX without adding concurrency", async () => {
    expect(
      registrations
        .filter((item) => item.queue === DELTA)
        .map((item) => item.options),
    ).toEqual([
      { localConcurrency: 1 },
      { localConcurrency: 1, minPriority: 20 },
    ]);
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    await enqueueDelta(boss, a.id, a.box.Sent, "poll");
    // The INBOX lane never takes other folders...
    expect(await step(DELTA, "inbox")).toBeNull();
    // ...so while a long Archive delta occupies the general slot, INBOX
    // (also another account's INBOX) still starts immediately.
    let release!: () => void;
    hooks.set(
      "delta:Archive",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const archive = step(DELTA);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    await enqueueDelta(boss, b.id, b.box.INBOX, "idle");
    expect(await step(DELTA, "inbox")).toBe("INBOX");
    expect(await step(DELTA, "inbox")).toBe("INBOX");
    expect(runs).toEqual(["delta:Archive", "delta:INBOX", "delta:INBOX"]);
    release();
    await archive;
  });

  it("2. a waiting INBOX delta is admitted before another folder's recent", async () => {
    await enqueueRecent(boss, a.id, a.box.Archive);
    await enqueueDelta(boss, a.id, a.box.INBOX, "poll");
    // A free recent slot claims Archive first, but admission defers it.
    expect(await step(RECENT)).toBe("Archive");
    expect(runs).toEqual([]);
    const successor = await live(RECENT, a.box.Archive);
    expect(successor).toHaveLength(1);
    expect(successor[0].state).toBe("created");
    expect(successor[0].startAfter.getTime()).toBeGreaterThan(Date.now());
    expect(await step(RECENT)).toBeNull();
    expect(await step(DELTA)).toBe("INBOX");
    await makeReady(RECENT, a.box.Archive);
    expect(await step(RECENT)).toBe("Archive");
    expect(runs).toEqual(["delta:INBOX", "recent:Archive"]);
    expect(await live(RECENT, a.box.Archive)).toEqual([]);
  });

  it("3. a waiting INBOX recent is admitted before another folder's delta", async () => {
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    await enqueueRecent(boss, a.id, a.box.INBOX);
    expect((await jobs(RECENT, a.box.INBOX))[0].priority).toBe(20);
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual([]);
    expect(await step(RECENT)).toBe("INBOX");
    await makeReady(DELTA, a.box.Archive);
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual(["recent:INBOX", "delta:Archive"]);
  });

  it("4. pending history of another folder or of INBOX does not start before a ready INBOX delta", async () => {
    await enqueueBackfill(boss, a.id, a.box.Archive);
    await enqueueBackfill(boss, a.id, a.box.INBOX);
    await enqueueDelta(boss, a.id, a.box.INBOX, "poll");
    expect(await step(BACKFILL)).toBe("INBOX");
    expect(await step(BACKFILL)).toBe("Archive");
    expect(runs).toEqual([]);
    // Each yield left exactly one delayed successor with its original key.
    for (const path of ["INBOX", "Archive"]) {
      const pending = await live(BACKFILL, `${a.box[path]}:initial`);
      expect(pending.map((job) => job.state)).toEqual(["created"]);
    }
    expect(await step(DELTA)).toBe("INBOX");
    await makeReady(BACKFILL, `${a.box.INBOX}:initial`);
    await makeReady(BACKFILL, `${a.box.Archive}:initial`);
    expect(await step(BACKFILL)).toBe("INBOX");
    expect(await step(BACKFILL)).toBe("Archive");
    expect(runs).toEqual(["delta:INBOX", "backfill:INBOX", "backfill:Archive"]);
  });

  it("5. LIMITATION: an already active backfill is not preempted", async () => {
    // Another folder's active chunk keeps running; INBOX starts in parallel.
    let releaseArchive!: () => void;
    hooks.set(
      "backfill:Archive",
      () => new Promise<void>((resolve) => (releaseArchive = resolve)),
    );
    await enqueueBackfill(boss, a.id, a.box.Archive);
    const archive = step(BACKFILL);
    await vi.waitFor(() => expect(releaseArchive).toBeTypeOf("function"));
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(await step(DELTA)).toBe("INBOX");
    expect(runs).toEqual(["backfill:Archive", "delta:INBOX"]);
    releaseArchive();
    await archive;

    // INBOX's own active chunk holds the mailbox lock: the delta cannot start
    // until the chunk commits. It is requeued shortly (no backoff, no lost
    // work) instead of interrupting the FETCH.
    runs = [];
    let releaseInbox!: () => void;
    hooks.set(
      "backfill:INBOX",
      () => new Promise<void>((resolve) => (releaseInbox = resolve)),
    );
    await enqueueBackfill(boss, a.id, a.box.INBOX);
    const inbox = step(BACKFILL);
    await vi.waitFor(() => expect(releaseInbox).toBeTypeOf("function"));
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(await step(DELTA)).toBe("INBOX");
    expect(runs).toEqual(["backfill:INBOX"]);
    const deferred = await jobs(DELTA, a.box.INBOX);
    expect(deferred.filter((job) => job.state === "retry")).toEqual([]);
    expect(deferred.filter((job) => job.state === "failed")).toEqual([]);
    expect(
      deferred
        .filter((job) => job.state === "created")
        .map((job) => job.priority),
    ).toEqual([20]);
    releaseInbox();
    await inbox;
    await makeReady(DELTA, a.box.INBOX);
    expect(await step(DELTA)).toBe("INBOX");
    expect(runs).toEqual(["backfill:INBOX", "delta:INBOX"]);
  });

  it("6. INBOX history goes before other history, and all history yields to ready fresh work", async () => {
    await enqueueBackfill(boss, a.id, a.box.Archive);
    await enqueueBackfill(boss, a.id, a.box.Sent);
    await enqueueBackfill(boss, a.id, a.box.INBOX);
    expect((await jobs(BACKFILL, `${a.box.INBOX}:initial`))[0].priority).toBe(
      -5,
    );
    expect((await jobs(BACKFILL, `${a.box.Sent}:initial`))[0].priority).toBe(
      -10,
    );
    expect(await step(BACKFILL)).toBe("INBOX");
    // Another folder's ready fresh work outranks INBOX history too.
    await enqueueBackfill(boss, a.id, a.box.INBOX, "100");
    await enqueueDelta(boss, a.id, a.box.Spam, "poll");
    expect(await step(BACKFILL)).toBe("INBOX");
    expect(runs).toEqual(["backfill:INBOX"]);
    expect(await step(DELTA)).toBe("Spam");
    expect(await step(BACKFILL)).toBe("Archive");
    expect(runs).toEqual(["backfill:INBOX", "delta:Spam", "backfill:Archive"]);
  });

  it("7. IDLE schedules INBOX delta that keeps priority over queued folders", async () => {
    await database.db
      .update(mailAccounts)
      .set({ imapCapabilities: ["IDLE"] })
      .where(eq(mailAccounts.id, a.id));
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    await enqueueDelta(boss, a.id, a.box.Sent, "poll");
    class FakeIdleClient extends EventEmitter {
      capabilities = new Map([["IDLE", true]]);
      connect = async () => undefined;
      mailboxOpen = async () => undefined;
      close = () => {
        this.emit("close");
      };
    }
    const client = new FakeIdleClient();
    const manager = new IdleWatcherManager(
      database.db,
      {
        getProviderImapAccountForWork: async () => ({
          accountId: a.id,
          imap: {
            host: "imap.invalid",
            port: 993,
            security: "tls",
            username: "fixture",
            credential: { kind: "password", password: "fixture" },
          },
        }),
      } as unknown as AccountsService,
      boss,
      { info: () => undefined, warn: () => undefined } as unknown as Logger,
      () => client as unknown as ImapFlow,
    );
    await manager.start();
    try {
      await vi.waitFor(async () =>
        expect(await live(DELTA, a.box.INBOX)).toHaveLength(1),
      );
      client.emit("exists", { count: 2 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const inbox = await live(DELTA, a.box.INBOX);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].priority).toBe(20);
      expect(await step(DELTA)).toBe("INBOX");
    } finally {
      await manager.stop();
    }
  });

  it("8. DeltaPoller enqueues INBOX first and execution follows", async () => {
    const poller = new DeltaPoller(database.db, boss, 300);
    await poller.start();
    poller.stop();
    const created = (
      await Promise.all(
        [a, b].flatMap((account) =>
          PATHS.map(async (path) => ({
            path,
            job: (await live(DELTA, account.box[path]))[0],
          })),
        ),
      )
    ).sort((x, y) => x.job.createdOn.getTime() - y.job.createdOn.getTime());
    expect(created.slice(0, 2).map((item) => item.path)).toEqual([
      "INBOX",
      "INBOX",
    ]);
    expect(await step(DELTA)).toBe("INBOX");
    expect(await step(DELTA)).toBe("INBOX");
    expect(await step(DELTA)).not.toBe("INBOX");
  });

  it("9. manual refresh of INBOX keeps priority; callers cannot choose it", async () => {
    const service = new MessageService(
      database.db,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        schedule: (account, mailbox, reason) =>
          enqueueDelta(boss, account, mailbox, reason),
      },
    );
    await service.requestSync(a.id, a.box.Archive);
    await service.requestSync(a.id, a.box.INBOX);
    expect((await live(DELTA, a.box.INBOX))[0].priority).toBe(20);
    expect((await live(DELTA, a.box.Archive))[0].priority).toBe(10);
    expect(await step(DELTA)).toBe("INBOX");
  });

  it("10. INBOX retry keeps priority, coalesces producers and is not duplicated", async () => {
    failOnce.add("delta:INBOX");
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(await step(DELTA)).toBe("INBOX");
    const retry = await live(DELTA, a.box.INBOX);
    expect(retry.map((job) => [job.state, job.priority])).toEqual([
      ["retry", 20],
    ]);
    expect(await enqueueDelta(boss, a.id, a.box.INBOX, "idle")).toBe(false);
    expect(await enqueueDelta(boss, a.id, a.box.INBOX, "poll")).toBe(false);
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    await makeReady(DELTA, a.box.INBOX);
    expect(await step(DELTA)).toBe("INBOX");
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual(["delta:INBOX", "delta:INBOX", "delta:Archive"]);
    expect(await live(DELTA, a.box.INBOX)).toEqual([]);

    // Lock collision is not a failure: one successor, no retry consumed.
    let release!: () => void;
    const held = lock(
      a.box.INBOX,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(await step(DELTA)).toBe("INBOX");
    expect(await step(DELTA)).toBeNull();
    const after = await live(DELTA, a.box.INBOX);
    expect(after.map((job) => [job.state, job.retryCount])).toEqual([
      ["created", 0],
    ]);
    release();
    await held;
  });

  it("11. deferred, stale or self-blocked INBOX work does not block other folders", async () => {
    // Retry with a future startAfter.
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    await sql(
      `UPDATE pgboss.job SET state = 'retry', start_after = now() + interval '10 minutes'
        WHERE name = $1 AND singleton_key = $2`,
      [DELTA, a.box.INBOX],
    );
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    await enqueueBackfill(boss, a.id, a.box.Sent);
    expect(await step(DELTA)).toBe("Archive");
    expect(await step(BACKFILL)).toBe("Sent");
    expect(runs).toEqual(["delta:Archive", "backfill:Sent"]);

    // Ready but never claimed for longer than the starvation bound.
    await sql(
      `UPDATE pgboss.job SET state = 'created',
              created_on = now() - interval '200 seconds',
              start_after = now() - interval '200 seconds'
        WHERE name = $1 AND singleton_key = $2`,
      [DELTA, a.box.INBOX],
    );
    expect(
      await higherPriorityWorkWaiting(boss, a.id, a.box.Archive, "fresh"),
    ).toBe(false);

    // Active INBOX with a queued successor it blocks itself (stately).
    await sql("DELETE FROM pgboss.job WHERE name = $1", [DELTA]);
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    const [active] = await boss.fetch(DELTA, { minPriority: 20 });
    expect(active).toBeDefined();
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(await live(DELTA, a.box.INBOX)).toHaveLength(2);
    expect(
      await higherPriorityWorkWaiting(boss, a.id, a.box.Archive, "fresh"),
    ).toBe(false);
    // History still yields to the live INBOX run...
    expect(
      await higherPriorityWorkWaiting(boss, a.id, a.box.Sent, "history"),
    ).toBe(true);
    // ...but not to an orphan past the queue expiry.
    await sql(
      `UPDATE pgboss.job SET started_on = now() - interval '20 minutes'
        WHERE id = $1`,
      [active.id],
    );
    await sql(
      `UPDATE pgboss.job SET start_after = now() + interval '1 minute'
        WHERE name = $1 AND state = 'created'`,
      [DELTA],
    );
    expect(
      await higherPriorityWorkWaiting(boss, a.id, a.box.Sent, "history"),
    ).toBe(false);
  });

  it("12. a worker restart keeps INBOX priority and admission", async () => {
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    await enqueueRecent(boss, a.id, a.box.INBOX);
    await boss.stop();
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    await register();
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual([]);
    expect(await step(RECENT)).toBe("INBOX");
    await makeReady(DELTA, a.box.Archive);
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual(["recent:INBOX", "delta:Archive"]);
  });

  it("13. INBOX work of account A does not hold back account B", async () => {
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(
      await higherPriorityWorkWaiting(boss, b.id, b.box.Archive, "fresh"),
    ).toBe(false);
    expect(
      await higherPriorityWorkWaiting(boss, b.id, b.box.Archive, "history"),
    ).toBe(false);
    expect(
      await higherPriorityWorkWaiting(boss, a.id, a.box.Archive, "fresh"),
    ).toBe(true);
    const handler = registrations.find(
      (item) => item.queue === DELTA && !item.options.minPriority,
    )!.handler;
    await handler([
      {
        data: {
          version: 1,
          accountId: b.id,
          mailboxId: b.box.Archive,
          reason: "poll",
        },
      } as Job<unknown>,
    ]);
    await enqueueBackfill(boss, b.id, b.box.Sent);
    expect(await step(BACKFILL)).toBe("Sent");
    expect(runs).toEqual(["delta:Archive", "backfill:Sent"]);
  });

  it("14. user commands and interactive fetches bypass INBOX-first admission", async () => {
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    await enqueueBackfill(boss, a.id, a.box.INBOX);
    const proxy = capturing();
    const commandId = randomUUID();
    await registerMessageCommandWorker(
      proxy,
      {
        mailboxId: async () => a.box.Archive,
        run: async () => {
          runs.push("command:Archive");
        },
      } as unknown as MessageCommandService,
      lock,
    );
    await registerContentWorker(proxy, {
      run: async () => {
        runs.push("content:Archive");
      },
    } as unknown as MessageContentService);
    await enqueueMessageCommand(boss, commandId);
    await boss.send(CONTENT, {
      version: 1,
      accountId: a.id,
      mailboxId: a.box.Archive,
      messageId: randomUUID(),
    });
    const claim = async (queue: string) => {
      const [job] = await boss.fetch(queue);
      await registrations.find((item) => item.queue === queue)!.handler([job]);
      await boss.complete(queue, job.id);
    };
    await claim(COMMAND);
    await claim(CONTENT);
    expect(runs).toEqual(["command:Archive", "content:Archive"]);
    expect(await live(DELTA, a.box.INBOX)).toHaveLength(1);
  });

  it("races: INBOX created after the first check defers under the lock; after it, no preemption", async () => {
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    const racing = async (id: string, work: () => Promise<void>) => {
      await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
      await lock(id, work);
    };
    registrations = [];
    await registerDeltaWorker(capturing(), deltaService, 2, racing);
    expect(await step(DELTA)).toBe("Archive");
    expect(runs).toEqual([]);
    expect((await live(DELTA, a.box.Archive))[0].state).toBe("created");

    // After the under-lock check the started job finishes; INBOX takes its
    // reserved slot in parallel.
    await register();
    await sql("DELETE FROM pgboss.job WHERE name = $1", [DELTA]);
    await enqueueDelta(boss, a.id, a.box.Archive, "poll");
    let inboxStarted: Promise<string | null> | undefined;
    hooks.set("delta:Archive", async () => {
      await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
      inboxStarted = step(DELTA, "inbox");
      await inboxStarted;
    });
    expect(await step(DELTA)).toBe("Archive");
    expect(await inboxStarted).toBe("INBOX");
    expect(runs).toEqual(["delta:Archive", "delta:INBOX"]);
  });

  it("16. yielding history keeps checkpoint keys; continuations keep their tier", async () => {
    await database.db
      .update(mailboxes)
      .set({ backfillFrontierUid: 500n })
      .where(eq(mailboxes.id, a.box.Archive));
    await enqueueBackfill(boss, a.id, a.box.Archive, "500");
    await enqueueDelta(boss, a.id, a.box.INBOX, "idle");
    expect(await step(BACKFILL)).toBe("Archive");
    expect(runs).toEqual([]);
    expect(
      (await live(BACKFILL, `${a.box.Archive}:500`)).map((job) => job.state),
    ).toEqual(["created"]);
    const [row] = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, a.box.Archive));
    expect(row.backfillFrontierUid).toBe(500n);
    expect(await step(DELTA)).toBe("INBOX");
    await makeReady(BACKFILL, `${a.box.Archive}:500`);
    continuation.set(a.box.Archive, "400");
    expect(await step(BACKFILL)).toBe("Archive");
    const next = await live(BACKFILL, `${a.box.Archive}:400`);
    expect(next.map((job) => job.priority)).toEqual([-10]);
    expect(next[0].startAfter.getTime()).toBeGreaterThan(Date.now());
  });
});
