import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { ReceivingDemand } from "@/modules/mail/application/receiving-demand";
import { persistMessageMetadata } from "@/modules/mail/application/message-metadata-persistence";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/modules/mail/domain/attachments";
import type { RemoteMessageMetadata } from "@/modules/accounts/domain/mail-provider";
import { JobRuntime } from "@/modules/jobs/infrastructure/job-runtime";
import { createLogger } from "@/shared/infrastructure/logging/logger";
import {
  ensureContentQueue,
  MESSAGE_CONTENT_QUEUE,
} from "@/modules/mail/infrastructure/content-jobs";
import {
  ensureMessageCommandQueue,
  enqueueMessageCommand,
  MESSAGE_COMMAND_QUEUE,
} from "@/modules/mail/infrastructure/message-command-jobs";
import {
  ensureAttachmentQueue,
  enqueueAttachment,
  ATTACHMENT_QUEUE,
} from "@/modules/mail/infrastructure/attachment-jobs";

const budget = () => ({ deadline: performance.now() + 5000 });
const metadata: RemoteMessageMetadata = {
  uid: "1",
  internalDate: "2026-01-01T00:00:00Z",
  size: "10",
  flags: [],
  envelope: {
    messageId: "<cutover@example.test>",
    subject: "Cutover boundary",
    from: [],
    sender: [],
    replyTo: [],
    to: [],
    cc: [],
    bcc: [],
  },
  hasAttachments: true,
  mimeStructure: {
    part: "1",
    type: "application/pdf",
    disposition: "attachment",
    filename: "fixture.pdf",
    encoding: "base64",
    size: "10",
    contentId: null,
    parameters: {},
    dispositionParameters: {},
    children: [],
  },
};

