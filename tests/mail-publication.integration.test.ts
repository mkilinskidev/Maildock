import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
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
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
  messageCommands,
  gmailAccountSyncState,
  conversationMembers,
} from "@/shared/infrastructure/database/schema";
import { MailPublicationService } from "@/modules/mail/application/mail-publication-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MessageService } from "@/modules/mail/application/message-service";
import { ConversationService } from "@/modules/mail/application/conversation-service";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { GmailProvider } from "@/modules/mail/infrastructure/gmail-provider";
import { GmailSyncService } from "@/modules/mail/application/gmail-sync-service";
import { createGmailAccountLock } from "@/modules/mail/infrastructure/gmail-account-lock";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { SyntheticGmail } from "./helpers/gmail-fixture";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";

describe("coherent committed mail publications", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let publication: MailPublicationService;
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 7).toString("base64"),
  });
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "maildock",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/maildock`,
      databasePoolSize: 5,
    });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    publication = new MailPublicationService(database.db);
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    await database.db.delete(mailAccounts);
    await new ConversationService(database.db).setEnabled(false);
  });
  async function account(microsoft = false) {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "IMAP",
      email: "owner@example.test",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpSecurity: "tls",
      imapCapabilities: ["MOVE"],
      ...(microsoft
        ? {
            authMethod: "oauth2",
            oauthProviderId: "microsoft",
            oauthStatus: "reconnect_required",
            oauthCache: encryption.encrypt("fixture", "fixture"),
          }
        : { imapPassword: encryption.encrypt("fixture", "fixture") }),
    });
    const inbox = randomUUID(),
      archive = randomUUID();
    await database.db.insert(mailboxes).values(
      [inbox, archive].map((box, i) => ({
        id: box,
        accountId: id,
        remotePath: i ? "Archive" : "INBOX",
        name: i ? "Archive" : "Inbox",
        selectable: true,
        uidValidity: 1n,
        recentSyncUidValidity: 1n,
        reportedUnseenCount: 999n,
        reportedMessageCount: 999n,
        recentSyncStatus: "success",
        backfillStatus: "pending",
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      })),
    );
    return { id, inbox, archive };
  }
  function remote(uid: number, seen = false) {
    return {
      uid: String(uid),
      internalDate: "2026-10-11T08:00:00Z",
      size: "10",
      flags: seen ? ["\\Seen"] : [],
      envelope: {
        subject: `Message ${uid}`,
        from: [],
        sender: [],
        replyTo: [],
        to: [],
        cc: [],
        bcc: [],
      },
      hasAttachments: false,
    };
  }
  async function page(
    a: Awaited<ReturnType<typeof account>>,
    readerId?: string,
  ) {
    return publication.snapshot({
      accountId: a.id,
      mailboxId: a.inbox,
      pageSize: 50,
      reader: readerId
        ? { id: readerId, accountId: a.id, mailboxId: a.inbox }
        : undefined,
    });
  }
  it.each([false, true])(
    "IMAP arrival/replay, external flags and source/destination movement (Microsoft=%s)",
    async (microsoft) => {
      const a = await account(microsoft);
      const service = new MessageService(database.db);
      await service.persistBatch(a.id, a.inbox, 1n, [remote(1)]);
      await service.persistBatch(a.id, a.inbox, 1n, [remote(1)]);
      let snapshot = await page(a);
      expect(snapshot.items).toHaveLength(1);
      expect(
        snapshot.publication!.boxes[a.id].find((b) => b.id === a.inbox),
      ).toMatchObject({ unseenCount: "1", remoteUnseenCount: "999" });
      expect(snapshot.publication!.coverage[a.id].historyIncomplete).toBe(true);
      const id = snapshot.items[0].id;
      await service.persistBatch(a.id, a.inbox, 1n, [remote(1, true)]);
      snapshot = await page(a, id);
      expect(snapshot.items[0].seen).toBe(true);
      expect(snapshot.publication!.reader?.seen).toBe(true);
      expect(snapshot.publication!.allInboxesUnread).toBe("0");
      await service.persistBatch(a.id, a.inbox, 1n, [remote(1)]);
      await database.db.transaction(async (tx) => {
        await tx
          .update(mailboxMessages)
          .set({ mailboxId: a.archive })
          .where(eq(mailboxMessages.messageId, id));
      });
      snapshot = await page(a, id);
      expect(snapshot.items).toHaveLength(0);
      expect(snapshot.publication!.reader).toBeNull();
      expect(
        snapshot.publication!.boxes[a.id].find((b) => b.id === a.archive)
          ?.unseenCount,
      ).toBe("1");
      await database.db
        .delete(mailboxMessages)
        .where(eq(mailboxMessages.messageId, id));
      expect(
        (await page(a)).publication!.boxes[a.id].find((b) => b.id === a.archive)
          ?.unseenCount,
      ).toBe("0");
    },
  );
  it("deduplicates account/message identities, excludes disabled/missing/hidden placements, and keeps conversation badge a message count", async () => {
    const a = await account(),
      b = await account(true);
    const service = new MessageService(database.db);
    await service.persistBatch(a.id, a.inbox, 1n, [remote(1), remote(2)]);
    await service.persistBatch(b.id, b.inbox, 1n, [remote(1)]);
    const [placement] = await database.db
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.accountId, a.id));
    await database.db
      .insert(mailboxMessages)
      .values({ ...placement, id: randomUUID(), uid: 500n, flags: ["\\Seen"] });
    const [box] = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, a.inbox));
    const duplicateInbox = randomUUID();
    await database.db
      .insert(mailboxes)
      .values({ ...box, id: duplicateInbox, remotePath: "Inbox" });
    await database.db
      .insert(mailboxMessages)
      .values({ ...placement, id: randomUUID(), mailboxId: duplicateInbox });
    let snapshot = await publication.snapshot({ pageSize: 50 });
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.publication!.allInboxesUnread).toBe("3");
    const disabledReaderId = snapshot.items.find(
      (item) => item.accountId === b.id,
    )!.id;
    const members = await database.db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.accountId, a.id));
    await database.db
      .update(conversationMembers)
      .set({ conversationId: members[0].conversationId })
      .where(eq(conversationMembers.messageId, members[1].messageId));
    await new ConversationService(database.db).setEnabled(true);
    snapshot = await publication.snapshot({ pageSize: 50 });
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.publication!.allInboxesUnread).toBe("3");
    expect(
      snapshot.items.reduce((n, item) => n + (item.messageCount ?? 1), 0),
    ).toBe(3);
    await database.db
      .update(mailAccounts)
      .set({ enabled: false })
      .where(eq(mailAccounts.id, b.id));
    snapshot = await publication.snapshot({ pageSize: 50 });
    expect(snapshot.publication!.allInboxesUnread).toBe("2");
    expect(
      (
        await publication.snapshot({
          pageSize: 50,
          reader: { id: disabledReaderId, accountId: b.id, mailboxId: b.inbox },
        })
      ).publication!.reader,
    ).toBeNull();
    await database.db
      .update(mailboxMessages)
      .set({ actionHidden: true })
      .where(eq(mailboxMessages.accountId, a.id));
    expect(
      (await publication.snapshot({ pageSize: 50 })).publication!
        .allInboxesUnread,
    ).toBe("0");
    await database.db
      .update(mailboxes)
      .set({ lifecycleStatus: "missing" })
      .where(eq(mailboxes.id, a.inbox));
    expect((await page(a)).items).toHaveLength(0);
  });
  it("does not expose uncommitted/rolled back rows or publish their revisions; a retry publishes only committed materialization", async () => {
    const a = await account();
    const before = await page(a);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = database.db
      .transaction(async (tx) => {
        await new MessageService(
          tx as unknown as typeof database.db,
        ).persistBatch(a.id, a.inbox, 1n, [remote(1)]);
        entered();
        await gate;
        throw Error("rollback publication");
      })
      .catch((error) => error);
    await ready;
    const during = await page(a);
    expect(during.items).toHaveLength(0);
    expect(during.publication!.revision).toBe(before.publication!.revision);
    release();
    expect((await writer).message).toBe("rollback publication");
    expect((await page(a)).publication!.revision).toBe(
      before.publication!.revision,
    );
    await new MessageService(database.db).persistBatch(a.id, a.inbox, 1n, [
      remote(1),
    ]);
    const after = await page(a);
    expect(after.items).toHaveLength(1);
    expect(after.publication!.allInboxesUnread).toBe("1");
    expect(after.publication!.revision).not.toBe(before.publication!.revision);
    const otherScope = await publication.snapshot({
      pageSize: 50,
      revision: after.publication!.revision,
    });
    expect(otherScope.unchanged).toBeUndefined();
    expect(otherScope.items).toHaveLength(1);
    expect(otherScope.publication!.revision).not.toBe(
      after.publication!.revision,
    );

    expect(
      await publication.snapshot({
        accountId: a.id,
        mailboxId: a.inbox,
        pageSize: 50,
        revision: after.publication!.revision,
      }),
    ).toMatchObject({ unchanged: true });
  });
  it("holds one MVCC snapshot when synchronization commits between revision and count/list reads", async () => {
    const a = await account();
    const before = await page(a);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = MailboxService.prototype.listForAccount;
    const spy = vi
      .spyOn(MailboxService.prototype, "listForAccount")
      .mockImplementationOnce(async function (this: MailboxService, ...args) {
        entered();
        await gate;
        return original.apply(this, args);
      });
    try {
      const reading = page(a);
      await ready;
      await new MessageService(database.db).persistBatch(a.id, a.inbox, 1n, [
        remote(1),
      ]);
      release();
      const snapshot = await reading;
      expect(snapshot.items).toHaveLength(0);
      expect(snapshot.publication!.allInboxesUnread).toBe("0");
      expect(snapshot.publication!.revision).toBe(before.publication!.revision);
      const next = await page(a);
      expect(next.items).toHaveLength(1);
      expect(next.publication!.allInboxesUnread).toBe("1");
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("rolls back materialization if the deferred publication write fails at commit", async () => {
    const a = await account();
    const before = await page(a);
    await database.db.execute(
      sql`create function reject_mail_publication() returns trigger language plpgsql as $$ begin raise exception 'publication rejected'; end $$`,
    );
    await database.db.execute(
      sql`create trigger reject_publication before insert or update on mail_publications for each row execute function reject_mail_publication()`,
    );
    try {
      await expect(
        new MessageService(database.db).persistBatch(a.id, a.inbox, 1n, [
          remote(1),
        ]),
      ).rejects.toThrow();
    } finally {
      await database.db.execute(
        sql`drop trigger reject_publication on mail_publications`,
      );
      await database.db.execute(sql`drop function reject_mail_publication()`);
    }
    const after = await page(a);
    expect(after.items).toHaveLength(0);
    expect(after.publication!.allInboxesUnread).toBe("0");
    expect(after.publication!.revision).toBe(before.publication!.revision);
  });
  it.each(["mark_read", "mark_unread"] as const)(
    "publishes the locally committed %s overlay before remote completion",
    async (action) => {
      const a = await account();
      await new MessageService(database.db).persistBatch(a.id, a.inbox, 1n, [
        remote(1, action === "mark_unread"),
      ]);
      const id = (await page(a)).items[0].id;
      const commands = new MessageCommandService(
        database.db,
        async () => {},
        async () => {},
      );
      await commands.create(a.id, a.inbox, id, action);
      const snapshot = await page(a, id);
      expect(snapshot.items[0].seen).toBe(action === "mark_read");
      expect(snapshot.publication!.reader?.seen).toBe(action === "mark_read");
      expect(snapshot.publication!.allInboxesUnread).toBe(
        action === "mark_read" ? "0" : "1",
      );
      expect((await database.db.select().from(messageCommands))[0].status).toBe(
        "pending",
      );
    },
  );
  it("Gmail real projection publishes arrivals, external flags, archive and deletion independently of history completion", async () => {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Gmail",
      email: "owner@example.test",
      providerType: "gmail_smtp",
      authMethod: "oauth2",
      oauthProviderId: "google",
      oauthHomeAccountId: id,
      oauthStatus: "connected",
      oauthCache: encryption.encrypt("fixture", "fixture"),
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      smtpUsesImapCredentials: false,
      smtpUsername: "owner@example.test",
    });
    const remote = new SyntheticGmail();
    remote.fixture("first");
    const accounts = {
      getProviderGmailAccountForWork: async () => ({
        accountId: id,
        revision: "1",
        accessToken: "synthetic",
      }),
    } as unknown as AccountsService;
    const provider = new GmailProvider(database.db, accounts, remote.fetch);
    const sync = new GmailSyncService(
      database.db,
      provider,
      createGmailAccountLock(database.client),
      30,
    );
    const state = async () =>
      (
        await database.db
          .select()
          .from(gmailAccountSyncState)
          .where(eq(gmailAccountSyncState.accountId, id))
      )[0];
    const finish = async () => {
      await database.db
        .update(gmailAccountSyncState)
        .set({ nextAttemptAt: null, needsWork: true })
        .where(eq(gmailAccountSyncState.accountId, id));
      for (let i = 0; i < 60; i++) {
        await sync.run(id, "1");
        const s = await state();
        if (s.inventoryComplete && !s.historyRunId) return;
      }
      throw Error("Gmail fixture failed to finish");
    };
    await sync.run(id, "1");
    const empty = await publication.snapshot({ pageSize: 50 });
    expect(empty.publication!.allInboxesUnread).toBe("0");
    expect(empty.publication!.coverage[id].historyIncomplete).toBe(true);
    expect(
      empty.publication!.boxes[id].find((b) => b.remotePath === "INBOX")
        ?.remoteUnseenCount,
    ).toBe("1");
    await finish();
    expect(
      (await publication.snapshot({ pageSize: 50 })).publication!
        .allInboxesUnread,
    ).toBe("1");
    for (const labels of [
      ["INBOX"],
      ["INBOX", "UNREAD"],
      ["UNREAD", "Label_one"],
    ]) {
      remote.change("first", labels);
      await finish();
      const snapshot = await publication.snapshot({ pageSize: 50 });
      expect(snapshot.publication!.allInboxesUnread).toBe(
        labels.includes("INBOX") && labels.includes("UNREAD") ? "1" : "0",
      );
      expect(snapshot.items.length).toBe(labels.includes("INBOX") ? 1 : 0);
    }
    remote.messages.delete("first");
    remote.change("first");
    await finish();
    expect((await publication.snapshot({ pageSize: 50 })).items).toHaveLength(
      0,
    );
  });
  it("measures unread counting and unchanged publication checks with 10,000 local messages", async () => {
    const a = await account();
    let writeStart = performance.now();
    await database.db.execute(sql`
      insert into messages(id, account_id, internal_date, size)
      select md5('publication-benchmark-' || n)::uuid, ${a.id}::uuid, now() - n * interval '1 second', 10
      from generate_series(1,10000) n`);
    const messageWriteMs = performance.now() - writeStart;
    writeStart = performance.now();
    await database.db.execute(sql`
      insert into mailbox_messages(id, account_id, mailbox_id, message_id, uid_validity, uid, flags, first_synchronized_at, last_synchronized_at)
      select gen_random_uuid(), ${a.id}::uuid, ${a.inbox}::uuid, md5('publication-benchmark-' || n)::uuid,
        1, n, case when n % 2 = 0 then ARRAY['\\Seen']::text[] else ARRAY[]::text[] end, now(), now()
      from generate_series(1,10000) n`);
    const placementWriteMs = performance.now() - writeStart;
    await database.db.execute(sql`analyze messages`);
    await database.db.execute(sql`analyze mailbox_messages`);
    const full: number[] = [],
      unchanged: number[] = [],
      localCounters: number[] = [];
    for (let i = 0; i < 5; i++) {
      let start = performance.now();
      const snapshot = await page(a);
      full.push(performance.now() - start);
      expect(snapshot.publication!.allInboxesUnread).toBe("5000");
      start = performance.now();
      expect(
        (
          await publication.snapshot({
            accountId: a.id,
            mailboxId: a.inbox,
            pageSize: 50,
            revision: snapshot.publication!.revision,
          })
        ).unchanged,
      ).toBe(true);
      unchanged.push(performance.now() - start);
      start = performance.now();
      const boxes = await new MailboxService(database.db).listForAccount(a.id);
      localCounters.push(performance.now() - start);
      expect(boxes.find((b) => b.id === a.inbox)?.unseenCount).toBe("5000");
    }
    console.log(
      "PHASE4_BENCHMARK",
      JSON.stringify({
        messages: 10000,
        fullSnapshotMs: full,
        unchangedCheckMs: unchanged,
        localCounterQueryMs: localCounters,
        messageWriteMs,
        placementWriteMs,
      }),
    );
    if (process.env.MAILDOCK_PHASE4_BENCHMARK_OUTPUT)
      await writeFile(
        process.env.MAILDOCK_PHASE4_BENCHMARK_OUTPUT,
        JSON.stringify(
          {
            messages: 10000,
            fullSnapshotMs: full,
            unchangedCheckMs: unchanged,
            localCounterQueryMs: localCounters,
            messageWriteMs,
            placementWriteMs,
          },
          null,
          2,
        ) + "\n",
      );
  });
});
