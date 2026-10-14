import { ConversationService } from "@/modules/mail/application/conversation-service";
import { SearchService } from "@/modules/mail/application/search-service";
import { vi } from "vitest";
import { MessageService } from "@/modules/mail/application/message-service";
import {
  enqueueReceivingWake,
  RECEIVING_WAKE_QUEUE,
} from "@/modules/mail/infrastructure/receiving-wake-jobs";
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

// R02 intentionally enables requests only. Keep Stage 4C forbidden-write
// probes as negative controls; this fixture does not activate the worker.
describe("R02 receiving business intents and Stage 4C negative controls", () => {
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
  let owner: { actor: string; generation: bigint };
  async function enroll(legacyReady = false) {
    // Even manufacturing the old readiness fields before enrollment cannot make
    // unfenced business writers safe. Enrollment itself stays new-install only.
    if (legacyReady)
      await reader`update mailboxes set recent_sync_uid_validity=7,recent_sync_status='success' where id=${inbox}`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    owner = { actor, generation: BigInt(lease.generation) };
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
  async function canonical() {
    const [r] =
      await reader`select to_jsonb(p) as placement,to_jsonb(m) as message,
      to_jsonb(b)-ARRAY['receiving_due_at','receiving_request_generation'] as mailbox,to_jsonb(s) as state
      from mailbox_messages p join messages m on m.id=p.message_id join mailboxes b on b.id=p.mailbox_id
      join receiving_mailboxes s on s.mailbox_id=b.id where b.id=${inbox}`;
    return r;
  }
  async function generation() {
    return BigInt(
      (
        await reader`select receiving_request_generation as g from mailboxes where id=${inbox}`
      )[0].g,
    );
  }
  async function contentSource() {
    return (
      await reader`select * from message_contents where message_id=${message}`
    )[0];
  }
  const readService = () => new MessageService(database.db);
  const content = (wake?: (id: string) => Promise<unknown>) =>
    new MessageContentService(
      database.db,
      contentScheduler,
      undefined,
      undefined,
      undefined,
      wake,
    );
  // R04 owns fenced terminal publication. These explicit fixture transitions
  // only seed read-projection states; they are not assertions of web authority.
  async function seedTerminal(id: string) {
    await reader.begin(async (tx) => {
      await tx`set constraints all immediate`;
      await tx`alter table message_commands disable trigger receiving_command_guard`;
      await tx`update message_commands set status='failed',error='fixture terminal state' where id=${id}`;
      await tx`alter table message_commands enable trigger receiving_command_guard`;
    });
  }
  async function publishFlags(flags: string[]) {
    await new ReceivingPersistence(executor).persist(
      owner,
      inbox,
      {
        epoch: 7n,
        revision: 1n,
        freshThrough: 1n,
        historyBefore: 1n,
        reconcileAfter: 0n,
      },
      {
        kind: "repair",
        complete: true,
        epoch: 7n,
        known: [1n],
        present: [1n],
        flags: [{ uid: "1", flags }],
        wrap: false,
      },
      budget(),
    );
  }

  it("new INBOX accepts Seen without retired readiness and preserves all canonical facts", async () => {
    await enroll();
    const before = await canonical();
    const g = await generation();
    expect((await facts()).recent_sync_uid_validity).toBeNull();
    const result = await commands().create(
      account,
      inbox,
      message,
      "mark_read",
    );
    expect(result.status).toBe("pending");
    expect(await canonical()).toEqual(before);
    expect(await generation()).toBe(g + 1n);
    expect((await readService().list(account, inbox)).items[0].seen).toBe(true);
    expect((await content().detail(account, inbox, message)).seen).toBe(true);
    expect(
      (await new ConversationService(database.db).list(account, inbox, 50))
        .items[0].seen,
    ).toBe(true);
    expect(
      (await new SearchService(database.db).search("Cutover")).items.find(
        (x) => x.id === message,
      )?.seen,
    ).toBe(true);
    const [row] =
      await reader`select * from message_commands where id=${result.id}`;
    expect(row).toMatchObject({
      account_id: account,
      mailbox_id: inbox,
      message_id: message,
      source_uid: "1",
      source_uid_validity: "7",
      source_configuration_binding: "1",
      attempts: 0,
    });
    expect(
      (
        await reader`select count(*)::int as n from pgboss.job where name=${MESSAGE_COMMAND_QUEUE} and data->>'commandId'=${result.id}`
      )[0].n,
    ).toBe(0);
  });
  it("legacy readiness still cannot authorize a direct placement flag/hidden/MODSEQ write", async () => {
    await enroll(true);
    const before = await canonical();
    await expect(
      reader`update mailbox_messages set flags=ARRAY['\\Seen'],action_hidden=true,modseq=9 where message_id=${message}`,
    ).rejects.toThrow("Receiving authoritative write context missing");
    expect(await canonical()).toEqual(before);
  });
  it.each(["mark_read", "mark_unread", "flag", "unflag"] as const)(
    "projects %s and failure exposes newly published canonical flags",
    async (action) => {
      await enroll();
      const before = await canonical();
      const command = await commands().create(account, inbox, message, action);
      expect(await canonical()).toEqual(before);
      const detail = await content().detail(account, inbox, message);
      expect(detail.seen).toBe(action === "mark_read");
      expect(detail.flagged).toBe(action === "flag");
      await publishFlags(["\\Answered", "\\Flagged"]);
      const fresh = await canonical();
      await seedTerminal(command.id);
      expect(await canonical()).toEqual(fresh);
      const after = await content().detail(account, inbox, message);
      expect(after.seen).toBe(false);
      expect(after.flagged).toBe(true);
    },
  );
  it("MOVE hides in lists and counts without canonical hiding; failure reveals the source", async () => {
    await reader`update mail_accounts set imap_capabilities=ARRAY['MOVE'] where id=${account}`;
    await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'trash',${secondary},'manual')`;
    await enroll();
    const before = await canonical();
    const command = await commands().create(account, inbox, message, "trash");
    expect(await canonical()).toEqual(before);
    expect((await readService().list(account, inbox)).items).toHaveLength(0);
    await expect(content().detail(account, inbox, message)).rejects.toThrow(
      "unavailable",
    );
    expect(
      (await new ConversationService(database.db).list(account, inbox, 50))
        .items,
    ).toHaveLength(0);
    expect(
      (await new SearchService(database.db).search("Cutover")).items.some(
        (x) => x.id === message,
      ),
    ).toBe(false);
    expect(
      (await readService().listAllInboxes()).items.some(
        (x) => x.id === message,
      ),
    ).toBe(false);
    expect(
      (await new MailboxService(database.db).listForAccount(account)).find(
        (x) => x.id === inbox,
      )?.synchronizedMessageCount,
    ).toBe("0");
    await seedTerminal(command.id);
    expect((await readService().list(account, inbox)).items).toHaveLength(1);
    expect(await canonical()).toEqual(before);
  });
  it("simultaneous identical commands coalesce with the original ID; conflicting action is rejected", async () => {
    await enroll();
    const g = await generation();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        commands().create(account, inbox, message, "flag"),
      ),
    );
    expect(new Set(results.map((x) => x.id)).size).toBe(1);
    expect(await generation()).toBe(g + 1n);
    await expect(
      commands().create(account, inbox, message, "unflag"),
    ).rejects.toThrow("already in progress");
    expect((await facts()).commands).toBe(1);
  });
  it("content intent freezes source, coalesces and never writes body/search or descriptors on detail", async () => {
    await enroll();
    const before = await canonical();
    const g = await generation();
    const attachmentsBefore =
      await reader`select * from message_attachments where message_id=${message}`;
    const requested = await Promise.all(
      Array.from({ length: 4 }, () =>
        content().request(account, inbox, message),
      ),
    );
    expect(requested.filter(Boolean)).toHaveLength(1);
    expect(await content().request(account, inbox, message)).toBe(false);
    expect(await generation()).toBe(g + 1n);
    expect(await canonical()).toEqual(before);
    expect(await contentSource()).toMatchObject({
      status: "pending",
      plain_text: null,
      search_text: null,
      sanitized_html: null,
      source_mailbox_id: inbox,
      source_uid: "1",
      source_uid_validity: "7",
      source_configuration_binding: "1",
    });
    await content().detail(account, inbox, message);
    expect(
      await reader`select * from message_attachments where message_id=${message}`,
    ).toEqual(attachmentsBefore);
    // Original Stage 4C content-publication blocker remains a negative control.
    await expect(
      reader`update message_contents set status='ready',plain_text='forged',search_text='forged' where message_id=${message}`,
    ).rejects.toThrow("Receiving intent-only fields required");
    expect(await canonical()).toEqual(before);
  });
  it("attachment request preserves part/blob identity and coalesces", async () => {
    await enroll();
    const before = await canonical();
    const g = await generation();
    const [original] =
      await reader`select * from message_attachments where message_id=${message}`;
    await attachments().request(original.id);
    await attachments().request(original.id);
    const [after] =
      await reader`select * from message_attachments where id=${original.id}`;
    expect(after).toEqual({
      ...original,
      status: "pending",
      updated_at: after.updated_at,
    });
    expect(await generation()).toBe(g + 1n);
    expect(await canonical()).toEqual(before);
    // Original Stage 4C attachment execution blocker is still enforced.
    await expect(
      reader`update message_attachments set status='fetching' where id=${original.id}`,
    ).rejects.toThrow("Receiving intent-only fields required");
  });
  it("commit survives failed wake transport and no legacy execution or enqueue occurs", async () => {
    await enroll();
    const before = await canonical();
    const g = await generation();
    const wake = vi.fn(async () => {
      expect(
        (await facts()).commands + (await facts()).contents,
      ).toBeGreaterThan(0);
      return jobs.boss.send("r02-unregistered-wake-queue", {
        accountId: account,
      });
    });
    const legacy = vi.fn(async () => {
      throw Error("legacy enqueue must not run");
    });
    const cmd = new MessageCommandService(
      database.db,
      legacy,
      async () => {},
      undefined,
      undefined,
      wake,
    );
    const c = await cmd.create(account, inbox, message, "flag");
    expect(await content(wake).request(account, inbox, message)).toBe(true);
    const [a] =
      await reader`select id from message_attachments where message_id=${message}`;
    const at = new AttachmentService(
      database.db,
      new LocalBlobStorage(tmpdir()),
      DEFAULT_ATTACHMENT_LIMITS,
      legacy,
      undefined,
      undefined,
      undefined,
      undefined,
      wake,
    );
    await at.request(a.id);
    expect(wake).toHaveBeenCalledTimes(3);
    for (const result of wake.mock.results)
      await expect(result.value).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
    expect(await generation()).toBe(g + 3n);
    expect(await canonical()).toEqual(before);
    expect(
      (await reader`select status from message_commands where id=${c.id}`)[0]
        .status,
    ).toBe("pending");
    expect((await contentSource()).status).toBe("pending");
    expect(
      (await reader`select status from message_attachments where id=${a.id}`)[0]
        .status,
    ).toBe("pending");
    await cmd.run(c.id);
    await content().run(account, inbox, message);
    const demand = new ReceivingDemand(database.db, async () => {});
    expect(await demand.eligible(account)).toBe(true);
    expect(
      (
        await reader`select receiving_due_at<=clock_timestamp() as due from mailboxes where id=${inbox}`
      )[0].due,
    ).toBe(true);
  });
  it("duplicate and ACKed actual pg-boss wakes do not complete any business intent", async () => {
    await enroll();
    await commands().create(account, inbox, message, "flag");
    await content().request(account, inbox, message);
    const [a] =
      await reader`select id from message_attachments where message_id=${message}`;
    await attachments().request(a.id);
    const before = await facts();
    const pending = await contentSource();
    await enqueueReceivingWake(jobs.boss, account);
    await enqueueReceivingWake(jobs.boss, account);
    const batch = await jobs.boss.fetch(RECEIVING_WAKE_QUEUE);
    expect(batch.length).toBeGreaterThan(0);
    for (const job of batch)
      await jobs.boss.complete(RECEIVING_WAKE_QUEUE, job.id);
    expect(
      (
        await reader`select count(*)::int as n from pgboss.job where name=${RECEIVING_WAKE_QUEUE} and data->>'accountId'=${account} and state='completed'`
      )[0].n,
    ).toBeGreaterThan(0);
    expect(await facts()).toEqual(before);
    expect(await contentSource()).toEqual(pending);
    expect(
      (await reader`select status from message_attachments where id=${a.id}`)[0]
        .status,
    ).toBe("pending");
  });
  it("stale configuration, foreign account, missing and unenrolled secondary placement are rejected", async () => {
    await enroll();
    const g = await generation();
    await expect(
      commands().create(randomUUID(), inbox, message, "flag"),
    ).rejects.toThrow();
    await expect(
      content().request(account, inbox, randomUUID()),
    ).rejects.toThrow("source mailbox placement");
    await expect(
      commands().create(account, secondary, message, "flag"),
    ).rejects.toThrow("no longer");
    const [a] =
      await reader`select id from message_attachments where message_id=${message}`;
    await expect(
      reader`select maildock_receiving_attachment_request(${randomUUID()}::uuid,${a.id}::uuid)`,
    ).rejects.toThrow("request account unavailable");
    await reader`update mail_accounts set imap_host='replacement.invalid.test' where id=${account}`;
    await expect(
      commands().create(account, inbox, message, "flag"),
    ).rejects.toThrow("no longer");
    await expect(content().request(account, inbox, message)).rejects.toThrow(
      "source mailbox placement",
    );
    await expect(attachments().request(a.id)).rejects.toThrow(
      "source mailbox placement",
    );
    expect(await generation()).toBe(g);
    expect((await facts()).commands).toBe(0);
    expect((await facts()).contents).toBe(0);
  });
  it("stale epoch retained placement cannot create requests", async () => {
    await enroll();
    await new ReceivingPersistence(executor).persist(
      owner,
      inbox,
      {
        epoch: 7n,
        revision: 1n,
        freshThrough: 1n,
        historyBefore: 1n,
        reconcileAfter: 0n,
      },
      { kind: "epoch", complete: true, epoch: 8n, uidNext: 2n },
      budget(),
    );
    await expect(
      commands().create(account, inbox, message, "flag"),
    ).rejects.toThrow("no longer");
    await expect(content().request(account, inbox, message)).rejects.toThrow(
      "source mailbox placement",
    );
    const [a] =
      await reader`select id from message_attachments where message_id=${message}`;
    await expect(attachments().request(a.id)).rejects.toThrow(
      "source mailbox placement",
    );
  });
  it("mixed content request plus payload rolls back intent and due atomically", async () => {
    await enroll();
    const before = await facts();
    await expect(
      reader.begin(async (tx) => {
        await tx`select maildock_receiving_content_request(${account}::uuid,${inbox}::uuid,${message}::uuid)`;
        await tx`update message_contents set status='pending',plain_text='forged' where message_id=${message}`;
      }),
    ).rejects.toThrow(
      "Receiving content result or in-flight identity forbidden",
    );
    expect(await facts()).toEqual(before);
    expect(await contentSource()).toBeUndefined();
  });
  it("mixed attachment request plus part/blob fields rolls back everything", async () => {
    await enroll();
    const before = await facts();
    const [a] =
      await reader`select * from message_attachments where message_id=${message}`;
    await expect(
      reader.begin(async (tx) => {
        await tx`select maildock_receiving_attachment_request(${account}::uuid,${a.id}::uuid)`;
        await tx`update message_attachments set status='pending',part_id='forged',blob_id=${randomUUID()}::uuid where id=${a.id}`;
      }),
    ).rejects.toThrow("Receiving attachment result or identity forbidden");
    expect(await facts()).toEqual(before);
    expect(
      (await reader`select * from message_attachments where id=${a.id}`)[0],
    ).toEqual(a);
  });
  it("forged content insert, command execution and result UIDs remain denied", async () => {
    await enroll();
    const before = await facts();
    await expect(reader`insert into message_contents(message_id,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding,plain_text)
      values(${message},'pending',${inbox},7,1,1,'forged')`).rejects.toThrow(
      "Receiving content payload forbidden",
    );
    expect(await facts()).toEqual(before);
    const c = await commands().create(account, inbox, message, "flag");
    await expect(
      reader`update message_commands set status='executing',attempts=1 where id=${c.id}`,
    ).rejects.toThrow("Receiving command execution capability disabled");
    await expect(
      reader`update message_commands set status='succeeded',destination_uid=10 where id=${c.id}`,
    ).rejects.toThrow("Receiving command execution capability disabled");
  });
  it("completed ready content and attachments are never replaced with pending requests", async () => {
    await enroll();
    await content().request(account, inbox, message);
    const [a] =
      await reader`select * from message_attachments where message_id=${message}`;
    const blob = randomUUID();
    // Future R11/R12 publication is outside this test; seed an immutable ready
    // fixture using the database-owner DDL ability, never an application bypass.
    await reader.begin(async (tx) => {
      await tx`set constraints all immediate`;
      await tx`alter table message_contents disable trigger receiving_write_guard`;
      await tx`alter table message_contents disable trigger message_contents_search_body`;
      await tx`update message_contents set status='ready',plain_text='completed result',policy_version='old-policy' where message_id=${message}`;
      await tx`alter table message_contents enable trigger receiving_write_guard`;
      await tx`alter table message_contents enable trigger message_contents_search_body`;
      await tx`insert into blobs(id,storage_key,size,sha256) values(${blob},${"r02-" + blob},5,${"0".repeat(64)})`;
      await tx`alter table message_attachments disable trigger receiving_write_guard`;
      await tx`update message_attachments set status='ready',blob_id=${blob} where id=${a.id}`;
      await tx`alter table message_attachments enable trigger receiving_write_guard`;
    });
    const before = await contentSource();
    const g = await generation();
    const remote = await canonical();
    expect(await content().request(account, inbox, message)).toBe(false);
    await attachments().request(a.id);
    expect(await contentSource()).toEqual(before);
    expect(await generation()).toBe(g);
    expect(await canonical()).toEqual(remote);
    expect(
      (
        await reader`select status,blob_id from message_attachments where id=${a.id}`
      )[0],
    ).toEqual({ status: "ready", blob_id: blob });
  });
  it("failed content retry increments demand once and preserves prior derived search body", async () => {
    await enroll();
    await content().request(account, inbox, message);
    await reader.begin(async (tx) => {
      await tx`set constraints all immediate`;
      await tx`alter table message_contents disable trigger receiving_write_guard`;
      await tx`update message_contents set status='failed',error='fixture failure' where message_id=${message}`;
      await tx`alter table message_contents enable trigger receiving_write_guard`;
      await tx`alter table messages disable trigger receiving_write_guard`;
      await tx`update messages set search_body='prior derived body' where id=${message}`;
      await tx`alter table messages enable trigger receiving_write_guard`;
    });
    const before = await canonical();
    const g = await generation();
    expect(await content().request(account, inbox, message)).toBe(true);
    expect(await generation()).toBe(g + 1n);
    expect(await canonical()).toEqual(before);
    expect((await contentSource()).status).toBe("pending");
  });
  it("forged pending source/part changes and owner-only results remain fenced", async () => {
    await enroll();
    const before = await facts();
    const [a] =
      await reader`select * from message_attachments where message_id=${message}`;
    await expect(
      reader`update message_attachments set status='pending',source_uid=999,part_id='forged' where id=${a.id}`,
    ).rejects.toThrow("Receiving attachment result or identity forbidden");
    await expect(reader`insert into message_contents(message_id,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding)
      values(${message},'pending',${inbox},8,1,1)`).rejects.toThrow(
      "Receiving request frozen source mismatch",
    );
    expect(await facts()).toEqual(before);
  });
  it("local staged upload remains independent from receiving requests", async () => {
    await enroll();
    const g = await generation();
    const before = await canonical();
    const uploaded = await attachments().upload(
      (async function* () {
        yield Buffer.from("R02 local draft bytes");
      })(),
      "local.txt",
      "text/plain",
    );
    expect(uploaded.status).toBe("ready");
    expect(
      (
        await reader`select status from staged_attachments where id=${uploaded.id}`
      )[0].status,
    ).toBe("ready");
    expect(await generation()).toBe(g);
    expect(await canonical()).toEqual(before);
  });
  it("executing commands retain projection and block conflicting commands without authorizing web transitions", async () => {
    await enroll();
    const c = await commands().create(account, inbox, message, "mark_read");
    const g = await generation();
    const before = await canonical();
    await reader.begin(async (tx) => {
      await tx`alter table message_commands disable trigger receiving_command_guard`;
      await tx`update message_commands set status='executing' where id=${c.id}`;
      await tx`set constraints all immediate`;
      await tx`alter table message_commands enable trigger receiving_command_guard`;
    });
    expect(
      (await commands().create(account, inbox, message, "mark_read")).id,
    ).toBe(c.id);
    await expect(
      commands().create(account, inbox, message, "flag"),
    ).rejects.toThrow("already in progress");
    expect((await content().detail(account, inbox, message)).seen).toBe(true);
    expect(await generation()).toBe(g);
    expect(await canonical()).toEqual(before);
    await seedTerminal(c.id);
    expect((await content().detail(account, inbox, message)).seen).toBe(false);
  });
  it("foreign existing accounts and source retargets fail without changing either demand", async () => {
    await enroll();
    const [other] =
      await reader`select id from mail_accounts where id<>${account} limit 1`;
    const before = await facts();
    await expect(
      commands().create(other.id, inbox, message, "flag"),
    ).rejects.toThrow();
    await expect(content().request(other.id, inbox, message)).rejects.toThrow();
    const [a] =
      await reader`select id from message_attachments where message_id=${message}`;
    await expect(
      reader`select maildock_receiving_attachment_request(${other.id}::uuid,${a.id}::uuid)`,
    ).rejects.toThrow("Receiving request source unavailable");
    await expect(
      reader`update message_attachments set status='pending',source_mailbox_id=${secondary} where id=${a.id}`,
    ).rejects.toThrow("Receiving attachment result or identity forbidden");
    expect(await facts()).toEqual(before);
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
