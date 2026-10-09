import { ApplicationEventService } from "@/modules/diagnostics/application/application-event-service";
import { applicationEvents } from "@/shared/infrastructure/database/schema";
import { createLogger } from "@/shared/infrastructure/logging/logger";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { loadOutgoingMime } from "@/modules/mail/application/outgoing-mime-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/modules/mail/domain/attachments";
import { ComposePreparationService } from "@/modules/mail/application/compose-preparation-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
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
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import type {
  MailProvider,
  SmtpDeliveryResult,
} from "@/modules/accounts/domain/mail-provider";
import { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";
import { SentCopyService } from "@/modules/mail/application/sent-copy-service";
import { createOutgoingLock } from "@/modules/mail/infrastructure/outgoing-lock";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxRoles,
  outgoingMessages,
  messages,
  mailboxMessages,
  messageContents,
} from "@/shared/infrastructure/database/schema";

describe("durable outgoing mail", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let accounts: AccountsService;
  let encryption: AesGcmSecretEncryption;
  let databaseUrl: string;
  let service: OutgoingMessageService;
  let storage: LocalBlobStorage;
  let storageRoot: string;
  let lock: ReturnType<typeof createOutgoingLock>;
  let accountId: string;
  let otherAccountId: string;
  const enqueue = vi.fn<(id: string) => Promise<void>>(async () => {});
  const deliver = vi.fn<NonNullable<MailProvider["deliverMessage"]>>();
  const append = vi.fn<NonNullable<MailProvider["appendMessage"]>>();
  const findCopy = vi.fn<NonNullable<MailProvider["findSentCopy"]>>();
  const enqueueCopy = vi.fn<(id: string) => Promise<void>>();
  const syncCopy =
    vi.fn<
      (
        accountId: string,
        mailboxId: string,
        initial: boolean,
      ) => Promise<boolean>
    >();
  const provider: MailProvider = {
    testConnection: async () => ({
      imap: { success: true },
      smtp: { success: true },
    }),
    listMailboxes: async () => ({ mailboxes: [], capabilities: [] }),
    synchronizeRecentMailbox: async () => ({
      uidValidity: "1",
      messageCount: 0,
    }),
    fetchMessageContent: async () => ({ plainText: null, html: null }),
    deliverMessage: deliver,
    appendMessage: append,
    findSentCopy: findCopy,
  };
  const makeService = () =>
    new OutgoingMessageService(
      database.db,
      enqueue,
      accounts,
      provider,
      lock,
      enqueueCopy,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      new ApplicationEventService(
        database.db,
        createLogger({ logLevel: "fatal" }),
      ),
    );
  const copies = () =>
    new SentCopyService(
      database.db,
      accounts,
      provider,
      lock,
      enqueueCopy,
      syncCopy,
      storage,
    );
  const destination = async (
    source: "manual" | "special_use" = "manual",
    owner = accountId,
    mapped = true,
  ) => {
    const id = randomUUID();
    const [mailbox] = await database.db
      .insert(mailboxes)
      .values({
        id,
        accountId: owner,
        remotePath: `private/output/${id}`,
        name: "Correspondence",
        lifecycleStatus: "active",
        selectable: true,
        specialUse: source === "special_use" ? ["\\Sent"] : [],
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
        recentSyncStatus: "success",
        uidValidity: 7n,
      })
      .returning();
    if (mapped)
      await database.db
        .insert(mailboxRoles)
        .values({ accountId, role: "sent", source, mailboxId: id });
    return mailbox;
  };
  const sentWithCopy = async () => {
    await accounts.update(accountId, { sentCopyPolicy: "maildock" });
    const created = await service.create(input());
    await service.run(created.id);
    return created;
  };
  const input = () => ({
    accountId,
    to: "Mateusz <to@example.com>",
    cc: "cc@example.com",
    bcc: "Ukryty <hidden@example.com>",
    subject: "Cześć",
    plainText: "Zażółć gęślą jaźń\n",
  });
  const row = async (id: string) =>
    (
      await database.db
        .select()
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, id))
    )[0];
  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "maildock-outgoing-"));
    storage = new LocalBlobStorage(storageRoot);
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_outgoing",
          POSTGRES_USER: "maildock",
          POSTGRES_PASSWORD: "maildock-test",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        )
        .start();
      url = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_outgoing`;
    }
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: url,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: process.cwd(),
    });
    database = createDatabase(config);
    databaseUrl = config.databaseUrl;
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    lock = createOutgoingLock(database.client);
    encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    accounts = new AccountsService(database.db, encryption, provider);
    accountId = randomUUID();
    otherAccountId = randomUUID();
    for (const id of [accountId, otherAccountId])
      await accounts.create({
        id,
        displayName: "Łukasz Żółć",
        email: id === accountId ? "owner@example.com" : "other@example.com",
        enabled: true,
        providerType: "imap_smtp",
        imap: {
          host: "imap.example.com",
          port: 993,
          security: "tls",
          username: id,
          password: "secret",
        },
        smtp: {
          host: "smtp.example.com",
          port: 465,
          security: "tls",
          useImapCredentials: true,
        },
      });
  });
  beforeEach(async () => {
    await database.db.delete(applicationEvents);
    await database.db.delete(outgoingMessages);
    await database.db.delete(mailboxes);
    await database.db.delete(messages);
    await database.db
      .update(mailAccounts)
      .set({
        enabled: true,
        displayName: "Łukasz Żółć",
        senderDisplayName: "Łukasz Żółć",
        smtpHost: "smtp.example.com",
        sentCopyPolicy: "server",
      })
      .where(eq(mailAccounts.id, accountId));
    enqueue.mockReset();
    enqueue.mockResolvedValue(undefined);
    enqueueCopy.mockReset();
    enqueueCopy.mockResolvedValue(undefined);
    append.mockReset();
    append.mockResolvedValue({ outcome: "saved", uidValidity: "7", uid: "42" });
    findCopy.mockReset();
    findCopy.mockResolvedValue({ outcome: "not_found" });
    syncCopy.mockReset();
    syncCopy.mockResolvedValue(true);
    deliver.mockReset();
    deliver.mockResolvedValue({
      outcome: "accepted",
      acceptedCount: 3,
      rejectedCount: 0,
    });
    service = makeService();
  });
  afterAll(async () => {
    if (database) await database.client.end();
    await container?.stop();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("Phase 3F persists successful send and permanent failure without message content", async () => {
    const sent = await service.create(input());
    await service.run(sent.id);
    deliver.mockResolvedValueOnce({
      outcome: "definite_failure",
      retryable: false,
      message: "secret provider payload",
    });
    const failed = await service.create(input());
    await service.run(failed.id);
    const events = await database.db.select().from(applicationEvents);
    expect(events.map((e) => e.event).sort()).toEqual([
      "mail.send_failed",
      "mail.sent",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret provider payload");
    expect(events.every((e) => e.accountId === accountId)).toBe(true);
  });
  it("Phase 3F diagnostic persistence failure cannot fail successful SMTP delivery", async () => {
    const diagnostics = new ApplicationEventService(
      {
        insert: () => {
          throw Error("diagnostic database unavailable");
        },
        delete: () => {
          throw Error();
        },
      } as unknown as typeof database.db,
      createLogger({ logLevel: "fatal" }),
    );
    const sender = new OutgoingMessageService(
      database.db,
      enqueue,
      accounts,
      provider,
      lock,
      enqueueCopy,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      diagnostics,
    );
    const created = await sender.create(input());
    await expect(sender.run(created.id)).resolves.toBeUndefined();
    expect((await row(created.id)).status).toBe("sent");
    expect(deliver).toHaveBeenCalledOnce();
  });
  async function replyFixture(
    status = "ready",
    plainText: string | null = "Original body",
    sanitizedHtml: string | null = null,
  ) {
    const mailbox = await destination();
    const messageId = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      accountId,
      internalDate: new Date(),
      size: 42n,
      from: [{ address: "alice@example.com" }],
      to: [{ address: "owner@example.com" }],
      subject: "Hello",
      rfcMessageId: "<original@example.com>",
      references: "<parent@example.com>",
      hasAttachments: true,
    });
    await database.db.insert(mailboxMessages).values({
      accountId,
      id: randomUUID(),
      mailboxId: mailbox.id,
      messageId,
      uid: 1n,
      uidValidity: 7n,
      firstSynchronizedAt: new Date(),
      lastSynchronizedAt: new Date(),
    });
    await database.db
      .insert(messageContents)
      .values({ messageId, status, plainText, sanitizedHtml });
    return {
      accountId,
      mailboxId: mailbox.id,
      messageId,
      mode: "reply" as const,
    };
  }
  it.each(["reply", "reply_all", "forward"] as const)(
    "creates %s through existing delivery paths with re-derived immutable threading",
    async (mode) => {
      const source = { ...(await replyFixture()), mode };
      const result = await new ComposePreparationService(
        database.db,
        new MessageContentService(database.db),
      ).prepare(source);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error();
      expect(result.prefill.accountId).toBe(accountId);
      expect(result.prefill.attachmentsOmitted).toBe(mode !== "forward");
      if (mode === "forward") expect(result.prefill.to).toBe("");
      await database.db
        .update(messages)
        .set({ rfcMessageId: "<updated@example.com>" })
        .where(eq(messages.id, source.messageId));
      await accounts.update(otherAccountId, { sentCopyPolicy: "maildock" });
      const target = await destination("manual", otherAccountId, false);
      await database.db.insert(mailboxRoles).values({
        accountId: otherAccountId,
        role: "sent",
        source: "manual",
        mailboxId: target.id,
      });
      const created = await service.create({
        ...input(),
        accountId: otherAccountId,
        source,
        subject: result.prefill.subject,
        plainText: result.prefill.plainText,
      });
      const saved = await row(created.id);
      expect(saved.from.address).toBe("other@example.com");
      const mime = await simpleParser(
        await loadOutgoingMime(
          database.db,
          storage,
          saved,
          DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
        ),
      );
      expect(mime.messageId).toBe(saved.messageId);
      expect(saved.messageId).not.toBe("<updated@example.com>");
      expect(saved.inReplyTo).toBe(
        mode === "forward" ? null : "<updated@example.com>",
      );
      expect(mime.inReplyTo).toBe(
        mode === "forward" ? undefined : "<updated@example.com>",
      );
      expect(saved.references).toEqual(
        mode === "forward"
          ? []
          : ["<parent@example.com>", "<updated@example.com>"],
      );
      for (const mutation of [
        { inReplyTo: "<evil@example.com>" },
        { references: ["<evil@example.com>"] },
      ])
        await expect(
          database.db
            .update(outgoingMessages)
            .set(mutation)
            .where(eq(outgoingMessages.id, created.id)),
        ).rejects.toThrow();
      await service.run(created.id);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: otherAccountId }),
        expect.objectContaining({
          to: expect.arrayContaining(["hidden@example.com"]),
        }),
        await loadOutgoingMime(
          database.db,
          storage,
          saved,
          DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
        ),
      );
      expect(mime.bcc).toBeUndefined();
      expect(enqueueCopy).toHaveBeenCalledWith(created.id);
      await copies().run(created.id);
      expect(append).toHaveBeenCalled();
    },
  );
  it("enforces source account and mailbox isolation at preparation and creation", async () => {
    const source = await replyFixture();
    const prepare = new ComposePreparationService(
      database.db,
      new MessageContentService(database.db),
    );
    await expect(
      prepare.prepare({ ...source, accountId: otherAccountId }),
    ).rejects.toThrow();
    await expect(
      service.create({
        ...input(),
        source: { ...source, accountId: otherAccountId },
      }),
    ).rejects.toThrow("source message");
    await expect(
      service.create({
        ...input(),
        source: { ...source, mailboxId: randomUUID() },
      }),
    ).rejects.toThrow("source message");
    for (const field of ["inReplyTo", "references"])
      await expect(
        service.create({ ...input(), [field]: "<evil@example.com>" }),
      ).rejects.toThrow();
  });
  it.each(["not_fetched", "pending", "fetching"])(
    "handles %s via existing content scheduling without an empty quote",
    async (status) => {
      const source = await replyFixture(status, null);
      const schedule = vi.fn(async () => true);
      const content = new MessageContentService(database.db, { schedule });
      const prepare = new ComposePreparationService(database.db, content);
      expect(await prepare.prepare(source)).toEqual({ status: "pending" });
      expect(schedule).toHaveBeenCalledTimes(status === "not_fetched" ? 1 : 0);
      await database.db
        .update(messageContents)
        .set({ status: "ready", plainText: "Fetched" })
        .where(eq(messageContents.messageId, source.messageId));
      const result = await prepare.prepare(source);
      expect(result.status === "ready" && result.prefill.plainText).toContain(
        "> Fetched",
      );
    },
  );
  it("reports failed fetch and supports the existing retry", async () => {
    const source = await replyFixture("failed", null);
    const schedule = vi.fn(async () => true);
    const content = new MessageContentService(database.db, { schedule });
    await expect(
      new ComposePreparationService(database.db, content).prepare(source),
    ).rejects.toThrow("Content fetch failed");
    await content.request(source.accountId, source.mailboxId, source.messageId);
    expect(schedule).toHaveBeenCalledOnce();
  });
  it("converts local sanitized HTML into plain text", async () => {
    const source = await replyFixture(
      "ready",
      null,
      "<p>Hello &amp; world</p><p>Next<br>Line</p>",
    );
    const result = await new ComposePreparationService(
      database.db,
      new MessageContentService(database.db),
    ).prepare(source);
    if (result.status !== "ready") throw Error();
    expect(result.prefill.plainText).toContain("Hello & world");
    expect(result.prefill.plainText).toContain("> Line");
    expect(result.prefill.plainText).not.toContain("<p>");
  });
  it("persists authoritative From, recipients, stable ID and immutable MIME without performing SMTP", async () => {
    const created = await service.create(input());
    const saved = await row(created.id);
    expect(saved.from).toEqual({
      name: "Łukasz Żółć",
      address: "owner@example.com",
    });
    expect(saved.to).toEqual([{ name: "Mateusz", address: "to@example.com" }]);
    expect(saved.cc).toEqual([{ address: "cc@example.com" }]);
    expect(saved.bcc).toEqual([
      { name: "Ukryty", address: "hidden@example.com" },
    ]);
    expect(saved.messageId).toMatch(/^<[0-9a-f-]{36}@maildock\.invalid>$/);
    const mime = await simpleParser(
      await loadOutgoingMime(
        database.db,
        storage,
        saved,
        DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
      ),
    );
    expect(mime.messageId).toBe(saved.messageId);
    expect(mime.subject).toBe("Cześć");
    expect(mime.text).toBe(input().plainText);
    expect(mime.bcc).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(created.id);
    await expect(
      database.db
        .update(outgoingMessages)
        .set({ mimeBase64: "changed" })
        .where(eq(outgoingMessages.id, created.id)),
    ).rejects.toThrow();
    expect((await service.status(created.id))!).not.toHaveProperty("bcc");
    expect((await service.status(created.id))!).not.toHaveProperty(
      "mimeBase64",
    );
  });
  it("uses the persisted human sender name rather than the local account label in From", async () => {
    await accounts.updateIdentity(accountId, {
      displayName: "DPoczta",
      senderDisplayName: "Mateusz Kiliński",
      email: "owner@example.com",
    });
    const created = await service.create(input());
    const saved = await row(created.id);
    expect(saved.from).toEqual({
      address: "owner@example.com",
      name: "Mateusz Kiliński",
    });
    const mime = await simpleParser(
      await loadOutgoingMime(
        database.db,
        storage,
        saved,
        DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
      ),
    );
    expect(mime.from?.value).toEqual([
      { address: "owner@example.com", name: "Mateusz Kiliński" },
    ]);
    expect(mime.from?.text).not.toContain("DPoczta");
  });
  it.each([
    { to: "", cc: "", bcc: "" },
    { to: "broken-address" },
    { subject: "Injected\r\nBcc: victim@example.com" },
    { from: "forged@example.com" },
  ])(
    "rejects invalid creation with no durable attempt: %j",
    async (changes) => {
      await expect(
        service.create({ ...input(), ...changes }),
      ).rejects.toThrow();
      expect(await database.db.select().from(outgoingMessages)).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
    },
  );
  it.each(["cc", "bcc"])(
    "accepts a message with only %s recipients",
    async (field) => {
      const created = await service.create({
        ...input(),
        to: "",
        cc: "",
        bcc: "",
        [field]: "recipient@example.com",
      });
      await service.run(created.id);
      expect((await row(created.id)).status).toBe("sent");
    },
  );
  it("keeps enqueue failures repairable after restarting the service", async () => {
    enqueue.mockRejectedValueOnce(Error("queue unavailable"));
    const created = await service.create(input());
    expect((await row(created.id)).status).toBe("queued");
    enqueue.mockClear();
    await makeService().repair();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(created.id);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("commits sending before SMTP, passes exact persisted bytes and records acceptance without IMAP calls", async () => {
    const created = await service.create(input());
    const saved = await row(created.id);
    deliver.mockImplementationOnce(async (account, envelope, mime) => {
      expect((await row(created.id)).status).toBe("sending");
      expect(account.accountId).toBe(accountId);
      expect(envelope).toEqual({
        from: saved.from.address,
        to: ["to@example.com", "cc@example.com", "hidden@example.com"],
      });
      expect(mime).toEqual(
        await loadOutgoingMime(
          database.db,
          storage,
          saved,
          DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
        ),
      );
      return { outcome: "accepted", acceptedCount: 3, rejectedCount: 0 };
    });
    const imap = vi.spyOn(provider, "listMailboxes");
    await service.run(created.id);
    const final = await row(created.id);
    expect(final.status).toBe("sent");
    expect(final.smtpAcceptedAt).toBeInstanceOf(Date);
    expect(final.attempts).toBe(1);
    expect(final.mimeBase64).toBe(saved.mimeBase64);
    expect(imap).not.toHaveBeenCalled();
    imap.mockRestore();
  });
  it("bounds definitely-safe transient failures at three attempts and reuses MIME", async () => {
    deliver.mockResolvedValue({
      outcome: "definite_failure",
      retryable: true,
      message: "SMTP connection could not be established.",
    });
    const created = await service.create(input());
    const initial = await row(created.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await service.run(created.id);
      expect((await row(created.id)).status).toBe(
        attempt === 3 ? "failed" : "queued",
      );
      // A duplicate job before the durable backoff must not start another attempt.
      await service.run(created.id);
      expect(deliver).toHaveBeenCalledTimes(attempt);
      await database.db
        .update(outgoingMessages)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(outgoingMessages.id, created.id));
    }
    await makeService().repair();
    await makeService().run(created.id);
    expect(deliver).toHaveBeenCalledTimes(3);
    for (const call of deliver.mock.calls)
      expect(call[2]).toEqual(
        await loadOutgoingMime(
          database.db,
          storage,
          initial,
          DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
        ),
      );
    expect((await row(created.id)).messageId).toBe(initial.messageId);
  });
  it("makes permanent failures terminal", async () => {
    deliver.mockResolvedValue({
      outcome: "definite_failure",
      retryable: false,
      message: "SMTP rejected the sender or recipients.",
    });
    const created = await service.create(input());
    await service.run(created.id);
    await service.run(created.id);
    await service.repair();
    expect((await row(created.id)).status).toBe("failed");
    expect(deliver).toHaveBeenCalledOnce();
  });
  it("never retries uncertain or unexpected provider exceptions", async () => {
    deliver.mockRejectedValueOnce(Error("private SMTP detail"));
    const created = await service.create(input());
    await service.run(created.id);
    await makeService().repair();
    await makeService().run(created.id);
    expect((await row(created.id)).status).toBe("uncertain");
    expect((await row(created.id)).error).not.toContain("private");
    expect(deliver).toHaveBeenCalledOnce();
  });
  it("CRITICAL: SMTP accepted, worker cannot persist sent; restart recovers sending as uncertain without resubmission", async () => {
    const created = await service.create(input());
    // Simulate process death/DB outage precisely between external acceptance
    // and the final durable update. The earlier sending commit survives.
    await database.client.unsafe(
      `CREATE FUNCTION test_outgoing_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'sent' THEN RAISE EXCEPTION 'worker died before success persistence'; END IF; RETURN NEW; END $$`,
    );
    await database.client.unsafe(
      `CREATE TRIGGER test_outgoing_crash BEFORE UPDATE ON outgoing_messages FOR EACH ROW EXECUTE FUNCTION test_outgoing_crash()`,
    );
    try {
      await expect(service.run(created.id)).rejects.toThrow();
      expect(deliver).toHaveBeenCalledOnce();
      expect((await row(created.id)).status).toBe("sending");
    } finally {
      await database.client.unsafe(
        "DROP TRIGGER test_outgoing_crash ON outgoing_messages",
      );
      await database.client.unsafe("DROP FUNCTION test_outgoing_crash()");
    }
    const restarted = makeService();
    await restarted.repair();
    await restarted.run(created.id);
    await restarted.repair();
    expect(deliver).toHaveBeenCalledOnce();
    expect((await row(created.id)).status).toBe("uncertain");
    expect((await row(created.id)).smtpAcceptedAt).toBeNull();
    expect((await row(created.id)).error).toBe(
      "Maildock could not confirm whether this message was sent.",
    );
  });
  it("recovers a worker lost immediately after claiming, without guessing that no delivery happened", async () => {
    const created = await service.create(input());
    await database.db
      .update(outgoingMessages)
      .set({ status: "sending", attempts: 1 })
      .where(eq(outgoingMessages.id, created.id));
    await makeService().run(created.id);
    await makeService().repair();
    expect((await row(created.id)).status).toBe("uncertain");
    expect(deliver).not.toHaveBeenCalled();
  });
  it("duplicate workers and repair cannot resubmit or disturb an active sender", async () => {
    let release!: (result: SmtpDeliveryResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    deliver.mockImplementationOnce(async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const created = await service.create(input());
    const active = service.run(created.id);
    await Promise.race([started, active]);
    expect(deliver).toHaveBeenCalledOnce();
    try {
      await Promise.all([
        makeService().run(created.id),
        makeService().run(created.id),
        makeService().repair(),
      ]);
      expect((await row(created.id)).status).toBe("sending");
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      release({ outcome: "accepted", acceptedCount: 3, rejectedCount: 0 });
    }
    await active;
    await makeService().run(created.id);
    expect((await row(created.id)).status).toBe("sent");
    expect(deliver).toHaveBeenCalledOnce();
  });
  it("selects exactly the requested existing account and its credentials", async () => {
    const created = await service.create({
      ...input(),
      accountId: otherAccountId,
    });
    await service.run(created.id);
    expect(deliver.mock.calls[0][0].accountId).toBe(otherAccountId);
    expect(deliver.mock.calls[0][0].smtp.username).toBe(otherAccountId);
    expect(deliver.mock.calls[0][1].from).toBe("other@example.com");
    await expect(
      service.create({ ...input(), accountId: randomUUID() }),
    ).rejects.toThrow();
  });
  it("can claim and deliver with a one-connection application pool", async () => {
    const single = createDatabase({ databaseUrl, databasePoolSize: 1 });
    try {
      const sender = new OutgoingMessageService(
        single.db,
        enqueue,
        new AccountsService(single.db, encryption, provider),
        provider,
        createOutgoingLock(single.client),
        undefined,
        storage,
        DEFAULT_ATTACHMENT_LIMITS,
        new ApplicationEventService(
          single.db,
          createLogger({ logLevel: "fatal" }),
        ),
      );
      const created = await sender.create(input());
      await sender.run(created.id);
      expect((await row(created.id)).status).toBe("sent");
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      await single.client.end();
    }
  }, 10_000);
  it("keeps the conservative server default and never APPENDs even with a Sent role", async () => {
    await destination();
    expect((await accounts.get(accountId)).sentCopyPolicy).toBe("server");
    const created = await service.create(input());
    await service.run(created.id);
    await copies().run(created.id);
    await copies().repair();
    expect((await row(created.id)).sentCopyStatus).toBe("not_required");
    expect(append).not.toHaveBeenCalled();
    expect(enqueueCopy).not.toHaveBeenCalled();
  });
  it("snapshots policy for future sends only, including changes while SMTP is queued", async () => {
    await destination();
    const old = await service.create(input());
    await accounts.update(accountId, { sentCopyPolicy: "maildock" });
    const current = await service.create(input());
    await accounts.update(accountId, { sentCopyPolicy: "server" });
    await service.run(old.id);
    await service.run(current.id);
    expect((await row(old.id)).sentCopyStatus).toBe("not_required");
    expect((await row(current.id)).sentCopyStatus).toBe("pending");
    await copies().run(old.id);
    await copies().run(current.id);
    expect(append).toHaveBeenCalledOnce();
    await expect(
      database.db
        .update(outgoingMessages)
        .set({ sentCopyPolicy: "server" })
        .where(eq(outgoingMessages.id, current.id)),
    ).rejects.toThrow();
    await expect(
      accounts.update(accountId, { sentCopyPolicy: "guess" } as never),
    ).rejects.toThrow();
  });
  it.each(["manual", "special_use"] as const)(
    "uses the %s semantic role, exact MIME, Seen, original date and APPENDUID",
    async (source) => {
      const target = await destination(source);
      const created = await sentWithCopy();
      const before = await row(created.id);
      expect(before.status).toBe("sent");
      expect(before.sentCopyStatus).toBe("pending");
      expect(enqueueCopy).toHaveBeenCalledWith(created.id);
      append.mockImplementationOnce(async (account, request, raw) => {
        expect((await row(created.id)).sentCopyStatus).toBe("saving");
        expect(account.accountId).toBe(accountId);
        expect(request).toEqual({
          remotePath: target.remotePath,
          flags: ["\\Seen"],
          internalDate: before.smtpAcceptedAt,
        });
        expect(
          raw.equals(
            await loadOutgoingMime(
              database.db,
              storage,
              before,
              DEFAULT_ATTACHMENT_LIMITS.maxOutgoingMimeBytes,
            ),
          ),
        ).toBe(true);
        expect(raw.equals(deliver.mock.calls[0][2])).toBe(true);
        return { outcome: "saved", uidValidity: "7", uid: "42" };
      });
      await copies().run(created.id);
      const after = await row(created.id);
      expect(after).toMatchObject({
        status: "sent",
        sentCopyStatus: "saved",
        sentCopyMailboxId: target.id,
        sentCopyUidValidity: 7n,
        sentCopyUid: 42n,
        sentCopySyncPending: false,
      });
      expect(after.sentCopySavedAt).toBeInstanceOf(Date);
      expect(syncCopy).toHaveBeenCalledWith(accountId, target.id, false);
      await copies().run(created.id);
      expect(append).toHaveBeenCalledOnce();
    },
  );
  it("supports confirmed APPEND without UIDPLUS and requests initial sync when needed", async () => {
    const target = await destination();
    await database.db
      .update(mailboxes)
      .set({ recentSyncStatus: "not_started" })
      .where(eq(mailboxes.id, target.id));
    append.mockResolvedValue({ outcome: "saved" });
    const created = await sentWithCopy();
    await copies().run(created.id);
    expect(await row(created.id)).toMatchObject({
      status: "sent",
      sentCopyStatus: "saved",
      sentCopyUid: null,
      sentCopyUidValidity: null,
    });
    expect(syncCopy).toHaveBeenCalledWith(accountId, target.id, true);
  });
  it.each(["unmapped", "missing", "nonselectable", "other_account"])(
    "does not guess a destination for %s Sent configuration",
    async (configuration) => {
      const target = await destination(
        "manual",
        configuration === "other_account" ? otherAccountId : accountId,
        configuration !== "unmapped",
      );
      await database.db
        .update(mailboxes)
        .set({
          name: "Sent",
          specialUse: ["\\Sent"],
          ...(configuration === "missing"
            ? { lifecycleStatus: "missing" }
            : {}),
          ...(configuration === "nonselectable" ? { selectable: false } : {}),
        })
        .where(eq(mailboxes.id, target.id));
      const created = await sentWithCopy();
      await copies().run(created.id);
      expect(await row(created.id)).toMatchObject({
        status: "sent",
        sentCopyStatus: "failed",
      });
      expect(append).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledOnce();
    },
  );
  it.each(["failed", "uncertain"] as const)(
    "keeps positive SMTP success final when APPEND is %s",
    async (outcome) => {
      await destination();
      append.mockResolvedValue({ outcome });
      const created = await sentWithCopy();
      await copies().run(created.id);
      await copies().repair();
      await copies().run(created.id);
      await service.run(created.id);
      expect(await row(created.id)).toMatchObject({
        status: "sent",
        sentCopyStatus: outcome,
      });
      expect(append).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledOnce();
    },
  );
  it.each(["not_found", "uncertain", "found"] as const)(
    "CRITICAL: recovers an APPEND accepted before DB crash via %s lookup without another APPEND",
    async (outcome) => {
      const target = await destination();
      const created = await sentWithCopy();
      await database.client.unsafe(
        `CREATE FUNCTION test_sent_copy_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sent_copy_status = 'saved' THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END $$`,
      );
      await database.client.unsafe(
        `CREATE TRIGGER test_sent_copy_crash BEFORE UPDATE ON outgoing_messages FOR EACH ROW EXECUTE FUNCTION test_sent_copy_crash()`,
      );
      try {
        await expect(copies().run(created.id)).rejects.toThrow();
      } finally {
        await database.client.unsafe(
          `DROP TRIGGER test_sent_copy_crash ON outgoing_messages`,
        );
        await database.client.unsafe(`DROP FUNCTION test_sent_copy_crash()`);
      }
      expect((await row(created.id)).sentCopyStatus).toBe("saving");
      expect(append).toHaveBeenCalledOnce();
      findCopy.mockResolvedValue(
        outcome === "found"
          ? { outcome, uidValidity: "7", uid: "42" }
          : { outcome },
      );
      const restarted = copies();
      await restarted.repair();
      await restarted.run(created.id);
      await restarted.run(created.id);
      expect(findCopy).toHaveBeenCalledWith(
        expect.objectContaining({ accountId }),
        target.remotePath,
        (await row(created.id)).messageId,
      );
      expect(await row(created.id)).toMatchObject({
        status: "sent",
        sentCopyStatus: outcome === "found" ? "saved" : "uncertain",
      });
      expect(append).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledOnce();
    },
  );
  it("recovers only the snapshotted destination even if the semantic mapping changes", async () => {
    const target = await destination();
    const created = await sentWithCopy();
    await database.db
      .update(outgoingMessages)
      .set({
        sentCopyStatus: "saving",
        sentCopyMailboxId: target.id,
        sentCopyPath: target.remotePath,
      })
      .where(eq(outgoingMessages.id, created.id));
    await database.db.delete(mailboxRoles);
    await destination();
    findCopy.mockResolvedValue({
      outcome: "found",
      uid: "42",
      uidValidity: "7",
    });
    await copies().run(created.id);
    expect(findCopy.mock.calls[0][1]).toBe(target.remotePath);
    expect(append).not.toHaveBeenCalled();
  });
  it("repairs failed enqueue and sync enqueue without repeating APPEND", async () => {
    const target = await destination();
    enqueueCopy.mockRejectedValue(new Error("queue unavailable"));
    const created = await sentWithCopy();
    expect((await row(created.id)).sentCopyStatus).toBe("pending");
    enqueueCopy.mockResolvedValue(undefined);
    await copies().repair();
    expect(enqueueCopy).toHaveBeenLastCalledWith(created.id);
    syncCopy.mockResolvedValue(false);
    await copies().run(created.id);
    expect(await row(created.id)).toMatchObject({
      sentCopyStatus: "saved",
      sentCopySyncPending: true,
    });
    syncCopy.mockResolvedValue(true);
    await copies().repair();
    await copies().run(created.id);
    expect((await row(created.id)).sentCopySyncPending).toBe(false);
    expect(syncCopy).toHaveBeenLastCalledWith(accountId, target.id, false);
    expect(append).toHaveBeenCalledOnce();
  });
  it("prevents concurrent duplicate jobs and recovery while APPEND is active", async () => {
    await destination();
    const created = await sentWithCopy();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    append.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { outcome: "saved" };
    });
    const active = copies().run(created.id);
    await Promise.race([started, active]);
    try {
      await Promise.all([
        copies().run(created.id),
        copies().run(created.id),
        copies().repair(),
      ]);
      expect(append).toHaveBeenCalledOnce();
      expect(findCopy).not.toHaveBeenCalled();
    } finally {
      release();
      await active;
    }
    expect((await row(created.id)).sentCopyStatus).toBe("saved");
  });
  it("rejects disabled or unusable account at creation and rechecks before delivery", async () => {
    const created = await service.create(input());
    await database.db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, accountId));
    await expect(service.create(input())).rejects.toThrow();
    await service.run(created.id);
    expect((await row(created.id)).status).toBe("failed");
    expect(deliver).not.toHaveBeenCalled();
    await database.db
      .update(mailAccounts)
      .set({ enabled: true, smtpHost: "" })
      .where(eq(mailAccounts.id, accountId));
    await expect(service.create(input())).rejects.toThrow();
  });
});
