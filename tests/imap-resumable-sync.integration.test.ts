import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
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
import { eq } from "drizzle-orm";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { StaleAccountWorkError } from "@/modules/accounts/domain/receive-transport";
import { ImapSliceSyncService } from "@/modules/mail/application/imap-slice-sync-service";
import { MessageService } from "@/modules/mail/application/message-service";
import { DeltaSyncService } from "@/modules/mail/application/delta-sync-service";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailboxes,
  mailAccounts,
  mailboxMessages,
} from "@/shared/infrastructure/database/schema";
import { createMailboxLock } from "@/modules/mail/infrastructure/mailbox-lock";
import { installSyncAdmission } from "@/modules/mail/infrastructure/sync-admission";
import {
  enqueueRecent,
  ensureRecentQueue,
  MAILBOX_RECENT_SYNC_QUEUE as recent,
  registerRecentSyncWorker,
} from "@/modules/mail/infrastructure/recent-sync-jobs";
import {
  enqueueDelta,
  ensureDeltaQueue,
  DeltaPoller,
  MAILBOX_DELTA_SYNC_QUEUE as delta,
  registerDeltaWorker,
} from "@/modules/mail/infrastructure/delta-sync-jobs";
import { enqueueImapContinuation } from "@/modules/mail/infrastructure/imap-slice-continuation";
import { sliceServer } from "./fixtures/imap-slice-server";

