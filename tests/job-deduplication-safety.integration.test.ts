// Job deduplication and orphan recovery. Never uses DATABASE_URL or
// TEST_DATABASE_URL: a disposable PostgreSQL container, its own pg-boss, the
// real advisory locks and fake providers. Time is controlled through the job
// table (started_on, heartbeat_on) and boss.supervise(); nothing waits minutes.
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
  afterEach,
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
  messageContents,
  messages,
} from "@/shared/infrastructure/database/schema";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import type {
  MailProvider,
  RemoteMutationResult,
} from "@/modules/accounts/domain/mail-provider";
import {
  JOB_HEARTBEAT_SECONDS,
  ensureHeartbeatQueue,
} from "@/modules/mail/infrastructure/deduplicated-enqueue";
import {
  MESSAGE_COMMAND_QUEUE as COMMAND,
  MessageCommandPoller,
  enqueueMessageCommand,
  ensureMessageCommandQueue,
  registerMessageCommandWorker,
} from "@/modules/mail/infrastructure/message-command-jobs";
import {
  ContentRepairPoller,
  MESSAGE_CONTENT_QUEUE as CONTENT,
  enqueueContentRepair,
  ensureContentQueue,
  registerContentWorker,
} from "@/modules/mail/infrastructure/content-jobs";
import {
  ATTACHMENT_QUEUE as ATTACHMENT,
  AttachmentPoller,
  enqueueAttachment,
  ensureAttachmentQueue,
  registerAttachmentWorker,
} from "@/modules/mail/infrastructure/attachment-jobs";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
import { createAttachmentLock } from "@/modules/mail/infrastructure/attachment-lock";

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const WAIT = { timeout: 40_000, interval: 250 };

