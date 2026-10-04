import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { simpleParser } from "mailparser";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { ComposePreparationService } from "@/modules/mail/application/compose-preparation-service";
import { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";
import { SentCopyService } from "@/modules/mail/application/sent-copy-service";
import { loadOutgoingMime } from "@/modules/mail/application/outgoing-mime-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/modules/mail/domain/attachments";
import { createAttachmentLock } from "@/modules/mail/infrastructure/attachment-lock";
import { createOutgoingLock } from "@/modules/mail/infrastructure/outgoing-lock";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import type {
  MailProvider,
  ProviderImapAccount,
  RemoteMimePart,
} from "@/modules/accounts/domain/mail-provider";
import {
  blobs,
  mailAccounts,
  mailboxes,
  mailboxRoles,
  mailboxMessages,
  messages,
  messageContents,
  messageAttachments,
  stagedAttachments,
  outgoingMessages,
  outgoingMessageAttachments,
} from "@/shared/infrastructure/database/schema";

const limits = DEFAULT_ATTACHMENT_LIMITS;
const pdf = Buffer.from([37, 80, 68, 70, 0, 255, 128, 10]);
function part(id: string, extra: Partial<RemoteMimePart> = {}): RemoteMimePart {
  return {
    part: id,
    type: "application/pdf",
    disposition: "attachment",
    filename: "invoice.pdf",
    contentId: null,
    encoding: "base64",
    size: "1",
    parameters: {},
    dispositionParameters: {},
    children: [],
    ...extra,
  };
}
describe("durable attachment and MIME lifecycle", () => {
  let container: StartedTestContainer,
    database: ReturnType<typeof createDatabase>,
    root: string,
    storage: LocalBlobStorage;
  let accountId: string,
    mailboxId: string,
    messageId: string,
    incomingId: string;
  let attachments: AttachmentService,
    outgoing: OutgoingMessageService,
    content: MessageContentService;
  let remoteBytes = pdf;
  const enqueue = vi.fn<(id: string) => Promise<void>>(async () => {}),
    fetch = vi.fn(async () => {}),
    deliver = vi.fn<NonNullable<MailProvider["deliverMessage"]>>(async () => ({
      outcome: "accepted" as const,
      acceptedCount: 1,
      rejectedCount: 0,
    }));
  const append = vi.fn<NonNullable<MailProvider["appendMessage"]>>(
    async () => ({
      outcome: "saved" as const,
      uidValidity: "7",
      uid: "99",
    }),
  );
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
    fetchMessageContent: async () => ({ plainText: "Body", html: null }),
    deliverMessage: deliver,
    appendMessage: append,
    async fetchAttachment<T>(
      _account: ProviderImapAccount,
      request: {
        remotePath: string;
        uid: string;
        expectedUidValidity: string;
        partId: string;
        maxBytes: number;
      },
      consume: (bytes: AsyncIterable<Uint8Array>) => Promise<T>,
    ) {
      await fetch();
      expect(request).toMatchObject({
        uid: "42",
        expectedUidValidity: "7",
        partId: "2",
      });
      return consume(Readable.from([remoteBytes]));
    },
  };
  const accounts = {
    getProviderImapAccountForWork: async () => ({ accountId, imap: {} }),
    getProviderSmtpAccountForWork: async () => ({ accountId, smtp: {} }),
  } as unknown as AccountsService;
  const source = () => ({
    accountId,
    mailboxId,
    messageId,
    mode: "forward" as const,
  });
  const input = () => ({
    accountId,
    to: "to@example.com",
    subject: "Files",
    plainText: "Body",
  });
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maildock-attachments-"));
    storage = new LocalBlobStorage(root);
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "attachments",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/attachments`,
      databasePoolSize: 4,
    });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  afterAll(async () => {
    if (database) await database.client.end();
    await container?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await database.db.delete(outgoingMessageAttachments);
    await database.db.delete(outgoingMessages);
    await database.db.delete(stagedAttachments);
    await database.db.delete(mailAccounts);
    await database.db.delete(blobs);
    accountId = randomUUID();
    mailboxId = randomUUID();
    messageId = randomUUID();
    remoteBytes = pdf;
    await database.db.insert(mailAccounts).values({
      id: accountId,
      displayName: "Owner",
      email: "owner@example.com",
      imapHost: "imap.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      imapPassword: { v: 1 } as never,
      smtpHost: "smtp.test",
      smtpPort: 465,
      smtpSecurity: "tls",
      sentCopyPolicy: "maildock",
    });
    await database.db.insert(mailboxes).values({
      id: mailboxId,
      accountId,
      name: "Inbox",
      remotePath: "INBOX",
      selectable: true,
      uidValidity: 7n,
      recentSyncUidValidity: 7n,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await database.db
      .insert(mailboxRoles)
      .values({ accountId, role: "sent", mailboxId, source: "manual" });
    await database.db.insert(messages).values({
      id: messageId,
      accountId,
      internalDate: new Date(),
      size: 100n,
      hasAttachments: true,
      mimeStructure: part("", {
        type: "multipart/mixed",
        disposition: null,
        filename: null,
        children: [
          part("1", {
            type: "text/plain",
            disposition: null,
            filename: null,
          }),
          part("2"),
          part("3", {
            type: "image/png",
            disposition: "inline",
            filename: null,
            contentId: "<logo>",
          }),
        ],
      }),
    });
    await database.db.insert(mailboxMessages).values({
      id: randomUUID(),
      mailboxId,
      messageId,
      uidValidity: 7n,
      uid: 42n,
      firstSynchronizedAt: new Date(),
      lastSynchronizedAt: new Date(),
    });
    await database.db
      .insert(messageContents)
      .values({ messageId, status: "ready", plainText: "Body" });
    enqueue.mockClear();
    fetch.mockReset();
    fetch.mockResolvedValue(undefined);
    deliver.mockClear();
    append.mockClear();
    attachments = new AttachmentService(
      database.db,
      storage,
      limits,
      enqueue,
      accounts,
      provider,
      createAttachmentLock(database.client),
    );
    outgoing = new OutgoingMessageService(
      database.db,
      enqueue,
      accounts,
      provider,
      createOutgoingLock(database.client),
      enqueue,
      storage,
    );
    content = new MessageContentService(database.db);
    incomingId = (
      await content.detail(accountId, mailboxId, messageId)
    ).attachments.find((a) => a.visible)!.id;
  });
  async function cached() {
    await attachments.request(incomingId);
    await attachments.run(incomingId);
    expect((await attachments.status(incomingId)).status).toBe("ready");
  }
  async function saved(id: string) {
    return (
      await database.db
        .select()
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, id))
    )[0];
  }
  async function blobFor(id: string) {
    return (await database.db.select().from(blobs).where(eq(blobs.id, id)))[0];
  }
  it("opening discovers durable MIME metadata without fetching binaries and preserves inline resources", async () => {
    const detail = await content.detail(accountId, mailboxId, messageId);
    expect(detail.attachments).toHaveLength(2);
    expect(detail.attachments[1]).toMatchObject({
      inline: true,
      visible: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await database.db.select().from(messageAttachments)).toHaveLength(2);
    expect(await database.db.select().from(blobs)).toEqual([]);
    await expect(
      content.detail(randomUUID(), mailboxId, messageId),
    ).rejects.toThrow();
  });
  it("queues only an ID, atomically publishes a cache and reuses it for subsequent downloads", async () => {
    await attachments.request(incomingId);
    expect(enqueue).toHaveBeenCalledWith(incomingId);
    expect((await attachments.status(incomingId)).status).toBe("pending");
    await attachments.run(incomingId);
    expect((await attachments.download(incomingId)).bytes).toEqual(pdf);
    await attachments.request(incomingId);
    await attachments.run(incomingId);
    expect((await attachments.download(incomingId)).bytes).toEqual(pdf);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await attachments.status(incomingId)).not.toHaveProperty(
      "storageKey",
    );
  });
  it("serializes concurrent fetches under an attachment advisory lock", async () => {
    await attachments.request(incomingId);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const entry = new Promise<void>((r) => {
      entered = r;
    });
    fetch.mockImplementation(async () => {
      entered();
      await gate;
    });
    const first = attachments.run(incomingId);
    await entry;
    await attachments.run(incomingId);
    release();
    await first;
    expect(fetch).toHaveBeenCalledOnce();
    expect((await attachments.status(incomingId)).status).toBe("ready");
  });
  it.each(["epoch", "placement", "disabled"])(
    "fails safely for stale/unavailable %s without fetching",
    async (change) => {
      await attachments.request(incomingId);
      if (change === "epoch")
        await database.db
          .update(mailboxes)
          .set({ recentSyncUidValidity: 8n })
          .where(eq(mailboxes.id, mailboxId));
      if (change === "placement") await database.db.delete(mailboxMessages);
      if (change === "disabled")
        await database.db
          .update(mailAccounts)
          .set({ enabled: false })
          .where(eq(mailAccounts.id, accountId));
      await attachments.run(incomingId);
      expect(fetch).not.toHaveBeenCalled();
      expect((await attachments.status(incomingId)).status).toBe("failed");
      await expect(attachments.download(incomingId)).rejects.toThrow();
    },
  );
  it("repairs durable fetching state after worker interruption", async () => {
    await attachments.request(incomingId);
    await database.db
      .update(messageAttachments)
      .set({ status: "fetching" })
      .where(eq(messageAttachments.id, incomingId));
    enqueue.mockClear();
    await attachments.repair();
    expect(enqueue).toHaveBeenCalledWith(incomingId);
    await attachments.run(incomingId);
    expect((await attachments.status(incomingId)).status).toBe("ready");
  });
  it("never references a partial blob on oversized remote stream or storage failure", async () => {
    const small = new AttachmentService(
      database.db,
      storage,
      { ...limits, maxAttachmentBytes: 4 },
      enqueue,
      accounts,
      provider,
      createAttachmentLock(database.client),
    );
    await small.request(incomingId);
    await small.run(incomingId);
    const [row] = await database.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, incomingId));
    expect(row).toMatchObject({ status: "failed", blobId: null });
    expect(await database.db.select().from(blobs)).toHaveLength(0);
    const failing = new AttachmentService(
      database.db,
      {
        ...storage,
        put: async () => {
          throw Error("disk full");
        },
      } as unknown as LocalBlobStorage,
      limits,
      enqueue,
      accounts,
      provider,
      createAttachmentLock(database.client),
    );
    await failing.request(incomingId);
    await failing.run(incomingId);
    expect((await attachments.status(incomingId)).status).toBe("failed");
  });
  it("recovers a missing incoming cache from the exact authoritative placement", async () => {
    await cached();
    const [row] = await database.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, incomingId));
    const blob = await blobFor(row.blobId!);
    await storage.delete(blob.storageKey);
    await attachments.request(incomingId);
    await attachments.run(incomingId);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await attachments.download(incomingId)).bytes).toEqual(pdf);
  });
  it("stages durable bytes with safe metadata before ready and rejects oversized uploads", async () => {
    const uploaded = await attachments.upload(
      Readable.from([pdf]),
      "../../Zażółć.pdf\r\n",
      "bad\r\nheader",
    );
    expect(uploaded).toMatchObject({
      size: "8",
      status: "ready",
      type: "application/octet-stream",
    });
    expect(uploaded.filename).not.toMatch(/[\\/\r\n]/);
    expect(uploaded).not.toHaveProperty("storageKey");
    const small = new AttachmentService(
      database.db,
      storage,
      { ...limits, maxAttachmentBytes: 4 },
      enqueue,
    );
    await expect(
      small.upload(Readable.from([pdf]), "x", "application/pdf"),
    ).rejects.toThrow("size limit");
    expect(await database.db.select().from(stagedAttachments)).toHaveLength(1);
  });
  it("freezes attachment order/metadata/hash and uses blob MIME for exact SMTP and Sent APPEND", async () => {
    const first = await attachments.upload(
        Readable.from([pdf]),
        "Zażółć.pdf",
        "application/pdf",
      ),
      second = await attachments.upload(
        Readable.from([Buffer.from("second")]),
        "invoice.pdf",
        "application/pdf",
      );
    const created = await outgoing.create({
      ...input(),
      attachments: [second, first].map((a) => ({ kind: "staged", id: a.id })),
    });
    const row = await saved(created.id);
    expect(row.mimeBase64).toBeNull();
    expect(row.mimeBlobId).toBeTruthy();
    const snap = await database.db
      .select()
      .from(outgoingMessageAttachments)
      .orderBy(outgoingMessageAttachments.position);
    expect(snap.map((a) => a.filename)).toEqual(["invoice.pdf", "Zażółć.pdf"]);
    expect(snap.map((a) => a.size)).toEqual([6, 8]);
    expect(snap[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    await database.db.delete(stagedAttachments); // Outgoing is independent of mutable staging.
    const mime = await loadOutgoingMime(
      database.db,
      storage,
      row,
      limits.maxOutgoingMimeBytes,
    );
    expect(
      (await simpleParser(mime)).attachments.map((a) => a.content),
    ).toEqual([Buffer.from("second"), pdf]);
    await outgoing.run(created.id);
    const copies = new SentCopyService(
      database.db,
      accounts,
      provider,
      createOutgoingLock(database.client),
      enqueue,
      async () => true,
      storage,
    );
    await copies.run(created.id);
    expect(deliver.mock.calls[0][2]).toEqual(mime);
    expect(append.mock.calls[0][2]).toEqual(mime);
    expect((await saved(created.id)).sentCopyStatus).toBe("saved");
    await expect(
      database.db
        .update(outgoingMessages)
        .set({ mimeBlobId: randomUUID() })
        .where(eq(outgoingMessages.id, created.id)),
    ).rejects.toThrow();
    await expect(
      database.db
        .update(outgoingMessageAttachments)
        .set({ filename: "changed" }),
    ).rejects.toThrow();
    await expect(
      database.db.delete(blobs).where(eq(blobs.id, row.mimeBlobId!)),
    ).rejects.toThrow();
  });
  it.each(["missing", "corrupt"])(
    "fails before SMTP when immutable MIME is %s",
    async (kind) => {
      const created = await outgoing.create(input());
      const row = await saved(created.id);
      const blob = await blobFor(row.mimeBlobId!);
      if (kind === "missing") await storage.delete(blob.storageKey);
      else
        await writeFile(
          path.join(
            root,
            "blobs",
            blob.storageKey.slice(0, 2),
            blob.storageKey,
          ),
          "corrupt",
        );
      await outgoing.run(created.id);
      expect(deliver).not.toHaveBeenCalled();
      expect(await saved(created.id)).toMatchObject({
        status: "failed",
        attempts: 0,
      });
    },
  );
  it("Sent-copy storage failure leaves SMTP sent and never resends", async () => {
    const created = await outgoing.create(input());
    await outgoing.run(created.id);
    const row = await saved(created.id);
    const blob = await blobFor(row.mimeBlobId!);
    await storage.delete(blob.storageKey);
    await new SentCopyService(
      database.db,
      accounts,
      provider,
      createOutgoingLock(database.client),
      enqueue,
      async () => true,
      storage,
    ).run(created.id);
    expect(await saved(created.id)).toMatchObject({
      status: "sent",
      sentCopyStatus: "failed",
    });
    expect(append).not.toHaveBeenCalled();
    await outgoing.run(created.id);
    expect(deliver).toHaveBeenCalledOnce();
  });
  it.each(["reply", "reply_all", "forward"] as const)(
    "prepares %s with the correct original attachment selection",
    async (mode) => {
      await database.db
        .update(messages)
        .set({ from: [{ address: "sender@example.com" }] })
        .where(eq(messages.id, messageId));
      const result = await new ComposePreparationService(
        database.db,
        content,
        attachments,
      ).prepare({ ...source(), mode });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error();
      expect(result.prefill.attachments?.length).toBe(
        mode === "forward" ? 1 : 0,
      );
      if (mode === "forward") {
        expect(result.prefill.attachments![0]).toMatchObject({
          id: incomingId,
          status: "pending",
        });
        expect(enqueue).toHaveBeenCalledWith(incomingId);
      }
    },
  );
  it("Forward reuses the cached incoming blob, and removing selection never deletes it", async () => {
    await cached();
    const [original] = await database.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, incomingId));
    const forwarded = await outgoing.create({
      ...input(),
      source: source(),
      attachments: [{ kind: "incoming", id: incomingId }],
    });
    const [snap] = await database.db
      .select()
      .from(outgoingMessageAttachments)
      .where(eq(outgoingMessageAttachments.outgoingMessageId, forwarded.id));
    expect(snap.blobId).toBe(original.blobId);
    expect(fetch).toHaveBeenCalledOnce();
    const removed = await outgoing.create({
      ...input(),
      source: source(),
      attachments: [],
    });
    expect(
      (
        await simpleParser(
          await loadOutgoingMime(
            database.db,
            storage,
            await saved(removed.id),
            limits.maxOutgoingMimeBytes,
          ),
        )
      ).attachments,
    ).toHaveLength(0);
    expect((await attachments.download(incomingId)).bytes).toEqual(pdf);
  });
  it("refuses unavailable, cross-message, duplicate or inline-only forwarded selections without silently omitting them", async () => {
    await expect(
      outgoing.create({
        ...input(),
        source: source(),
        attachments: [{ kind: "incoming", id: incomingId }],
      }),
    ).rejects.toThrow("not ready");
    await cached();
    await expect(
      outgoing.create({
        ...input(),
        source: { ...source(), mode: "reply" },
        attachments: [{ kind: "incoming", id: incomingId }],
      }),
    ).rejects.toThrow("Forward");
    const inline = (
      await content.detail(accountId, mailboxId, messageId)
    ).attachments.find((a) => !a.visible)!;
    await expect(
      outgoing.create({
        ...input(),
        source: source(),
        attachments: [{ kind: "incoming", id: inline.id }],
      }),
    ).rejects.toThrow();
    await expect(
      outgoing.create({
        ...input(),
        source: source(),
        attachments: [
          { kind: "incoming", id: incomingId },
          { kind: "incoming", id: incomingId },
        ],
      }),
    ).rejects.toThrow();
    expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
  });
  it("enforces total attachment payload and final MIME size server-side without queued rows", async () => {
    const uploaded = await attachments.upload(
      Readable.from([pdf]),
      "x",
      "application/pdf",
    );
    for (const changed of [
      { maxOutgoingAttachmentBytes: 4 },
      { maxOutgoingMimeBytes: 50 },
    ]) {
      const small = new OutgoingMessageService(
        database.db,
        enqueue,
        undefined,
        undefined,
        undefined,
        undefined,
        storage,
        { ...limits, ...changed },
      );
      await expect(
        small.create({
          ...input(),
          attachments: [{ kind: "staged", id: uploaded.id }],
        }),
      ).rejects.toThrow();
    }
    expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
    expect((await database.db.select().from(stagedAttachments))[0].status).toBe(
      "ready",
    );
  });
  it("removal and expiry make staged uploads ineligible without deleting shared physical bytes", async () => {
    const uploaded = await attachments.upload(
      Readable.from([pdf]),
      "x",
      "application/pdf",
    );
    const [staged] = await database.db.select().from(stagedAttachments);
    const blob = await blobFor(staged.blobId);
    await attachments.removeStaged(uploaded.id);
    expect(await storage.exists(blob.storageKey)).toBe(true);
    await expect(
      outgoing.create({
        ...input(),
        attachments: [{ kind: "staged", id: uploaded.id }],
      }),
    ).rejects.toThrow("unavailable");
    const expired = await attachments.upload(
      Readable.from([pdf]),
      "y",
      "application/pdf",
    );
    await database.db
      .update(stagedAttachments)
      .set({ expiresAt: new Date(0) })
      .where(eq(stagedAttachments.id, expired.id));
    await expect(
      outgoing.create({
        ...input(),
        attachments: [{ kind: "staged", id: expired.id }],
      }),
    ).rejects.toThrow("expired");
  });
  it("continues to deliver and APPEND legacy MIME without rebuilding", async () => {
    const id = randomUUID(),
      legacy = Buffer.from("Message-ID: <legacy@example.com>\r\n\r\nLegacy");
    await database.db.insert(outgoingMessages).values({
      id,
      accountId,
      from: { address: "owner@example.com" },
      to: [{ address: "to@example.com" }],
      cc: [],
      bcc: [],
      subject: "Legacy",
      plainText: "Legacy",
      messageId: "<legacy@example.com>",
      mimeBase64: legacy.toString("base64"),
      sentCopyPolicy: "maildock",
    });
    await outgoing.run(id);
    await new SentCopyService(
      database.db,
      accounts,
      provider,
      createOutgoingLock(database.client),
      enqueue,
      async () => true,
      storage,
    ).run(id);
    expect(deliver.mock.calls[0][2]).toEqual(legacy);
    expect(append.mock.calls[0][2]).toEqual(legacy);
  });
  it("leaves an unreferenced MIME object on transaction rollback instead of queueing partial state", async () => {
    await database.client.unsafe(
      "CREATE FUNCTION fail_outgoing_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated'; END; $$",
    );
    await database.client.unsafe(
      "CREATE TRIGGER fail_outgoing_insert BEFORE INSERT ON outgoing_messages FOR EACH ROW EXECUTE FUNCTION fail_outgoing_insert()",
    );
    try {
      await expect(outgoing.create(input())).rejects.toThrow();
      expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
      expect(await database.db.select().from(blobs)).toHaveLength(0);
    } finally {
      await database.client.unsafe(
        "DROP TRIGGER fail_outgoing_insert ON outgoing_messages",
      );
      await database.client.unsafe("DROP FUNCTION fail_outgoing_insert()");
    }
  });
});
