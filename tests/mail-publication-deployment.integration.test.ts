import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  copyFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
  gmailAccountSyncState,
} from "@/shared/infrastructure/database/schema";
import { MailPublicationService } from "@/modules/mail/application/mail-publication-service";
import { MessageService } from "@/modules/mail/application/message-service";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { GmailProvider } from "@/modules/mail/infrastructure/gmail-provider";
import { GmailSyncService } from "@/modules/mail/application/gmail-sync-service";
import { createGmailAccountLock } from "@/modules/mail/infrastructure/gmail-account-lock";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { SyntheticGmail } from "./helpers/gmail-fixture";

// Always owns a new container. Deliberately ignores DATABASE_URL/TEST_DATABASE_URL.
describe("0042 deployment on an existing PostgreSQL installation", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let previousMigrations: string;
  const measurements: Record<string, unknown> = {};
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 7).toString("base64"),
  });
  const id = randomUUID(),
    inbox = randomUUID(),
    archive = randomUUID();
  let databaseUrl: string;
  const remote = (uid: number, seen = false) => ({
    uid: String(uid),
    internalDate: "2026-10-11T08:00:00Z",
    size: "10",
    flags: seen ? ["\\Seen"] : [],
    envelope: {
      subject: `Deployment ${uid}`,
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
    },
    hasAttachments: false,
  });
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  const snapshot = () =>
    new MailPublicationService(database.db).snapshot({
      accountId: id,
      mailboxId: inbox,
      pageSize: 50,
    });
  async function revision() {
    const rows =
      await database.client`select revision::text from mail_publications where account_id=${id}`;
    return rows[0]?.revision;
  }
  async function fingerprint() {
    const result: Record<string, unknown> = {};
    // Full rows include all IMAP/Gmail checkpoints, encryption envelopes and flags.
    for (const table of [
      "mail_accounts",
      "mailboxes",
      "messages",
      "mailbox_messages",
      "gmail_account_sync_state",
      "conversation_members",
      "message_contents",
    ]) {
      result[table] = await database.client.unsafe(
        `select count(*)::int as rows, md5(coalesce(string_agg(row_to_json(t)::text, '' order by row_to_json(t)::text), '')) as digest from ${table} t`,
      );
    }
    return result;
  }
  async function benchmark() {
    const service = new MessageService(database.db);
    const results: Record<string, number[]> = {
      ingestion150Ms: [],
      replay150Ms: [],
      flags150Ms: [],
    };
    // Seven samples, disjoint arrivals and equal-sized replay/flag work in both schemas.
    for (let round = 0; round < 7; round++) {
      const startUid = 10000 + round * 150;
      const batch = Array.from({ length: 150 }, (_, n) => remote(startUid + n));
      let start = performance.now();
      await service.persistBatch(id, inbox, 1n, batch);
      results.ingestion150Ms.push(performance.now() - start);
      start = performance.now();
      await service.persistBatch(id, inbox, 1n, batch);
      results.replay150Ms.push(performance.now() - start);
      start = performance.now();
      await database.client`update mailbox_messages set flags = case when cardinality(flags)=0 then array['\\Seen']::text[] else array[]::text[] end where mailbox_id=${inbox} and uid between ${startUid} and ${startUid + 149}`;
      results.flags150Ms.push(performance.now() - start);
    }
    return results;
  }
  async function revisionExists() {
    const [row] =
      await database.client`select to_regclass('public.mail_publications') is not null as present`;
    return row.present as boolean;
  }
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
    databaseUrl = `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/maildock`;
    database = createDatabase({
      databaseUrl,
      databasePoolSize: 20,
    });
    previousMigrations = await mkdtemp(join(tmpdir(), "maildock-0042-"));
    await mkdir(join(previousMigrations, "meta"));
    const journal = JSON.parse(
      await readFile("db/migrations/meta/_journal.json", "utf8"),
    );
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 42,
    );
    for (const entry of journal.entries)
      await copyFile(
        `db/migrations/${entry.tag}.sql`,
        join(previousMigrations, `${entry.tag}.sql`),
      );
    await writeFile(
      join(previousMigrations, "meta/_journal.json"),
      JSON.stringify(journal),
    );
    await migrate(database.db, { migrationsFolder: previousMigrations });
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Existing IMAP",
      email: "owner@example.test",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      imapPassword: encryption.encrypt("fixture", "fixture"),
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpSecurity: "tls",
      imapCapabilities: ["MOVE"],
    });
    await database.db.insert(mailboxes).values(
      [inbox, archive].map((box, i) => ({
        id: box,
        accountId: id,
        remotePath: i ? "Archive" : "INBOX",
        name: i ? "Archive" : "Inbox",
        selectable: true,
        uidValidity: 1n,
        recentSyncUidValidity: 1n,
        recentSyncStatus: "success",
        backfillStatus: "pending",
        backfillUidValidity: 1n,
        backfillFrontierUid: 900n,
        deltaUidValidity: 1n,
        deltaLastSeenUid: 1000n,
        deltaHighestModseq: 500n,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      })),
    );
    await new MessageService(database.db).persistBatch(
      id,
      inbox,
      1n,
      Array.from({ length: 50 }, (_, i) => remote(i + 1)),
    );
    const existingGmail = randomUUID(),
      gmailBox = randomUUID(),
      gmailMessage = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: existingGmail,
      displayName: "Existing Gmail",
      email: "existing@example.test",
      providerType: "gmail_smtp",
      authMethod: "oauth2",
      oauthProviderId: "google",
      oauthHomeAccountId: existingGmail,
      oauthStatus: "connected",
      oauthCache: encryption.encrypt("fixture", "fixture"),
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      smtpUsesImapCredentials: false,
      smtpUsername: "existing@example.test",
    });
    await database.db.insert(gmailAccountSyncState).values({
      accountId: existingGmail,
      accountRevision: 1n,
      status: "ready",
      inventoryComplete: true,
      recentReady: true,
      historyId: "789",
      processedCount: 1n,
    });
    await database.db.insert(mailboxes).values({
      id: gmailBox,
      accountId: existingGmail,
      receiveTransport: "gmail",
      remotePath: "Label_existing",
      providerMailboxId: "Label_existing",
      name: "Existing label",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await database.client`insert into messages(id,account_id,receive_transport,provider_message_id,provider_thread_id,provider_history_id,internal_date,size) values(${gmailMessage},${existingGmail},'gmail','existing-message','existing-thread','789',now(),10)`;
    await database.db.insert(mailboxMessages).values({
      id: randomUUID(),
      accountId: existingGmail,
      receiveTransport: "gmail",
      mailboxId: gmailBox,
      messageId: gmailMessage,
      firstSynchronizedAt: new Date(),
      lastSynchronizedAt: new Date(),
    });
    await database.client`insert into message_contents(message_id,status,plain_text,search_text,fetched_at) values(${gmailMessage},'ready','Existing local body','Existing local body',now())`;
    measurements.postgres = (
      await database.client`select version() as version`
    )[0].version;
  });
  afterAll(async () => {
    if (process.env.MAILDOCK_DEPLOYMENT_REVIEW_OUTPUT)
      await writeFile(
        process.env.MAILDOCK_DEPLOYMENT_REVIEW_OUTPUT,
        JSON.stringify(measurements, null, 2) + "\n",
      );
    console.log("PHASE4_DEPLOYMENT", JSON.stringify(measurements));
    await database?.client.end();
    await container?.stop();
    if (previousMigrations)
      await rm(previousMigrations, { recursive: true, force: true });
  });
  it("preserves existing materialization/checkpoints through the journaled migration and measures writes", async () => {
    expect(await revisionExists()).toBe(false);
    measurements.before = await benchmark();
    // Restore the same starting cardinality for the post-migration benchmark.
    await database.client`delete from messages where id in (select message_id from mailbox_messages where mailbox_id=${inbox} and uid >= 10000)`;
    const before = await fingerprint();
    const count = (
      await database.client`select count(*)::int as n from drizzle.__drizzle_migrations`
    )[0].n;
    const writerReady = gate(),
      writerHold = gate();
    let writerPid = 0;
    const existingWriter = database.client.begin(async (tx) => {
      writerPid = (await tx`select pg_backend_pid() as pid`)[0].pid;
      await tx`update mailbox_messages set flags=flags where mailbox_id=${inbox} and uid=1`;
      writerReady.release();
      await writerHold.promise;
    });
    await Promise.race([writerReady.promise, existingWriter]);
    const start = performance.now();
    const migrationProcess = promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/shared/infrastructure/database/migrate.ts"],
      {
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          MAILDOCK_ENV: "test",
          DATABASE_URL: databaseUrl,
          AUTH_SECRET: "deployment-fixture-secret-".repeat(3),
          CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
          APP_ORIGIN: "http://localhost:3000",
          ATTACHMENTS_PATH: previousMigrations,
        },
        timeout: 30000,
      },
    );
    try {
      let waiting: readonly unknown[] = [];
      for (let n = 0; n < 500; n++) {
        waiting =
          await database.client`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where ${writerPid}=any(pg_blocking_pids(pid))`;
        if (waiting.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toHaveLength(1);
      expect((waiting[0] as { wait_event: string }).wait_event).toBe(
        "relation",
      );
      measurements.migrationWait = waiting;
    } finally {
      writerHold.release();
    }
    const migration = await migrationProcess;
    await existingWriter;
    measurements.migrationOutput = migration.stdout.trim();
    measurements.migrationMs = performance.now() - start;
    expect(await fingerprint()).toEqual(before);
    measurements.preserved = before;
    expect(
      (
        await database.client`select count(*)::int as n from drizzle.__drizzle_migrations`
      )[0].n,
    ).toBe(count + 1);
    expect(await revision()).toBeUndefined(); // Existing accounts use coalesce(revision,0).
    const [triggers] =
      await database.client`select count(*)::int as n from pg_trigger where tgname='mail_publication' and not tgisinternal and tgdeferrable and tginitdeferred`;
    expect(triggers.n).toBe(8);
    expect((await snapshot()).publication!.allInboxesUnread).toBe("50");
    measurements.after = await benchmark();
    const stable = await revision();
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    expect(await revision()).toBe(stable);
    await database.client`update mailbox_messages set flags=flags where account_id=${id}`;
    expect(await revision()).toBe(stable);
    // Inspect per-transaction stats before rollback: many changed rows update
    // the publication tuple once, and even that tuple update is rolled back.
    await expect(
      database.client.begin(async (tx) => {
        const [beforeStats] =
          await tx`select n_tup_upd::int as updates from pg_stat_xact_user_tables where relname='mail_publications'`;
        await tx`update mailbox_messages set flags=array['\\Flagged']::text[] where account_id=${id}`;
        await tx`set constraints mail_publication immediate`;
        const [stats] =
          await tx`select n_tup_upd::int as updates from pg_stat_xact_user_tables where relname='mail_publications'`;
        measurements.publicationTupleUpdatesPerBatch =
          stats.updates - beforeStats.updates;
        expect(stats.updates - beforeStats.updates).toBe(1);
        throw Error("rollback coalescing probe");
      }),
    ).rejects.toThrow("rollback coalescing probe");
    expect(await revision()).toBe(stable);
    expect(
      (
        await database.client`select count(*)::int as n from drizzle.__drizzle_migrations`
      )[0].n,
    ).toBe(count + 1);
  });
  it("serializes same-account commits, without snapshots blocking them, and preserves rollback/retry revisions", async () => {
    const hold = gate(),
      ready = gate();
    const old = await revision();
    let pid = 0;
    const owner = database.client.begin(async (tx) => {
      pid = (await tx`select pg_backend_pid() as pid`)[0].pid;
      await tx`update mailbox_messages set flags=array['\\Flagged']::text[] where mailbox_id=${inbox} and uid=1`;
      // Force the deferred event now to inspect the lock normally held at commit.
      await tx`set constraints mail_publication immediate`;
      ready.release();
      await hold.promise;
    });
    await Promise.race([ready.promise, owner]);
    const start = performance.now();
    const contender = database.client.begin(async (tx) => {
      await tx`update mailbox_messages set flags=array['\\Seen']::text[] where mailbox_id=${inbox} and uid=2`;
    });
    let blockers: readonly unknown[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        blockers =
          await database.client`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
        if (blockers.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockers).toHaveLength(1);
      expect((blockers[0] as { wait_event_type: string }).wait_event_type).toBe(
        "Lock",
      );
      const readStart = performance.now();
      await Promise.all(Array.from({ length: 8 }, snapshot));
      measurements.snapshotDuringPublicationLockMs =
        performance.now() - readStart;
      expect(await revision()).toBe(old);
    } finally {
      hold.release();
    }
    await Promise.all([owner, contender]);
    measurements.publicationLock = blockers;
    measurements.contendedCommitMs = performance.now() - start;
    expect(await revision()).not.toBe(old);
    const committed = await revision();
    await expect(
      database.client.begin(async (tx) => {
        await tx`update mailbox_messages set flags=array[]::text[] where mailbox_id=${inbox} and uid=2`;
        await tx`set constraints mail_publication immediate`;
        throw Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");
    expect(await revision()).toBe(committed);
    await database.client.begin(async (tx) => {
      const [xid] = await tx`select pg_current_xact_id()::text as xid`;
      await tx`update mailbox_messages set flags=array[]::text[] where mailbox_id=${inbox} and uid=2`;
      await tx`set constraints mail_publication immediate`;
      expect(
        (
          await tx`select revision::text from mail_publications where account_id=${id}`
        )[0].revision,
      ).toBe(xid.xid);
    });
    expect(await revision()).not.toBe(committed);
  });
  it("does not lock publication during a long batch; older transactions may publish after newer ones", async () => {
    const hold = gate(),
      ready = gate(),
      batchDone = gate();
    let older = "";
    const worker = database.db.transaction(async (tx) => {
      older = (
        await tx.execute(sql`select pg_current_xact_id()::text as xid`)
      )[0].xid as string;
      await tx.execute(
        sql`update mailbox_messages set flags=array['\\Flagged']::text[] where mailbox_id=${inbox} and uid between 3 and 12`,
      );
      ready.release();
      const start = performance.now();
      await new MessageService(
        tx as unknown as typeof database.db,
      ).persistBatch(
        id,
        inbox,
        1n,
        Array.from({ length: 1000 }, (_, n) => remote(40000 + n)),
      );
      measurements.longBatch = {
        messages: 1000,
        projectionMs: performance.now() - start,
      };
      batchDone.release();
      await hold.promise;
    });
    await Promise.race([ready.promise, worker]);
    let newer = "";
    try {
      await database.client.begin(async (tx) => {
        newer = (await tx`select pg_current_xact_id()::text as xid`)[0].xid;
        await tx`update mailbox_messages set flags=array['\\Seen']::text[] where mailbox_id=${inbox} and uid=13`;
      });
      expect(await revision()).toBe(newer);
      await Promise.race([batchDone.promise, worker]);
      expect(await revision()).toBe(newer);
      const before = await snapshot();
      const start = performance.now();
      // A genuinely open repeatable-read snapshot must not delay the worker commit.
      const readerReady = gate(),
        readerHold = gate();
      const reader = database.client.begin(
        "isolation level repeatable read read only",
        async (tx) => {
          await tx`select revision from mail_publications where account_id=${id}`;
          await tx`select count(*) from mailbox_messages where account_id=${id}`;
          readerReady.release();
          await readerHold.promise;
          expect(
            (
              await tx`select revision::text from mail_publications where account_id=${id}`
            )[0].revision,
          ).toBe(newer);
        },
      );
      await readerReady.promise;
      const commitStart = performance.now();
      hold.release();
      try {
        await worker;
        measurements.workerCommitWithOpenSnapshotMs =
          performance.now() - commitStart;
      } finally {
        readerHold.release();
      }
      await reader;
      measurements.commitWithOpenSnapshotMs = performance.now() - start;
      expect(BigInt(older)).toBeLessThan(BigInt(newer));
      expect(await revision()).toBe(older);
      expect((await snapshot()).publication!.revision).not.toBe(
        before.publication!.revision,
      );
    } finally {
      hold.release();
      await worker;
    }
  });
  it("runs competing same-account writes/moves/deletes/local commands and coherent snapshots", async () => {
    await new MessageService(database.db).persistBatch(
      id,
      inbox,
      1n,
      Array.from({ length: 40 }, (_, n) => remote(30000 + n)),
    );
    let running = true,
      reads = 0;
    const readTimes: number[] = [];
    const reader = (async () => {
      while (running) {
        const start = performance.now();
        const page = await snapshot();
        readTimes.push(performance.now() - start);
        const count = page.publication!.boxes[id].find(
          (box) => box.id === inbox,
        )!.unseenCount;
        expect(page.publication!.allInboxesUnread).toBe(count);
        if (page.items.length < 50)
          expect(Number(count)).toBe(
            page.items.filter((item) => !item.seen).length,
          );
        reads++;
      }
    })();
    const writeTimes: number[] = [];
    try {
      await Promise.all(
        Array.from({ length: 12 }, async (_, lane) => {
          for (let round = 0; round < 15; round++) {
            const start = performance.now();
            await database.client.begin(async (tx) => {
              await tx`update mailbox_messages set flags=${round % 2 ? [] : ["\\Seen"]}::text[] where mailbox_id=${inbox} and uid=${30000 + lane}`;
              const [xid] = await tx`select pg_current_xact_id()::text as xid`;
              await tx`set constraints mail_publication immediate`;
              expect(
                (
                  await tx`select revision::text from mail_publications where account_id=${id}`
                )[0].revision,
              ).toBe(xid.xid);
            });
            writeTimes.push(performance.now() - start);
          }
        }),
      );
      await Promise.all([
        new MessageService(database.db).persistBatch(
          id,
          inbox,
          1n,
          Array.from({ length: 150 }, (_, n) => remote(31000 + n)),
        ),
        database.client`update mailbox_messages set mailbox_id=${archive} where mailbox_id=${inbox} and uid between 30012 and 30019`,
        database.client`delete from mailbox_messages where mailbox_id=${inbox} and uid between 30020 and 30027`,
        (async () => {
          const [placement] = await database.db
            .select()
            .from(mailboxMessages)
            .where(
              sql`${mailboxMessages.mailboxId}=${inbox} and ${mailboxMessages.uid}=30028`,
            );
          await new MessageCommandService(
            database.db,
            async () => {},
            async () => {},
          ).create(id, inbox, placement.messageId, "mark_read");
        })(),
        (async () => {
          const [placement] = await database.db
            .select()
            .from(mailboxMessages)
            .where(
              sql`${mailboxMessages.mailboxId}=${inbox} and ${mailboxMessages.uid}=30029`,
            );
          await database.db
            .update(mailboxMessages)
            .set({ flags: ["\\Seen"] })
            .where(eq(mailboxMessages.id, placement.id));
          await new MessageCommandService(
            database.db,
            async () => {},
            async () => {},
          ).create(id, inbox, placement.messageId, "mark_unread");
        })(),
      ]);
    } finally {
      running = false;
      await reader;
    }
    measurements.concurrent = {
      writers: 12,
      commits: writeTimes.length,
      snapshots: reads,
      writeTimesMs: writeTimes,
      snapshotTimesMs: readTimes,
    };
    expect(writeTimes).toHaveLength(180);
    expect(reads).toBeGreaterThan(0);
    const [stats] =
      await database.client`select deadlocks from pg_stat_database where datname=current_database()`;
    measurements.deadlocks = stats.deadlocks;
    expect(Number(stats.deadlocks)).toBe(0);
  });
  it("runs the real Gmail projection with synthetic HTTP concurrently with IMAP writes and snapshots", async () => {
    const gmailId = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: gmailId,
      displayName: "Existing Gmail",
      email: "gmail@example.test",
      providerType: "gmail_smtp",
      authMethod: "oauth2",
      oauthProviderId: "google",
      oauthHomeAccountId: gmailId,
      oauthStatus: "connected",
      oauthCache: encryption.encrypt("fixture", "fixture"),
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      smtpUsesImapCredentials: false,
      smtpUsername: "gmail@example.test",
    });
    const fixture = new SyntheticGmail();
    for (let n = 0; n < 25; n++) fixture.fixture(`gmail-${n}`);
    const accounts = {
      getProviderGmailAccountForWork: async () => ({
        accountId: gmailId,
        revision: "1",
        accessToken: "synthetic",
      }),
    } as unknown as AccountsService;
    const sync = new GmailSyncService(
      database.db,
      new GmailProvider(database.db, accounts, fixture.fetch),
      createGmailAccountLock(database.client),
      30,
    );
    const finish = async () => {
      await database.db
        .update(gmailAccountSyncState)
        .set({ nextAttemptAt: null, needsWork: true })
        .where(eq(gmailAccountSyncState.accountId, gmailId));
      for (let n = 0; n < 60; n++) {
        await sync.run(gmailId, "1");
        const [state] = await database.db
          .select()
          .from(gmailAccountSyncState)
          .where(eq(gmailAccountSyncState.accountId, gmailId));
        if (state.inventoryComplete && !state.historyRunId) return;
      }
      throw Error("Synthetic Gmail did not finish");
    };
    const gmailPage = async () => {
      const [box] =
        await database.client`select id from mailboxes where account_id=${gmailId} and remote_path='INBOX'`;
      return new MailPublicationService(database.db).snapshot({
        accountId: gmailId,
        mailboxId: box?.id,
        pageSize: 50,
      });
    };
    for (const labels of [
      null,
      ["INBOX"],
      ["INBOX", "UNREAD"],
      ["UNREAD", "Label_one"],
    ]) {
      if (labels)
        for (let n = 0; n < 25; n++) fixture.change(`gmail-${n}`, labels);
      await Promise.all([
        finish(),
        new MessageService(database.db).persistBatch(id, inbox, 1n, [
          remote(32000, Boolean(labels)),
        ]),
        ...Array.from({ length: 4 }, gmailPage),
      ]);
      const page = await gmailPage();
      expect(
        page.publication!.boxes[gmailId].find(
          (box) => box.remotePath === "INBOX",
        )!.unseenCount,
      ).toBe(
        labels && !labels.includes("UNREAD")
          ? "0"
          : labels && !labels.includes("INBOX")
            ? "0"
            : "25",
      );
    }
    for (let n = 0; n < 25; n++) {
      fixture.messages.delete(`gmail-${n}`);
      fixture.change(`gmail-${n}`);
    }
    await Promise.all([finish(), ...Array.from({ length: 4 }, gmailPage)]);
    expect((await gmailPage()).items).toHaveLength(0);
    expect(
      (await gmailPage()).publication!.boxes[gmailId].find(
        (box) => box.remotePath === "INBOX",
      )!.unseenCount,
    ).toBe("0");
  });
});
