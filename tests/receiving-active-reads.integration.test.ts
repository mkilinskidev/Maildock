import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
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
import { ReceivingPublication } from "@/modules/mail/application/receiving-publication";
import { MessageService } from "@/modules/mail/application/message-service";
import { initializeLocalSearchBodies } from "@/modules/mail/infrastructure/search-local-backfill";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { ConversationService } from "@/modules/mail/application/conversation-service";
import { SearchService } from "@/modules/mail/application/search-service";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { ComposePreparationService } from "@/modules/mail/application/compose-preparation-service";
import { DraftService } from "@/modules/mail/application/draft-service";
import { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";
import { NotificationService } from "@/modules/mail/application/notification-service";
import { EmailRenderingService } from "@/modules/mail/application/email-rendering-service";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/modules/mail/domain/attachments";
import type { RemoteMessageMetadata } from "@/modules/accounts/domain/mail-provider";
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

describe("R05 active identity public reads", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let account: string, inbox: string, secondary: string, message: string;
  let storageRoot: string;
  let storage: LocalBlobStorage;
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
    await root`create database active_reads owner lane`;
    await root.end();
    const url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/active_reads`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 2 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 1);
    storageRoot = await mkdtemp(path.join(tmpdir(), "maildock-r05-"));
    storage = new LocalBlobStorage(storageRoot);
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
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
    await rm(storageRoot, { recursive: true, force: true });
  });
  let owner: { actor: string; generation: bigint };
  async function enroll(legacyReady = false, received = metadata) {
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
        metadata: [received],
      },
      budget(),
    );
    const [row] =
      await reader`select message_id from receiving_current_placements where mailbox_id=${inbox}`;
    message = row.message_id;
  }
  const content = () => new MessageContentService(database.db);
  it("startup local search conversion leaves enrolled pending content and authority unchanged", async () => {
    await enroll();
    await content().request(account, inbox, message);
    const before =
      await reader`select to_jsonb(c) as row from message_contents c where message_id=${message}`;
    const authority =
      await reader`select * from receiving_mailboxes where mailbox_id=${inbox}`;
    expect(before[0].row.status).toBe("pending");
    expect(before[0].row.search_text).toBeNull();
    await initializeLocalSearchBodies(database.db);
    await initializeLocalSearchBodies(database.db);
    expect(
      await reader`select to_jsonb(c) as row from message_contents c where message_id=${message}`,
    ).toEqual(before);
    expect(
      await reader`select * from receiving_mailboxes where mailbox_id=${inbox}`,
    ).toEqual(authority);
  });
  const attachments = () =>
    new AttachmentService(
      database.db,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      async () => {},
    );
  const list = () => new MessageService(database.db);
  const conversations = () => new ConversationService(database.db);
  const search = () => new SearchService(database.db);
  const commands = () =>
    new MessageCommandService(
      database.db,
      async () => {},
      async () => {},
    );
  const compose = () =>
    new ComposePreparationService(database.db, content(), attachments());
  const draftFields = (
    p: import("@/modules/mail/domain/compose-source").ComposePrefill,
  ) => ({
    accountId: p.accountId,
    to: p.to,
    cc: p.cc,
    subject: p.subject,
    plainText: p.plainText,
    richDocument: p.richDocument,
    source: p.source,
  });
  const source = () => ({
    accountId: account,
    mailboxId: inbox,
    messageId: message,
    mode: "forward" as const,
  });
  async function state(mailbox = inbox) {
    const [s] =
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`;
    return {
      mailbox,
      configuration: BigInt(s.configuration_binding),
      state: {
        epoch: BigInt(s.epoch),
        revision: BigInt(s.revision),
        freshThrough: BigInt(s.fresh_through),
        historyBefore: BigInt(s.history_before),
        reconcileAfter: BigInt(s.reconcile_after),
      },
    };
  }
  async function replaceEpoch() {
    await new ReceivingPersistence(executor).persist(
      owner,
      inbox,
      (await state()).state,
      { kind: "epoch", complete: true, epoch: 8n, uidNext: 2n },
      budget(),
    );
  }
  async function publishBody(plainText = "uniquebodytoken obsolete payload") {
    await content().request(account, inbox, message);
    const pub = new ReceivingPublication(executor, storage);
    const attempt = await pub.claim(
      owner,
      await state(),
      "content",
      message,
      budget(),
    );
    await pub.contentResult(
      owner,
      await state(),
      message,
      attempt.id,
      {
        complete: true,
        taggedOk: true,
        streamComplete: true,
        decoded: true,
        eof: true,
        method: "BODY.PEEK",
        origin: 0,
        encodedBytes: 10n,
        part: "TEXT",
        epoch: 7n,
        uid: 1n,
        plainText,
        html: "<p>uniquebodytoken</p>",
        searchText: "untrusted",
      },
      budget(),
    );
  }
  async function publishAttachment(bytes = Buffer.from("fixture")) {
    const [a] =
      await reader`select id from message_attachments where message_id=${message}`;
    await attachments().request(a.id);
    const pub = new ReceivingPublication(executor, storage);
    const attempt = await pub.claim(
      owner,
      await state(),
      "attachment",
      a.id,
      budget(),
    );
    const blob = await storage.put(
      (async function* () {
        yield bytes;
      })(),
      100,
    );
    await pub.attachmentResult(
      owner,
      await state(),
      a.id,
      attempt.id,
      {
        complete: true,
        taggedOk: true,
        streamComplete: true,
        decoded: true,
        eof: true,
        method: "BODY.PEEK",
        origin: 0,
        encodedBytes: 10n,
        part: "1",
        epoch: 7n,
        uid: 1n,
        blob,
      },
      budget(),
    );
    return a.id as string;
  }
  async function conversationId() {
    return (
      await reader`select conversation_id from conversation_members where message_id=${message}`
    )[0].conversation_id as string;
  }
  async function counts() {
    return (await new MailboxService(database.db).listForAccount(account)).find(
      (b) => b.id === inbox,
    )!;
  }
  async function sharedPlacement(enrolled = true) {
    if (enrolled)
      await new ReceivingPersistence(executor).initialize(
        owner,
        secondary,
        { complete: true, epoch: 7n, uidNext: 2n },
        budget(),
      );
    // Database-owner fixture DDL supplies a shared placement without pretending
    // to implement R14. Immediate constraints and guards are restored atomically.
    await reader.begin(async (tx) => {
      await tx`set constraints all immediate`;
      await tx`alter table mailbox_messages disable trigger receiving_write_guard`;
      await tx`insert into mailbox_messages(id,mailbox_id,message_id,uid_validity,uid,configuration_binding,first_synchronized_at,last_synchronized_at) values(${randomUUID()},${secondary},${message},7,1,1,now(),now())`;
      await tx`alter table mailbox_messages enable trigger receiving_write_guard`;
    });
  }
  it("active identity supports detail, list, counts, indexed search, conversations and source-bound R04 publication", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    expect(
      (await list().list(account, inbox, 1)).items.map((m) => m.id),
    ).toEqual([message]);
    expect(
      (await content().detail(account, inbox, message)).content.plainText,
    ).toContain("uniquebodytoken");
    expect(
      (await search().search("uniquebodytoken")).items.some(
        (m) => m.id === message,
      ),
    ).toBe(true);
    expect(
      (await conversations().open(account, await conversationId()))[0]
        .plainText,
    ).toContain("uniquebodytoken");
    expect(await counts()).toMatchObject({
      messageCount: "1",
      unseenCount: "1",
      synchronizedMessageCount: "1",
    });
    expect((await attachments().download(attachment)).bytes.toString()).toBe(
      "fixture",
    );
    const prepared = await compose().prepare(source());
    expect(prepared.status).toBe("ready");
    if (prepared.status === "ready")
      expect(prepared.prefill.source.identity).toEqual({
        epoch: "7",
        uid: "1",
        configuration: "1",
      });
    expect(
      (await reader`select search_body from messages where id=${message}`)[0]
        .search_body,
    ).toContain("uniquebodytoken");
  });
  it("retained old epoch disappears from every message read before pagination and counting", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    const conversation = await conversationId();
    await replaceEpoch();
    expect((await list().list(account, inbox, 1)).items).toEqual([]);
    expect(
      (await list().listAllInboxes(1)).items.some((m) => m.id === message),
    ).toBe(false);
    await expect(content().detail(account, inbox, message)).rejects.toThrow(
      "unavailable",
    );
    expect(
      (await search().search("Cutover")).items.some((m) => m.id === message),
    ).toBe(false);
    expect(await conversations().list(account, inbox, 1)).toMatchObject({
      items: [],
    });
    expect(await conversations().open(account, conversation)).toEqual([]);
    expect(await counts()).toMatchObject({
      messageCount: "0",
      unseenCount: "0",
      synchronizedMessageCount: "0",
    });
    await expect(attachments().download(attachment)).rejects.toThrow(
      "unavailable",
    );
    await expect(
      attachments().inlineResource(message, attachment, "fixture"),
    ).rejects.toThrow("unavailable");
    await expect(compose().prepare(source())).rejects.toThrow("unavailable");
    await expect(
      new EmailRenderingService(database.db, content(), attachments()).render(
        account,
        inbox,
        message,
        { loadImages: false, trustSender: false },
      ),
    ).rejects.toThrow("unavailable");
    // Negative oracle: the unfiltered source and indexed body still exist.
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where message_id=${message}`
      )[0].n,
    ).toBe(1);
    expect(
      (
        await reader`select count(*)::int n from messages where id=${message} and search_vector @@ plainto_tsquery('simple','uniquebodytoken')`
      )[0].n,
    ).toBe(1);
    expect(
      (
        await reader`select status from message_contents where message_id=${message}`
      )[0].status,
    ).toBe("ready");
    expect(
      (
        await reader`select status,blob_id from message_attachments where id=${attachment}`
      )[0],
    ).toMatchObject({ status: "ready", blob_id: expect.any(String) });
  });
  it("optimistic Seen counts and pending MOVE remain consistent across APIs", async () => {
    await enroll();
    await publishBody();
    const seen = await commands().create(account, inbox, message, "mark_read");
    expect((await counts()).unseenCount).toBe("0");
    await reader.begin(async (tx) => {
      await tx`set constraints all immediate`;
      await tx`alter table message_commands disable trigger receiving_command_guard`;
      await tx`update message_commands set status='failed' where id=${seen.id}`;
      await tx`alter table message_commands enable trigger receiving_command_guard`;
    });
    expect((await counts()).unseenCount).toBe("1");
    await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'trash',${secondary},'manual')`;
    await reader`update mail_accounts set imap_capabilities=ARRAY['MOVE'] where id=${account}`;
    await commands().create(account, inbox, message, "trash");
    expect((await list().list(account, inbox)).items).toEqual([]);
    expect(
      (await search().search("Cutover")).items.some((m) => m.id === message),
    ).toBe(false);
    expect(await conversations().open(account, await conversationId())).toEqual(
      [],
    );
    expect((await counts()).messageCount).toBe("0");
    await expect(content().detail(account, inbox, message)).rejects.toThrow();
  });
  it("shared active placement preserves headers while stale body, rank and snippets disappear", async () => {
    await enroll();
    await publishBody();
    await sharedPlacement();
    await replaceEpoch();
    expect((await list().list(account, secondary)).items[0]).toMatchObject({
      id: message,
      snippet: null,
    });
    const hits = await search().search("Cutover");
    expect(hits.items.find((m) => m.id === message)).toMatchObject({
      snippet: "Cutover boundary",
      mailboxId: secondary,
    });
    expect(
      (await search().search("uniquebodytoken")).items.some(
        (m) => m.id === message,
      ),
    ).toBe(false);
    expect(
      (await conversations().open(account, await conversationId()))[0],
    ).toMatchObject({
      id: message,
      plainText: null,
      contentStatus: "not_fetched",
    });
    expect(
      (await content().detail(account, secondary, message)).content,
    ).toMatchObject({
      status: "not_fetched",
      plainText: null,
      sanitizedHtml: null,
    });
    await expect(
      content().request(account, secondary, message),
    ).rejects.toThrow("source mailbox placement");
    expect(
      (
        await reader`select source_mailbox_id,status from message_contents where message_id=${message}`
      )[0],
    ).toEqual({ source_mailbox_id: inbox, status: "ready" });
  });
  it("disabled accounts keep valid cached reads and reject remote requests", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    await reader`update mail_accounts set enabled=false where id=${account}`;
    expect(
      (await content().detail(account, inbox, message)).content.status,
    ).toBe("ready");
    expect((await attachments().download(attachment)).bytes.toString()).toBe(
      "fixture",
    );
    expect(
      (await list().listAllInboxes()).items.some((m) => m.id === message),
    ).toBe(true);
    expect(
      (await conversations().list("", "", 50, undefined, true)).items.some(
        (m) => m.id === message,
      ),
    ).toBe(true);
    await expect(content().request(account, inbox, message)).rejects.toThrow();
    await expect(attachments().request(attachment)).rejects.toThrow("disabled");
    await expect(
      commands().create(account, inbox, message, "flag"),
    ).rejects.toThrow();
  });
  it("configuration changes invalidate placements, bytes and prepared references without deleting them", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    const prepared = await compose().prepare(source());
    expect(prepared.status).toBe("ready");
    await reader`update mail_accounts set imap_host='new.test' where id=${account}`;
    expect((await list().list(account, inbox)).items).toEqual([]);
    await expect(attachments().download(attachment)).rejects.toThrow();
    if (prepared.status === "ready")
      await expect(
        new DraftService(database.db).create({
          id: randomUUID(),
          ...draftFields(prepared.prefill),
          to: "recipient@example.test",
          attachments: [],
        }),
      ).rejects.toThrow();
    expect(
      (
        await reader`select configuration_version from mail_accounts where id=${account}`
      )[0].configuration_version,
    ).toBe("2");
    expect(
      (
        await reader`select configuration_binding from mailbox_messages where message_id=${message}`
      )[0].configuration_binding,
    ).toBe("1");
  });
  it("local copied draft and immutable outgoing attachments survive source loss", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    const prepared = await compose().prepare(source());
    if (prepared.status !== "ready") throw Error("expected ready");
    const drafts = new DraftService(database.db);
    const draft = await drafts.create({
      id: randomUUID(),
      ...draftFields(prepared.prefill),
      to: "recipient@example.test",
      attachments: [{ id: attachment, kind: "incoming" }],
    });
    await replaceEpoch();
    const local = await drafts.get(draft.id);
    expect(local.attachments[0]).toMatchObject({
      status: "ready",
      kind: "draft",
    });
    const outgoing = new OutgoingMessageService(
      database.db,
      async () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      storage,
    );
    const sent = await outgoing.create(
      {},
      { id: draft.id, expectedRevision: local.revision },
    );
    expect(sent.id).toBeTruthy();
    expect(
      (
        await reader`select count(*)::int n from outgoing_message_attachments where outgoing_message_id=${sent.id}`
      )[0].n,
    ).toBe(1);
    await expect(attachments().download(attachment)).rejects.toThrow();
  });
  it("unenrolled secondary legacy placements cannot bypass receiving account enrollment", async () => {
    await enroll();
    await sharedPlacement(false);
    expect((await list().list(account, secondary)).items).toEqual([]);
    expect(
      (await new MailboxService(database.db).listForAccount(account)).find(
        (b) => b.id === secondary,
      )?.synchronizedMessageCount,
    ).toBe("0");
    await replaceEpoch();
    expect(
      (await search().search("Cutover")).items.some((m) => m.id === message),
    ).toBe(false);
    expect(await conversations().open(account, await conversationId())).toEqual(
      [],
    );
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where mailbox_id=${secondary}`
      )[0].n,
    ).toBe(1);
  });
  it("negative control: removing shared predicates exposes retained stale rows and bytes", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    await replaceEpoch();
    const [active] =
      await reader`select pg_get_functiondef('maildock_receiving_active_source(uuid,uuid,uuid,bigint,bigint,bigint)'::regprocedure) as ddl`;
    const [resource] =
      await reader`select pg_get_functiondef('maildock_receiving_visible_resource(uuid,uuid,bigint,bigint,bigint)'::regprocedure) as ddl`;
    expect((await list().list(account, inbox)).items).toEqual([]);
    try {
      // Explicit database-owner fault injection; no application bypass exists.
      await reader.unsafe(
        "CREATE OR REPLACE FUNCTION maildock_receiving_active_source(account uuid, mailbox uuid, message uuid, epoch bigint, remote_uid bigint, binding bigint) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$",
      );
      await reader.unsafe(
        "CREATE OR REPLACE FUNCTION maildock_receiving_visible_resource(message uuid, mailbox uuid, epoch bigint, remote_uid bigint, binding bigint) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$",
      );
      expect(
        (await list().list(account, inbox)).items.map((m) => m.id),
      ).toEqual([message]);
      expect(
        (await search().search("uniquebodytoken")).items.some(
          (m) => m.id === message,
        ),
      ).toBe(true);
      expect((await attachments().download(attachment)).bytes.toString()).toBe(
        "fixture",
      );
    } finally {
      await reader.unsafe(active.ddl);
      await reader.unsafe(resource.ddl);
    }
    expect((await list().list(account, inbox)).items).toEqual([]);
    await expect(attachments().download(attachment)).rejects.toThrow();
  });
  it.each(["active", "epoch", "move"] as const)(
    "notification-linked lookup validates %s source before LIMIT",
    async (kind) => {
      await enroll();

      const notifications = new NotificationService(database.db);
      // Reuse the real notification writer's existing row shape, after consuming
      // earlier arrivals; the event itself grants no placement authority.
      await notifications.setPreferences({
        enabled: true,
        folders: "all",
        accountIds: null,
        backgroundOnly: false,
      });
      await notifications.consume(true);
      await reader.begin(async (tx) => {
        await tx`set constraints all immediate`;
        await tx`alter table notification_events disable trigger receiving_notification_guard`;
        await tx`alter table notification_events disable trigger receiving_notification_authority`;
        await tx`insert into notification_events(sequence,account_id,mailbox_id,message_id,uid_validity,uid,sender,subject,created_at)
      values((select notification_sequence+1 from instance_state where id=1),${account},${inbox},${message},7,1,'fixture','Cutover boundary',now())`;
        await tx`alter table notification_events enable trigger receiving_notification_guard`;
        await tx`alter table notification_events enable trigger receiving_notification_authority`;
        await tx`update instance_state set notification_sequence=notification_sequence+1 where id=1`;
      });
      if (kind === "epoch") await replaceEpoch();
      if (kind === "move") {
        await reader`update mail_accounts set imap_capabilities=ARRAY['MOVE'] where id=${account}`;
        await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'trash',${secondary},'manual')`;
        await commands().create(account, inbox, message, "trash");
      }
      const result = await notifications.consume();
      expect(result.events.map((e) => e.messageId)).toEqual(
        kind === "active" ? [message] : [],
      );
    },
  );
  it("pagination, conversation newest member and counts ignore a newer retained epoch", async () => {
    await enroll();
    const old = message;
    const conversation = await conversationId();
    await replaceEpoch();
    const persistence = new ReceivingPersistence(executor);
    await persistence.persist(
      owner,
      inbox,
      (await state()).state,
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 8n,
          low: 1n,
          high: 1n,
          searched: [1n],
          confirmedAbsent: [],
        },
        metadata: [
          {
            ...metadata,
            internalDate: "2025-01-01T00:00:00Z",
            envelope: {
              ...metadata.envelope,
              messageId: "<newsource@example.test>",
              inReplyTo: "<cutover@example.test>",
              references: "<cutover@example.test>",
            },
          },
        ],
      },
      budget(),
    );
    const [replacement] =
      await reader`select message_id from receiving_current_placements where mailbox_id=${inbox}`;
    expect(replacement.message_id).not.toBe(old);
    const page = await list().list(account, inbox, 1);
    expect(page.items.map((m) => m.id)).toEqual([replacement.message_id]);
    expect(page.nextCursor).toBeNull();
    const threads = await conversations().list(account, inbox, 1);
    expect(threads.items[0]).toMatchObject({
      id: replacement.message_id,
      messageCount: 1,
      conversationMessageCount: 1,
    });
    expect(
      (await conversations().open(account, conversation)).map((m) => m.id),
    ).toEqual([replacement.message_id]);
    expect((await counts()).messageCount).toBe("1");
  });
  it("replacement placement for the same message ID cannot authorize old ready bytes or prepared compose identity", async () => {
    await enroll();
    await publishBody();
    const attachment = await publishAttachment();
    const prepared = await compose().prepare(source());
    if (prepared.status !== "ready") throw Error("expected ready");
    await replaceEpoch();
    await reader.begin(async (tx) => {
      await tx`set constraints all immediate`;
      await tx`alter table mailbox_messages disable trigger receiving_write_guard`;
      await tx`insert into mailbox_messages(id,mailbox_id,message_id,uid_validity,uid,configuration_binding,first_synchronized_at,last_synchronized_at) values(${randomUUID()},${inbox},${message},8,1,1,now(),now())`;
      await tx`alter table mailbox_messages enable trigger receiving_write_guard`;
    });
    expect((await list().list(account, inbox)).items[0]).toMatchObject({
      id: message,
      snippet: null,
    });
    expect(
      (await content().detail(account, inbox, message)).content,
    ).toMatchObject({ status: "not_fetched", plainText: null });
    await expect(content().request(account, inbox, message)).rejects.toThrow(
      "source mailbox placement",
    );
    await expect(compose().prepare(prepared.prefill.source)).rejects.toThrow(
      "unavailable",
    );
    await expect(
      new DraftService(database.db).create({
        id: randomUUID(),
        ...draftFields(prepared.prefill),
        to: "recipient@example.test",
        attachments: [],
      }),
    ).rejects.toThrow("unavailable");
    await expect(attachments().download(attachment)).rejects.toThrow();
    expect(
      (await search().search("uniquebodytoken")).items.some(
        (m) => m.id === message,
      ),
    ).toBe(false);
    expect(
      (
        await reader`select uid_validity from mailbox_messages where mailbox_id=${inbox} order by uid_validity`
      ).map((r) => r.uid_validity),
    ).toEqual(["7", "8"]);
  });
  it.each([
    "missing",
    "nonselectable",
    "uid",
    "unenrolled source mailbox",
  ] as const)(
    "shared predicate rejects %s source on all public paths",
    async (kind) => {
      await enroll();
      await publishBody();
      const attachment = await publishAttachment();
      await reader.begin(async (tx) => {
        await tx`set constraints all immediate`;
        if (kind === "missing" || kind === "nonselectable") {
          await tx`alter table mailboxes disable trigger receiving_update_guard`;
          if (kind === "missing")
            await tx`update mailboxes set lifecycle_status='missing' where id=${inbox}`;
          else
            await tx`update mailboxes set selectable=false where id=${inbox}`;
          await tx`alter table mailboxes enable trigger receiving_update_guard`;
        } else {
          await tx`alter table mailbox_messages disable trigger receiving_write_guard`;
          if (kind === "uid")
            await tx`update mailbox_messages set uid=0 where message_id=${message}`;
          else
            await tx`update mailbox_messages set mailbox_id=${secondary} where message_id=${message}`;
          await tx`alter table mailbox_messages enable trigger receiving_write_guard`;
        }
      });
      expect((await list().list(account, inbox)).items).toEqual([]);
      expect(
        (await search().search("Cutover")).items.some((m) => m.id === message),
      ).toBe(false);
      expect(
        await conversations().open(account, await conversationId()),
      ).toEqual([]);
      await expect(content().detail(account, inbox, message)).rejects.toThrow();
      await expect(attachments().download(attachment)).rejects.toThrow();
    },
  );
  it("direct CID resource requires original active source even with a valid ready raster", async () => {
    await enroll(false, {
      ...metadata,
      mimeStructure: {
        ...metadata.mimeStructure!,
        type: "image/png",
        disposition: "inline",
        filename: "logo.png",
        contentId: "logo",
      },
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYqkAAAAASUVORK5CYII=",
      "base64",
    );
    const attachment = await publishAttachment(png);
    expect(
      (await attachments().inlineResource(message, attachment, "logo")).bytes,
    ).toEqual(png);
    await replaceEpoch();
    await expect(
      attachments().inlineResource(message, attachment, "logo"),
    ).rejects.toThrow("unavailable");
    const [original] =
      await reader`select pg_get_functiondef('maildock_receiving_visible_resource(uuid,uuid,bigint,bigint,bigint)'::regprocedure) as ddl`;
    try {
      await reader.unsafe(
        "CREATE OR REPLACE FUNCTION maildock_receiving_visible_resource(message uuid, mailbox uuid, epoch bigint, remote_uid bigint, binding bigint) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$",
      );
      expect(
        (await attachments().inlineResource(message, attachment, "logo")).bytes,
      ).toEqual(png);
    } finally {
      await reader.unsafe(original.ddl);
    }
  });
  it("stale matching body cannot influence header-hit ranking", async () => {
    await enroll();
    await publishBody("Cutover ".repeat(100));
    await sharedPlacement();
    await replaceEpoch();
    await new ReceivingPersistence(executor).persist(
      owner,
      secondary,
      (await state(secondary)).state,
      {
        kind: "fresh",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 2n,
          high: 2n,
          searched: [2n],
          confirmedAbsent: [],
        },
        metadata: [
          {
            ...metadata,
            uid: "2",
            internalDate: "2027-01-01T00:00:00Z",
            envelope: {
              ...metadata.envelope,
              messageId: "<rank-control@example.test>",
            },
          },
        ],
      },
      budget(),
    );
    const [other] =
      await reader`select message_id from mailbox_messages where mailbox_id=${secondary} and uid=2`;
    const hits = (await search().search("Cutover")).items.filter(
      (m) => m.accountId === account,
    );
    expect(hits.map((m) => m.id)).toEqual([other.message_id, message]);
    expect(hits.every((m) => m.snippet === "Cutover boundary")).toBe(true);
    // The old generated vector would rank the retained source ahead of its
    // newer equal-header control; the endpoint's effective vector reverses it.
    const unsafe =
      await reader`select id from messages where account_id=${account} order by ts_rank(search_vector,plainto_tsquery('simple','Cutover')) desc,internal_date desc`;
    expect(unsafe[0].id).toBe(message);
  });
  it("SQL filters stale candidate sets before search limits and mailbox cursors", async () => {
    await enroll();
    const persistence = new ReceivingPersistence(executor);
    const batch = Array.from({ length: 55 }, (_, i) => ({
      ...metadata,
      uid: String(i + 2),
      internalDate: "2028-01-01T00:00:00Z",
      envelope: {
        ...metadata.envelope,
        subject: "R05paginationtoken",
        messageId: `<oldpage${i}@example.test>`,
      },
    }));
    await persistence.persist(
      owner,
      inbox,
      (await state()).state,
      {
        kind: "fresh",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 2n,
          high: 56n,
          searched: batch.map((m) => BigInt(m.uid)),
          confirmedAbsent: [],
        },
        metadata: batch,
      },
      budget(),
    );
    await persistence.persist(
      owner,
      inbox,
      (await state()).state,
      { kind: "epoch", complete: true, epoch: 8n, uidNext: 3n },
      budget(),
    );
    const current = [1, 2].map((uid) => ({
      ...metadata,
      uid: String(uid),
      internalDate: `2025-01-0${uid}T00:00:00Z`,
      envelope: {
        ...metadata.envelope,
        subject: "R05paginationtoken",
        messageId: `<newpage${uid}@example.test>`,
      },
    }));
    await persistence.persist(
      owner,
      inbox,
      (await state()).state,
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 8n,
          low: 1n,
          high: 2n,
          searched: [1n, 2n],
          confirmedAbsent: [],
        },
        metadata: current,
      },
      budget(),
    );
    const hits = await search().search("R05paginationtoken");
    expect(hits.items).toHaveLength(2);
    expect(hits.hasMore).toBe(false);
    const first = await list().list(account, inbox, 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await list().list(account, inbox, 1, first.nextCursor!);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect((await counts()).messageCount).toBe("2");
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where mailbox_id=${inbox}`
      )[0].n,
    ).toBe(58);
  });
});
