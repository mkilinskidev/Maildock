import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
  conversationMembers,
  conversations,
  instanceState,
  messageContents,
} from "@/shared/infrastructure/database/schema";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { MessageService } from "@/modules/mail/application/message-service";
import { ConversationService } from "@/modules/mail/application/conversation-service";
import { threading } from "@/modules/mail/domain/reply-forward";
import type {
  MailProvider,
  RemoteMessageMetadata,
} from "@/modules/accounts/domain/mail-provider";

describe("Phase 2G conversation graph and queries", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let messageService: MessageService;
  let service: ConversationService;
  let account: string;
  let inbox: string;
  let sent: string;
  let uid: number;

  async function addAccount() {
    const id = randomUUID();
    const accounts = new AccountsService(
      database.db,
      new AesGcmSecretEncryption("v1", {
        v1: Buffer.alloc(32, 4).toString("base64"),
      }),
      {} as MailProvider,
    );
    await accounts.create({
      id,
      displayName: "Threads",
      email: "owner@example.test",
      enabled: false,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        password: "secret",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: true,
      },
    });
    await new MailboxService(database.db).reconcile(
      id,
      ["INBOX", "Sent"].map((path) => ({
        remotePath: path,
        name: path,
        delimiter: "/",
        attributes: [],
        selectable: true,
        specialUse: [],
        uidValidity: "1",
      })),
    );
    const folders = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, id));
    return {
      id,
      inbox: folders.find((f) => f.remotePath === "INBOX")!.id,
      sent: folders.find((f) => f.remotePath === "Sent")!.id,
    };
  }

  async function add(
    header: string | undefined,
    reply?: string,
    references?: string,
    options: {
      account?: string;
      mailbox?: string;
      subject?: string;
      seen?: boolean;
      date?: string;
    } = {},
  ) {
    const metadata: RemoteMessageMetadata = {
      uid: String(++uid),
      internalDate:
        options.date ?? new Date(Date.UTC(2026, 0, uid)).toISOString(),
      size: "1",
      flags: options.seen ? ["\\Seen"] : [],
      hasAttachments: false,
      envelope: {
        messageId: header,
        inReplyTo: reply,
        references,
        subject: options.subject ?? "Same subject",
        from: [{ address: "sender@example.test" }],
        sender: [],
        replyTo: [],
        to: [],
        cc: [],
        bcc: [],
      },
    };
    await messageService.persistBatch(
      options.account ?? account,
      options.mailbox ?? inbox,
      1n,
      [metadata],
    );
    const [placement] = await database.db
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.uid, BigInt(uid)));
    return placement.messageId;
  }
  async function groups() {
    return database.db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.accountId, account));
  }
  async function groupCount() {
    return new Set((await groups()).map((m) => m.conversationId)).size;
  }

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "conversations",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "maildock-test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/conversations`,
      databasePoolSize: 5,
    });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    messageService = new MessageService(database.db);
    service = new ConversationService(database.db);
  });
  beforeEach(async () => {
    await database.db.delete(mailAccounts);
    await database.db.delete(instanceState);
    const owner = await addAccount();
    account = owner.id;
    inbox = owner.inbox;
    sent = owner.sent;
    uid = 0;
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });

  it.each([false, true])(
    "All Inboxes uses enabled source placements and account isolation (conversation=%s)",
    async (enabled) => {
      const other = await addAccount();
      const disabled = await addAccount();
      await database.db
        .update(mailAccounts)
        .set({ enabled: true })
        .where(eq(mailAccounts.id, account));
      await database.db
        .update(mailAccounts)
        .set({ enabled: true })
        .where(eq(mailAccounts.id, other.id));
      await service.setEnabled(enabled);
      const first = await add("<first@all>", undefined, undefined, {
        date: "2026-01-01T00:00:00Z",
      });
      const second = await add("<second@all>", "<first@all>", undefined, {
        account: other.id,
        mailbox: other.inbox,
        date: "2026-01-02T00:00:00Z",
      });
      await add("<sent@all>", undefined, undefined, { mailbox: sent });
      await add("<disabled@all>", undefined, undefined, {
        account: disabled.id,
        mailbox: disabled.inbox,
      });
      const hidden = await add("<hidden@all>");
      await database.db
        .update(mailboxMessages)
        .set({ actionHidden: true })
        .where(eq(mailboxMessages.messageId, hidden));
      const page = await messageService.listAllInboxes(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: second,
        accountId: other.id,
        mailboxId: other.inbox,
      });
      expect(page.nextCursor).not.toBeNull();
      const next = await messageService.listAllInboxes(1, page.nextCursor!);
      expect(next.items).toHaveLength(1);
      expect(next.items[0]).toMatchObject({
        id: first,
        accountId: account,
        mailboxId: inbox,
      });
      expect(next.nextCursor).toBeNull();
      if (enabled) {
        const members = await service.open(
          other.id,
          page.items[0].conversationId!,
          true,
          other.inbox,
        );
        expect(members.map((m) => m.id)).toEqual([second]);
        expect(members[0].mailboxId).toBe(other.inbox);
      }
      await expect(
        messageService.listAllInboxes(50, "invalid"),
      ).rejects.toThrow("Invalid cursor.");
    },
  );

  it("connects A -> B -> C across Sent and Inbox using external headers and existing outgoing threading", async () => {
    await add("<maildock.a@example.test>", undefined, undefined, {
      mailbox: sent,
    });
    await add(
      "<gmail.b@mail.gmail.com>",
      "<maildock.a@example.test>",
      "<maildock.a@example.test>",
    );
    const reply = threading(
      {
        rfcMessageId: "<gmail.b@mail.gmail.com>",
        references: "<maildock.a@example.test>",
      },
      "reply_all",
    );
    await add(
      "<maildock.c@example.test>",
      reply.inReplyTo ?? undefined,
      reply.references.join(" "),
      { mailbox: sent },
    );
    await add(
      "<outlook.d@outlook.com>",
      "<maildock.c@example.test>",
      "<maildock.a@example.test> <gmail.b@mail.gmail.com> <maildock.c@example.test>",
    );
    expect(await groupCount()).toBe(1);
    expect(await groups()).toHaveLength(4);
  });
  it("never crosses account boundaries", async () => {
    await add("<a@example>");
    const other = await addAccount();
    await add("<b@example>", "<a@example>", undefined, {
      account: other.id,
      mailbox: other.inbox,
    });
    const all = await database.db.select().from(conversationMembers);
    expect(new Set(all.map((m) => m.conversationId)).size).toBe(2);
  });
  it.each(["Same subject", "Re: Same subject", "Fwd: Same subject"])(
    "never groups by subject %s",
    async (subject) => {
      await add("<a@example>");
      await add("<b@example>", undefined, undefined, { subject });
      expect(await groupCount()).toBe(2);
    },
  );
  it("handles missing IDs without merging unrelated mail, but honors explicit references", async () => {
    await add(undefined);
    await add(undefined);
    await add("<a@example>");
    await add(undefined, "<a@example>");
    expect(await groupCount()).toBe(3);
  });
  it("does not treat duplicate Message-ID as message identity or merge evidence", async () => {
    await add("<duplicate@example>");
    await add("<duplicate@example>");
    await add("<reply@example>", "<duplicate@example>");
    expect(await groupCount()).toBe(3);
    await add("<another-reply@example>", "<duplicate@example>");
    expect(await groupCount()).toBe(4);
  });
  it("retracts ambiguous parent evidence when a collision appears after the child", async () => {
    await add("<duplicate@example>");
    await add("<reply@example>", "<duplicate@example>");
    expect(await groupCount()).toBe(1);
    await add("<duplicate@example>");
    expect(await groupCount()).toBe(3);
  });
  it.each([
    ["a", "b", "c"],
    ["a", "c", "b"],
    ["b", "a", "c"],
    ["b", "c", "a"],
    ["c", "a", "b"],
    ["c", "b", "a"],
  ])(
    "converges for synchronization order %s %s %s",
    async (first, second, third) => {
      for (const id of [first, second, third])
        await add(
          `<${id}@example>`,
          id === "a" ? undefined : id === "b" ? "<a@example>" : "<b@example>",
          id === "c" ? "<a@example> <b@example>" : undefined,
        );
      expect(await groupCount()).toBe(1);
    },
  );
  it("repairs late ancestors and a historical checkpoint incrementally", async () => {
    await add("<c@example>", "<b@example>");
    await add("<b@example>", "<a@example>");
    await database.db
      .update(mailboxes)
      .set({
        backfillUidValidity: 1n,
        recentSyncUidValidity: 1n,
        backfillFrontierUid: 50n,
      })
      .where(eq(mailboxes.id, inbox));
    await messageService.persistBatch(
      account,
      inbox,
      1n,
      [
        {
          uid: "50",
          internalDate: "2020-01-01T00:00:00Z",
          size: "1",
          flags: [],
          hasAttachments: false,
          envelope: {
            messageId: "<a@example>",
            from: [],
            sender: [],
            replyTo: [],
            to: [],
            cc: [],
            bcc: [],
          },
        },
      ],
      undefined,
      { frontier: 50n, nextFrontier: 0n },
    );
    expect(await groupCount()).toBe(1);
    expect(await groups()).toHaveLength(3);
  });
  it("safely merges groups, redirects losing IDs, and reconciliation never duplicates membership", async () => {
    await add("<a@example>");
    await add("<b@example>", "<a@example>");
    await add("<c@example>");
    await add("<d@example>", "<c@example>");
    expect(await groupCount()).toBe(2);
    const oldIds = [...new Set((await groups()).map((m) => m.conversationId))];
    const bridge = await add(
      "<e@example>",
      "<b@example>",
      "<b@example> <c@example>",
    );
    for (let i = 0; i < 3; i++)
      await database.db.execute(
        sql`SELECT maildock_reconcile_conversation(${bridge}::uuid)`,
      );
    expect(await groupCount()).toBe(1);
    expect(await groups()).toHaveLength(5);
    for (const id of oldIds)
      expect(await service.open(account, id)).toHaveLength(5);
    const merged = await database.db
      .select()
      .from(conversations)
      .where(eq(conversations.accountId, account));
    expect(merged.filter((c) => c.mergedInto)).toHaveLength(4);
  });
  it("Forward uses Phase 2D semantics and cannot inherit source membership", async () => {
    await add("<a@example>");
    const forward = threading(
      { rfcMessageId: "<a@example>", references: "<ancestor@example>" },
      "forward",
    );
    await add(
      "<forward@example>",
      forward.inReplyTo ?? undefined,
      forward.references.join(" "),
      { subject: "Fwd: Same subject" },
    );
    expect(await groupCount()).toBe(2);
  });
  it("defaults Off, persists On, and never rethreads when toggled", async () => {
    await add("<a@example>");
    await add("<b@example>", "<a@example>");
    expect(await service.enabled()).toBe(false);
    expect((await messageService.list(account, inbox)).items).toHaveLength(2);
    const before = await groups();
    await service.setEnabled(true);
    expect(await new ConversationService(database.db).enabled()).toBe(true);
    expect((await messageService.list(account, inbox)).items).toHaveLength(1);
    await service.setEnabled(false);
    expect(await groups()).toEqual(before);
  });
  it("groups only mailbox-relevant rows and counts/unread, opens complete chronological history", async () => {
    const a = await add("<a@example>", undefined, undefined, {
      mailbox: sent,
      seen: false,
    });
    const b = await add("<b@example>", "<a@example>", undefined, {
      seen: true,
    });
    await add("<c@example>", "<b@example>", undefined, {
      mailbox: sent,
      seen: false,
    });
    const d = await add("<d@example>", "<c@example>", undefined, {
      seen: true,
    });
    await add("<sent-only@example>", undefined, undefined, { mailbox: sent });
    await service.setEnabled(true);
    const list = await messageService.list(account, inbox);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: d, messageCount: 2, seen: true });
    expect(list.items[0].conversationMessageCount).toBe(4);
    const history = await service.open(account, list.items[0].conversationId!);
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ id: a, mailboxId: sent });
    expect(history[1].id).toBe(b);
    expect(
      await service.open(randomUUID(), list.items[0].conversationId!),
    ).toEqual([]);
  });
  it("expanded list metadata omits bodies and prefers the currently viewed mailbox placement", async () => {
    const parent = await add("<a@example>", undefined, undefined, {
      mailbox: sent,
    });
    const child = await add("<b@example>", "<a@example>");
    const [placement] = await database.db
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.messageId, child));
    await database.db
      .insert(mailboxMessages)
      .values({ ...placement, id: randomUUID(), mailboxId: sent, uid: 99n });
    await database.db.insert(messageContents).values({
      messageId: child,
      status: "ready",
      plainText: "Message body",
      sanitizedHtml: "<p>Message body</p>",
    });
    await service.setEnabled(true);
    const [group] = (await messageService.list(account, inbox)).items;
    const members = await service.open(
      account,
      group.conversationId!,
      true,
      inbox,
    );
    expect(members.map((member) => member.id)).toEqual([parent, child]);
    expect(members[1].mailboxId).toBe(inbox);
    expect(
      members.every(
        (member) => member.plainText === null && member.sanitizedHtml === null,
      ),
    ).toBe(true);
    const sentMembers = await service.open(
      account,
      group.conversationId!,
      true,
      sent,
    );
    expect(sentMembers[1].mailboxId).toBe(sent);
    const full = await service.open(
      account,
      group.conversationId!,
      false,
      inbox,
    );
    expect(full[1].plainText).toBe("Message body");
  });
  it("maintains keyset pagination over conversation representatives", async () => {
    await add("<a@example>");
    await add("<b@example>", "<a@example>");
    await add("<x@example>");
    await add("<y@example>");
    await service.setEnabled(true);
    const one = await messageService.list(account, inbox, 2);
    expect(one.items).toHaveLength(2);
    expect(one.nextCursor).not.toBeNull();
    const two = await messageService.list(account, inbox, 2, one.nextCursor!);
    expect(two.items).toHaveLength(1);
    expect(two.items[0].messageCount).toBe(2);
    expect(two.nextCursor).toBeNull();
  });
  it("placement changes and hidden messages preserve identity and mailbox membership", async () => {
    const a = await add("<a@example>");
    await add("<b@example>", "<a@example>");
    const before = await groups();
    await database.db
      .update(mailboxMessages)
      .set({ mailboxId: sent })
      .where(eq(mailboxMessages.messageId, a));
    await service.setEnabled(true);
    expect(
      (await messageService.list(account, inbox)).items[0].messageCount,
    ).toBe(1);
    expect(await groups()).toEqual(before);
    await database.db
      .update(mailboxMessages)
      .set({ actionHidden: true })
      .where(eq(mailboxMessages.mailboxId, inbox));
    expect((await messageService.list(account, inbox)).items).toEqual([]);
  });
  it("migrates existing Phase 2F messages without changing content or placements", async () => {
    await database.client.unsafe("CREATE DATABASE phase2g_upgrade");
    const upgraded = createDatabase({
      databaseUrl: `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/phase2g_upgrade`,
      databasePoolSize: 2,
    });
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: "db/migrations",
      });
      for (const migration of migrations.slice(0, 17))
        for (const statement of migration.sql)
          await upgraded.client.unsafe(statement);
      const owner = randomUUID(),
        parent = randomUUID(),
        child = randomUUID();
      await upgraded.client`INSERT INTO mail_accounts (id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) VALUES (${owner},'Legacy','owner@example.com','imap.example.com',993,'tls','owner','{}','smtp.example.com',465,'tls')`;
      await upgraded.client`INSERT INTO messages (id,account_id,rfc_message_id,in_reply_to,subject,internal_date,size) VALUES (${child},${owner},'<child@example>','<parent@example>','Preserved child',now(),1), (${parent},${owner},'<parent@example>',NULL,'Preserved parent',now(),2)`;
      await upgraded.client.begin(async (tx) => {
        for (const statement of migrations[17].sql) await tx.unsafe(statement);
      });
      const members = await upgraded.db.select().from(conversationMembers);
      expect(members).toHaveLength(2);
      expect(new Set(members.map((m) => m.conversationId)).size).toBe(1);
      const original =
        await upgraded.client`SELECT subject, size FROM messages ORDER BY subject`;
      expect(original.map((m) => m.subject)).toEqual([
        "Preserved child",
        "Preserved parent",
      ]);
      expect(await new ConversationService(upgraded.db).enabled()).toBe(false);
    } finally {
      await upgraded.client.end();
    }
  });
  it("concurrent mailbox workers converge under the account transaction lock", async () => {
    const envelope = (messageId: string, inReplyTo?: string) => ({
      messageId,
      inReplyTo,
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
    });
    await Promise.all([
      messageService.persistBatch(account, inbox, 1n, [
        {
          uid: "100",
          internalDate: "2026-01-01T00:00:00Z",
          size: "1",
          flags: [],
          hasAttachments: false,
          envelope: envelope("<b@example>", "<a@example>"),
        },
      ]),
      messageService.persistBatch(account, sent, 1n, [
        {
          uid: "200",
          internalDate: "2026-01-01T00:00:00Z",
          size: "1",
          flags: [],
          hasAttachments: false,
          envelope: envelope("<a@example>"),
        },
      ]),
    ]);
    expect(await groupCount()).toBe(1);
  });
});