describe("job deduplication and orphan recovery (isolated PostgreSQL)", () => {
  let container: StartedTestContainer;
  let databaseUrl: string;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let lock: ReturnType<typeof createMailboxLock>;
  let accountId: string;
  let inboxId: string;
  let archiveId: string;

  // Fake IMAP provider state.
  let mutations: string[];
  let mutateGate: Gate | undefined;
  let outcome: RemoteMutationResult;

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
      mutations.push(request.action);
      if (mutateGate) await mutateGate.promise;
      return outcome;
    },
  };
  const accountsStub = {
    getProviderImapAccountForWork: async () => ({}),
  } as never;
  let commands: MessageCommandService;

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
  /** A job that has been running for ten minutes with a healthy heartbeat. */
  const ageActive = (queue: string) =>
    sql(
      `UPDATE pgboss.job SET started_on = now() - interval '10 minutes'
        WHERE name = $1 AND state = 'active'`,
      [queue],
    );
  /** The worker died: its heartbeat stopped long ago (job age is irrelevant). */
  const killHeartbeat = (queue: string) =>
    sql(
      `UPDATE pgboss.job SET heartbeat_on = now() - interval '10 minutes'
        WHERE name = $1 AND state = 'active'`,
      [queue],
    );
  /** The job passed expireInSeconds. */
  const expireActive = (queue: string) =>
    sql(
      `UPDATE pgboss.job SET started_on = now() - interval '20 minutes'
        WHERE name = $1 AND state = 'active'`,
      [queue],
    );
  /** The supervisor throttles per queue; clear its claim to run a pass now. */
  const supervise = async (instance: PgBoss, queue?: string) => {
    await sql(
      `UPDATE pgboss.queue SET monitor_claim_on = NULL, monitor_on = NULL
        WHERE $1::text IS NULL OR name = $1`,
      [queue ?? null],
    );
    await instance.supervise(queue);
    // Stately queues claim from the queue stats snapshot, which still lists
    // the key as active after the pass that failed its job; a second pass
    // refreshes it (in production the next supervise interval does).
    await sql(
      `UPDATE pgboss.queue SET monitor_claim_on = NULL, monitor_on = NULL
        WHERE $1::text IS NULL OR name = $1`,
      [queue ?? null],
    );
    await instance.supervise(queue);
  };
  const state = async (queue: string, data: object) =>
    (await jobsFor(queue, data)).map((job) => job.state).sort();

  const commandRow = async (id: string) =>
    (
      await database.db
        .select()
        .from(messageCommands)
        .where(eq(messageCommands.id, id))
    )[0]!;

  let uid = 100;
  const seedMessage = async (mailboxId: string) => {
    const messageId = randomUUID();
    const now = new Date();
    await database.db.insert(messages).values({
      id: messageId,
      accountId,
      internalDate: now,
      size: 1n,
    });
    await database.db.insert(mailboxMessages).values({
      id: randomUUID(),
      mailboxId,
      messageId,
      uidValidity: 7n,
      uid: BigInt((uid += 1)),
      flags: [],
      firstSynchronizedAt: now,
      lastSynchronizedAt: now,
    });
    return messageId;
  };
  const seedCommand = async (action: "mark_read" | "archive") => {
    const messageId = await seedMessage(inboxId);
    const command = await commands.create(
      accountId,
      inboxId,
      messageId,
      action,
    );
    await sql("DELETE FROM pgboss.job WHERE name = $1", [COMMAND]);
    return command.id;
  };
  const seedContent = async (status: string, ageSeconds = 120) => {
    const messageId = await seedMessage(inboxId);
    await database.db.insert(messageContents).values({
      messageId,
      status,
      updatedAt: new Date(Date.now() - ageSeconds * 1000),
    });
    return messageId;
  };
  const seedAttachment = async (status: string) => {
    const messageId = await seedMessage(inboxId);
    const id = randomUUID();
    await database.db.insert(messageAttachments).values({
      id,
      messageId,
      sourceMailboxId: inboxId,
      sourceUidValidity: 7n,
      sourceUid: 1n,
      partId: "2",
      contentType: "application/pdf",
      inline: false,
      visible: true,
      status,
    });
    return id;
  };

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "job_dedup_isolated",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    databaseUrl = `postgresql://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/job_dedup_isolated`;
    database = createDatabase({ databaseUrl, databasePoolSize: 12 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({
      connectionString: databaseUrl,
      queueCacheIntervalSeconds: 1,
    });
    boss.on("error", () => undefined);
    await boss.start();
    await ensureMessageCommandQueue(boss);
    await ensureContentQueue(boss);
    await ensureAttachmentQueue(boss);
    lock = createMailboxLock(database.client);

    accountId = randomUUID();
    inboxId = randomUUID();
    archiveId = randomUUID();
    const now = new Date();
    await database.db.insert(mailAccounts).values({
      id: accountId,
      displayName: "Fixture",
      email: `${accountId}@example.invalid`,
      imapHost: "imap.invalid",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: { fixture: true } as never,
      smtpHost: "smtp.invalid",
      smtpPort: 465,
      smtpSecurity: "tls",
      imapCapabilities: ["MOVE"],
    });
    await database.db.insert(mailboxes).values([
      {
        id: inboxId,
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
        remotePath: "Archive",
        name: "Archive",
        selectable: true,
        specialUse: ["\\Archive"],
        uidValidity: 9n,
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
      },
    ]);
    await new MailboxRoleService(database.db).autodetect(accountId);
    commands = new MessageCommandService(
      database.db,
      async (id) => {
        await enqueueMessageCommand(boss, id);
      },
      async () => undefined,
      accountsStub,
      provider,
    );
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    mutations = [];
    mutateGate = undefined;
    outcome = { outcome: "applied" } as RemoteMutationResult;
    await sql("DELETE FROM pgboss.job");
    await database.db.delete(messageCommands);
    await database.db.delete(messageContents);
    await database.db.delete(messageAttachments);
  });
  afterEach(async () => {
    mutateGate?.open();
    for (const queue of [COMMAND, CONTENT, ATTACHMENT])
      await boss.offWork(queue).catch(() => undefined);
  });

  describe("liveness contract", () => {
    it("enables the pg-boss heartbeat on all three queues and upgrades older queues", async () => {
      for (const queue of [COMMAND, CONTENT, ATTACHMENT])
        expect((await boss.getQueue(queue))?.heartbeatSeconds).toBe(
          JOB_HEARTBEAT_SECONDS,
        );
      // A queue created by an earlier version (no heartbeat) is upgraded.
      const legacy = `legacy-${randomUUID()}`;
      await boss.createQueue(legacy, { expireInSeconds: 900 });
      expect((await boss.getQueue(legacy))?.heartbeatSeconds).toBeNull();
      await ensureHeartbeatQueue(boss, legacy, { expireInSeconds: 900 });
      expect((await boss.getQueue(legacy))?.heartbeatSeconds).toBe(
        JOB_HEARTBEAT_SECONDS,
      );
      // Idempotent: repeated startups keep the setting.
      await ensureHeartbeatQueue(boss, legacy, { expireInSeconds: 900 });
      expect((await boss.getQueue(legacy))?.heartbeatSeconds).toBe(
        JOB_HEARTBEAT_SECONDS,
      );
      await boss.deleteQueue(legacy);
    });

    it("new jobs carry the heartbeat", async () => {
      const id = randomUUID();
      await enqueueAttachment(boss, id);
      const [job] = await boss.fetch(ATTACHMENT, { includeMetadata: true });
      expect(job?.heartbeatSeconds).toBe(JOB_HEARTBEAT_SECONDS);
    });
  });

  describe("long-running live workers are never replaced (1-4)", () => {
    it("command: a live job older than 120 s keeps one job and one remote call", async () => {
      const id = await seedCommand("mark_read");
      mutateGate = gate();
      await registerMessageCommandWorker(boss, commands, lock);
      await enqueueMessageCommand(boss, id);
      await vi.waitFor(() => expect(mutations).toHaveLength(1), WAIT);

      await ageActive(COMMAND);
      const poller = new MessageCommandPoller(boss, commands);
      await poller.start();
      poller.stop();
      await enqueueMessageCommand(boss, id);
      expect(await state(COMMAND, { commandId: id })).toEqual(["active"]);
      // The supervisor does not touch a live job: its heartbeat is fresh.
      await supervise(boss, COMMAND);
      expect(await state(COMMAND, { commandId: id })).toEqual(["active"]);

      mutateGate.open();
      await vi.waitFor(
        async () => expect((await commandRow(id)).status).toBe("succeeded"),
        WAIT,
      );
      expect(mutations).toEqual(["mark_read"]);
    });

    it("content: a live job older than 300 s is not replaced and fetches once", async () => {
      const messageId = await seedContent("fetching");
      let fetches = 0;
      const release = gate();
      await registerContentWorker(boss, {
        run: async () => {
          fetches += 1;
          await release.promise;
        },
      } as unknown as MessageContentService);
      const poller = new ContentRepairPoller(
        boss,
        new MessageContentService(database.db),
      );
      await poller.start();
      await vi.waitFor(() => expect(fetches).toBe(1), WAIT);

      await ageActive(CONTENT);
      await Promise.all([poller.start(), poller.start()]);
      poller.stop();
      expect(await state(CONTENT, { messageId })).toEqual(["active"]);
      await supervise(boss, CONTENT);
      expect(await state(CONTENT, { messageId })).toEqual(["active"]);

      release.open();
      await vi.waitFor(
        async () =>
          expect(await state(CONTENT, { messageId })).toEqual(["completed"]),
        WAIT,
      );
      expect(fetches).toBe(1);
    });

    it("attachment: a live job older than 300 s is not replaced and fetches once", async () => {
      const id = await seedAttachment("fetching");
      let fetches = 0;
      const release = gate();
      const withLock = createAttachmentLock(database.client);
      await registerAttachmentWorker(boss, {
        run: (attachmentId: string) =>
          withLock(attachmentId, async () => {
            fetches += 1;
            await release.promise;
          }),
      } as unknown as AttachmentService);
      await enqueueAttachment(boss, id);
      await vi.waitFor(() => expect(fetches).toBe(1), WAIT);

      await ageActive(ATTACHMENT);
      const service = new AttachmentService(
        database.db,
        {} as never,
        {} as never,
        async (attachmentId) => enqueueAttachment(boss, attachmentId),
      );
      const poller = new AttachmentPoller(service);
      await poller.start();
      poller.stop();
      await enqueueAttachment(boss, id);
      expect(await state(ATTACHMENT, { attachmentId: id })).toEqual(["active"]);
      await supervise(boss, ATTACHMENT);
      expect(await state(ATTACHMENT, { attachmentId: id })).toEqual(["active"]);

      release.open();
      await vi.waitFor(
        async () =>
          expect(await state(ATTACHMENT, { attachmentId: id })).toEqual([
            "completed",
          ]),
        WAIT,
      );
      expect(fetches).toBe(1);
    });
  });

  describe("worker crash recovery (5, 9, 10, 15)", () => {
    it("command: crash before the mutation is recovered by pg-boss and runs once", async () => {
      const id = await seedCommand("mark_read");
      await enqueueMessageCommand(boss, id);
      await boss.fetch(COMMAND); // claimed by a worker that then dies
      await killHeartbeat(COMMAND);
      await supervise(boss, COMMAND);
      expect(await state(COMMAND, { commandId: id })).toEqual(["retry"]);

      const poller = new MessageCommandPoller(boss, commands);
      await poller.start();
      poller.stop();
      expect(await jobsFor(COMMAND, { commandId: id })).toHaveLength(1);

      await makeReady(COMMAND);
      await registerMessageCommandWorker(boss, commands, lock);
      await vi.waitFor(
        async () => expect((await commandRow(id)).status).toBe("succeeded"),
        WAIT,
      );
      expect(mutations).toEqual(["mark_read"]);
    });

    it("command: crash during MOVE is never replayed, whatever the recovery path", async () => {
      const id = await seedCommand("archive");
      const [placement] = await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.id, (await commandRow(id)).placementId!));
      expect(placement?.actionHidden).toBe(true);
      // Mid-mutation state, also the state after a confirmed MOVE whose
      // result was never stored: the two are indistinguishable by design.
      await database.db
        .update(messageCommands)
        .set({ status: "executing", attempts: 1 })
        .where(eq(messageCommands.id, id));
      await enqueueMessageCommand(boss, id);
      await boss.fetch(COMMAND);
      await killHeartbeat(COMMAND);
      await supervise(boss, COMMAND);
      await makeReady(COMMAND);
      await registerMessageCommandWorker(boss, commands, lock);
      await vi.waitFor(
        async () => expect((await commandRow(id)).status).toBe("failed"),
        WAIT,
      );
      expect((await commandRow(id)).error).toMatch(/uncertain/i);
      expect(mutations).toEqual([]);
      const [after] = await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.id, placement!.id));
      expect(after?.actionHidden).toBe(false);
    });

    it("command: a pending-orphan poller replay of an uncertain MOVE only reconciles", async () => {
      const id = await seedCommand("archive");
      await database.db
        .update(messageCommands)
        .set({ status: "executing", attempts: 1 })
        .where(eq(messageCommands.id, id));
      // No job at all (crash after claim, job already failed): the poller
      // re-enqueues, and run() resolves the command without a remote call.
      const poller = new MessageCommandPoller(boss, commands);
      await poller.start();
      poller.stop();
      expect(await liveFor(COMMAND, { commandId: id })).toHaveLength(1);
      await registerMessageCommandWorker(boss, commands, lock);
      await vi.waitFor(
        async () => expect((await commandRow(id)).status).toBe("failed"),
        WAIT,
      );
      expect(mutations).toEqual([]);
    });

    it("command: a confirmed mutation is not repeated by a stray duplicate job", async () => {
      const id = await seedCommand("mark_read");
      await database.db
        .update(messageCommands)
        .set({ status: "succeeded", completedAt: new Date() })
        .where(eq(messageCommands.id, id));
      await boss.send(COMMAND, { commandId: id });
      await boss.send(COMMAND, { commandId: id });
      await registerMessageCommandWorker(boss, commands, lock);
      // Concurrent duplicates may meet the mailbox lock and defer once (one
      // short successor); every job still ends without a provider call.
      await vi.waitFor(async () => {
        await makeReady(COMMAND);
        const jobs = await jobsFor(COMMAND, { commandId: id });
        expect(jobs.length).toBeGreaterThanOrEqual(2);
        expect(jobs.every((job) => job.state === "completed")).toBe(true);
      }, WAIT);
      expect(mutations).toEqual([]);
    });

    it("command: pg-boss expiry of a still-working job never repeats the remote call", async () => {
      const id = await seedCommand("mark_read");
      mutateGate = gate();
      await registerMessageCommandWorker(boss, commands, lock);
      await enqueueMessageCommand(boss, id);
      await vi.waitFor(() => expect(mutations).toHaveLength(1), WAIT);

      await expireActive(COMMAND);
      await supervise(boss, COMMAND);
      expect(await state(COMMAND, { commandId: id })).toEqual(["retry"]);
      await makeReady(COMMAND);
      // The retry runs while the first handler still holds the mailbox lock:
      // it defers (busy) instead of calling the provider.
      await vi.waitFor(async () => {
        const jobs = await jobsFor(COMMAND, { commandId: id });
        expect(jobs.some((job) => job.state === "completed")).toBe(true);
      }, WAIT);
      expect(mutations).toHaveLength(1);
      expect(await liveFor(COMMAND, { commandId: id })).toHaveLength(1);

      mutateGate.open();
      await vi.waitFor(
        async () => expect((await commandRow(id)).status).toBe("succeeded"),
        WAIT,
      );
      await makeReady(COMMAND);
      await vi.waitFor(
        async () =>
          expect(await liveFor(COMMAND, { commandId: id })).toEqual([]),
        WAIT,
      );
      expect(mutations).toEqual(["mark_read"]);
    });

    it("content: crashed fetch is recovered without a duplicate and runs again once", async () => {
      const messageId = await seedContent("fetching");
      await enqueueContentRepair(boss, accountId, inboxId, messageId);
      await boss.fetch(CONTENT);
      await killHeartbeat(CONTENT);
      await supervise(boss, CONTENT);
      expect(await state(CONTENT, { messageId })).toEqual(["retry"]);

      const poller = new ContentRepairPoller(
        boss,
        new MessageContentService(database.db),
      );
      await poller.start();
      poller.stop();
      expect(await jobsFor(CONTENT, { messageId })).toHaveLength(1);

      let runs = 0;
      await makeReady(CONTENT);
      await registerContentWorker(boss, {
        run: async () => {
          runs += 1;
        },
      } as unknown as MessageContentService);
      await vi.waitFor(
        async () =>
          expect(await state(CONTENT, { messageId })).toEqual(["completed"]),
        WAIT,
      );
      expect(runs).toBe(1);
    });

    it("content: pending and fetching rows without any job are repaired", async () => {
      const pending = await seedContent("pending");
      const fetching = await seedContent("fetching");
      const poller = new ContentRepairPoller(
        boss,
        new MessageContentService(database.db),
      );
      await poller.start();
      poller.stop();
      for (const messageId of [pending, fetching])
        expect(await liveFor(CONTENT, { messageId })).toHaveLength(1);
    });

    it("attachment: crashed fetch fails in pg-boss and the poller re-enqueues exactly once", async () => {
      const id = await seedAttachment("fetching");
      await enqueueAttachment(boss, id);
      await boss.fetch(ATTACHMENT);
      await killHeartbeat(ATTACHMENT);
      await supervise(boss, ATTACHMENT);
      expect(await state(ATTACHMENT, { attachmentId: id })).toEqual(["failed"]);

      const service = new AttachmentService(
        database.db,
        {} as never,
        {} as never,
        async (attachmentId) => enqueueAttachment(boss, attachmentId),
      );
      const poller = new AttachmentPoller(service);
      await poller.start();
      await poller.start();
      poller.stop();
      expect(await liveFor(ATTACHMENT, { attachmentId: id })).toHaveLength(1);
    });

    it("attachment: pending row without a job is repaired", async () => {
      const id = await seedAttachment("pending");
      const service = new AttachmentService(
        database.db,
        {} as never,
        {} as never,
        async (attachmentId) => enqueueAttachment(boss, attachmentId),
      );
      const poller = new AttachmentPoller(service);
      await poller.start();
      poller.stop();
      expect(await liveFor(ATTACHMENT, { attachmentId: id })).toHaveLength(1);
    });

    it("a restarted pg-boss instance leaves no permanently orphaned work", async () => {
      const commandId = await seedCommand("mark_read");
      const contentId = await seedContent("fetching");
      const attachmentId = await seedAttachment("pending");
      // Previous process: three claimed jobs, then death.
      await enqueueMessageCommand(boss, commandId);
      await enqueueContentRepair(boss, accountId, inboxId, contentId);
      await enqueueAttachment(boss, attachmentId);
      await boss.fetch(COMMAND);
      await boss.fetch(CONTENT);
      await boss.fetch(ATTACHMENT);
      for (const queue of [COMMAND, CONTENT, ATTACHMENT])
        await killHeartbeat(queue);

      // New process: own pg-boss, supervisor pass, pollers, workers.
      const restarted = new PgBoss({
        connectionString: databaseUrl,
        queueCacheIntervalSeconds: 1,
      });
      restarted.on("error", () => undefined);
      await restarted.start();
      try {
        await supervise(restarted);
        await makeReady(COMMAND);
        await makeReady(CONTENT);
        const contentRuns: string[] = [];
        const service = new AttachmentService(
          database.db,
          {} as never,
          {} as never,
          async (id) => enqueueAttachment(restarted, id),
        );
        const attachmentRuns: string[] = [];
        await registerMessageCommandWorker(restarted, commands, lock);
        await registerContentWorker(restarted, {
          run: async (_a: string, _m: string, messageId: string) => {
            contentRuns.push(messageId);
            await database.db
              .update(messageContents)
              .set({ status: "ready", updatedAt: new Date() })
              .where(eq(messageContents.messageId, messageId));
          },
        } as unknown as MessageContentService);
        await registerAttachmentWorker(restarted, {
          run: async (id: string) => {
            attachmentRuns.push(id);
            await database.db
              .update(messageAttachments)
              .set({ status: "ready", updatedAt: new Date() })
              .where(eq(messageAttachments.id, id));
          },
        } as unknown as AttachmentService);
        const pollers = [
          new MessageCommandPoller(restarted, commands),
          new ContentRepairPoller(
            restarted,
            new MessageContentService(database.db),
          ),
          new AttachmentPoller(service),
        ];
        for (const poller of pollers) {
          await poller.start();
          poller.stop();
        }
        await vi.waitFor(async () => {
          expect((await commandRow(commandId)).status).toBe("succeeded");
          expect(contentRuns).toEqual([contentId]);
          expect(attachmentRuns).toEqual([attachmentId]);
        }, WAIT);
        expect(mutations).toEqual(["mark_read"]);
        for (const [queue, data] of [
          [COMMAND, { commandId }],
          [CONTENT, { messageId: contentId }],
          [ATTACHMENT, { attachmentId }],
        ] as const)
          await vi.waitFor(
            async () => expect(await liveFor(queue, data)).toEqual([]),
            WAIT,
          );
      } finally {
        await restarted.stop();
      }
    });
  });

  describe("no parallel execution (6, 13)", () => {
    it("content: duplicate jobs for one key never run concurrently", async () => {
      const messageId = randomUUID();
      const payload = {
        version: 1,
        accountId,
        mailboxId: inboxId,
        messageId,
      };
      let running = 0;
      let max = 0;
      let total = 0;
      const release = gate();
      await registerContentWorker(boss, {
        run: async () => {
          running += 1;
          total += 1;
          max = Math.max(max, running);
          await release.promise;
          running -= 1;
        },
      } as unknown as MessageContentService);
      const singletonKey = `${inboxId}:${messageId}`;
      await boss.send(CONTENT, payload, { singletonKey });
      await vi.waitFor(() => expect(total).toBe(1), WAIT);
      // Forced duplicate (what a stale-age heuristic used to create).
      await boss.send(CONTENT, payload, { singletonKey });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(max).toBe(1);
      expect(total).toBe(1);
      release.open();
      await vi.waitFor(
        async () =>
          expect(await state(CONTENT, { messageId })).toEqual([
            "completed",
            "completed",
          ]),
        WAIT,
      );
      expect(max).toBe(1);
    });

    it("attachment: duplicate jobs for one attachment never fetch concurrently", async () => {
      const id = randomUUID();
      const withLock = createAttachmentLock(database.client);
      let running = 0;
      let max = 0;
      let fetches = 0;
      const release = gate();
      await registerAttachmentWorker(boss, {
        run: (attachmentId: string) =>
          withLock(attachmentId, async () => {
            running += 1;
            fetches += 1;
            max = Math.max(max, running);
            await release.promise;
            running -= 1;
          }),
      } as unknown as AttachmentService);
      await boss.send(ATTACHMENT, { attachmentId: id });
      await vi.waitFor(() => expect(fetches).toBe(1), WAIT);
      await boss.send(ATTACHMENT, { attachmentId: id });
      await vi.waitFor(async () => {
        const states = await state(ATTACHMENT, { attachmentId: id });
        expect(states).toContain("completed");
      }, WAIT);
      // The second job found the attachment lock held and ended without IMAP.
      expect(fetches).toBe(1);
      expect(max).toBe(1);
      release.open();
      await vi.waitFor(
        async () =>
          expect(await state(ATTACHMENT, { attachmentId: id })).toEqual([
            "completed",
            "completed",
          ]),
        WAIT,
      );
      expect(fetches).toBe(1);
    });
  });

  describe("producers (7, 8)", () => {
    it("many concurrent producers create one job per work item", async () => {
      const commandId = await seedCommand("mark_read");
      const messageId = await seedContent("pending");
      const attachmentId = randomUUID();
      await Promise.all(
        Array.from({ length: 24 }, () =>
          Promise.all([
            enqueueMessageCommand(boss, commandId),
            enqueueContentRepair(boss, accountId, inboxId, messageId),
            enqueueAttachment(boss, attachmentId),
          ]),
        ),
      );
      expect(await jobsFor(COMMAND, { commandId })).toHaveLength(1);
      expect(await jobsFor(CONTENT, { messageId })).toHaveLength(1);
      expect(await jobsFor(ATTACHMENT, { attachmentId })).toHaveLength(1);
    });

    it("busy continuations create at most one successor while the job is active", async () => {
      const commandId = await seedCommand("mark_read");
      await enqueueMessageCommand(boss, commandId);
      await boss.fetch(COMMAND); // the command's own active job
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          enqueueMessageCommand(boss, commandId, {
            mode: "continue",
            startAfter: 3,
            deferrals: 1,
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await state(COMMAND, { commandId })).toEqual([
        "active",
        "created",
      ]);
      // A request-mode producer sees the queued successor and adds nothing.
      expect(await enqueueMessageCommand(boss, commandId)).toBe(false);
    });
  });
});
