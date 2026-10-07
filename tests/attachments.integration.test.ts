import { EmailRenderingService } from "@/modules/mail/application/email-rendering-service";
import { RemoteContentSenderService } from "@/modules/mail/application/remote-content-sender-service";
import {
  EMAIL_HTML_POLICY,
  sanitizeEmailHtml,
} from "@/modules/mail/infrastructure/sanitize-email-html";
import { JSDOM } from "jsdom";
import { DraftService } from "@/modules/mail/application/draft-service";
import { SignatureService } from "@/modules/mail/application/signature-service";
import { automaticSignature } from "@/modules/mail/domain/signature";
import { DraftConflictError } from "@/modules/mail/domain/draft";
import {
  plainTextDocument,
  richElement,
  richText,
  richResourceIds,
  serializeRichDocument,
  type RichDocument,
} from "@/modules/mail/domain/rich-document";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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
  remoteContentSenders,
  drafts,
  draftAttachments,
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
  signatures,
  signatureResources,
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
    await database.db.delete(signatures);
    await database.db.delete(remoteContentSenders);
    await database.db.delete(drafts);
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
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYqkAAAAASUVORK5CYII=",
    "base64",
  );
  async function richHtml(html: string) {
    const clean = sanitizeEmailHtml(html);
    await database.db
      .update(messages)
      .set({
        from: [{ name: "Microsoft Support", address: " Evil@Example.Test " }],
      })
      .where(eq(messages.id, messageId));
    await database.db
      .update(messageContents)
      .set({
        sanitizedHtml: clean.html,
        remoteContentBlocked: clean.remoteContentBlocked,
        policyVersion: EMAIL_HTML_POLICY,
      })
      .where(eq(messageContents.messageId, messageId));
  }
  const blockedOptions = { loadImages: false, trustSender: false };
  it("fetches only referenced CID on demand, reuses verified cache, and keeps inline visibility", async () => {
    await richHtml('<p>HTML</p><img src="cid:%3Clogo%3E">');
    const renderer = new EmailRenderingService(
      database.db,
      content,
      attachments,
    );
    const first = await renderer.render(
      accountId,
      mailboxId,
      messageId,
      blockedOptions,
    );
    const inline = (
      await content.detail(accountId, mailboxId, messageId)
    ).attachments.find((a) => a.inline)!;
    expect(first.pending).toBe(true);
    expect(first.blocked).toBe(false);
    expect(enqueue.mock.calls.map((c) => c[0])).toEqual([inline.id]);
    expect((await attachments.status(incomingId)).status).toBe("not_fetched");
    const fetchInline = vi.fn();
    const inlineProvider: MailProvider = {
      ...provider,
      async fetchAttachment(_account, request, consume) {
        fetchInline();
        expect(request.partId).toBe("3");
        return consume(Readable.from([png]));
      },
    };
    const worker = new AttachmentService(
      database.db,
      storage,
      limits,
      enqueue,
      accounts,
      inlineProvider,
      createAttachmentLock(database.client),
    );
    await worker.run(inline.id);
    const ready = await renderer.render(
      accountId,
      mailboxId,
      messageId,
      blockedOptions,
    );
    expect(ready.pending).toBe(false);
    expect(ready.inlineFailures).toBe(0);
    expect(
      new JSDOM(ready.document!).window.document.querySelector("img")?.src,
    ).toMatch(/^data:image\/png;base64,/);
    await renderer.render(accountId, mailboxId, messageId, blockedOptions);
    await worker.run(inline.id);
    expect(fetchInline).toHaveBeenCalledTimes(1);
    expect(
      (await content.detail(accountId, mailboxId, messageId)).attachments.find(
        (a) => a.id === inline.id,
      )?.visible,
    ).toBe(false);
    await expect(
      attachments.inlineResource(randomUUID(), inline.id, "logo"),
    ).rejects.toThrow("Inline resource is unavailable");
    await expect(
      attachments.inlineResource(messageId, inline.id, "wrong"),
    ).rejects.toThrow("Inline resource is unavailable");
  });
  it("normalizes CID domain case, refuses ambiguous/missing/unsafe types, and handles fetch failure", async () => {
    const inline = (
      await content.detail(accountId, mailboxId, messageId)
    ).attachments.find((a) => a.inline)!;
    await database.db
      .update(messageAttachments)
      .set({ contentId: " <Logo@EXAMPLE.TEST> " })
      .where(eq(messageAttachments.id, inline.id));
    await richHtml('<img src="cid:Logo@example.test"><img src="cid:missing">');
    const renderer = new EmailRenderingService(
      database.db,
      content,
      attachments,
    );
    expect(
      (await renderer.render(accountId, mailboxId, messageId, blockedOptions))
        .pending,
    ).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(inline.id);
    await database.db
      .update(messageAttachments)
      .set({ status: "failed", error: "Failed" })
      .where(eq(messageAttachments.id, inline.id));
    const failed = await renderer.render(
      accountId,
      mailboxId,
      messageId,
      blockedOptions,
    );
    expect(failed.pending).toBe(false);
    expect(failed.inlineFailures).toBe(2);
    expect(failed.document).toBeTruthy();
    enqueue.mockClear();
    await database.db
      .update(messageAttachments)
      .set({ status: "not_fetched", contentType: "image/svg+xml" })
      .where(eq(messageAttachments.id, inline.id));
    expect(
      (await renderer.render(accountId, mailboxId, messageId, blockedOptions))
        .inlineFailures,
    ).toBe(2);
    expect(enqueue).not.toHaveBeenCalled();
    await expect(
      attachments.inlineResource(messageId, inline.id, "Logo@example.test"),
    ).rejects.toThrow("Inline resource is unavailable");
  });
  it("refuses script-capable bytes mislabeled as a raster inline resource", async () => {
    await richHtml('<img src="cid:logo">');
    const inline = (
      await content.detail(accountId, mailboxId, messageId)
    ).attachments.find((a) => a.inline)!;
    await attachments.request(inline.id);
    const worker = new AttachmentService(
      database.db,
      storage,
      limits,
      enqueue,
      accounts,
      {
        ...provider,
        async fetchAttachment(_account, _request, consume) {
          return consume(
            Readable.from([
              Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>',
              ),
            ]),
          );
        },
      },
      createAttachmentLock(database.client),
    );
    await worker.run(inline.id);
    await expect(
      attachments.inlineResource(messageId, inline.id, "logo"),
    ).rejects.toThrow("Inline image format is invalid");
    const result = await new EmailRenderingService(
      database.db,
      content,
      attachments,
    ).render(accountId, mailboxId, messageId, blockedOptions);
    expect(result.inlineFailures).toBe(1);
    expect(result.document).not.toContain("data:image");
  });
  it("never downloads unreferenced attachments for remote-only HTML", async () => {
    await richHtml('<p>Newsletter</p><img src="https://tracker.test/pixel">');
    const renderer = new EmailRenderingService(
      database.db,
      content,
      attachments,
    );
    const blocked = await renderer.render(
      accountId,
      mailboxId,
      messageId,
      blockedOptions,
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.document).not.toContain("tracker.test");
    expect(enqueue).not.toHaveBeenCalled();
    const loaded = await renderer.render(accountId, mailboxId, messageId, {
      ...blockedOptions,
      loadImages: true,
    });
    expect(loaded.blocked).toBe(false);
    expect(loaded.document).toContain('src="https://tracker.test/pixel"');
    expect(
      (await renderer.render(accountId, mailboxId, messageId, blockedOptions))
        .blocked,
    ).toBe(true);
    expect(await new RemoteContentSenderService(database.db).list()).toEqual(
      [],
    );
  });
  it("persists exact parsed sender, applies to later messages, and removal restores blocking", async () => {
    await richHtml('<p>Hello</p><img src="https://tracker.test/image">');
    const renderer = new EmailRenderingService(
      database.db,
      content,
      attachments,
    );
    await renderer.render(accountId, mailboxId, messageId, {
      ...blockedOptions,
      trustSender: true,
    });
    const rules = new RemoteContentSenderService(database.db);
    expect((await rules.list()).map((r) => r.address)).toEqual([
      "evil@example.test",
    ]);
    async function next(address: string) {
      const id = randomUUID();
      await database.db.insert(messages).values({
        id,
        accountId,
        internalDate: new Date(),
        size: 1n,
        from: [{ name: "Microsoft Support", address }],
      });
      await database.db.insert(mailboxMessages).values({
        id: randomUUID(),
        messageId: id,
        mailboxId,
        uidValidity: 7n,
        uid: BigInt(Math.floor(Math.random() * 100000) + 1000),
        firstSynchronizedAt: new Date(),
        lastSynchronizedAt: new Date(),
      });
      const clean = sanitizeEmailHtml('<img src="https://tracker.test/image">');
      await database.db.insert(messageContents).values({
        messageId: id,
        status: "ready",
        sanitizedHtml: clean.html,
        remoteContentBlocked: true,
        policyVersion: EMAIL_HTML_POLICY,
      });
      return renderer.render(accountId, mailboxId, id, blockedOptions);
    }
    expect((await next("EVIL@example.test")).blocked).toBe(false);
    expect((await next("other@example.test")).blocked).toBe(true);
    await rules.remove("evil@example.test");
    expect((await next("evil@example.test")).blocked).toBe(true);
  });
  it("lazily refreshes historical HTML using selected text parts without full MIME", async () => {
    await richHtml("<p>Old reduced body</p>");
    await database.db
      .update(messageContents)
      .set({ policyVersion: "email-html-v1" })
      .where(eq(messageContents.messageId, messageId));
    await database.db
      .update(messages)
      .set({
        mimeStructure: part("", {
          type: "multipart/alternative",
          disposition: null,
          filename: null,
          children: [
            part("1", {
              type: "text/plain",
              disposition: null,
              filename: null,
            }),
            part("2", { type: "text/html", disposition: null, filename: null }),
          ],
        }),
      })
      .where(eq(messages.id, messageId));
    const schedule = vi.fn(async () => true);
    const fetchBody = vi.fn<MailProvider["fetchMessageContent"]>(
      async (_account, request) => {
        expect(request.parts).toEqual([
          { part: "1", type: "text/plain" },
          { part: "2", type: "text/html" },
        ]);
        return {
          plainText: "Fallback",
          html: '<table><tr><td style="color:red">Restored<img src="https://tracker.test/x"></td></tr></table>',
        };
      },
    );
    const service = new MessageContentService(
      database.db,
      { schedule },
      accounts,
      { ...provider, fetchMessageContent: fetchBody },
      { maxMessageTextPartBytes: 100000 },
    );
    expect(
      (await service.detail(accountId, mailboxId, messageId)).content.status,
    ).toBe("not_fetched");
    await service.request(accountId, mailboxId, messageId);
    await service.run(accountId, mailboxId, messageId);
    const result = await service.detail(accountId, mailboxId, messageId);
    expect(result.content.status).toBe("ready");
    expect(result.content.sanitizedHtml).toContain("Restored");
    expect(result.content.sanitizedHtml).toContain('style="color:red"');
    expect(fetchBody).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    await service.request(accountId, mailboxId, messageId);
    expect(schedule).toHaveBeenCalledTimes(1);
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
  it.each(["reply", "reply_all", "forward"] as const)(
    "quotes HTML-only %s without stylesheet text",
    async (mode) => {
      await richHtml(
        "<p>Visible message</p><style>.signature{color:#123456}</style><p>Signature</p>",
      );
      await database.db
        .update(messageContents)
        .set({ plainText: null })
        .where(eq(messageContents.messageId, messageId));
      const result = await new ComposePreparationService(
        database.db,
        content,
        attachments,
      ).prepare({ ...source(), mode });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error();
      expect(result.prefill.plainText).toContain("Visible message");
      expect(result.prefill.plainText).toContain("Signature");
      expect(result.prefill.plainText).not.toContain(".signature");
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
  const draftInput = () => ({
    id: randomUUID(),
    ...input(),
    cc: "cc@example.com",
    bcc: "private@example.com",
    attachments: [],
  });
  const draftService = () => new DraftService(database.db);
  it("signature CRUD, account defaults, image snapshots and real MIME reuse the rich draft pipeline", async () => {
    const service = new SignatureService(database.db, attachments);
    const id = randomUUID();
    const image = await attachments.upload(
      Readable.from([png]),
      "signature.png",
      "image/png",
      id,
      true,
    );
    const template = plainTextDocument("NMI signature");
    template.editor.root.children![0].children!.push({
      type: "maildock-image",
      version: 1,
      resourceId: image.id,
      alt: "NMI logo",
      width: 160,
    });
    const created = await service.save(id, {
      name: "NMI",
      richDocument: template,
    });
    expect((await service.get(id)).name).toBe("NMI");
    await service.setDefaults(accountId, { new: id, reply: id, forward: id });
    expect((await service.catalog()).defaults[accountId]).toEqual({
      new: id,
      reply: id,
      forward: id,
    });
    await expect(
      service.setDefaults(randomUUID(), {
        new: id,
        reply: null,
        forward: null,
      }),
    ).rejects.toThrow();
    await expect(
      service.setDefaults(accountId, {
        new: randomUUID(),
        reply: null,
        forward: null,
      }),
    ).rejects.toThrow();
    const blobCount = (await database.db.select().from(blobs)).length;
    const draftId = randomUUID();
    const snapshot = await service.snapshot(id, draftId);
    const otherDraftId = randomUUID();
    const another = await service.snapshot(id, otherDraftId);
    expect(snapshot.attachments[0].id).not.toBe(image.id);
    expect(another.attachments[0].id).not.toBe(snapshot.attachments[0].id);
    expect((await database.db.select().from(blobs)).length).toBe(blobCount);
    await expect(
      draftService().create({
        ...draftInput(),
        richDocument: snapshot.richDocument,
        attachments: snapshot.attachments.map(({ id, kind, inline }) => ({
          id,
          kind,
          inline,
        })),
      }),
    ).rejects.toThrow();
    const document = plainTextDocument("Editable content");
    document.editor.root.children!.push(
      await automaticSignature(id, snapshot.richDocument),
    );
    const row = await draftService().create({
      ...draftInput(),
      id: draftId,
      richDocument: document,
      attachments: snapshot.attachments.map(({ id, kind, inline }) => ({
        id,
        kind,
        inline,
      })),
    });
    const changed = await service.save(
      id,
      { name: "Renamed", richDocument: plainTextDocument("Changed template") },
      created.revision,
    );
    await expect(
      service.save(
        id,
        { name: "stale", richDocument: template },
        created.revision,
      ),
    ).rejects.toThrow();
    await expect(service.delete(id, created.revision)).rejects.toThrow();
    await service.delete(id, changed.revision);
    expect((await service.catalog()).signatures).toEqual([]);
    expect((await service.catalog()).defaults[accountId]).toEqual({
      new: null,
      reply: null,
      forward: null,
    });
    expect(await database.db.select().from(signatureResources)).toEqual([]);
    const savedAfterDeletion = await draftService().create({
      ...draftInput(),
      id: otherDraftId,
      richDocument: another.richDocument,
      attachments: another.attachments.map(({ id, kind, inline }) => ({
        id,
        kind,
        inline,
      })),
    });
    expect(savedAfterDeletion.plainText).toContain("NMI signature");
    expect(
      (
        await attachments.composeResource(
          otherDraftId,
          another.attachments[0].id,
        )
      ).bytes,
    ).toEqual(png);
    const reopened = await draftService().get(draftId);
    expect(reopened.richDocument).toEqual(row.richDocument);
    expect(reopened.plainText).toContain("NMI signature");
    expect(reopened.plainText).not.toContain("Changed template");
    expect(
      (await attachments.composeResource(draftId, snapshot.attachments[0].id))
        .bytes,
    ).toEqual(png);
    await expect(
      attachments.composeResource(randomUUID(), snapshot.attachments[0].id),
    ).rejects.toThrow();
    const sent = await outgoing.create(undefined, {
      id: draftId,
      expectedRevision: reopened.revision,
    });
    const [message] = await database.db
      .select()
      .from(outgoingMessages)
      .where(eq(outgoingMessages.id, sent.id));
    const mime = await loadOutgoingMime(
      database.db,
      storage,
      message,
      limits.maxOutgoingMimeBytes,
    );
    const parsed = await simpleParser(mime, { skipImageLinks: true });
    expect(parsed.text).toContain("NMI signature");
    expect(parsed.html).toContain("NMI signature");
    expect(parsed.html).not.toContain("maildock-signature");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].content).toEqual(png);
    expect(parsed.attachments[0].contentDisposition).toBe("inline");
    expect(parsed.html).toContain(
      `cid:${parsed.attachments[0].contentId!.replace(/^<|>$/g, "")}`,
    );
  });
  it("signature resources reject foreign bindings, arbitrary resources, unsafe documents and replay", async () => {
    const service = new SignatureService(database.db, attachments);
    const id = randomUUID(),
      other = randomUUID();
    const image = await attachments.upload(
      Readable.from([png]),
      "logo.png",
      "image/png",
      id,
      true,
    );
    const document = plainTextDocument("Signature");
    document.editor.root.children![0].children!.push({
      type: "maildock-image",
      version: 1,
      resourceId: image.id,
      alt: "Logo",
      width: 480,
    });
    await expect(
      service.save(other, { name: "Foreign", richDocument: document }),
    ).rejects.toThrow();
    const created = await service.save(id, {
      name: "Owner",
      richDocument: document,
    });
    await expect(
      service.save(other, { name: "Replay", richDocument: document }),
    ).rejects.toThrow();
    await expect(
      attachments.composeResource(other, image.id),
    ).rejects.toThrow();
    const arbitrary = structuredClone(document);
    arbitrary.editor.root.children![0].children![1].resourceId = randomUUID();
    await expect(
      service.save(
        id,
        { name: "Arbitrary", richDocument: arbitrary },
        created.revision,
      ),
    ).rejects.toThrow();
    const unsafe = structuredClone(document);
    unsafe.editor.root.children![0].children![1] = {
      type: "maildock-image",
      version: 1,
      url: "data:image/png;base64,AAAA",
      alt: "bad",
      width: 480,
    };
    await expect(
      service.save(
        id,
        { name: "Unsafe", richDocument: unsafe },
        created.revision,
      ),
    ).rejects.toThrow();
    expect((await service.get(id)).richDocument).toEqual(created.richDocument);
  });
  it("forward migration preserves active legacy line breaks and leaves consumed drafts alone", async () => {
    const migration = await readFile(
      "db/migrations/0020_mighty_slayback.sql",
      "utf8",
    );
    await database.client.begin(async (sql) => {
      for (const table of [
        "drafts",
        "draft_attachments",
        "staged_attachments",
        "outgoing_messages",
        "outgoing_message_attachments",
      ])
        await sql.unsafe(
          `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
      await sql.unsafe(
        "ALTER TABLE drafts DROP COLUMN rich_document; ALTER TABLE draft_attachments DROP COLUMN inline, DROP COLUMN content_id; ALTER TABLE staged_attachments DROP COLUMN draft_id; ALTER TABLE outgoing_messages DROP COLUMN rich_document, DROP COLUMN html; ALTER TABLE outgoing_message_attachments DROP COLUMN inline, DROP COLUMN content_id, DROP COLUMN resource_id",
      );
      const active = randomUUID(),
        consumed = randomUUID();
      const text = "\nZażółć\r\n\r\nlast\n";
      await sql`INSERT INTO drafts(id,account_id,compose_mode,plain_text,status) VALUES (${active},${accountId},'new',${text},'active'),(${consumed},${accountId},'new','Consumed','consumed')`;
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await sql.unsafe(statement);
      const rows = await sql`SELECT id,rich_document FROM drafts`;
      expect(
        serializeRichDocument(rows.find((r) => r.id === active)!.rich_document)
          .plainText,
      ).toBe(text.replace(/\r\n/g, "\n"));
      expect(rows.find((r) => r.id === consumed)!.rich_document).toBeNull();
    });
  });
  it("round-trips a durable rich draft, CID and PDF, claims resources once, and preserves immutable retry/Sent bytes", async () => {
    const draftId = randomUUID();
    const image = await attachments.upload(
      Readable.from([png]),
      "screen.png",
      "image/png",
      draftId,
      true,
    );
    const file = await attachments.upload(
      Readable.from([pdf]),
      "file.pdf",
      "application/pdf",
      draftId,
    );
    const document: RichDocument = {
      version: 1,
      editor: {
        root: richElement("root", [
          richElement("paragraph", [
            richText("Zażółć", 1),
            {
              type: "maildock-image",
              version: 1,
              resourceId: image.id,
              alt: "Screenshot",
              width: 320,
            },
          ]),
        ]),
      },
    };
    const row = await draftService().create({
      ...draftInput(),
      id: draftId,
      richDocument: document,
      plainText: "untrusted stale alternative",
      attachments: [
        { id: image.id, kind: "staged", inline: true },
        { id: file.id, kind: "staged" },
      ],
    });
    const restored = await new DraftService(database.db).get(row.id);
    expect(restored.richDocument).toEqual(row.richDocument);
    expect(restored.plainText).toContain("Zażółć[Image: Screenshot]");
    expect(restored.plainText).not.toContain("untrusted");
    expect(restored.attachments.map((a) => a.inline)).toEqual([true, false]);
    expect(
      (await attachments.composeResource(draftId, image.id)).bytes,
    ).toEqual(png);
    await expect(
      attachments.composeResource(randomUUID(), image.id),
    ).rejects.toThrow();
    await expect(
      draftService().create({
        ...draftInput(),
        richDocument: document,
        attachments: [{ id: image.id, kind: "staged", inline: true }],
      }),
    ).rejects.toThrow();
    await expect(
      draftService().create({
        ...draftInput(),
        richDocument: document,
        attachments: [{ id: image.id, kind: "draft", inline: true }],
      }),
    ).rejects.toThrow();
    const sent = await outgoing.create(undefined, {
      id: row.id,
      expectedRevision: row.revision,
    });
    const message = (
      await database.db
        .select()
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, sent.id))
    )[0];
    const snapshots = await database.db
      .select()
      .from(outgoingMessageAttachments)
      .where(eq(outgoingMessageAttachments.outgoingMessageId, sent.id));
    const inline = snapshots.find((a) => a.inline)!;
    expect(inline.contentId).toMatch(/@maildock\.invalid$/);
    expect(message.html).toContain(`cid:${inline.contentId}`);
    expect(message.richDocument).toEqual(restored.richDocument);
    const mime = await loadOutgoingMime(
      database.db,
      storage,
      message,
      limits.maxOutgoingMimeBytes,
    );
    const parsed = await simpleParser(mime, { skipImageLinks: true });
    expect(parsed.html).toBe(message.html);
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.attachments.map((a) => a.contentDisposition)).toEqual([
      "inline",
      "attachment",
    ]);
    await expect(
      database.db
        .update(outgoingMessages)
        .set({ html: "changed" })
        .where(eq(outgoingMessages.id, sent.id)),
    ).rejects.toThrow();
    await expect(
      database.db
        .update(outgoingMessageAttachments)
        .set({ contentId: `${randomUUID()}@maildock.invalid` })
        .where(eq(outgoingMessageAttachments.outgoingMessageId, sent.id)),
    ).rejects.toThrow();
    deliver.mockResolvedValueOnce({
      outcome: "definite_failure",
      retryable: true,
      message: "Retry",
    });
    await outgoing.run(sent.id);
    await database.db
      .update(outgoingMessages)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(outgoingMessages.id, sent.id));
    await outgoing.run(sent.id);
    expect(deliver.mock.calls).toHaveLength(2);
    expect(deliver.mock.calls[0][2]).toEqual(mime);
    expect(deliver.mock.calls[1][2]).toEqual(mime);
    expect(deliver.mock.calls[0][1].to).toContain("private@example.com");
    await new SentCopyService(
      database.db,
      accounts,
      provider,
      createOutgoingLock(database.client),
      enqueue,
      async () => true,
      storage,
    ).run(sent.id);
    expect(append.mock.calls[0][2]).toEqual(mime);
    expect(
      await outgoing.create(undefined, { id: row.id, expectedRevision: 1 }),
    ).toEqual({ id: sent.id, status: "sent" });
  });
  it("rejects invalid inline bytes, source substitution, dangling references and corrupt cached resources before consuming draft", async () => {
    const id = randomUUID();
    await expect(
      attachments.upload(
        Readable.from([pdf]),
        "fake.png",
        "image/png",
        id,
        true,
      ),
    ).rejects.toThrow();
    await expect(
      attachments.upload(
        Readable.from([Buffer.from("<svg/>")]),
        "fake.svg",
        "image/svg+xml",
        id,
        true,
      ),
    ).rejects.toThrow();
    const image = await attachments.upload(
      Readable.from([png]),
      "screen.png",
      "image/png",
      id,
      true,
    );
    const document = plainTextDocument("Body");
    document.editor.root.children![0].children!.push({
      type: "maildock-image",
      version: 1,
      resourceId: image.id,
      alt: "Image",
      width: 480,
    });
    await expect(
      draftService().create({ ...draftInput(), id, richDocument: document }),
    ).rejects.toThrow("resource");
    const row = await draftService().create({
      ...draftInput(),
      id,
      richDocument: document,
      attachments: [{ id: image.id, kind: "staged", inline: true }],
    });
    const [association] = await database.db
      .select()
      .from(draftAttachments)
      .where(eq(draftAttachments.draftId, row.id));
    const [blob] = await database.db
      .select()
      .from(blobs)
      .where(eq(blobs.id, association.blobId!));
    await writeFile(
      path.join(root, "blobs", blob.storageKey.slice(0, 2), blob.storageKey),
      Buffer.from("corrupt"),
    );
    await expect(
      outgoing.create(undefined, { id, expectedRevision: row.revision }),
    ).rejects.toThrow("integrity");
    expect((await draftService().get(id)).status).toBe("active");
    expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
    await expect(attachments.composeResource(id, image.id)).rejects.toThrow();
    const incoming = (
      await content.detail(accountId, mailboxId, messageId)
    ).attachments.find((a) => a.inline)!;
    await expect(
      draftService().create({
        ...draftInput(),
        source: { ...source(), messageId: randomUUID() },
        richDocument: plainTextDocument("Body"),
        attachments: [{ id: incoming.id, kind: "incoming", inline: true }],
      }),
    ).rejects.toThrow();
  });
  it.each(["reply", "reply_all", "forward"] as const)(
    "imports HTML-only %s without flattening, transfers only source CID and retains remote placeholders",
    async (mode) => {
      // A real local raster in another account must never satisfy source A's CID.
      const otherAccountId = randomUUID(),
        otherMessageId = randomUUID(),
        otherAttachmentId = randomUUID();
      const [owner] = await database.db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, accountId));
      await database.db
        .insert(mailAccounts)
        .values({ ...owner, id: otherAccountId, email: "other@example.com" });
      await database.db.insert(messages).values({
        id: otherMessageId,
        accountId: otherAccountId,
        internalDate: new Date(),
        size: 100n,
      });
      const foreign = await attachments.upload(
        Readable.from([png]),
        "foreign.png",
        "image/png",
      );
      const [foreignStage] = await database.db
        .select()
        .from(stagedAttachments)
        .where(eq(stagedAttachments.id, foreign.id));
      await database.db.insert(messageAttachments).values({
        id: otherAttachmentId,
        messageId: otherMessageId,
        sourceUidValidity: 7n,
        sourceUid: 42n,
        partId: "3",
        contentType: "image/png",
        contentId: "<foreign>",
        inline: true,
        visible: false,
        blobId: foreignStage.blobId,
        status: "ready",
      });
      await richHtml(
        '<h2>Title</h2><p><b>Rich</b> <a href="https://example.com/">link</a></p><table><tr><td>Table</td></tr></table><img src="cid:logo"><img src="cid:foreign"><img src="https://tracker.invalid/pixel">',
      );
      await database.db
        .update(messages)
        .set({ from: [{ address: "alice@example.com" }] })
        .where(eq(messages.id, messageId));
      await database.db
        .update(messageContents)
        .set({ plainText: null })
        .where(eq(messageContents.messageId, messageId));
      const inline = (
        await content.detail(accountId, mailboxId, messageId)
      ).attachments.find((a) => a.inline)!;
      const staged = await attachments.upload(
        Readable.from([png]),
        "logo.png",
        "image/png",
      );
      const [blob] = await database.db
        .select()
        .from(stagedAttachments)
        .where(eq(stagedAttachments.id, staged.id));
      await database.db
        .update(messageAttachments)
        .set({ blobId: blob.blobId, status: "ready" })
        .where(eq(messageAttachments.id, inline.id));
      const preparation = new ComposePreparationService(
        database.db,
        content,
        attachments,
      );
      const ready = await preparation.prepare({ ...source(), mode });
      expect(ready.status).toBe("ready");
      if (ready.status !== "ready") throw Error();
      const resources = [...richResourceIds(ready.prefill.richDocument!)];
      expect(resources).toEqual([inline.id]);
      const output = serializeRichDocument(
        ready.prefill.richDocument,
        new Map([[inline.id, `${randomUUID()}@maildock.invalid`]]),
      );
      expect(output.html).toContain("<strong>Rich</strong>");
      expect(output.html).toContain("<table");
      expect(output.html).toContain("https://tracker.invalid/pixel");
      expect(output.plainText).toContain("Image unavailable");
      expect(ready.prefill.attachments?.filter((a) => !a.inline)).toHaveLength(
        mode === "forward" ? 1 : 0,
      );
      const row = await draftService().create({
        ...draftInput(),
        richDocument: ready.prefill.richDocument,
        source: { ...source(), mode },
        attachments: ready.prefill.attachments
          ?.filter((a) => a.inline)
          .map((a) => ({ id: a.id, kind: "incoming", inline: true })),
      });
      const substituted = plainTextDocument("Body");
      substituted.editor.root.children![0].children!.push({
        type: "maildock-image",
        version: 1,
        resourceId: otherAttachmentId,
        alt: "Foreign",
        width: 480,
      });
      await expect(
        draftService().create({
          ...draftInput(),
          source: { ...source(), mode },
          richDocument: substituted,
          attachments: [
            { id: otherAttachmentId, kind: "incoming", inline: true },
          ],
        }),
      ).rejects.toThrow("unavailable");
      const sent = await outgoing.create(undefined, {
        id: row.id,
        expectedRevision: row.revision,
      });
      const message = (
        await database.db
          .select()
          .from(outgoingMessages)
          .where(eq(outgoingMessages.id, sent.id))
      )[0];
      expect(message.html).toContain("cid:");
      expect(message.html).not.toContain("cid:logo");
      expect(
        (await database.db.select().from(outgoingMessageAttachments)).filter(
          (a) => a.inline,
        ),
      ).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  const updateFields = (row: Awaited<ReturnType<DraftService["get"]>>) => ({
    accountId: row.accountId,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    plainText: row.plainText,
    attachments: row.attachments.map(({ id, kind }) => ({ id, kind })),
    expectedRevision: row.revision,
  });
  it("creates one draft with a stable UUID, saves partial recipients, and restores every field after service restart", async () => {
    const value = { ...draftInput(), to: "jan@", subject: "", plainText: "" };
    const [one, two] = await Promise.all([
      draftService().create(value),
      draftService().create(value),
    ]);
    expect(one.id).toBe(two.id);
    expect(await database.db.select().from(drafts)).toHaveLength(1);
    const updated = await draftService().update(one.id, {
      ...updateFields(one),
      plainText: "Edited",
      subject: "Subject",
    });
    expect(updated.revision).toBe(2);
    expect(await draftService().get(one.id)).toMatchObject({
      ...value,
      plainText: "Edited",
      subject: "Subject",
      revision: 2,
    });
    await draftService().create(value); // late/lost initial response cannot undo edits
    expect((await draftService().get(one.id)).plainText).toBe("Edited");
  });
  it("rejects stale autosave and concurrent two-tab edits", async () => {
    const row = await draftService().create(draftInput());
    const attempts = await Promise.allSettled([
      draftService().update(row.id, {
        ...updateFields(row),
        plainText: "Tab A",
      }),
      draftService().update(row.id, {
        ...updateFields(row),
        plainText: "Tab B",
      }),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected")).toHaveLength(1);
    await expect(
      draftService().update(row.id, updateFields(row)),
    ).rejects.toBeInstanceOf(DraftConflictError);
    expect((await draftService().get(row.id)).revision).toBe(2);
  });
  it.each(["reply", "reply_all", "forward"] as const)(
    "restores %s saved body without regenerating quotes and rejects source mutation",
    async (mode) => {
      const value = {
        ...draftInput(),
        source: { ...source(), mode },
        plainText: "Edited quote exactly once",
      };
      const row = await draftService().create(value);
      expect(await draftService().get(row.id)).toMatchObject({
        source: value.source,
        composeMode: mode,
        plainText: value.plainText,
        attachments: [],
      });
      await expect(
        draftService().update(row.id, {
          ...updateFields(row),
          source: { ...source(), messageId: randomUUID() },
        }),
      ).rejects.toThrow();
    },
  );
  it("pins staged attachments without copying blobs, survives expiry/removal, restores order, and discards associations only", async () => {
    const first = await attachments.upload(
      Readable.from([pdf]),
      "one.pdf",
      "application/pdf",
    );
    const second = await attachments.upload(
      Readable.from([pdf]),
      "two.pdf",
      "application/pdf",
    );
    const row = await draftService().create({
      ...draftInput(),
      attachments: [second, first].map((a) => ({ id: a.id, kind: "staged" })),
    });
    expect(row.attachments.map((a) => a.filename)).toEqual([
      "two.pdf",
      "one.pdf",
    ]);
    expect(await database.db.select().from(blobs)).toHaveLength(2);
    await database.db
      .update(stagedAttachments)
      .set({ expiresAt: new Date(0), status: "removed" });
    const restored = await draftService().get(row.id);
    expect(
      restored.attachments.every(
        (a) => a.kind === "draft" && a.status === "ready",
      ),
    ).toBe(true);
    await draftService().update(row.id, {
      ...updateFields(restored),
      attachments: [updateFields(restored).attachments[1]],
    });
    expect(await database.db.select().from(blobs)).toHaveLength(2);
    await draftService().discard(row.id, 2);
    expect(await database.db.select().from(draftAttachments)).toHaveLength(0);
    expect(await database.db.select().from(blobs)).toHaveLength(2);
    await expect(
      draftService().update(row.id, updateFields(row)),
    ).rejects.toBeInstanceOf(DraftConflictError);
  });
  it("reuses forwarded cache and pins selections that finish preparation after draft creation", async () => {
    const row = await draftService().create({
      ...draftInput(),
      source: source(),
      attachments: [{ id: incomingId, kind: "incoming" }],
    });
    expect(row.attachments[0].kind).toBe("incoming");
    await cached();
    const restored = await draftService().get(row.id);
    expect(restored.attachments[0]).toMatchObject({
      id: incomingId,
      kind: "draft",
      status: "ready",
    });
    const before = await database.db.select().from(blobs);
    await draftService().update(row.id, updateFields(restored));
    expect(await database.db.select().from(blobs)).toHaveLength(before.length);
    const result = await outgoing.create(undefined, {
      id: row.id,
      expectedRevision: 2,
    });
    const [selection] = await database.db
      .select()
      .from(outgoingMessageAttachments)
      .where(eq(outgoingMessageAttachments.outgoingMessageId, result.id));
    expect(selection.blobId).toBe(before[0].id);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("pre-send validation and blob failures preserve the active draft", async () => {
    const row = await draftService().create({ ...draftInput(), to: "jan@" });
    await expect(
      outgoing.create(undefined, {
        id: row.id,
        expectedRevision: row.revision,
      }),
    ).rejects.toThrow();
    expect((await draftService().get(row.id)).status).toBe("active");
    const staged = await attachments.upload(
      Readable.from([pdf]),
      "file.pdf",
      "application/pdf",
    );
    const ready = await draftService().update(row.id, {
      ...updateFields(row),
      to: "valid@example.com",
      attachments: [{ id: staged.id, kind: "staged" }],
    });
    const [association] = await database.db
      .select()
      .from(draftAttachments)
      .where(eq(draftAttachments.draftId, row.id));
    const blob = await blobFor(association.blobId!);
    await writeFile(
      path.join(root, "blobs", blob.storageKey.slice(0, 2), blob.storageKey),
      Buffer.from("corrupt"),
    );
    await expect(
      outgoing.create(undefined, {
        id: row.id,
        expectedRevision: ready.revision,
      }),
    ).rejects.toThrow("integrity");
    expect((await draftService().get(row.id)).status).toBe("active");
    expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
  });
  it("uses the existing outgoing pipeline, consumes atomically, and reuses one outgoing across concurrent sends and lost response retry", async () => {
    const staged = await attachments.upload(
      Readable.from([pdf]),
      "file.pdf",
      "application/pdf",
    );
    const row = await draftService().create({
      ...draftInput(),
      attachments: [{ id: staged.id, kind: "staged" }],
    });
    const send = () =>
      outgoing.create(undefined, {
        id: row.id,
        expectedRevision: row.revision,
      });
    const results = await Promise.all([send(), send(), send()]);
    expect(new Set(results.map((a) => a.id)).size).toBe(1);
    expect((await send()).id).toBe(results[0].id); // first HTTP response was lost
    expect(await database.db.select().from(outgoingMessages)).toHaveLength(1);
    expect(await database.db.select().from(drafts)).toEqual([
      expect.objectContaining({
        status: "consumed",
        outgoingMessageId: results[0].id,
      }),
    ]);
    await expect(
      draftService().update(row.id, updateFields(row)),
    ).rejects.toBeInstanceOf(DraftConflictError);
    await expect(
      draftService().create({ ...draftInput(), id: row.id }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    await outgoing.run(results[0].id);
    expect(deliver).toHaveBeenCalledOnce();
    expect((await send()).status).toBe("sent");
    expect((await database.db.select().from(drafts))[0].status).toBe(
      "consumed",
    );
  });
  it("rejects send when autosave changed the revision before handoff", async () => {
    const row = await draftService().create(draftInput());
    await draftService().update(row.id, {
      ...updateFields(row),
      subject: "Newer",
    });
    await expect(
      outgoing.create(undefined, { id: row.id, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
  });
  it.each(["source", "mime"] as const)(
    "preserves draft on %s preparation failure before outgoing creation",
    async (kind) => {
      const row = await draftService().create({
        ...draftInput(),
        source: { ...source(), mode: "reply" },
      });
      let service = outgoing;
      if (kind === "source") await database.db.delete(mailboxMessages);
      else
        service = new OutgoingMessageService(
          database.db,
          enqueue,
          undefined,
          undefined,
          undefined,
          undefined,
          storage,
          { ...limits, maxOutgoingMimeBytes: 10 },
        );
      await expect(
        service.create(undefined, {
          id: row.id,
          expectedRevision: row.revision,
        }),
      ).rejects.toThrow();
      expect((await draftService().get(row.id)).status).toBe("active");
      expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
    },
  );
  it("serializes autosave against Send with no stale content handoff or resurrection", async () => {
    const row = await draftService().create(draftInput());
    const [save, send] = await Promise.allSettled([
      draftService().update(row.id, {
        ...updateFields(row),
        plainText: "Newer content",
      }),
      outgoing.create(undefined, { id: row.id, expectedRevision: 1 }),
    ]);
    const [state] = await database.db.select().from(drafts);
    if (send.status === "fulfilled") {
      expect(save.status).toBe("rejected");
      expect(state.status).toBe("consumed");
      expect((await saved(send.value.id)).plainText).toBe(row.plainText);
    } else {
      expect(save.status).toBe("fulfilled");
      expect(state).toMatchObject({
        status: "active",
        revision: 2,
        plainText: "Newer content",
      });
      expect(send.reason).toBeInstanceOf(DraftConflictError);
      expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
    }
  });
  it("returns the committed autosave snapshot even when another tab writes before HTTP response delivery", async () => {
    const row = await draftService().create(draftInput());
    let committed!: () => void;
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedDb = Object.create(database.db) as typeof database.db;
    const original = database.db.transaction.bind(database.db);
    delayedDb.transaction = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      committed();
      await gate;
      return result;
    }) as typeof original;
    const delayed = new DraftService(delayedDb).update(row.id, {
      ...updateFields(row),
      plainText: "First tab",
    });
    await commit;
    const newer = await draftService().update(row.id, {
      ...updateFields(row),
      expectedRevision: 2,
      plainText: "Second tab",
    });
    release();
    expect(await delayed).toMatchObject({
      revision: 2,
      plainText: "First tab",
    });
    expect(newer).toMatchObject({ revision: 3, plainText: "Second tab" });
  });
  it.each(["uncertain", "failed"] as const)(
    "keeps draft consumed after existing SMTP pipeline becomes %s",
    async (outcome) => {
      const row = await draftService().create(draftInput());
      const result = await outgoing.create(undefined, {
        id: row.id,
        expectedRevision: 1,
      });
      if (outcome === "uncertain")
        deliver.mockResolvedValueOnce({ outcome: "uncertain" });
      else
        deliver.mockResolvedValueOnce({
          outcome: "definite_failure",
          retryable: false,
          message: "Rejected",
        });
      await outgoing.run(result.id);
      expect((await saved(result.id)).status).toBe(outcome);
      expect((await database.db.select().from(drafts))[0].status).toBe(
        "consumed",
      );
      expect(
        await outgoing.create(undefined, { id: row.id, expectedRevision: 1 }),
      ).toEqual({ id: result.id, status: outcome });
      expect(await database.db.select().from(outgoingMessages)).toHaveLength(1);
      expect(deliver).toHaveBeenCalledOnce();
    },
  );
});
