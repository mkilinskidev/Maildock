// User-actions-first: message commands outrank sync on the same mailbox, busy
// locks defer instead of failing, and producers never multiply jobs.
// Never uses DATABASE_URL or TEST_DATABASE_URL: a disposable PostgreSQL
// container, its own pg-boss, the real mailbox advisory lock and fake services.
import { randomUUID } from "node:crypto";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss, type Job } from "pg-boss";
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
  messageCommands,
  messageContents,
  messages,
} from "@/shared/infrastructure/database/schema";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import type { MessageService } from "@/modules/mail/application/message-service";
import type { DeltaSyncService } from "@/modules/mail/application/delta-sync-service";
import type { BackfillSyncService } from "@/modules/mail/application/backfill-sync-service";
import type { MessageCommandService } from "@/modules/mail/application/message-command-service";
import type { RemoteMailbox } from "@/modules/accounts/domain/mail-provider";
import { commandBusyDelaySeconds } from "@/modules/mail/application/inbox-first-policy";
import {
  enqueueMessageCommand,
  ensureMessageCommandQueue,
  MessageCommandPoller,
  registerMessageCommandWorker,
  MESSAGE_COMMAND_QUEUE as COMMAND,
} from "@/modules/mail/infrastructure/message-command-jobs";
import {
  enqueueRecent,
  registerRecentSyncWorker,
  MAILBOX_RECENT_SYNC_QUEUE as RECENT,
} from "@/modules/mail/infrastructure/recent-sync-jobs";
import {
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
  ContentRepairPoller,
  ensureContentQueue,
  registerContentWorker,
  MESSAGE_CONTENT_QUEUE as CONTENT,
} from "@/modules/mail/infrastructure/content-jobs";
import {
  ATTACHMENT_QUEUE,
  enqueueAttachment,
  ensureAttachmentQueue,
} from "@/modules/mail/infrastructure/attachment-jobs";
import {
  createMailboxLock,
  MailboxBusyError,
} from "@/modules/mail/infrastructure/mailbox-lock";
import { higherPriorityWorkWaiting } from "@/modules/mail/infrastructure/sync-admission";

type Handler = (jobs: Job<unknown>[]) => Promise<void>;
type Registration = {
  queue: string;
  options: { minPriority?: number; localConcurrency?: number };
  handler: Handler;
};
type Account = { id: string; box: Record<string, string> };

const PATHS = ["Archive", "INBOX"];