describe("durable IMAP slices and Phase 2 admission", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  let restore: () => void;
  let server: ReturnType<typeof sliceServer>;
  let messages: MessageService;
  let service: ImapSliceSyncService;
  let accounts: AccountsService;
  let accountId: string, mailboxId: string;
  let recentRequests: string[];
  const diagnostics = { debug: vi.fn() };
  const limits = { uidSpan: 3, batchSize: 2, timeoutMs: 60000 };
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "slices",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const databaseUrl = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/slices`;
    database = createDatabase({ databaseUrl, databasePoolSize: 5 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    await ensureRecentQueue(boss);
    await ensureDeltaQueue(boss);
    restore = installSyncAdmission(boss, 2);
  });
  afterAll(async () => {
    restore?.();
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  async function seed(path = "Archive", owner?: string) {
    const a = owner ?? randomUUID(),
      m = randomUUID();
    if (!owner)
      await database.client`insert into mail_accounts(id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) values(${a},'Slices','fake@test.invalid','fake.invalid',993,'tls','fake','{}'::jsonb,'fake.invalid',465,'tls')`;
    await database.client`insert into mailboxes(id,account_id,remote_path,name,selectable,first_discovered_at,last_discovered_at) values(${m},${a},${path},${path},true,now(),now())`;
    return { accountId: a, mailboxId: m };
  }
  const row = async () =>
    (
      await database.db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
    )[0];
  const uids = async () =>
    (
      await database.db
        .select({ uid: mailboxMessages.uid })
        .from(mailboxMessages)
        .where(eq(mailboxMessages.mailboxId, mailboxId))
        .orderBy(mailboxMessages.uid)
    ).map((item) => item.uid!.toString());
  const makeService = () =>
    new ImapSliceSyncService(
      database.db,
      accounts,
      server.provider,
      messages,
      limits,
      30,
      diagnostics,
    );
  beforeEach(async () => {
    vi.restoreAllMocks();
    diagnostics.debug.mockClear();
    await boss.deleteAllJobs(recent);
    await boss.deleteAllJobs(delta);
    await database.client`delete from mail_accounts`;
    await database.client`update sync_admission_policy set p0_admissions=0,last_lower_class=2`;
    ({ accountId, mailboxId } = await seed());
    server = sliceServer();
    recentRequests = [];
    accounts = {
      getProviderImapAccountForWork: async (id: string, revision?: string) => {
        const [a] = await database.db
          .select()
          .from(mailAccounts)
          .where(eq(mailAccounts.id, id));
        if (!a?.enabled || (revision && revision !== a.workRevision.toString()))
          throw new StaleAccountWorkError();
        return {
          accountId: id,
          revision: a.workRevision.toString(),
          imap: {
            host: "fake.invalid",
            port: 993,
            security: "tls",
            username: "fake",
            credential: { kind: "password", password: "fake" },
          },
        };
      },
    } as AccountsService;
    messages = new MessageService(
      database.db,
      accounts,
      server.provider,
      undefined,
      {
        schedule: async (_a, m) => {
          recentRequests.push(m);
          return true;
        },
      },
    );
    service = makeService();
    for (let uid = 1; uid <= 7; uid++) server.add(uid);
  });
  async function recentComplete() {
    while (await service.run(accountId, mailboxId, "recent", "1")) {
      /* drain */
    }
  }
  async function deltaComplete() {
    while (await service.run(accountId, mailboxId, "delta", "1")) {
      /* drain */
    }
  }

  it("persists recent progress and resumes with a new service after a crash before enqueue", async () => {
    expect(await service.run(accountId, mailboxId, "recent", "1")).toBe(true);
    expect((await row()).imapRecentProgress).toMatchObject({
      cursor: "3",
      frontier: "7",
      phase: "messages",
    });
    const cutoff = (await row()).imapRecentProgress!.cutoff;
    service = makeService();
    await recentComplete();
    expect(await uids()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect((await row()).recentSyncStatus).toBe("success");
    expect((await row()).recentSyncMessageCount).toBe(7);
    expect((await row()).recentSyncCutoff?.toISOString()).toBe(cutoff);
    expect((await row()).imapRecentProgress).toBeNull();
    expect((await row()).backfillStatus).toBe("pending");
    expect(server.state.searches.map((query) => query.uid)).toEqual([
      "1:3",
      "4:6",
      "7:7",
    ]);
  });
  it("replays committed messages after lost acknowledgement without duplicates or skipped UID", async () => {
    const persist = messages.persistBatch.bind(messages);
    vi.spyOn(messages, "persistBatch").mockImplementationOnce(
      async (...args) => {
        await persist(...args);
        throw new Error("lost commit acknowledgement");
      },
    );
    await expect(
      service.run(accountId, mailboxId, "recent", "1"),
    ).rejects.toThrow();
    expect(await uids()).toEqual(["1", "2"]);
    expect((await row()).imapRecentProgress?.cursor).toBe("0");
    await recentComplete();
    expect(await uids()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(
      server.state.clients.every(
        (client) => vi.mocked(client.close).mock.calls.length >= 1,
      ),
    ).toBe(true);
  });
  it("rolls back a failed durable checkpoint after successfully persisted message batches", async () => {
    await database.client`create function fail_slice_checkpoint() returns trigger language plpgsql as $$ begin if new.imap_recent_progress->>'cursor'='3' then raise exception 'injected checkpoint failure'; end if; return new; end $$`;
    await database.client`create trigger fail_checkpoint before update on mailboxes for each row execute function fail_slice_checkpoint()`;
    try {
      await expect(
        service.run(accountId, mailboxId, "recent", "1"),
      ).rejects.toThrow();
      expect((await row()).imapRecentProgress?.cursor).toBe("0");
      expect(await uids()).toEqual(["1", "2", "3"]);
    } finally {
      await database.client`drop trigger fail_checkpoint on mailboxes`;
      await database.client`drop function fail_slice_checkpoint()`;
    }
    await recentComplete();
    expect((await row()).recentSyncMessageCount).toBe(7);
  });
  it("discards partial recent state and old placements on UIDVALIDITY reset", async () => {
    await service.run(accountId, mailboxId, "recent", "1");
    server.state.epoch = 11n;
    server.state.remote.clear();
    server.add(6);
    await service.run(accountId, mailboxId, "recent", "1");
    expect(await uids()).toEqual([]);
    expect((await row()).imapRecentProgress?.uidValidity).toBe("11");
    expect((await row()).uidValidityChangeCount).toBe(1);
    await recentComplete();
    expect(await uids()).toEqual(["6"]);
  });
  it("keeps MODSEQ unchanged until the entire flag/presence cycle completes", async () => {
    await recentComplete();
    await database.db
      .update(mailboxes)
      .set({
        deltaUidValidity: 10n,
        deltaLastSeenUid: 7n,
        deltaHighestModseq: 5n,
      })
      .where(eq(mailboxes.id, mailboxId));
    await service.run(accountId, mailboxId, "delta", "1");
    expect((await row()).deltaHighestModseq).toBe(5n);
    server.add(1, ["\\Seen"], 20n);
    server.state.modseq = 20n;
    server.state.remote.delete(2);
    server.add(8);
    await deltaComplete();
    expect((await row()).deltaHighestModseq).toBe(10n);
    expect((await row()).deltaLastSeenUid).toBe(7n);
    expect(await uids()).not.toContain("2");
    expect(await uids()).not.toContain("8");
    const [first] = await database.db
      .select()
      .from(mailboxMessages)
      .where(eq(mailboxMessages.uid, 1n));
    expect(first.flags).toEqual(["\\Seen"]);
    await deltaComplete();
    expect(await uids()).toContain("8");
    expect((await row()).deltaHighestModseq).toBe(20n);
  });
  it("recovers delta epoch changes through recent synchronization", async () => {
    await recentComplete();
    await service.run(accountId, mailboxId, "delta", "1");
    server.state.epoch = 11n;
    expect(await service.run(accountId, mailboxId, "delta", "1")).toBe(false);
    expect(recentRequests).toEqual([mailboxId]);
    expect(await uids()).toEqual([]);
    expect((await row()).imapDeltaProgress).toBeNull();
    await recentComplete();
    expect((await row()).recentSyncUidValidity).toBe(11n);
  });
  it("fences stale account revisions and cancellation without advancing progress", async () => {
    await service.run(accountId, mailboxId, "recent", "1");
    const before = (await row()).imapRecentProgress;
    await database.db
      .update(mailAccounts)
      .set({ workRevision: 2n })
      .where(eq(mailAccounts.id, accountId));
    await expect(
      service.run(accountId, mailboxId, "recent", "1"),
    ).rejects.toBeInstanceOf(StaleAccountWorkError);
    expect((await row()).imapRecentProgress).toEqual(before);
    const controller = new AbortController();
    server.state.onFetch = () => controller.abort();
    await expect(
      service.run(accountId, mailboxId, "recent", "2", controller.signal),
    ).rejects.toThrow();
    expect((await row()).imapRecentProgress?.cursor).toBe("0");
  });
  it("admits same-account INBOX between Archive slices and rotates other accounts", async () => {
    const inbox = await seed("INBOX", accountId),
      other = await seed("Other");
    await database.db
      .update(mailboxes)
      .set({
        recentSyncStatus: "success",
        recentSyncUidValidity: 10n,
        recentSyncMessageCount: 0,
        recentSyncCutoff: new Date(Date.now() - 30 * 86400000),
      })
      .where(eq(mailboxes.id, inbox.mailboxId));
    await enqueueRecent(boss, accountId, mailboxId);
    const [active] = await boss.fetch<{
      version: 1;
      accountId: string;
      mailboxId: string;
      accountRevision: string;
    }>(recent, { includeMetadata: true });
    const lock = createMailboxLock(database.client);
    let more = false;
    await lock(mailboxId, async () => {
      more = await service.run(accountId, mailboxId, "recent", "1");
    });
    expect(more).toBe(true);
    await enqueueDelta(boss, accountId, inbox.mailboxId, "idle");
    await enqueueImapContinuation(boss, recent, active.data, diagnostics);
    await enqueueImapContinuation(boss, recent, active.data, diagnostics);
    expect(
      await boss.findJobs(recent, { key: mailboxId, queued: true }),
    ).toHaveLength(1);
    await enqueueRecent(boss, other.accountId, other.mailboxId);
    await boss.complete(recent, active.id);
    await database.client`update pgboss.job set start_after=now() where state='created'`;
    expect(await boss.fetch(recent)).toHaveLength(0);
    const [p0] = await boss.fetch<{ mailboxId: string }>(delta, {
      includeMetadata: true,
    });
    expect(p0.data.mailboxId).toBe(inbox.mailboxId);
    expect((await boss.getJobById(delta, p0.id))?.priority).toBe(100);
    await lock(inbox.mailboxId, async () => {
      await service.run(accountId, inbox.mailboxId, "delta", "1");
    });
    expect(
      (
        await database.db
          .select()
          .from(mailboxMessages)
          .where(eq(mailboxMessages.mailboxId, inbox.mailboxId))
      ).map((item) => item.uid),
    ).toEqual([1n, 2n, 3n]);
    await boss.complete(delta, p0.id);
    const [rotated] = await boss.fetch<{ accountId: string }>(recent);
    expect(rotated.data.accountId).toBe(other.accountId);
    await boss.complete(recent, rotated.id);
    const [continued] = await boss.fetch<{ mailboxId: string }>(recent);
    expect(continued.data.mailboxId).toBe(mailboxId);
    expect(
      diagnostics.debug.mock.calls.some(
        ([entry]) =>
          entry.event === "mail.imap_slice_yield" &&
          entry.higherPriorityWaiting,
      ),
    ).toBe(true);
  });
  it("repairs missing recent continuation and coalesces repeated polls without changing retry deadlines", async () => {
    await service.run(accountId, mailboxId, "recent", "1");
    const poller = new DeltaPoller(database.db, boss, 300);
    await poller.start();
    poller.stop();
    expect(
      await boss.findJobs(recent, { key: mailboxId, queued: true }),
    ).toHaveLength(1);
    const [active] = await boss.fetch(recent);
    await boss.fail(recent, active.id);
    const [retry] = await boss.findJobs(recent, {
      key: mailboxId,
      queued: true,
    });
    await poller.start();
    poller.stop();
    const pending = await boss.findJobs(recent, {
      key: mailboxId,
      queued: true,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].startAfter).toEqual(retry.startAfter);
    expect(pending[0].retryCount).toBe(retry.retryCount);
  });
  it("rejects overlapping mailbox execution and releases authority after cancellation", async () => {
    const lock = createMailboxLock(database.client),
      controller = new AbortController();
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const persist = messages.persistBatch.bind(messages);
    vi.spyOn(messages, "persistBatch").mockImplementationOnce(
      async (...args) => {
        await persist(...args);
        entered();
        await blocked;
      },
    );
    const running = lock(mailboxId, async () => {
      await service.run(accountId, mailboxId, "recent", "1", controller.signal);
    });
    const rejected = expect(running).rejects.toThrow();
    await started;
    await expect(lock(mailboxId, async () => {})).rejects.toThrow(
      "already running",
    );
    controller.abort();
    finish();
    await rejected;
    expect((await row()).imapRecentProgress?.cursor).toBe("0");
    await lock(mailboxId, async () => {
      await service.run(accountId, mailboxId, "recent", "1");
    });
    expect((await row()).imapRecentProgress?.cursor).toBe("3");
  });
  it("drains recent and delta through registered pg-boss workers and existing authority", async () => {
    const lock = createMailboxLock(database.client);
    messages = new MessageService(
      database.db,
      accounts,
      server.provider,
      {
        initialSyncDays: 30,
        messageFetchBatchSize: 2,
        imapSliceUidSpan: 3,
        imapSliceTimeoutMs: 60000,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      diagnostics,
    );
    const deltaService = new DeltaSyncService(
      database.db,
      accounts,
      server.provider,
      messages,
      2,
      undefined,
      undefined,
      limits,
    );
    try {
      await registerRecentSyncWorker(boss, messages, 2, lock, diagnostics);
      await registerDeltaWorker(boss, deltaService, 2, lock, diagnostics);
      await enqueueRecent(boss, accountId, mailboxId);
      await expect
        .poll(async () => (await row()).recentSyncStatus, {
          timeout: 30000,
          interval: 50,
        })
        .toBe("success");
      expect(await uids()).toHaveLength(7);
      server.add(8);
      server.add(1, ["\\Seen"], 20n);
      server.state.modseq = 20n;
      await enqueueDelta(boss, accountId, mailboxId, "idle");
      await expect
        .poll(async () => (await row()).deltaSyncStatus, {
          // This checks eventual durable drain, not a freshness SLO. Existing
          // admission polling contenders can defer this queue between slices.
          timeout: 90000,
          interval: 50,
        })
        .toBe("success");
      expect(await uids()).toHaveLength(8);
      expect((await row()).deltaLastSeenUid).toBe(8n);
      const [placement] = await database.db
        .select()
        .from(mailboxMessages)
        .where(eq(mailboxMessages.uid, 1n));
      expect(placement.flags).toEqual(["\\Seen"]);
      expect(
        await boss.findJobs(recent, { key: mailboxId, queued: true }),
      ).toHaveLength(0);
      expect(
        await boss.findJobs(delta, { key: mailboxId, queued: true }),
      ).toHaveLength(0);
      expect(
        server.state.clients.every(
          (client) => vi.mocked(client.close).mock.calls.length >= 1,
        ),
      ).toBe(true);
    } finally {
      await boss.offWork(recent);
      await boss.offWork(delta);
    }
  });
});
