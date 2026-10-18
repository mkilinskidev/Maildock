// Job expiration versus heartbeat for the three deduplicated queues. Never uses
// DATABASE_URL or TEST_DATABASE_URL: a disposable PostgreSQL container, its own
// pg-boss, real advisory locks, real services and fake providers.
//
// The production queues expire after 900 s. After asserting that, the tests
// shorten `expireInSeconds` to EXPIRY_SECONDS on the throw-away database so the
// real pg-boss timers run in seconds. Heartbeat settings are production values.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  blobs,
  mailAccounts,
  mailboxes,
  mailboxMessages,
  messageAttachments,
  messageCommands,
  messageContents,
  messages,
} from "@/shared/infrastructure/database/schema";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/modules/mail/domain/attachments";
import type {
  MailProvider,
  RemoteMimePart,
  RemoteMutationResult,
} from "@/modules/accounts/domain/mail-provider";
import { JOB_HEARTBEAT_SECONDS } from "@/modules/mail/infrastructure/deduplicated-enqueue";
import {
  MESSAGE_COMMAND_QUEUE as COMMAND,
  enqueueMessageCommand,
  ensureMessageCommandQueue,
  registerMessageCommandWorker,
} from "@/modules/mail/infrastructure/message-command-jobs";
import {
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
const EXPIRY_SECONDS = 3;
const PROBE = "expiry-probe-v1";

const textPart = (id: string): RemoteMimePart => ({
  part: id,
  type: "text/plain",
  disposition: null,
  filename: null,
  contentId: null,
  encoding: "7bit",
  size: "5",
  parameters: {},
  dispositionParameters: {},
  children: [],
});
const mime = (children: RemoteMimePart[]): RemoteMimePart => ({
  ...textPart(""),
  type: "multipart/mixed",
  children,
});
const pdfPart = (id: string): RemoteMimePart => ({
  ...textPart(id),
  type: "application/pdf",
  disposition: "attachment",
  filename: "big.pdf",
  encoding: "base64",
});

describe("job expiration versus heartbeat (isolated PostgreSQL)", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let storageRoot: string;
  let storage: LocalBlobStorage;
  let accountId: string;
  let inboxId: string;
  let archiveId: string;

  let gates: Gate[];
  let mutations: string[];
  let contentCalls: number;
  let contentRunning: number;
  let contentMax: number;
  let attachmentCalls: number;
  const newGate = () => {
    const g = gate();
    gates.push(g);
    return g;
  };

  const sql = (text: string, values: unknown[] = []) =>
    boss.getDb().executeSql(text, values);
  const jobRows = async (queue: string, data: object) =>
    (
      await sql(
        `SELECT state, output, heartbeat_on, heartbeat_seconds, expire_seconds,
                retry_count, now() AS db_now
           FROM pgboss.job
          WHERE name = $1 AND data @> $2::jsonb
          ORDER BY created_on`,
        [queue, JSON.stringify(data)],
      )
    ).rows as {
      state: string;
      output: unknown;
      heartbeat_on: Date | null;
      heartbeat_seconds: number | null;
      expire_seconds: number;
      retry_count: number;
      db_now: Date;
    }[];
  const states = async (queue: string, data: object) =>
    (await jobRows(queue, data)).map((row) => row.state);
  const makeReady = (queue: string) =>
    sql(
      `UPDATE pgboss.job SET start_after = now()
        WHERE name = $1 AND state IN ('created', 'retry')`,
      [queue],
    );
  const supervise = async (queue: string) => {
    for (let pass = 0; pass < 2; pass += 1) {
      await sql(
        `UPDATE pgboss.queue SET monitor_claim_on = NULL, monitor_on = NULL
          WHERE name = $1`,
        [queue],
      );
      await boss.supervise(queue);
    }
  };
  const live = async (queue: string, data: object) =>
    (await states(queue, data)).filter((state) =>
      ["created", "retry", "active"].includes(state),
    );
  const mentions = (output: unknown, text: string) =>
    JSON.stringify(output ?? null).includes(text);

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
    fetchMessageContent: async () => {
      contentCalls += 1;
      contentRunning += 1;
      contentMax = Math.max(contentMax, contentRunning);
      try {
        await newGate().promise;
        return { plainText: "hello", html: null };
      } finally {
        contentRunning -= 1;
      }
    },
    mutateMessage: async (_account, request) => {
      mutations.push(request.action);
      await newGate().promise;
      return { outcome: "applied" } as RemoteMutationResult;
    },
    async fetchAttachment(_account, _request, consume) {
      attachmentCalls += 1;
      const release = newGate();
      return consume(
        Readable.from(
          (async function* () {
            await release.promise; // the transfer stalls mid-stream
            yield Buffer.from("%PDF-1.4 body");
          })(),
        ),
      );
    },
  };
  const accountsStub = {
    getProviderImapAccountForWork: async () => ({}),
  } as never;
  let commands: MessageCommandService;
  let attachments: AttachmentService;

  const seedMessage = async (
    mailboxId: string,
    uid: bigint,
    mimeStructure?: RemoteMimePart,
  ) => {
    const messageId = randomUUID();
    const now = new Date();
    await database.db.insert(messages).values({
      id: messageId,
      accountId,
      internalDate: now,
      size: 1n,
      ...(mimeStructure ? { mimeStructure } : {}),
    });
    await database.db.insert(mailboxMessages).values({
      id: randomUUID(),
      mailboxId,
      messageId,
      uidValidity: 7n,
      uid,
      flags: [],
      firstSynchronizedAt: now,
      lastSynchronizedAt: now,
    });
    return messageId;
  };
  let uid = 1000n;
  const nextUid = () => (uid += 1n);

  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "maildock-expiry-"));
    storage = new LocalBlobStorage(storageRoot);
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "job_expiry_isolated",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const databaseUrl = `postgresql://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/job_expiry_isolated`;
    database = createDatabase({ databaseUrl, databasePoolSize: 16 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    boss.on("error", () => undefined);
    await boss.start();
    await ensureMessageCommandQueue(boss);
    await ensureContentQueue(boss);
    await ensureAttachmentQueue(boss);

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
    attachments = new AttachmentService(
      database.db,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      async (id) => enqueueAttachment(boss, id),
      accountsStub,
      provider,
      createAttachmentLock(database.client),
    );
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    gates = [];
    mutations = [];
    contentCalls = 0;
    contentRunning = 0;
    contentMax = 0;
    attachmentCalls = 0;
    await sql("DELETE FROM pgboss.job");
    await database.db.delete(messageCommands);
    await database.db.delete(messageContents);
    await database.db.delete(messageAttachments);
    await database.db.delete(blobs);
  });
  afterEach(async () => {
    for (const g of gates) g.open();
    for (const queue of [COMMAND, CONTENT, ATTACHMENT, PROBE])
      await boss.offWork(queue).catch(() => undefined);
  });

  it("production queues use 900 s expiry and the 90 s heartbeat", async () => {
    for (const queue of [COMMAND, CONTENT, ATTACHMENT]) {
      const config = await boss.getQueue(queue);
      expect(config?.expireInSeconds).toBe(900);
      expect(config?.heartbeatSeconds).toBe(JOB_HEARTBEAT_SECONDS);
    }
    // The rest of the file shortens only the expiry, on this throw-away database.
    for (const queue of [COMMAND, CONTENT, ATTACHMENT])
      await boss.updateQueue(queue, { expireInSeconds: EXPIRY_SECONDS });
  });

  it("supervisor: a job past expireInSeconds with a fresh heartbeat is failed anyway (content, attachment)", async () => {
    const messageId = randomUUID();
    const attachmentId = randomUUID();
    await boss.send(CONTENT, { messageId });
    await boss.send(ATTACHMENT, { attachmentId });
    await boss.fetch(CONTENT);
    await boss.fetch(ATTACHMENT);
    for (const [queue, data] of [
      [CONTENT, { messageId }],
      [ATTACHMENT, { attachmentId }],
    ] as const) {
      const [row] = await jobRows(queue, data);
      expect(row?.state).toBe("active");
      expect(row?.heartbeat_seconds).toBe(JOB_HEARTBEAT_SECONDS);
      // Heartbeat is current: the cause below cannot be a heartbeat timeout.
      expect(row!.db_now.getTime() - row!.heartbeat_on!.getTime()).toBeLessThan(
        10_000,
      );
    }
    await sql(
      `UPDATE pgboss.job SET started_on = now() - interval '1 hour'
        WHERE name = ANY($1) AND state = 'active'`,
      [[CONTENT, ATTACHMENT]],
    );
    await supervise(CONTENT);
    await supervise(ATTACHMENT);
    const [content] = await jobRows(CONTENT, { messageId });
    const [attachment] = await jobRows(ATTACHMENT, { attachmentId });
    expect(content?.state).toBe("retry");
    expect(mentions(content?.output, "job timed out")).toBe(true);
    expect(attachment?.state).toBe("failed");
    expect(mentions(attachment?.output, "job timed out")).toBe(true);
  });

  it("pg-boss exposes an AbortSignal that fires at expiry; the handler keeps running and its result is dropped", async () => {
    await boss.createQueue(PROBE, {
      retryLimit: 0,
      expireInSeconds: EXPIRY_SECONDS,
      heartbeatSeconds: JOB_HEARTBEAT_SECONDS,
    });
    let signalAtStart: boolean | undefined;
    let signalAfterExpiry: boolean | undefined;
    let finished = false;
    const release = gate();
    await boss.work(PROBE, async ([job]) => {
      signalAtStart = job!.signal?.aborted;
      await release.promise;
      signalAfterExpiry = job!.signal?.aborted;
      finished = true;
      return { done: true };
    });
    const id = await boss.send(PROBE, { probe: randomUUID() });
    await new Promise<void>((resolve) => {
      const poll = setInterval(async () => {
        const [row] = (
          await sql(`SELECT state FROM pgboss.job WHERE id = $1`, [id])
        ).rows as { state: string }[];
        if (row?.state === "failed") {
          clearInterval(poll);
          resolve();
        }
      }, 250);
    });
    expect(signalAtStart).toBe(false);
    expect(finished).toBe(false); // still running although pg-boss failed the job
    release.open();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(finished).toBe(true);
    expect(signalAfterExpiry).toBe(true);
    const [row] = (
      await sql(`SELECT state, output FROM pgboss.job WHERE id = $1`, [id])
    ).rows as { state: string; output: unknown }[];
    // The late successful result neither completes nor revives the job.
    expect(row?.state).toBe("failed");
    expect(mentions(row?.output, "exceeded")).toBe(true);
  });

  it("command (MOVE): live handler outlives expiry, retry defers, the provider is called once", async () => {
    const messageId = await seedMessage(inboxId, nextUid());
    const command = await commands.create(
      accountId,
      inboxId,
      messageId,
      "archive",
    );
    const id = command.id;
    await sql("DELETE FROM pgboss.job WHERE name = $1", [COMMAND]);
    await registerMessageCommandWorker(
      boss,
      commands,
      createMailboxLock(database.client),
    );
    await enqueueMessageCommand(boss, id);
    await until(() => mutations.length === 1);

    const [fresh] = await jobRows(COMMAND, { commandId: id });
    expect(fresh?.state).toBe("active");
    expect(
      fresh!.db_now.getTime() - fresh!.heartbeat_on!.getTime(),
    ).toBeLessThan(JOB_HEARTBEAT_SECONDS * 1000);

    // The worker's own timer fails the job at expireInSeconds.
    await until(async () =>
      (await states(COMMAND, { commandId: id })).includes("retry"),
    );
    const [expired] = await jobRows(COMMAND, { commandId: id });
    expect(mentions(expired?.output, "exceeded")).toBe(true);
    expect(mutations).toEqual(["archive"]);
    expect((await commandRow(id)).status).toBe("executing");

    // The recovery attempt meets the mailbox lock held by the first handler.
    await until(async () => {
      await makeReady(COMMAND);
      return (await states(COMMAND, { commandId: id })).includes("completed");
    });
    expect(mutations).toEqual(["archive"]);

    gates.forEach((g) => g.open());
    await until(async () => (await commandRow(id)).status === "succeeded");
    await until(async () => {
      await makeReady(COMMAND);
      return (await live(COMMAND, { commandId: id })).length === 0;
    });
    expect(mutations).toEqual(["archive"]); // no double MOVE
  });

  it("content: expiry lets a second attempt fetch in parallel; both write the same consistent result", async () => {
    const messageId = await seedMessage(
      inboxId,
      nextUid(),
      mime([textPart("1")]),
    );
    await database.db
      .insert(messageContents)
      .values({ messageId, status: "pending" });
    const service = new MessageContentService(
      database.db,
      undefined,
      accountsStub,
      provider,
      { maxMessageTextPartBytes: 5 * 1024 * 1024 },
    );
    await registerContentWorker(boss, service);
    await enqueueContentRepair(boss, accountId, inboxId, messageId);
    await until(() => contentCalls === 1);
    await until(async () =>
      (await states(CONTENT, { messageId })).includes("retry"),
    );
    const [expired] = await jobRows(CONTENT, { messageId });
    expect(mentions(expired?.output, "exceeded")).toBe(true);

    // Content has no executor lock and the first job is no longer `active`,
    // so the stately policy lets the retry start while the first fetch lives.
    await until(async () => {
      await makeReady(CONTENT);
      return contentCalls === 2;
    });
    expect(contentMax).toBe(2);

    gates.forEach((g) => g.open());
    await until(async () => {
      const [row] = await database.db
        .select()
        .from(messageContents)
        .where(eq(messageContents.messageId, messageId));
      return row?.status === "ready" && row.plainText === "hello";
    });
    const rows = await database.db
      .select()
      .from(messageContents)
      .where(eq(messageContents.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBeNull();
    await until(async () => {
      await makeReady(CONTENT);
      return (await live(CONTENT, { messageId })).length === 0;
    });
    expect(contentCalls).toBe(2);
  });

  it("attachment: stalled transfer outlives expiry; the poller's job defers to the lock; one blob, ready once", async () => {
    const mailboxMessageUid = nextUid();
    const messageId = await seedMessage(
      inboxId,
      mailboxMessageUid,
      mime([textPart("1"), pdfPart("2")]),
    );
    const attachmentId = randomUUID();
    await database.db.insert(messageAttachments).values({
      id: attachmentId,
      messageId,
      sourceMailboxId: inboxId,
      sourceUidValidity: 7n,
      sourceUid: mailboxMessageUid,
      partId: "2",
      filename: "big.pdf",
      contentType: "application/pdf",
      disposition: "attachment",
      inline: false,
      visible: true,
      status: "pending",
    });
    await registerAttachmentWorker(boss, attachments);
    await enqueueAttachment(boss, attachmentId);
    await until(() => attachmentCalls === 1);
    await until(async () =>
      (await states(ATTACHMENT, { attachmentId })).includes("failed"),
    );
    const [expired] = await jobRows(ATTACHMENT, { attachmentId });
    expect(mentions(expired?.output, "exceeded")).toBe(true);
    const during = await database.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, attachmentId));
    expect(during[0]?.status).toBe("fetching");

    // Several poller passes while the transfer is stalled: each re-enqueued job
    // finds the attachment lock held and ends without touching IMAP.
    const poller = new AttachmentPoller(attachments);
    for (let pass = 0; pass < 3; pass += 1) {
      await poller.start();
      poller.stop();
      await until(
        async () => (await live(ATTACHMENT, { attachmentId })).length === 0,
      );
    }
    expect(attachmentCalls).toBe(1);

    gates.forEach((g) => g.open());
    await until(async () => {
      const [row] = await database.db
        .select()
        .from(messageAttachments)
        .where(eq(messageAttachments.id, attachmentId));
      return row?.status === "ready" && row.blobId !== null;
    });
    expect(await database.db.select().from(blobs)).toHaveLength(1);
    const files = (await readdir(storageRoot, { recursive: true })).length;
    expect(files).toBeGreaterThan(0);
    await poller.start();
    poller.stop();
    expect(await live(ATTACHMENT, { attachmentId })).toEqual([]);
    expect(attachmentCalls).toBe(1);
  });

  const commandRow = async (id: string) =>
    (
      await database.db
        .select()
        .from(messageCommands)
        .where(eq(messageCommands.id, id))
    )[0]!;
});

/** Polls a condition (sync or async) until true. */
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + WAIT.timeout;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline)
      throw new Error("Condition not reached in time.");
    await new Promise((resolve) => setTimeout(resolve, WAIT.interval));
  }
}