describe("user-actions-first with isolated PostgreSQL and pg-boss", () => {
  let container: StartedTestContainer;
  let databaseUrl: string;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let lock: ReturnType<typeof createMailboxLock>;
  let registrations: Registration[];
  let runs: string[];
  let paths: Map<string, string>;
  let commandMailbox: Map<string, string>;
  let commandRun: (id: string) => Promise<void>;
  let a: Account;
  let b: Account;

  const syncRecord = async (kind: string, mailboxId: string) => {
    runs.push(`${kind}:${paths.get(mailboxId)}`);
  };
  const recentService = {
    shouldDeferInitialRecent: async () => false,
    runRecentSync: (_account: string, mailboxId: string) =>
      syncRecord("recent", mailboxId),
  } as unknown as MessageService;
  const deltaService = {
    run: (_account: string, mailboxId: string) =>
      syncRecord("delta", mailboxId),
  } as unknown as DeltaSyncService;
  const backfillService = {
    run: async (_account: string, mailboxId: string) => {
      await syncRecord("backfill", mailboxId);
      return { outcome: "completed" };
    },
  } as unknown as BackfillSyncService;
  const commandService = {
    mailboxId: async (id: string) => commandMailbox.get(id),
    run: (id: string) => commandRun(id),
  } as unknown as MessageCommandService;

  // Real pg-boss for everything except work(), which is captured so the test
  // decides when each slot claims its next job.
  const capturing = (overrides: Partial<PgBoss> = {}) =>
    ({
      createQueue: (...args: Parameters<PgBoss["createQueue"]>) =>
        boss.createQueue(...args),
      updateQueue: (...args: Parameters<PgBoss["updateQueue"]>) =>
        boss.updateQueue(...args),
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
      ...overrides,
    }) as unknown as PgBoss;

  const register = async (
    proxy = capturing(),
    withLock: typeof lock = lock,
  ) => {
    registrations = [];
    await registerRecentSyncWorker(proxy, recentService, 2, withLock);
    await registerDeltaWorker(proxy, deltaService, 2, withLock);
    await registerBackfillWorker(proxy, backfillService, withLock);
    await registerMessageCommandWorker(proxy, commandService, withLock);
  };

  /** One claim, then complete/fail exactly like boss.work. */
  const step = async (queue: string, lane: "general" | "inbox" = "general") => {
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
      return { job, error: undefined as unknown };
    } catch (error) {
      await boss.fail(queue, job.id);
      return { job, error };
    }
  };

  const sql = (text: string, values: unknown[] = []) =>
    boss.getDb().executeSql(text, values);
  const jobsFor = (queue: string, data: object) =>
    boss.findJobs(queue, { data });
  const liveFor = async (queue: string, data: object) =>
    (await jobsFor(queue, data)).filter((job) =>
      ["created", "retry", "active"].includes(job.state),
    );
  const makeReady = (queue: string) =>
    sql(
      `UPDATE pgboss.job SET start_after = now()
        WHERE name = $1 AND state IN ('created', 'retry')`,
      [queue],
    );
  const secondsUntilStart = async (id: string) => {
    const { rows } = await sql(
      "SELECT extract(epoch from start_after - now()) AS s FROM pgboss.job WHERE id = $1",
      [id],
    );
    return Number((rows[0] as { s: string }).s);
  };
  const ageActive = (queue: string) =>
    sql(
      "UPDATE pgboss.job SET started_on = now() - interval '10 minutes' WHERE name = $1 AND state = 'active'",
      [queue],
    );

  /** Holds the real mailbox lock, as an active backfill or delta would. */
  const hold = async (mailboxId: string) => {
    let release!: () => void;
    let acquired!: () => void;
    const started = new Promise<void>((resolve) => (acquired = resolve));
    const done = lock(
      mailboxId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          acquired();
        }),
    );
    await started;
    return async () => {
      release();
      await done;
    };
  };

  const seedCommand = async (
    account: Account,
    mailboxId: string,
    status = "pending",
  ) => {
    const messageId = randomUUID();
    const id = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      accountId: account.id,
      internalDate: new Date(),
      size: 1n,
    });
    await database.db.insert(messageCommands).values({
      id,
      accountId: account.id,
      mailboxId,
      messageId,
      action: "mark_read",
      status,
      sourcePath: paths.get(mailboxId)!,
      sourceUidValidity: 7n,
      sourceUid: 1n,
    });
    commandMailbox.set(id, mailboxId);
    return id;
  };
  const commandRow = async (id: string) =>
    (
      await database.db
        .select()
        .from(messageCommands)
        .where(eq(messageCommands.id, id))
    )[0]!;

  const remote = (remotePath: string): RemoteMailbox => ({
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
        POSTGRES_DB: "user_actions_isolated",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    databaseUrl = `postgresql://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/user_actions_isolated`;
    database = createDatabase({ databaseUrl, databasePoolSize: 10 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    await ensureMessageCommandQueue(boss);
    await ensureContentQueue(boss);
    await ensureAttachmentQueue(boss);
    lock = createMailboxLock(database.client);
    paths = new Map();
    a = await createAccount();
    b = await createAccount();
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    runs = [];
    commandMailbox = new Map();
    commandRun = async (id) => {
      runs.push(`command:${paths.get(commandMailbox.get(id)!)}`);
    };
    await sql("DELETE FROM pgboss.job");
    await database.db.delete(messageCommands);
    await database.db.delete(messageContents);
    await database.db.delete(messages);
    await register();
  });

  describe("busy mailbox lock", () => {
    it("defers once without attempts, failure or standard backoff, then runs after release (1-3)", async () => {
      const release = await hold(a.box.INBOX!);
      const id = await seedCommand(a, a.box.INBOX!);
      await enqueueMessageCommand(boss, id);
      const first = await step(COMMAND);
      expect(first?.error).toBeUndefined();
      expect(runs).toEqual([]);
      expect(await commandRow(id)).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      const [original] = await boss.findJobs(COMMAND, { id: first!.job.id });
      expect(original).toMatchObject({ state: "completed", retryCount: 0 });
      const queued = (await jobsFor(COMMAND, { commandId: id })).filter(
        (job) => job.state === "created",
      );
      expect(queued).toHaveLength(1);
      const wait = await secondsUntilStart(queued[0]!.id);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(4); // not the 15 s retry delay

      // Still busy: again exactly one successor.
      await makeReady(COMMAND);
      await step(COMMAND);
      expect(await liveFor(COMMAND, { commandId: id })).toHaveLength(1);
      expect(runs).toEqual([]);

      await release();
      await makeReady(COMMAND);
      expect((await step(COMMAND))?.error).toBeUndefined();
      expect(runs).toEqual(["command:INBOX"]);
      expect(await liveFor(COMMAND, { commandId: id })).toHaveLength(0);
    });

    it("keeps the busy delay short, capped and jittered", () => {
      expect(commandBusyDelaySeconds(0, () => 0)).toBe(2);
      expect(commandBusyDelaySeconds(0, () => 0.99)).toBe(3);
      expect(commandBusyDelaySeconds(50, () => 0.99)).toBe(7);
    });

    it("does not route a real mutation failure through the busy path (13)", async () => {
      const id = await seedCommand(a, a.box.INBOX!);
      await enqueueMessageCommand(boss, id);
      commandRun = async () => {
        throw new Error("IMAP mutation failed");
      };
      const result = await step(COMMAND);
      expect(result?.error).toBeInstanceOf(Error);
      const [job] = await boss.findJobs(COMMAND, { id: result!.job.id });
      expect(job?.state).toBe("retry"); // normal pg-boss failure path
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);
    });

    it("rethrows a busy error raised after run started", async () => {
      const id = await seedCommand(a, a.box.INBOX!);
      await enqueueMessageCommand(boss, id);
      commandRun = async () => {
        throw new MailboxBusyError();
      };
      const result = await step(COMMAND);
      expect(result?.error).toBeDefined(); // propagated, not deferred
      const [job] = await boss.findJobs(COMMAND, { id: result!.job.id });
      expect(job?.state).toBe("retry");
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);
    });

    it("does not lose the command when the successor cannot be stored (24)", async () => {
      const release = await hold(a.box.INBOX!);
      const id = await seedCommand(a, a.box.INBOX!);
      await enqueueMessageCommand(boss, id);
      let sends = 0;
      await register(
        capturing({
          send: (async () => {
            sends++;
            throw new Error("send unavailable");
          }) as unknown as PgBoss["send"],
        }),
      );
      const result = await step(COMMAND);
      expect(sends).toBe(1);
      expect(result?.error).toBeInstanceOf(Error);
      const [job] = await boss.findJobs(COMMAND, { id: result!.job.id });
      expect(job?.state).toBe("retry"); // pg-boss retry, never silent loss
      expect(await commandRow(id)).toMatchObject({ status: "pending" });
      await release();
    });

    it("keeps one successor under concurrent busy continuations, retries and poller (23)", async () => {
      const id = await seedCommand(a, a.box.INBOX!);
      await enqueueMessageCommand(boss, id);
      const [job] = await boss.fetch(COMMAND, { includeMetadata: true });
      const poller = new MessageCommandPoller(boss, {
        pendingIds: async () => [id],
      } as unknown as MessageCommandService);
      await Promise.all([
        enqueueMessageCommand(boss, id, { mode: "continue", startAfter: 2 }),
        enqueueMessageCommand(boss, id, { mode: "continue", startAfter: 2 }),
        enqueueMessageCommand(boss, id),
        enqueueMessageCommand(boss, id),
        poller.start(),
      ]);
      poller.stop();
      const all = await jobsFor(COMMAND, { commandId: id });
      expect(all.filter((item) => item.state === "created")).toHaveLength(1);
      expect(all.find((item) => item.id === job!.id)?.state).toBe("active");
    });

    it("does not hold PostgreSQL sessions or worker slots while busy (25)", async () => {
      const small = createDatabase({ databaseUrl, databasePoolSize: 2 });
      try {
        await register(capturing(), createMailboxLock(small.client));
        const release = await hold(a.box.INBOX!);
        const ids = await Promise.all(
          Array.from({ length: 8 }, () => seedCommand(a, a.box.INBOX!)),
        );
        for (const id of ids) await enqueueMessageCommand(boss, id);
        // Eight handlers over a two-session pool all return without waiting.
        const results = [];
        for (let i = 0; i < ids.length; i++) results.push(step(COMMAND));
        const settled = await Promise.all(results);
        expect(settled.every((result) => result?.error === undefined)).toBe(
          true,
        );
        expect(runs).toEqual([]);
        const first = await small.client.reserve();
        const second = await small.client.reserve();
        first.release();
        second.release();
        const { rows } = await sql(
          "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = 'created'",
          [COMMAND],
        );
        expect(rows[0]).toEqual({ n: 8 });
        await release();
      } finally {
        await small.client.end();
      }
    });

    it("keeps accounts independent: a held mailbox of A does not stop B (26)", async () => {
      const release = await hold(a.box.INBOX!);
      const commandA = await seedCommand(a, a.box.INBOX!);
      const commandB = await seedCommand(b, b.box.INBOX!);
      await enqueueMessageCommand(boss, commandA);
      await enqueueMessageCommand(boss, commandB);
      await step(COMMAND);
      await step(COMMAND);
      expect(runs).toEqual(["command:INBOX"]);
      expect(await liveFor(COMMAND, { commandId: commandA })).toHaveLength(1);
      expect(await liveFor(COMMAND, { commandId: commandB })).toHaveLength(0);
      await release();
    });

    it("serializes concurrent commands of one mailbox without overlap (15)", async () => {
      const first = await seedCommand(a, a.box.INBOX!);
      const second = await seedCommand(a, a.box.INBOX!);
      await enqueueMessageCommand(boss, first);
      await enqueueMessageCommand(boss, second);
      let active = 0;
      let overlap = 0;
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => (unblock = resolve));
      commandRun = async (id) => {
        active++;
        overlap = Math.max(overlap, active);
        if (id === first) await gate;
        runs.push(`done:${id === first ? "first" : "second"}`);
        active--;
      };
      const slow = step(COMMAND);
      await vi.waitFor(() => expect(active).toBe(1));
      await step(COMMAND); // the second command hits the lock and defers
      expect(overlap).toBe(1);
      unblock();
      await slow;
      await makeReady(COMMAND);
      await step(COMMAND);
      expect(runs).toEqual(["done:first", "done:second"]);
      expect(overlap).toBe(1);
    });
  });

  describe("commands outrank sync of their mailbox", () => {
    const syncOf = (queue: string, mailboxId: string, account = a) => {
      if (queue === RECENT) return enqueueRecent(boss, account.id, mailboxId);
      if (queue === DELTA)
        return enqueueDelta(boss, account.id, mailboxId, "poll");
      return enqueueBackfill(boss, account.id, mailboxId);
    };

    it("admission gate: every kind and tier yields only to a runnable command of its own mailbox (4-7)", async () => {
      await seedCommand(a, a.box.Archive!);
      for (const kind of ["fresh", "history"] as const) {
        expect(
          await higherPriorityWorkWaiting(boss, a.id, a.box.Archive!, kind),
        ).toBe(true);
        // INBOX of the same account and other accounts are not held back.
        expect(
          await higherPriorityWorkWaiting(boss, a.id, a.box.INBOX!, kind),
        ).toBe(false);
        expect(
          await higherPriorityWorkWaiting(boss, b.id, b.box.Archive!, kind),
        ).toBe(false);
      }
      await seedCommand(a, a.box.INBOX!);
      // INBOX-first never outranks a user action.
      expect(
        await higherPriorityWorkWaiting(boss, a.id, a.box.INBOX!, "fresh"),
      ).toBe(true);
    });

    it.each([
      ["recent", RECENT],
      ["delta", DELTA],
      ["backfill", BACKFILL],
    ])(
      "%s yields to a pending command before locking and returns once it is done (4-6)",
      async (_name, queue) => {
        for (const path of ["Archive", "INBOX"]) {
          const mailbox = a.box[path]!;
          runs.length = 0;
          await sql("DELETE FROM pgboss.job");
          const id = await seedCommand(a, mailbox);
          await syncOf(queue, mailbox);
          const result = await step(queue);
          expect(result?.error).toBeUndefined();
          expect(runs).toEqual([]);
          expect(await liveFor(queue, { mailboxId: mailbox })).toHaveLength(1);
          // The command finishes; the successor then runs the sync.
          await database.db
            .update(messageCommands)
            .set({ status: "succeeded" })
            .where(eq(messageCommands.id, id));
          await makeReady(queue);
          await step(queue);
          expect(runs).toHaveLength(1);
        }
      },
    );

    it("a command of another mailbox or account leaves sync untouched (7)", async () => {
      await seedCommand(a, a.box.Archive!);
      await seedCommand(b, b.box.INBOX!);
      await syncOf(DELTA, a.box.INBOX!);
      await syncOf(DELTA, b.box.Archive!, b);
      await step(DELTA);
      await step(DELTA);
      expect([...runs].sort()).toEqual(["delta:Archive", "delta:INBOX"]);
    });

    it("an orphaned, started or finished command does not hold sync back (14)", async () => {
      const orphan = await seedCommand(a, a.box.Archive!);
      await database.db
        .update(messageCommands)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(messageCommands.id, orphan));
      for (const status of ["executing", "succeeded", "failed"])
        await seedCommand(a, a.box.Archive!, status);
      expect(
        await higherPriorityWorkWaiting(boss, a.id, a.box.Archive!, "history"),
      ).toBe(false);
    });

    it("an active lock is respected rather than bypassed", async () => {
      const release = await hold(a.box.Archive!);
      await syncOf(DELTA, a.box.Archive!);
      await step(DELTA);
      expect(runs).toEqual([]);
      expect(await liveFor(DELTA, { mailboxId: a.box.Archive! })).toHaveLength(
        1,
      );
      await release();
    });
  });

  describe("command job deduplication", () => {
    it("API, retries and poller do not multiply queued, retry or active jobs (8)", async () => {
      const id = await seedCommand(a, a.box.INBOX!);
      const poller = new MessageCommandPoller(boss, {
        pendingIds: async () => [id],
      } as unknown as MessageCommandService);
      await Promise.all([
        enqueueMessageCommand(boss, id),
        enqueueMessageCommand(boss, id),
        enqueueMessageCommand(boss, id),
      ]);
      await poller.start();
      poller.stop();
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);

      const [job] = await boss.fetch(COMMAND, { includeMetadata: true });
      await boss.fail(COMMAND, job!.id);
      expect((await jobsFor(COMMAND, { commandId: id }))[0]?.state).toBe(
        "retry",
      );
      await poller.start();
      poller.stop();
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);

      await makeReady(COMMAND);
      await boss.fetch(COMMAND);
      await poller.start();
      poller.stop();
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);

      // Age alone never orphans an active job: a live worker keeps its job.
      await ageActive(COMMAND);
      await poller.start();
      poller.stop();
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);
    });

    it("the poller repairs a command written without an enqueue (10)", async () => {
      const id = await seedCommand(a, a.box.INBOX!); // crash before enqueue
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(0);
      const poller = new MessageCommandPoller(boss, {
        pendingIds: async () => [id],
      } as unknown as MessageCommandService);
      await poller.start();
      poller.stop();
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);
      expect((await step(COMMAND))?.error).toBeUndefined();
      expect(runs).toEqual(["command:INBOX"]);
    });
  });

  describe("interactive fetching", () => {
    it("a slow content fetch does not stop an unrelated one (16)", async () => {
      const slow = randomUUID();
      const fast = randomUUID();
      const done: string[] = [];
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => (unblock = resolve));
      const service = {
        run: async (_account: string, _mailbox: string, message: string) => {
          if (message === slow) await gate;
          done.push(message === slow ? "slow" : "fast");
        },
      } as unknown as MessageContentService;
      await registerContentWorker(boss, service);
      try {
        for (const message of [slow, fast])
          await boss.send(
            CONTENT,
            {
              version: 1,
              accountId: a.id,
              mailboxId: a.box.INBOX,
              messageId: message,
            },
            { singletonKey: `${a.box.INBOX}:${message}` },
          );
        await vi.waitFor(() => expect(done).toEqual(["fast"]), {
          timeout: 20_000,
        });
        unblock();
        await vi.waitFor(() => expect(done).toEqual(["fast", "slow"]), {
          timeout: 20_000,
        });
      } finally {
        unblock();
        await boss.offWork(CONTENT);
      }
    });

    let nextUid = 0;
    const seedContent = async (status: string, ageSeconds: number) => {
      const messageId = randomUUID();
      const now = new Date();
      await database.db.insert(messages).values({
        id: messageId,
        accountId: a.id,
        internalDate: now,
        size: 1n,
      });
      await database.db.insert(mailboxMessages).values({
        id: randomUUID(),
        mailboxId: a.box.INBOX!,
        messageId,
        uidValidity: 7n,
        uid: BigInt((nextUid += 1)),
        flags: [],
        firstSynchronizedAt: now,
        lastSynchronizedAt: now,
      });
      await database.db.insert(messageContents).values({
        messageId,
        status,
        updatedAt: new Date(Date.now() - ageSeconds * 1000),
      });
      return messageId;
    };

    it("repairs only stale pending/fetching content without a live job (17, 18)", async () => {
      const service = new MessageContentService(database.db);
      const orphanPending = await seedContent("pending", 120);
      const orphanFetching = await seedContent("fetching", 120);
      const fresh = await seedContent("pending", 1);
      const ready = await seedContent("ready", 600);
      const failed = await seedContent("failed", 600);
      const candidates = (await service.orphanedRequests()).map(
        (row) => row.messageId,
      );
      expect([...candidates].sort()).toEqual(
        [orphanPending, orphanFetching].sort(),
      );
      for (const excluded of [fresh, ready, failed])
        expect(candidates).not.toContain(excluded);

      const poller = new ContentRepairPoller(boss, service);
      await poller.start();
      poller.stop();
      for (const messageId of [orphanPending, orphanFetching])
        expect(await liveFor(CONTENT, { messageId })).toHaveLength(1);

      // A second and a concurrent poll never duplicate queued work.
      await Promise.all([poller.start(), poller.start()]);
      poller.stop();
      expect(await jobsFor(CONTENT, { messageId: orphanPending })).toHaveLength(
        1,
      );

      // An active fetch is not fetched twice by repair...
      await boss.fetch(CONTENT, { batchSize: 2 });
      await poller.start();
      poller.stop();
      expect(await jobsFor(CONTENT, { messageId: orphanPending })).toHaveLength(
        1,
      );
      // ...even when it has been active for a long time.
      await ageActive(CONTENT);
      await poller.start();
      poller.stop();
      expect(await jobsFor(CONTENT, { messageId: orphanPending })).toHaveLength(
        1,
      );
    });

    it("attachment requests and repair do not multiply jobs for one large attachment (19)", async () => {
      const id = randomUUID();
      await Promise.all(
        Array.from({ length: 6 }, () => enqueueAttachment(boss, id)),
      );
      expect(
        await jobsFor(ATTACHMENT_QUEUE, { attachmentId: id }),
      ).toHaveLength(1);
      await boss.fetch(ATTACHMENT_QUEUE);
      // Repair ticks every 30 s while the large fetch is still active.
      for (let tick = 0; tick < 3; tick++) await enqueueAttachment(boss, id);
      expect(
        await jobsFor(ATTACHMENT_QUEUE, { attachmentId: id }),
      ).toHaveLength(1);
      // Distinct attachments (many CIDs) stay independent.
      const other = randomUUID();
      await enqueueAttachment(boss, other);
      expect(
        await jobsFor(ATTACHMENT_QUEUE, { attachmentId: other }),
      ).toHaveLength(1);
    });
  });
});