// Passing tests reproduce a BLOCKER, not Stage 4C acceptance. No guard is
// weakened, no secondary executor or Stage 6 route is invented by this fixture.
describe("Stage 4C cutover business compatibility blockers", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let jobs: JobRuntime;
  let url: string;
  let account: string, inbox: string, secondary: string, message: string;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture-only",
        POSTGRES_DB: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const root = postgres(
      `postgres://fixture:fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/fixture`,
    );
    await root`create role lane login password 'lane-fixture-only'`;
    await root`create database stage4c_boundary owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/stage4c_boundary`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 2 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 1);
    jobs = new JobRuntime(
      { databaseUrl: url },
      createLogger({ logLevel: "fatal" }),
    );
    await jobs.start();
    await ensureContentQueue(jobs.boss);
    await ensureMessageCommandQueue(jobs.boss);
    await ensureAttachmentQueue(jobs.boss);
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    account = randomUUID();
    inbox = randomUUID();
    secondary = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Cutover fixture",
      email: "cutover@example.test",
      imapHost: "invalid.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyId: "fixture",
        iv: "fixture",
        ciphertext: "fixture",
        authTag: "fixture",
      },
      smtpHost: "invalid.test",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    const now = new Date();
    await database.db.insert(mailboxes).values([
      {
        id: inbox,
        accountId: account,
        name: "INBOX",
        remotePath: "INBOX",
        selectable: true,
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
      },
      {
        id: secondary,
        accountId: account,
        name: "Sent",
        remotePath: "Sent",
        selectable: true,
        uidValidity: 7n,
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
      },
    ]);
    await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'sent',${secondary},'manual')`;
  });
  afterAll(async () => {
    await jobs?.stop();
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  async function enroll(legacyReady = false) {
    // Even manufacturing the old readiness fields before enrollment cannot make
    // unfenced business writers safe. Enrollment itself stays new-install only.
    if (legacyReady)
      await reader`update mailboxes set recent_sync_uid_validity=7,recent_sync_status='success' where id=${inbox}`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    const owner = { actor, generation: BigInt(lease.generation) };
    const persistence = new ReceivingPersistence(executor);
    await persistence.initialize(
      owner,
      inbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await persistence.persist(
      owner,
      inbox,
      {
        epoch: 7n,
        revision: 0n,
        freshThrough: 1n,
        historyBefore: 2n,
        reconcileAfter: 0n,
      },
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 1n,
          high: 1n,
          searched: [1n],
          confirmedAbsent: [],
        },
        metadata: [metadata],
      },
      budget(),
    );
    const [row] =
      await reader`select message_id from receiving_current_placements where mailbox_id=${inbox}`;
    message = row.message_id;
  }
  async function facts() {
    const [row] =
      await reader`select s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after,
      m.uid_validity,m.recent_sync_uid_validity,m.lifecycle_status,m.receiving_request_generation,m.receiving_due_at,
      (select flags from mailbox_messages where mailbox_id=m.id limit 1) as flags,
      (select count(*)::int from message_commands where account_id=${account}) as commands,
      (select count(*)::int from message_contents c join messages msg on msg.id=c.message_id where msg.account_id=${account}) as contents,
      (select count(*)::int from mailbox_messages where mailbox_id=m.id) as placements
      from mailboxes m join receiving_mailboxes s on s.mailbox_id=m.id where m.id=${inbox}`;
    return row;
  }
  const commands = () =>
    new MessageCommandService(
      database.db,
      (id) => enqueueMessageCommand(jobs.boss, id),
      async () => {},
    );
  const contentScheduler = {
    schedule: async (accountId: string, mailboxId: string, messageId: string) =>
      (await jobs.boss.send(
        MESSAGE_CONTENT_QUEUE,
        { version: 1, accountId, mailboxId, messageId },
        { singletonKey: `${mailboxId}:${messageId}` },
      )) !== null,
  };
  const attachments = () =>
    new AttachmentService(
      database.db,
      new LocalBlobStorage(tmpdir()),
      DEFAULT_ATTACHMENT_LIMITS,
      (id) => enqueueAttachment(jobs.boss, id),
    );

  it("control: the same business APIs persist intents and real pg-boss jobs without enrollment", async () => {
    await reader`update mailboxes set uid_validity=7,recent_sync_uid_validity=7,recent_sync_status='success' where id=${inbox}`;
    await database.db.transaction((tx) =>
      persistMessageMetadata(tx, account, inbox, 7n, [metadata], false),
    );
    const [placement] =
      await reader`select message_id from mailbox_messages where mailbox_id=${inbox}`;
    message = placement.message_id;
    const command = await commands().create(
      account,
      inbox,
      message,
      "mark_read",
    );
    expect(
      await new MessageContentService(database.db, contentScheduler).request(
        account,
        inbox,
        message,
      ),
    ).toBe(true);
    const [attachment] =
      await reader`select id from message_attachments where message_id=${message}`;
    await attachments().request(attachment.id);
    expect(
      (
        await reader`select status from message_commands where id=${command.id}`
      )[0].status,
    ).toBe("pending");
    expect(
      (
        await reader`select status from message_contents where message_id=${message}`
      )[0].status,
    ).toBe("pending");
    expect(
      (
        await reader`select status from message_attachments where id=${attachment.id}`
      )[0].status,
    ).toBe("pending");
    const queues = await reader`select name,state from pgboss.job where
      (name=${MESSAGE_COMMAND_QUEUE} and data->>'commandId'=${command.id}) or
      (name=${MESSAGE_CONTENT_QUEUE} and data->>'messageId'=${message}) or
      (name=${ATTACHMENT_QUEUE} and data->>'attachmentId'=${attachment.id}) order by name`;
    expect(queues).toEqual(
      [ATTACHMENT_QUEUE, MESSAGE_COMMAND_QUEUE, MESSAGE_CONTENT_QUEUE]
        .sort()
        .map((name) => ({ name, state: "created" })),
    );
  });
  it("new INBOX metadata is visible but message actions still require retired recent-sync readiness", async () => {
    await enroll();
    const before = await facts();
    expect(before.placements).toBe(1);
    expect(before.recent_sync_uid_validity).toBeNull();
    await expect(
      commands().create(account, inbox, message, "mark_read"),
    ).rejects.toThrow("This mailbox is not ready for message actions.");
    expect(await facts()).toEqual(before);
  });
  it("legacy readiness fields cannot bypass the guard: optimistic command intent rolls back", async () => {
    await enroll(true);
    const before = await facts();
    await expect(
      commands().create(account, inbox, message, "mark_read"),
    ).rejects.toMatchObject({
      cause: { message: "Receiving authoritative write context missing" },
    });
    expect(await facts()).toEqual(before);
    expect((await facts()).commands).toBe(0);
  });
  it("content requests fail before durable intent or queue submission after enrollment", async () => {
    await enroll();
    const before = await facts();
    const content = new MessageContentService(database.db, contentScheduler);
    await expect(
      content.request(account, inbox, message),
    ).rejects.toMatchObject({
      cause: { message: "Receiving content capability disabled" },
    });
    expect(await facts()).toEqual(before);
  });
  it("attachment requests cannot transition the new receiver's discovered attachment to pending", async () => {
    await enroll();
    const [attachment] =
      await reader`select id,status,blob_id from message_attachments where message_id=${message}`;
    expect(attachment).toBeDefined();
    await expect(attachments().request(attachment.id)).rejects.toMatchObject({
      cause: { message: "Receiving authoritative write context missing" },
    });
    expect(
      (
        await reader`select id,status,blob_id from message_attachments where id=${attachment.id}`
      )[0],
    ).toEqual(attachment);
  });
  it("legacy LIST cannot publish against enrolled INBOX; roles and secondary demand survive rejection", async () => {
    await enroll();
    const demand = new ReceivingDemand(database.db, async () => {});
    expect(await demand.request(account, secondary)).toBe(true);
    const before = await facts();
    const [pending] =
      await reader`select receiving_due_at,receiving_request_generation from mailboxes where id=${secondary}`;
    const service = new MailboxService(database.db);
    await expect(
      service.reconcile(
        account,
        [
          {
            remotePath: "INBOX",
            name: "INBOX",
            delimiter: "/",
            attributes: [],
            specialUse: [],
            selectable: true,
            uidValidity: "7",
          },
          {
            remotePath: "Sent",
            name: "Sent",
            delimiter: "/",
            attributes: [],
            specialUse: ["\\Sent"],
            selectable: true,
            uidValidity: "7",
          },
        ],
        new Date("2026-10-14T10:00:00Z"),
      ),
    ).rejects.toMatchObject({
      cause: { message: "Receiving authoritative write context missing" },
    });
    expect(await facts()).toEqual(before);
    expect(
      (
        await reader`select receiving_due_at,receiving_request_generation from mailboxes where id=${secondary}`
      )[0],
    ).toEqual(pending);
    expect(
      (
        await reader`select mailbox_id,source from mailbox_roles where account_id=${account} and role='sent'`
      )[0],
    ).toEqual({ mailbox_id: secondary, source: "manual" });
  });
  it("keeping the old secondary metadata executor is unsafe even for an unenrolled secondary folder", async () => {
    await enroll();
    const before = await facts();
    await expect(
      database.db.transaction((tx) =>
        persistMessageMetadata(
          tx,
          account,
          secondary,
          7n,
          [
            {
              ...metadata,
              envelope: {
                ...metadata.envelope,
                messageId: "<secondary@example.test>",
              },
            },
          ],
          false,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { message: "Receiving authoritative write context missing" },
    });
    expect(await facts()).toEqual(before);
    expect(
      (
        await reader`select count(*)::int as count from mailbox_messages where mailbox_id=${secondary}`
      )[0].count,
    ).toBe(0);
  });
});
