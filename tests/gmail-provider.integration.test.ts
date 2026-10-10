import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { validateDatabaseAuthority } from "@/shared/infrastructure/database/database-authority";
import {
  mailAccounts,
  mailboxes,
  messages,
  mailboxMessages,
  gmailAccountSyncState,
  gmailSyncWork,
  messageContents,
  messageCommands,
  notificationEvents,
  outgoingMessages,
  gmailQuotaBuckets,
} from "@/shared/infrastructure/database/schema";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { GmailProvider } from "@/modules/mail/infrastructure/gmail-provider";
import { createGmailAccountLock } from "@/modules/mail/infrastructure/gmail-account-lock";
import { GmailSyncService } from "@/modules/mail/application/gmail-sync-service";
import { GmailMessageCommands } from "@/modules/mail/application/gmail-message-commands";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { createAttachmentLock } from "@/modules/mail/infrastructure/attachment-lock";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/modules/mail/domain/attachments";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import { SyntheticGmail } from "./helpers/gmail-fixture";
import { reserveGmailQuota } from "@/modules/mail/infrastructure/gmail-quota";

describe("complete native Gmail provider on disposable PostgreSQL, pool=1", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let directory: string;
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 9).toString("base64"),
  });
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "maildock",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withCopyContentToContainer([
        {
          content: await readFile(
            "scripts/postgres/99-maildock-authority.sql",
            "utf8",
          ),
          target: "/docker-entrypoint-initdb.d/99-maildock-authority.sql",
        },
      ])
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/maildock`,
      databasePoolSize: 1,
    });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await validateDatabaseAuthority(database.client);
    directory = await mkdtemp(path.join(tmpdir(), "maildock-gmail-test-"));
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function setup(remote = new SyntheticGmail()) {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Google",
      email: "owner@example.test",
      providerType: "gmail_smtp",
      authMethod: "oauth2",
      oauthProviderId: "google",
      oauthHomeAccountId: `subject-${id}`,
      oauthCache: encryption.encrypt(
        "fixture",
        `maildock:account-credential:v1:${id}:oauth-cache`,
      ),
      oauthStatus: "connected",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      smtpUsesImapCredentials: false,
      smtpUsername: "owner@example.test",
    });
    const accounts = {
      getProviderGmailAccountForWork: vi.fn(
        async (_id: string, revision?: string) => ({
          accountId: id,
          revision: revision ?? "1",
          accessToken: "synthetic",
        }),
      ),
    } as unknown as AccountsService;
    const provider = new GmailProvider(database.db, accounts, remote.fetch, {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 100000000,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 1000000000,
      MAILDOCK_GMAIL_DAILY_UNITS: 1000000000,
    });
    const lock = createGmailAccountLock(database.client);
    const sync = new GmailSyncService(database.db, provider, lock, 30);
    const state = async () =>
      (
        await database.db
          .select()
          .from(gmailAccountSyncState)
          .where(eq(gmailAccountSyncState.accountId, id))
      )[0];
    async function finish(max = 150) {
      for (let i = 0; i < max; i++) {
        await sync.run(id, "1");
        const s = await state();
        if (s?.inventoryComplete && !s.historyRunId) return s;
        await database.db
          .update(gmailAccountSyncState)
          .set({ nextAttemptAt: null })
          .where(eq(gmailAccountSyncState.accountId, id));
      }
      throw new Error("Inventory did not finish");
    }
    async function delta(max = 100) {
      await database.db
        .update(gmailAccountSyncState)
        .set({ nextAttemptAt: null, needsWork: true })
        .where(eq(gmailAccountSyncState.accountId, id));
      await sync.run(id, "1");
      for (let i = 0; i < max; i++) {
        await sync.run(id, "1");
        const s = await state();
        if (!s.historyRunId) return s;
      }
      throw new Error("History did not finish");
    }
    return { id, remote, accounts, provider, lock, sync, state, finish, delta };
  }
  it("bootstraps an empty account with an API history checkpoint", async () => {
    const t = await setup();
    const state = await t.finish();
    expect(state).toMatchObject({
      historyId: "100",
      recentReady: true,
      inventoryComplete: true,
      status: "ready",
    });
  });
  it("fills folder counters during blocked backfill and imports paginated MIME with long handles", async () => {
    const remote = new SyntheticGmail();
    remote.labels.push({ id: "Label_two", name: "Second", type: "user" });
    for (let i = 0; i < 102; i++) {
      const message = remote.fixture(
        `long-${i}`,
        ["INBOX", "Label_one", "Label_two", "UNREAD"],
        i === 101 ? Date.now() - 40 * 86400000 : Date.now(),
      );
      message.payload!.parts!.push({
        partId: "2",
        mimeType: "application/pdf",
        filename: "fixture.pdf",
        body: { attachmentId: "A".repeat(404), size: 18 },
      });
    }
    const t = await setup(remote);
    await t.sync.run(t.id, "1"); // Bootstrap refreshes only four counters.
    remote.failures.set("messages/long-0", 500);
    await t.sync.run(t.id, "1"); // Fill remaining counters and stage a page.
    await t.sync.run(t.id, "1"); // The metadata failure cannot hide counters.
    expect((await t.state()).inventoryComplete).toBe(false);
    const service = new MailboxService(database.db);
    const partial = await service.listForAccount(t.id);
    const [account] = await database.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, t.id));
    expect(account.lastSuccessfulMailboxDiscoveryAt).toBeInstanceOf(Date);
    expect(
      partial
        .filter((box) => box.providerMailboxId)
        .every((box) => box.unseenCount !== null),
    ).toBe(true);
    expect(
      partial.find((box) => box.providerMailboxId === "Label_two")?.unseenCount,
    ).toBe("102");
    expect(await t.finish()).toMatchObject({
      status: "ready",
      recentReady: true,
      inventoryComplete: true,
      errorCategory: null,
    });
    const boxes = await service.listForAccount(t.id);
    expect(
      boxes.find((box) => box.providerMailboxId === "Label_two"),
    ).toMatchObject({
      messageCount: "102",
      unseenCount: "102",
      synchronizedMessageCount: "102",
    });
    expect(
      remote.requests.some(
        (request) =>
          request.path === "messages" &&
          request.query.get("pageToken") === "100",
      ),
    ).toBe(true);
    expect(remote.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
  });
  it("refreshes a rejected token outside reserved authority with pool size one", async () => {
    const remote = new SyntheticGmail();
    remote.failures.set("profile", 401);
    const t = await setup(remote);
    await t.sync.run(t.id, "1");
    expect(t.accounts.getProviderGmailAccountForWork).toHaveBeenCalledTimes(2);
    expect((await t.state()).baselineHistoryId).toBe("100");
    expect(remote.requests.filter((r) => r.path === "profile")).toHaveLength(2);
  });
  it("preserves custom-label placement during optimistic archive and cancels stale commands", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("archive-custom", ["INBOX", "Label_one"]);
    const t = await setup(remote);
    await t.finish();
    const [message] = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    const boxes = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, t.id));
    const custom = boxes.find((b) => b.providerMailboxId === "Label_one")!;
    const inbox = boxes.find((b) => b.providerMailboxId === "INBOX")!;
    const commands = new GmailMessageCommands(
      database.db,
      async () => undefined,
      t.provider,
      t.lock,
    );
    const accepted = await commands.create(
      t.id,
      custom.id,
      message.id,
      "archive",
    );
    const placements = await database.db
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.messageId, message.id));
    expect(
      placements.find((p) => p.mailboxId === custom.id)!.actionHidden,
    ).toBe(false);
    expect(placements.find((p) => p.mailboxId === inbox.id)!.actionHidden).toBe(
      true,
    );
    await database.db
      .update(mailAccounts)
      .set({ enabled: false, workRevision: 2n })
      .where(eq(mailAccounts.id, t.id));
    // The fake credential resolver cannot mask the real publication fence.
    vi.mocked(t.accounts.getProviderGmailAccountForWork).mockRejectedValueOnce(
      new (
        await import("@/modules/accounts/domain/receive-transport")
      ).StaleAccountWorkError(),
    );
    await commands.run(accepted.id);
    expect(
      (
        await database.db
          .select()
          .from(messageCommands)
          .where(eq(messageCommands.id, accepted.id))
      )[0].status,
    ).toBe("failed");
    expect(remote.requests.some((r) => r.method === "POST")).toBe(false);
  });
  it("publishes recent messages before backfill and persists bounded pages across restart", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("recent");
    for (let i = 0; i < 230; i++)
      remote.fixture(`old-${i}`, ["Label_one"], Date.now() - 60 * 86400000);
    const t = await setup(remote);
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await t.sync.run(t.id, "1");
      if ((await t.state()).recentReady) {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
    expect((await t.state()).inventoryComplete).toBe(false);
    const local = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    expect(local.map((m) => m.providerMessageId)).toEqual(["recent"]);
    const restarted = new GmailSyncService(database.db, t.provider, t.lock);
    await restarted.run(t.id, "1");
    await t.finish();
    expect(
      (
        await database.db
          .select()
          .from(messages)
          .where(eq(messages.accountId, t.id))
      ).length,
    ).toBe(231);
    expect(
      remote.requests
        .filter((r) => r.path === "messages")
        .every((r) => r.query.get("includeSpamTrash") === "true"),
    ).toBe(true);
    expect(
      remote.requests
        .filter((r) => r.path.startsWith("messages/"))
        .every((r) => r.query.has("fields")),
    ).toBe(true);
  });
  it("stores one canonical UUID through multiple labels, rename and delete", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("same");
    const t = await setup(remote);
    await t.finish();
    const [local] = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    expect(
      (
        await database.db
          .select()
          .from(mailboxMessages)
          .where(eq(mailboxMessages.messageId, local.id))
      ).length,
    ).toBe(3);
    const [label] = await database.db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, t.id),
          eq(mailboxes.providerMailboxId, "Label_one"),
        ),
      );
    remote.labels[4].name = "Renamed";
    await t.delta();
    expect(
      (
        await database.db
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.id, label.id))
      )[0].name,
    ).toBe("Renamed");
    remote.labels.pop();
    remote.messages.get("same")!.labelIds = ["INBOX"];
    remote.change("same");
    await t.delta();
    expect(
      (
        await database.db
          .select()
          .from(messages)
          .where(eq(messages.accountId, t.id))
      )[0].id,
    ).toBe(local.id);
    expect(
      (
        await database.db
          .select()
          .from(mailboxMessages)
          .where(eq(mailboxMessages.mailboxId, label.id))
      ).length,
    ).toBe(0);
  });
  it("accounts for remote drafts without exposing them in normal placements", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("draft", ["DRAFT"]);
    remote.fixture("trash", ["TRASH"]);
    remote.fixture("spam", ["SPAM"]);
    const t = await setup(remote);
    await t.finish();
    const rows = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    expect(rows.length).toBe(3);
    const draft = rows.find((m) => m.providerMessageId === "draft")!;
    expect(
      await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.messageId, draft.id)),
    ).toHaveLength(0);
    remote.change("draft", ["SENT"]);
    await t.delta();
    expect(
      await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.messageId, draft.id)),
    ).toHaveLength(2);
  });
  it("does not advance history across a failed GET and resumes durable work", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("changed");
    const t = await setup(remote);
    await t.finish();
    remote.change("changed", ["INBOX", "STARRED"]);
    remote.failures.set("messages/changed", 500);
    await database.db
      .update(gmailAccountSyncState)
      .set({ nextAttemptAt: null })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    for (let i = 0; i < 3; i++) await t.sync.run(t.id, "1");
    expect((await t.state()).historyId).toBe("100");
    expect((await t.state()).errorCategory).toBe("network");
    expect(
      await database.db
        .select()
        .from(gmailSyncWork)
        .where(
          and(
            eq(gmailSyncWork.accountId, t.id),
            eq(gmailSyncWork.status, "pending"),
          ),
        ),
    ).toHaveLength(1);
    await database.db
      .update(gmailAccountSyncState)
      .set({ nextAttemptAt: null })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    for (let i = 0; i < 4; i++) await t.sync.run(t.id, "1");
    expect((await t.state()).historyId).toBe("101");
  });
  it("reconciles expired history without changing UUIDs or cached bodies", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("keep");
    remote.fixture("gone");
    const t = await setup(remote);
    await t.finish();
    const rows = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    const keep = rows.find((m) => m.providerMessageId === "keep")!;
    await database.db.insert(messageContents).values({
      messageId: keep.id,
      status: "ready",
      plainText: "cached",
      policyVersion: "fixture",
    });
    remote.messages.delete("gone");
    remote.expired = true;
    await t.delta();
    expect((await t.state()).status).toBe("reconcile_required");
    await database.db
      .update(gmailAccountSyncState)
      .set({ nextAttemptAt: null })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    await t.finish();
    const final = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    expect(final.find((m) => m.providerMessageId === "keep")!.id).toBe(keep.id);
    expect(
      final.find((m) => m.providerMessageId === "gone")!.remoteMissingAt,
    ).not.toBeNull();
    expect(
      (
        await database.db
          .select()
          .from(messageContents)
          .where(eq(messageContents.messageId, keep.id))
      )[0].plainText,
    ).toBe("cached");
  });
  it.each([
    "mark_read",
    "mark_unread",
    "flag",
    "unflag",
    "archive",
    "trash",
  ] as const)(
    "executes %s through Gmail with global projection and durable intent",
    async (action) => {
      const remote = new SyntheticGmail();
      remote.fixture("action", ["INBOX", "Label_one", "STARRED"]);
      const t = await setup(remote);
      await t.finish();
      const [local] = await database.db
        .select()
        .from(messages)
        .where(eq(messages.accountId, t.id));
      const [inbox] = await database.db
        .select()
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.accountId, t.id),
            eq(mailboxes.providerMailboxId, "INBOX"),
          ),
        );
      const commands = new GmailMessageCommands(
        database.db,
        async () => undefined,
        t.provider,
        t.lock,
      );
      const accepted = await commands.create(t.id, inbox.id, local.id, action);
      // An interleaved history GET must preserve the pending optimistic intent.
      remote.change("action");
      // Publish a history observation while the UI intent is pending, independently
      // of the scheduler's command priority (which pauses background slices).
      const { projectGmailMessage } =
        await import("@/modules/mail/infrastructure/gmail-projector");
      await t.lock(t.id, (db) =>
        projectGmailMessage(
          db,
          t.id,
          "1",
          "action",
          remote.messages.get("action")!,
        ),
      );
      await commands.run(accepted.id);
      expect(
        (
          await database.db
            .select()
            .from(messageCommands)
            .where(eq(messageCommands.id, accepted.id))
        )[0].status,
      ).toBe("succeeded");
      const placements = await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.messageId, local.id));
      expect(
        new Set(placements.map((p) => p.flags.join(","))).size,
      ).toBeLessThanOrEqual(1);
      expect(
        remote.requests.some(
          (r) => r.path.includes("/modify") || r.path.includes("/trash"),
        ) || ["mark_read", "flag"].includes(action),
      ).toBe(true);
      if (action === "archive")
        expect(remote.messages.get("action")!.labelIds).toEqual(
          expect.arrayContaining(["Label_one"]),
        );
      expect(remote.requests.some((r) => r.method === "DELETE")).toBe(false);
    },
  );
  it("fetches/sanitizes HTML on demand through the existing content cache", async () => {
    const remote = new SyntheticGmail();
    const native = remote.fixture("body");
    native.payload!.parts!.push({
      partId: "2",
      mimeType: "application/pdf",
      filename: "file.pdf",
      body: { attachmentId: "A".repeat(404), size: 18 },
    });
    const t = await setup(remote);
    await t.finish();
    const [local] = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    const [box] = await database.db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, t.id),
          eq(mailboxes.providerMailboxId, "INBOX"),
        ),
      );
    const service = new MessageContentService(
      database.db,
      { schedule: async () => true },
      t.accounts,
      {} as MailProvider,
      { maxMessageTextPartBytes: 10000 },
      t.provider,
    );
    await service.request(t.id, box.id, local.id);
    await service.run(t.id, box.id, local.id, 1, "1");
    const detail = await service.detail(t.id, box.id, local.id);
    expect(detail.content).toMatchObject({
      status: "ready",
      plainText: "hello",
      remoteContentBlocked: true,
    });
    expect(detail.content.sanitizedHtml).not.toContain("<script");
    expect(detail.attachments).toHaveLength(1);
    const storage = new LocalBlobStorage(directory);
    const attachments = new AttachmentService(
      database.db,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      async () => undefined,
      t.accounts,
      {} as MailProvider,
      createAttachmentLock(database.client),
      undefined,
      t.provider,
    );
    await attachments.request(detail.attachments[0].id);
    await attachments.run(detail.attachments[0].id, "1", t.id);
    expect(await attachments.status(detail.attachments[0].id)).toMatchObject({
      status: "ready",
      size: "18",
    });
  });
  it("moves between native labels without removing unrelated labels", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("move", ["INBOX", "Label_one", "STARRED"]);
    const t = await setup(remote);
    await t.finish();
    const [local] = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    const boxes = await database.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, t.id));
    const commands = new GmailMessageCommands(
      database.db,
      async () => undefined,
      t.provider,
      t.lock,
    );
    const command = await commands.createNative(
      t.id,
      "move",
      "move",
      boxes.find((b) => b.providerMailboxId === "SPAM")!.id,
    );
    await commands.run(command.id);
    expect(remote.messages.get("move")!.labelIds).toEqual(
      expect.arrayContaining(["SPAM", "Label_one", "STARRED"]),
    );
    expect(remote.messages.get("move")!.labelIds).not.toContain("INBOX");
    await expect(
      commands.create(
        t.id,
        boxes.find((b) => b.providerMailboxId === "SPAM")!.id,
        local.id,
        "move",
        randomUUID(),
      ),
    ).rejects.toThrow("destination");
  });
  it("observes SMTP-accepted native Sent without creating a duplicate or APPEND", async () => {
    const remote = new SyntheticGmail();
    const native = remote.fixture("sent-observation", ["SENT"]);
    native.payload!.headers!.find((h) => h.name === "From")!.value =
      "Owner <owner@example.test>";
    const t = await setup(remote);
    const outgoingId = randomUUID();
    await database.db.insert(outgoingMessages).values({
      id: outgoingId,
      accountId: t.id,
      from: { address: "owner@example.test" },
      to: [{ address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Sent",
      plainText: "body",
      messageId: "<sent-observation@example.test>",
      mimeBase64: Buffer.from("synthetic MIME").toString("base64"),
      status: "sent",
      smtpAcceptedAt: new Date(Number(native.internalDate)),
    });
    await t.finish();
    const [received] = await database.db
      .select()
      .from(messages)
      .where(eq(messages.accountId, t.id));
    expect(
      (
        await database.db
          .select()
          .from(outgoingMessages)
          .where(eq(outgoingMessages.id, outgoingId))
      )[0].sentCopyMessageId,
    ).toBe(received.id);
    remote.change("sent-observation", ["SENT", "Label_one"]);
    await t.delta();
    expect(
      await database.db
        .select()
        .from(messages)
        .where(eq(messages.accountId, t.id)),
    ).toHaveLength(1);
    expect(remote.requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("keeps cached data during incomplete inventory and rejects a repeated page cursor", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("first");
    const t = await setup(remote);
    remote.loop = true;
    for (let i = 0; i < 4; i++) await t.sync.run(t.id, "1");
    expect((await t.state()).inventoryComplete).toBe(false);
    expect((await t.state()).errorCategory).toBe("invalid_response");
    expect(
      (
        await database.db
          .select()
          .from(messages)
          .where(eq(messages.accountId, t.id))
      )[0].remoteMissingAt,
    ).toBeNull();
  });
  it("coalesces repeated history events and rejects a failed page before changing checkpoints", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("history");
    const t = await setup(remote);
    await t.finish();
    for (let i = 0; i < 230; i++)
      remote.change("history", ["INBOX", "STARRED"]);
    remote.failures.set("history", 500);
    await database.db
      .update(gmailAccountSyncState)
      .set({ nextAttemptAt: null })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    await t.sync.run(t.id, "1");
    await t.sync.run(t.id, "1");
    expect((await t.state()).historyId).toBe("100");
    await database.db
      .update(gmailAccountSyncState)
      .set({ nextAttemptAt: null })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    for (let i = 0; i < 15; i++) {
      await t.sync.run(t.id, "1");
      if (!(await t.state()).historyRunId) break;
    }
    expect((await t.state()).historyId).toBe("330");
    expect(
      await database.db
        .select()
        .from(messages)
        .where(eq(messages.accountId, t.id)),
    ).toHaveLength(1);
  });
  it("drains a history page affecting 501 IDs through bounded durable fragments", async () => {
    const remote = new SyntheticGmail();
    const t = await setup(remote);
    await t.finish();
    for (let i = 0; i < 501; i++) remote.fixture(`batch-${i}`, ["Label_one"]);
    remote.head++;
    remote.events.push({
      id: remote.head.toString(),
      messages: [...remote.messages.keys()].map((id) => ({ id })),
    });
    await t.delta();
    expect((await t.state()).historyId).toBe("101");
    expect((await t.state()).historyPageOffset).toBe(0);
    expect(
      await database.db
        .select()
        .from(messages)
        .where(eq(messages.accountId, t.id)),
    ).toHaveLength(501);
  });
  it("does not emit historical notifications and deduplicates a live Inbox arrival", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("old", ["INBOX"], Date.now() - 86400000);
    const t = await setup(remote);
    await t.finish();
    expect(
      await database.db
        .select()
        .from(notificationEvents)
        .where(eq(notificationEvents.accountId, t.id)),
    ).toHaveLength(0);
    remote.fixture("live");
    remote.change("live");
    await t.delta();
    remote.change("live");
    await t.delta();
    expect(
      await database.db
        .select()
        .from(notificationEvents)
        .where(eq(notificationEvents.accountId, t.id)),
    ).toHaveLength(1);
  });
  it("enforces shared weighted quota, daily cap and interactive reserve", async () => {
    const t = await setup();
    await t.provider.lease(t.id, "1");
    const limits = {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 100,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 100,
      MAILDOCK_GMAIL_DAILY_UNITS: 100,
    };
    const now = Date.now() + 30 * 86400000;
    await reserveGmailQuota(database.db, t.id, 1n, 65, false, limits, now);
    await expect(
      reserveGmailQuota(database.db, t.id, 1n, 10, false, limits, now),
    ).rejects.toMatchObject({ category: "quota" });
    await reserveGmailQuota(database.db, t.id, 1n, 20, true, limits, now);
    await expect(
      reserveGmailQuota(database.db, t.id, 1n, 20, true, limits, now + 180000),
    ).rejects.toMatchObject({ category: "quota" });
  });
  it("rejects stale account revision and disable before publication", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("cancelled");
    const t = await setup(remote);
    await t.sync.run(t.id, "1");
    await database.db
      .update(mailAccounts)
      .set({ workRevision: 2n, enabled: false })
      .where(eq(mailAccounts.id, t.id));
    await expect(t.sync.run(t.id, "1")).rejects.toThrow("stale");
    expect(
      await database.db
        .select()
        .from(messages)
        .where(eq(messages.accountId, t.id)),
    ).toHaveLength(0);
  });
  it("clears an authentication retry after reconnect while retaining charged quota", async () => {
    const t = await setup();
    await t.finish();
    const charged = (await t.state()).quotaDailyUnits;
    await database.db
      .update(gmailAccountSyncState)
      .set({
        status: "blocked",
        errorCategory: "authentication",
        nextAttemptAt: new Date(Date.now() + 86400000),
      })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    await database.db
      .update(mailAccounts)
      .set({ workRevision: 2n })
      .where(eq(mailAccounts.id, t.id));
    await t.provider.lease(t.id, "2");
    expect(await t.state()).toMatchObject({
      accountRevision: 2n,
      status: "not_started",
      errorCategory: null,
      nextAttemptAt: null,
      quotaDailyUnits: charged,
    });
  });
  it("quota expires a charged boundary second without retaining a whole previous minute", async () => {
    await database.db.delete(gmailQuotaBuckets);
    const t = await setup();
    await t.provider.lease(t.id, "1");
    const limits = {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 100,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 100,
      MAILDOCK_GMAIL_DAILY_UNITS: 1000,
    };
    const now = Math.floor(Date.now() / 60000) * 60000;
    await reserveGmailQuota(database.db, t.id, 1n, 100, true, limits, now);
    await expect(
      reserveGmailQuota(database.db, t.id, 1n, 1, true, limits, now + 59999),
    ).rejects.toMatchObject({ category: "quota", retryAfterMs: 1001 });
    await reserveGmailQuota(
      database.db,
      t.id,
      1n,
      1,
      true,
      limits,
      now + 61000,
    );
    expect((await t.state()).quotaDailyUnits).toBe(101n);
  });
  it("quota migration retains previous minute and daily reservations", async () => {
    const migration = await readFile(
      "db/migrations/0038_furry_molten_man.sql",
      "utf8",
    );
    // Isolated schema in the disposable fixture; roll back the entire probe.
    const namespace = `gmail_quota_probe_${randomUUID().replaceAll("-", "")}`;
    const sentinel = new Error("rollback quota migration fixture");
    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`create schema ${namespace}`));
        await tx.execute(sql.raw(`set local search_path to ${namespace}`));
        await tx.execute(
          sql`create table mail_accounts(id text,oauth_home_account_id text)`,
        );
        await tx.execute(
          sql`create table gmail_account_sync_state(account_id text,quota_minute bigint,quota_current_units bigint,quota_previous_units bigint,quota_day bigint,quota_daily_units bigint)`,
        );
        await tx.execute(
          sql`insert into mail_accounts values('legacy','legacy-subject')`,
        );
        await tx.execute(
          sql`insert into gmail_account_sync_state values('legacy',100,20,30,1,200)`,
        );
        for (const statement of migration.split("--> statement-breakpoint"))
          await tx.execute(sql.raw(statement));
        const project = await tx.execute(
          sql`select kind,bucket::text,units::text from gmail_quota_buckets where scope='project' order by kind,bucket`,
        );
        expect(project).toMatchObject([
          { kind: "day", bucket: "1", units: "200" },
          { kind: "second", bucket: "5999", units: "30" },
          { kind: "second", bucket: "6059", units: "20" },
        ]);
        expect(
          await tx.execute(
            sql`select sum(units)::text as units from gmail_quota_buckets where scope='user:'||encode(sha256(convert_to('legacy-subject','UTF8')),'hex')`,
          ),
        ).toMatchObject([{ units: "50" }]);
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
  });
  it("quota serializes competing workers and retains project usage after deletion", async () => {
    await database.db.delete(gmailQuotaBuckets);
    const a = await setup(),
      b = await setup();
    await a.provider.lease(a.id, "1");
    await b.provider.lease(b.id, "1");
    const limits = {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 1000,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 100,
      MAILDOCK_GMAIL_DAILY_UNITS: 1000,
    };
    const now = Date.now();
    const results = await Promise.allSettled(
      [a, b].map((t) =>
        t.lock(t.id, (db) =>
          reserveGmailQuota(db, t.id, 1n, 60, true, limits, now),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? a : b,
      survivor = winner === a ? b : a;
    await database.db
      .delete(mailAccounts)
      .where(eq(mailAccounts.id, winner.id));
    await reserveGmailQuota(
      database.db,
      survivor.id,
      1n,
      40,
      true,
      limits,
      now,
    );
    await expect(
      reserveGmailQuota(database.db, survivor.id, 1n, 1, true, limits, now),
    ).rejects.toMatchObject({ category: "quota" });
  });
  it("quota preserves daily and Google-user budgets after deletion and re-add", async () => {
    await database.db.delete(gmailQuotaBuckets);
    const a = await setup();
    await a.provider.lease(a.id, "1");
    const limits = {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 100,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 1000,
      MAILDOCK_GMAIL_DAILY_UNITS: 100,
    };
    const now = Date.now();
    await reserveGmailQuota(database.db, a.id, 1n, 60, true, limits, now);
    await database.db.delete(mailAccounts).where(eq(mailAccounts.id, a.id));
    const b = await setup();
    await database.db
      .update(mailAccounts)
      .set({ oauthHomeAccountId: `subject-${a.id}` })
      .where(eq(mailAccounts.id, b.id));
    await b.provider.lease(b.id, "1");
    await expect(
      reserveGmailQuota(
        database.db,
        b.id,
        1n,
        41,
        true,
        { ...limits, MAILDOCK_GMAIL_DAILY_UNITS: 1000 },
        now,
      ),
    ).rejects.toMatchObject({ category: "quota" });
    await expect(
      reserveGmailQuota(database.db, b.id, 1n, 41, true, limits, now + 180000),
    ).rejects.toMatchObject({ category: "quota" });
  });
  it("authority leaves pool-one interactive queries available during a remote wait", async () => {
    const t = await setup();
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>((resolve) => (entered = resolve)),
      released = new Promise<void>((resolve) => (resume = resolve));
    const work = t.lock(t.id, async (db) => {
      entered();
      await released;
      await db.transaction((tx) => tx.execute(sql`select 1`));
    });
    await waiting;
    try {
      await expect(
        Promise.race([
          database.db.execute(sql`select 1`).then(() => "available"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("starved"), 1000),
          ),
        ]),
      ).resolves.toBe("available");
      await expect(t.lock(t.id, async () => undefined)).rejects.toThrow(
        "already running",
      );
    } finally {
      resume();
      await work;
    }
  });
  it("authority verifies the exact advisory lock and rolls back failed nested transactions", async () => {
    const t = await setup();
    await t.lock(t.id, async (db) => {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`create temporary table gmail_lock_probe(value int)`,
        );
        await tx.execute(sql`insert into gmail_lock_probe values(1)`);
        await expect(
          tx.transaction(async (nested) => {
            await nested.execute(sql`insert into gmail_lock_probe values(2)`);
            throw new Error("rollback probe");
          }),
        ).rejects.toThrow("rollback probe");
        expect(
          await tx.execute(sql`select value from gmail_lock_probe`),
        ).toMatchObject([{ value: 1 }]);
      });
      await db.execute(sql`select pg_advisory_unlock_all()`);
      await db.execute(sql`select pg_advisory_lock(123)`);
      await expect(
        db.transaction((tx) => tx.execute(sql`select 1`)),
      ).rejects.toThrow("authority was lost");
    });
    // Failed authority must not poison a reused pool session.
    await t.lock(t.id, (db) =>
      db.transaction((tx) => tx.execute(sql`select 1`)),
    );
  });
  it("refreshes an expired metadata token and resumes durable receipts after 401", async () => {
    const remote = new SyntheticGmail();
    remote.fixture("expired-metadata");
    const fetcher = remote.fetch;
    const tokens: string[] = [];
    remote.fetch = async (input, options) => {
      const token = new Headers(options?.headers).get("authorization")!;
      tokens.push(token);
      if (token === "Bearer expired")
        return new Response("{}", { status: 401 });
      return fetcher(input, options);
    };
    const t = await setup(remote);
    await t.sync.run(t.id, "1");
    await t.sync.run(t.id, "1");
    vi.mocked(t.accounts.getProviderGmailAccountForWork)
      .mockResolvedValueOnce({
        accountId: t.id,
        revision: "1",
        accessToken: "expired",
      })
      .mockResolvedValueOnce({
        accountId: t.id,
        revision: "1",
        accessToken: "fresh",
      });
    await t.sync.run(t.id, "1");
    expect(tokens).toContain("Bearer expired");
    expect(tokens).toContain("Bearer fresh");
    expect(
      await database.db
        .select()
        .from(messages)
        .where(eq(messages.accountId, t.id)),
    ).toHaveLength(1);
    expect((await t.state()).processedCount).toBe(1n);
  });
  it("refreshes again on a worker retry after repeated 401 without advancing work", async () => {
    const remote = new SyntheticGmail(),
      fetcher = remote.fetch;
    let rejected = true;
    remote.fetch = async (input, options) =>
      rejected ? new Response("{}", { status: 401 }) : fetcher(input, options);
    const t = await setup(remote);
    await t.sync.run(t.id, "1");
    expect(await t.state()).toMatchObject({
      errorCategory: "authentication",
      baselineHistoryId: null,
    });
    rejected = false;
    await database.db
      .update(gmailAccountSyncState)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(gmailAccountSyncState.accountId, t.id));
    await t.sync.run(t.id, "1");
    expect((await t.state()).baselineHistoryId).toBe("100");
    expect(t.accounts.getProviderGmailAccountForWork).toHaveBeenCalledTimes(3);
  });
});
