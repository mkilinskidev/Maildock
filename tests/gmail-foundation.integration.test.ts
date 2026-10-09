import { verifyNativeSchema } from "@/shared/infrastructure/database/native-schema-verification";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { assertNativeReleaseCompatible } from "@/shared/infrastructure/database/native-release-guard";
import { validateDatabaseAuthority } from "@/shared/infrastructure/database/database-authority";
import { verifyRecoverySchema } from "@/shared/infrastructure/database/restore-verification";
import {
  mailAccounts,
  mailboxes,
  messages,
  mailboxMessages,
  messageAttachments,
  gmailAccountSyncState,
  gmailSyncWork,
  messageCommands,
  notificationEvents,
} from "@/shared/infrastructure/database/schema";
import { DeltaPoller } from "@/modules/mail/infrastructure/delta-sync-jobs";
import { BackfillPoller } from "@/modules/mail/infrastructure/backfill-sync-jobs";
import { IdleWatcherManager } from "@/modules/mail/infrastructure/idle-watchers";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { GmailSyncRepository } from "@/modules/mail/infrastructure/gmail-sync-repository";
import { assertImapPublication } from "@/modules/mail/infrastructure/receive-publication-fence";
import type { PgBoss } from "pg-boss";
import pino from "pino";

describe("P1 native Gmail PostgreSQL foundation", () => {
  let container: StartedTestContainer;
  let legacyContainer: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let legacy: ReturnType<typeof createDatabase>;
  const accountIds = [randomUUID(), randomUUID()];
  const mailboxIds = [randomUUID(), randomUUID()];
  const messageIds = [randomUUID(), randomUUID()];
  const hugeHistoryId = "900719925474099312345678901234567890";
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 9).toString("base64"),
  });
  const account = (id: string) => ({
    id,
    displayName: "Google",
    email: "owner@example.test",
    providerType: "gmail_smtp",
    authMethod: "oauth2",
    oauthProviderId: "google",
    oauthHomeAccountId: "subject",
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
  const box = (index: number) => ({
    id: mailboxIds[index],
    accountId: accountIds[index],
    receiveTransport: "gmail" as const,
    providerMailboxId: "INBOX",
    remotePath: "INBOX",
    name: "Inbox",
    selectable: true,
    firstDiscoveredAt: new Date(),
    lastDiscoveredAt: new Date(),
  });
  const message = (index: number) => ({
    id: messageIds[index],
    accountId: accountIds[index],
    receiveTransport: "gmail" as const,
    providerMessageId: "native-id",
    providerThreadId: "thread",
    providerHistoryId: hugeHistoryId,
    internalDate: new Date(),
    size: 1n,
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
    const url = `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}`;
    database = createDatabase({
      databaseUrl: `${url}/maildock`,
      databasePoolSize: 4,
    });
    await validateDatabaseAuthority(database.client);
    await assertNativeReleaseCompatible(database.client);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    legacyContainer = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "legacy_fixture",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    legacy = createDatabase({
      databaseUrl: `postgresql://maildock:test@${legacyContainer.getHost()}:${legacyContainer.getMappedPort(5432)}/legacy_fixture`,
      databasePoolSize: 2,
    });
    for (const migration of readMigrationFiles({
      migrationsFolder: "db/migrations",
    }).slice(0, -1))
      await legacy.client.begin(async (tx) => {
        for (const statement of migration.sql) await tx.unsafe(statement);
      });
    await database.db.insert(mailAccounts).values(accountIds.map(account));
    await database.db.insert(mailboxes).values([box(0), box(1)]);
    await database.db.insert(messages).values([message(0), message(1)]);
  });
  afterAll(async () => {
    if (legacy && legacy !== database) await legacy.client.end();
    await database?.client.end();
    await container?.stop();
    await legacyContainer?.stop();
  });

  it("provisions native schema through all immutable historical migrations under ordinary authority", async () => {
    await expect(
      assertNativeReleaseCompatible(database.client),
    ).resolves.toBeUndefined();
    await expect(
      validateDatabaseAuthority(database.client),
    ).resolves.toBeUndefined();
    await verifyNativeSchema(database.db);
    await expect(verifyRecoverySchema(database.db)).resolves.toBeUndefined();
  });
  it("rejects repeated Gmail identities per account but isolates identical IDs in different accounts", async () => {
    await expect(
      database.db.insert(messages).values({ ...message(0), id: randomUUID() }),
    ).rejects.toThrow();
    expect(
      (
        await database.db
          .select()
          .from(messages)
          .where(eq(messages.providerMessageId, "native-id"))
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual([...messageIds].sort());
    expect(
      (await database.db.select().from(messages))[0].providerHistoryId,
    ).toBe(hugeHistoryId);
  });
  it("enforces account and transport ownership for messages and Gmail labels", async () => {
    await expect(
      database.db.insert(messages).values({
        ...message(0),
        id: randomUUID(),
        receiveTransport: "imap",
        providerMessageId: null,
        providerThreadId: null,
        providerHistoryId: null,
      }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(mailboxes)
        .values({ ...box(0), id: randomUUID(), remotePath: "Renamed" }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(mailboxes).values({
        ...box(0),
        id: randomUUID(),
        providerMailboxId: "",
        remotePath: "Empty",
      }),
    ).rejects.toThrow();
  });
  it("stores multiple label memberships without fake UIDs and rejects duplicate or foreign membership", async () => {
    const membership = {
      id: randomUUID(),
      accountId: accountIds[0],
      receiveTransport: "gmail" as const,
      mailboxId: mailboxIds[0],
      messageId: messageIds[0],
      firstSynchronizedAt: new Date(),
      lastSynchronizedAt: new Date(),
    };
    await database.db.insert(mailboxMessages).values(membership);
    await expect(
      database.db
        .insert(mailboxMessages)
        .values({ ...membership, id: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(mailboxMessages)
        .values({ ...membership, id: randomUUID(), messageId: messageIds[1] }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(mailboxMessages)
        .values({ ...membership, id: randomUUID(), uid: 1n, uidValidity: 1n }),
    ).rejects.toThrow();
    const [stored] = await database.db.select().from(mailboxMessages);
    expect([stored.uid, stored.uidValidity, stored.modseq]).toEqual([
      null,
      null,
      null,
    ]);
  });
  it("fences command destinations, placements and account-level Gmail notifications", async () => {
    const command = {
      id: randomUUID(),
      accountId: accountIds[0],
      receiveTransport: "gmail" as const,
      mailboxId: mailboxIds[0],
      messageId: messageIds[0],
      action: "mark_read",
    };
    await database.db.insert(messageCommands).values(command);
    await expect(
      database.db.insert(messageCommands).values({
        ...command,
        id: randomUUID(),
        destinationMailboxId: mailboxIds[1],
      }),
    ).rejects.toThrow();
    const [placement] = await database.db
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.accountId, accountIds[0]));
    await expect(
      database.db.insert(messageCommands).values({
        ...command,
        id: randomUUID(),
        accountId: accountIds[1],
        mailboxId: mailboxIds[1],
        messageId: messageIds[1],
        placementId: placement.id,
      }),
    ).rejects.toThrow();
    const event = {
      sequence: 10001n,
      subject: "Synthetic",
      sender: "owner@test.invalid",
      accountId: accountIds[0],
      receiveTransport: "gmail" as const,
      mailboxId: mailboxIds[0],
      messageId: messageIds[0],
    };
    await database.db.insert(notificationEvents).values(event);
    await expect(
      database.db
        .insert(notificationEvents)
        .values({ ...event, sequence: 10002n }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(notificationEvents)
        .values({ ...event, sequence: 10003n, messageId: messageIds[1] }),
    ).rejects.toThrow();
  });
  it("rejects invalid credentials and transport-specific NULL or numeric identities", async () => {
    await expect(
      database.db.insert(mailAccounts).values({
        ...account(randomUUID()),
        authMethod: "password",
        imapPassword: account(accountIds[0]).oauthCache,
      }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(mailAccounts).values({
        ...account(randomUUID()),
        providerType: "imap_smtp",
        imapHost: "imap.gmail.com",
        imapPort: 993,
        imapSecurity: "tls",
        imapUsername: "owner",
      }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(messages)
        .values({ ...message(0), id: randomUUID(), providerMessageId: null }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(messages).values({
        ...message(0),
        id: randomUUID(),
        providerMessageId: "other",
        providerHistoryId: "1e20",
      }),
    ).rejects.toThrow();
  });
  it("accepts empty Gmail root part IDs and rejects cross-account attachment ownership", async () => {
    const attachment = {
      id: randomUUID(),
      accountId: accountIds[0],
      receiveTransport: "gmail" as const,
      messageId: messageIds[0],
      partId: "",
      contentType: "text/plain",
      inline: true,
      visible: false,
    };
    await database.db.insert(messageAttachments).values(attachment);
    await expect(
      database.db.insert(messageAttachments).values({
        ...attachment,
        id: randomUUID(),
        accountId: accountIds[1],
        partId: "1",
      }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(messageAttachments).values({
        ...attachment,
        id: randomUUID(),
        partId: "2",
        sourceUid: 1n,
        sourceUidValidity: 1n,
      }),
    ).rejects.toThrow();
  });
  it("excludes Google from IMAP polling, backfill and IDLE even when mailbox sync fields look eligible", async () => {
    await database.db
      .update(mailboxes)
      .set({ recentSyncStatus: "success" })
      .where(eq(mailboxes.receiveTransport, "gmail"));
    const send = vi.fn();
    const jobs = { send } as unknown as PgBoss;
    const delta = new DeltaPoller(database.db, jobs, 60);
    const backfill = new BackfillPoller(database.db, jobs);
    const accounts = new AccountsService(
      database.db,
      encryption,
      new ImapSmtpMailProvider(),
    );
    const client = vi.fn();
    const watchers = new IdleWatcherManager(
      database.db,
      accounts,
      jobs,
      pino({ level: "silent" }),
      client,
    );
    try {
      await delta.start();
      await backfill.start();
      await watchers.start();
    } finally {
      delta.stop();
      backfill.stop();
      await watchers.stop();
    }
    expect(send).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    await expect(
      accounts.getProviderImapAccountForWork(accountIds[0]),
    ).rejects.toThrow("Native Gmail receiving");
  });
  it("captures disable/reconnect revisions and rejects stale publication", async () => {
    const accounts = new AccountsService(
      database.db,
      encryption,
      new ImapSmtpMailProvider(),
    );
    await accounts.setEnabled(accountIds[0], false);
    await expect(
      accounts.receiveWorkIdentity(accountIds[0], "1"),
    ).rejects.toThrow("stale");
    await accounts.setEnabled(accountIds[0], true);
    const work = await accounts.receiveWorkIdentity(accountIds[0]);
    expect(work.revision).toBe("3");
    await expect(
      accounts.receiveWorkIdentity(accountIds[0], "1"),
    ).rejects.toThrow("stale");
    await expect(
      database.db.transaction((tx) =>
        assertImapPublication(tx, accountIds[0], "3"),
      ),
    ).rejects.toThrow("Native Gmail");
  });
  it("bounds durable page intake and atomically advances the matching inventory cursor", async () => {
    const id = accountIds[1],
      runId = randomUUID();
    await database.db.insert(gmailAccountSyncState).values({
      accountId: id,
      accountRevision: 1n,
      baselineHistoryId: hugeHistoryId,
      inventoryRunId: runId,
      inventoryPhase: "recent",
      recentCutoff: new Date(),
    });
    const repo = new GmailSyncRepository(database.db);
    const page = {
      accountId: id,
      revision: 1n,
      runId,
      purpose: "inventory" as const,
      messageIds: ["a", "b", "a"],
      expectedPageToken: null,
      nextPageToken: "page2",
    };
    await repo.stagePage(page);
    expect(
      await database.db
        .select()
        .from(gmailSyncWork)
        .where(eq(gmailSyncWork.accountId, id)),
    ).toHaveLength(2);
    await expect(
      repo.stagePage({
        ...page,
        expectedPageToken: "page2",
        nextPageToken: null,
      }),
    ).rejects.toThrow("Drain");
    await expect(
      repo.stagePage({ ...page, messageIds: Array(501).fill("x") }),
    ).rejects.toThrow("oversized");
    await database.db
      .update(gmailSyncWork)
      .set({ status: "complete" })
      .where(eq(gmailSyncWork.accountId, id));
    await repo.stagePage({
      ...page,
      expectedPageToken: "page2",
      messageIds: ["c"],
      nextPageToken: null,
    });
    const [state] = await database.db
      .select()
      .from(gmailAccountSyncState)
      .where(eq(gmailAccountSyncState.accountId, id));
    expect(state.inventoryPagesComplete).toBe(true);
    expect(
      await database.db
        .select()
        .from(gmailSyncWork)
        .where(eq(gmailSyncWork.accountId, id)),
    ).toHaveLength(1);
  });
  it("refuses populated legacy state before any incompatible DDL and leaves rows intact", async () => {
    await expect(
      assertNativeReleaseCompatible(legacy.client),
    ).resolves.toBeUndefined();
    const legacyId = randomUUID();
    await legacy.client`insert into mail_accounts(id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) values(${legacyId},'Legacy','owner@test.invalid','imap.test',993,'tls','owner','{}','smtp.test',465,'tls')`;
    await expect(assertNativeReleaseCompatible(legacy.client)).rejects.toThrow(
      "populated legacy",
    );
    const currentMigration = readMigrationFiles({
      migrationsFolder: "db/migrations",
    }).at(-1)!;
    await expect(
      legacy.client.begin(async (tx) => {
        for (const statement of currentMigration.sql)
          await tx.unsafe(statement);
      }),
    ).rejects.toThrow("fresh database");
    expect(
      (
        await legacy.client`select id from mail_accounts where id=${legacyId}`
      )[0].id,
    ).toBe(legacyId);
    expect(
      (
        await legacy.client`select to_regclass('public.gmail_account_sync_state') as native`
      )[0].native,
    ).toBeNull();
  });
  it("refuses altered boolean grouping in native locator checks during restore", async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`alter table public.mailbox_messages drop constraint mailbox_messages_locator`,
        );
        // Same predicate tokens, changed AND/OR grouping. Gmail fixtures still
        // satisfy it, but this would incorrectly reject otherwise-valid IMAP rows.
        await tx.execute(sql`alter table public.mailbox_messages add constraint mailbox_messages_locator check (
        ((receive_transport = 'imap' and uid is not null and uid > 0 and uid_validity is not null and uid_validity > 0 and (modseq is null or modseq > 0)) or receive_transport = 'gmail')
        and uid is null and uid_validity is null and modseq is null)`);
        await expect(verifyNativeSchema(tx)).rejects.toThrow(
          "Native schema constraint refused: mailbox_messages_locator",
        );
        throw new Error("rollback synthetic tampering");
      }),
    ).rejects.toThrow("rollback synthetic tampering");
    await verifyNativeSchema(database.db);
  });
  it("detects removed native identity indexes during restore verification", async () => {
    await database.client`drop index messages_gmail_identity_unique`;
    try {
      await expect(verifyRecoverySchema(database.db)).rejects.toThrow(
        "Offline recovery refused",
      );
    } finally {
      await database.client`create unique index messages_gmail_identity_unique on messages(account_id,provider_message_id) where receive_transport='gmail'`;
    }
  });
});
