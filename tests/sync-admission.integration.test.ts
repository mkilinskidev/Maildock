import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  installSyncAdmission,
  SYNC_QUEUES,
} from "@/modules/mail/infrastructure/sync-admission";
import { createIdleAccountLease } from "@/modules/mail/infrastructure/idle-account-lease";
import { SyncLockContentionError } from "@/modules/mail/infrastructure/sync-diagnostics";
import { MailboxDiscoveryService } from "@/modules/mail/application/mailbox-discovery-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import type { MessageService } from "@/modules/mail/application/message-service";
import {
  GmailPoller,
  ensureGmailQueue,
} from "@/modules/mail/infrastructure/gmail-sync-jobs";

const [discovery, recent, delta, backfill, gmail] = SYNC_QUEUES;
describe("distributed synchronization admission on real pg-boss", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let first: PgBoss;
  let second: PgBoss;
  let restoreFirst: () => void;
  let restoreSecond: () => void;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "admission",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const databaseUrl = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/admission`;
    database = createDatabase({ databaseUrl, databasePoolSize: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    first = new PgBoss({ connectionString: databaseUrl });
    second = new PgBoss({ connectionString: databaseUrl });
    await first.start();
    await second.start();
    for (const queue of SYNC_QUEUES)
      await first.createQueue(queue, {
        policy: "stately",
        retryDelay: 30,
        retryLimit: 4,
        expireInSeconds: 900,
      });
    restoreFirst = installSyncAdmission(first, 2);
    restoreSecond = installSyncAdmission(second, 2);
  });
  afterAll(async () => {
    restoreFirst?.();
    restoreSecond?.();
    await first?.stop();
    await second?.stop();
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    for (const queue of SYNC_QUEUES) await first.deleteAllJobs(queue);
    await database.client`delete from sync_account_admission`;
    await database.client`update sync_admission_policy set p0_admissions=0,last_lower_class=2`;
  });
  async function account(authMethod = "password") {
    const id = randomUUID();
    await database.client`insert into mail_accounts(id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security,auth_method,oauth_provider_id,oauth_status,oauth_cache)
      values(${id},'Admission fixture','owner@test.invalid','imap.test',993,'tls','owner',${authMethod === "oauth2" ? null : "{}"}::jsonb,'smtp.test',465,'tls',${authMethod},${authMethod === "oauth2" ? "microsoft" : null},${authMethod === "oauth2" ? "connected" : null},${authMethod === "oauth2" ? "{}" : null}::jsonb)`;
    return id;
  }
  async function mailbox(accountId: string, path: string) {
    const id = randomUUID();
    await database.client`insert into mailboxes(id,account_id,remote_path,name,selectable,first_discovered_at,last_discovered_at) values(${id},${accountId},${path},${path},true,now(),now())`;
    return id;
  }
  async function send(
    queue: string,
    accountId: string,
    mailboxId?: string,
    priority = 10,
  ) {
    return first.send(
      queue,
      {
        version: 1,
        accountId,
        mailboxId,
        accountRevision: "1",
        reason: "idle",
      },
      { singletonKey: randomUUID(), priority },
    );
  }
  async function fetch(queue: string, boss = first) {
    return boss.fetch<{ accountId: string; mailboxId?: string }>(queue, {
      includeMetadata: true,
    });
  }

  it.each(["password", "oauth2"])(
    "selects INBOX before other folders with %s authentication",
    async (auth) => {
      const a = await account(auth),
        b = await account(auth);
      await send(recent, a, await mailbox(a, "Archive"), 999);
      const inbox = await mailbox(b, "inbox");
      await send(delta, b, inbox, -999);
      expect(await fetch(recent)).toHaveLength(0);
      const [job] = await fetch(delta);
      expect(job.data.mailboxId).toBe(inbox);
      await first.complete(delta, job.id);
      expect(await fetch(recent)).toHaveLength(1);
    },
  );
  it("reserves P0 capacity while lower work keeps arriving in separate queues", async () => {
    const a = await account(),
      b = await account(),
      c = await account();
    await send(recent, a, await mailbox(a, "Archive"));
    const [lower] = await fetch(recent);
    expect(lower).toBeDefined();
    await send(recent, b, await mailbox(b, "Projects"));
    expect(await fetch(recent, second)).toHaveLength(0);
    await send(delta, c, await mailbox(c, "INBOX"));
    expect(await fetch(delta, second)).toHaveLength(1);
  });
  it("real queue consumers execute waiting P0 while a lower operation remains active", async () => {
    const a = await account(),
      b = await account(),
      c = await account();
    await send(recent, a, await mailbox(a, "Archive"));
    let enteredLower!: () => void,
      enteredInbox!: () => void,
      finish!: () => void;
    const lowerStarted = new Promise<void>((resolve) => {
      enteredLower = resolve;
    });
    const inboxStarted = new Promise<void>((resolve) => {
      enteredInbox = resolve;
    });
    const boundary = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const lowerAccounts: string[] = [];
    try {
      await first.work<{ accountId: string }>(
        recent,
        { localConcurrency: 2 },
        async (batch) => {
          lowerAccounts.push(batch[0].data.accountId);
          enteredLower();
          await boundary;
        },
      );
      await lowerStarted;
      await send(recent, b, await mailbox(b, "Projects"));
      await send(delta, c, await mailbox(c, "INBOX"));
      await second.work(delta, { localConcurrency: 2 }, async () => {
        enteredInbox();
        await boundary;
      });
      await inboxStarted;
      expect(lowerAccounts).toEqual([a]);
    } finally {
      finish();
      await first.offWork(recent);
      await second.offWork(delta);
    }
  });
  it("rotates accounts and rejects simultaneous cross-queue execution for one account", async () => {
    const a = await account(),
      b = await account();
    const inboxA = await mailbox(a, "INBOX");
    await send(delta, a, inboxA);
    const [initial] = await fetch(delta);
    await send(recent, a, inboxA);
    expect(await fetch(recent, second)).toHaveLength(0);
    await first.complete(delta, initial.id);
    await send(delta, b, await mailbox(b, "INBOX"));
    expect(await fetch(recent)).toHaveLength(0);
    const [next] = await fetch(delta, second);
    expect(next.data.accountId).toBe(b);
    await second.complete(delta, next.id);
    expect((await fetch(recent))[0].data.accountId).toBe(a);
  });
  it("permits alternating P1 and P2 after eight P0 admissions under sustained load", async () => {
    const hot = await account(),
      p1 = await account(),
      p2 = await account();
    const inbox = await mailbox(hot, "INBOX");
    await send(recent, p1, await mailbox(p1, "Projects"));
    await send(backfill, p2, await mailbox(p2, "Archive"));
    for (let i = 0; i < 8; i++) {
      await send(delta, hot, inbox);
      const [job] = await fetch(delta);
      expect(job).toBeDefined();
      await first.complete(delta, job.id);
    }
    await send(delta, hot, inbox);
    expect(await fetch(delta)).toHaveLength(0);
    const [lower] = await fetch(recent);
    expect(lower.data.accountId).toBe(p1);
    await first.complete(recent, lower.id);
    const [job] = await fetch(delta);
    await first.complete(delta, job.id);
    for (let i = 0; i < 7; i++) {
      await send(delta, hot, inbox);
      const [job] = await fetch(delta);
      await first.complete(delta, job.id);
    }
    await send(delta, hot, inbox);
    expect((await fetch(backfill))[0].data.accountId).toBe(p2);
    // The reserved slot still admits current work while the allowance executes.
    expect(await fetch(delta, second)).toHaveLength(1);
  });
  it("allows a lower turn after 60 seconds of eligible waiting", async () => {
    const hot = await account(),
      cold = await account();
    const id = await send(backfill, cold, await mailbox(cold, "Archive"));
    await database.client`update pgboss.job set created_on=now()-interval '61 seconds',start_after=now()-interval '61 seconds' where id=${id}`;
    await send(delta, hot, await mailbox(hot, "INBOX"));
    expect(await fetch(delta)).toHaveLength(0);
    expect(await fetch(backfill)).toHaveLength(1);
    expect(await fetch(delta)).toHaveLength(1);
  });
  it("backfill yields to current work on the same mailbox even on a lower turn", async () => {
    const a = await account(),
      inbox = await mailbox(a, "INBOX");
    await send(backfill, a, inbox);
    await send(delta, a, inbox);
    await database.client`update sync_admission_policy set p0_admissions=8`;
    expect(await fetch(backfill)).toHaveLength(0);
    expect(await fetch(delta)).toHaveLength(1);
  });
  it("serializes concurrent fetches across independent worker instances", async () => {
    const a = await account(),
      inbox = await mailbox(a, "INBOX");
    await send(recent, a, inbox);
    await send(delta, a, inbox);
    const result = await Promise.all([fetch(recent), fetch(delta, second)]);
    expect(result.flat()).toHaveLength(1);
    expect(await fetch(recent)).toHaveLength(0);
    expect(await fetch(delta, second)).toHaveLength(0);
  });
  it("does not bypass a queued retry deadline or increment retry counts for admission deferral", async () => {
    const a = await account(),
      b = await account();
    await send(delta, a, await mailbox(a, "INBOX"));
    const [job] = await fetch(delta);
    await first.fail(delta, job.id);
    await send(recent, b, await mailbox(b, "Archive"));
    expect(await fetch(delta)).toHaveLength(0);
    expect(await fetch(recent)).toHaveLength(1);
    const [retry] = await first.findJobs(delta, { id: job.id });
    expect(retry.state).toBe("retry");
    expect(retry.retryCount).toBe(0);
    expect(retry.startAfter.getTime()).toBeGreaterThan(Date.now());
  });
  async function gmailState(
    accountId: string,
    inventory: boolean,
    deadline?: string,
  ) {
    const runId = inventory ? randomUUID() : null;
    await database.client`update mail_accounts set provider_type='gmail_smtp',auth_method='oauth2',oauth_provider_id='google',oauth_home_account_id='fixture',oauth_cache='{}',oauth_status='connected',imap_password=null,imap_host=null,imap_port=null,imap_security=null,imap_username=null,smtp_uses_imap_credentials=false,smtp_username='owner' where id=${accountId}`;
    await database.client`insert into gmail_account_sync_state(account_id,account_revision,baseline_history_id,history_id,inventory_run_id,inventory_phase,recent_cutoff,next_attempt_at)
      values(${accountId},1,'100','100',${runId},${inventory ? "historical" : null},${inventory ? new Date().toISOString() : null}::timestamptz,${deadline ? new Date(Date.now() + 60000).toISOString() : null}::timestamptz)`;
  }
  it("prioritizes Gmail current accounts over inventory and rotates without changing checkpoints", async () => {
    const inventory = await account(),
      a = await account(),
      b = await account();
    await gmailState(inventory, true);
    await gmailState(a, false);
    await gmailState(b, false);
    await send(gmail, inventory);
    await send(gmail, a);
    await send(gmail, b);
    const [one] = await fetch(gmail);
    expect(one.data.accountId).not.toBe(inventory);
    await first.complete(gmail, one.id);
    await send(gmail, one.data.accountId);
    const [two] = await fetch(gmail, second);
    expect(two.data.accountId).not.toBe(one.data.accountId);
    expect(two.data.accountId).not.toBe(inventory);
    const states =
      await database.client`select history_id,baseline_history_id from gmail_account_sync_state where account_id in (${inventory},${a},${b})`;
    expect(
      states.every(
        (s) => s.history_id === "100" && s.baseline_history_id === "100",
      ),
    ).toBe(true);
  });
  it.each(["quota", "authentication", "network"])(
    "preserves Gmail %s deadlines",
    async (category) => {
      const blocked = await account(),
        healthy = await account();
      await gmailState(blocked, false, category);
      await gmailState(healthy, false);
      await database.client`update gmail_account_sync_state set error_category=${category} where account_id=${blocked}`;
      await send(gmail, blocked);
      await send(gmail, healthy);
      const [job] = await fetch(gmail);
      expect(job.data.accountId).toBe(healthy);
      await first.complete(gmail, job.id);
      expect(await fetch(gmail, second)).toHaveLength(0);
    },
  );
  it("keeps bootstrap prerequisites eligible", async () => {
    const a = await account();
    await send(discovery, a);
    expect(await fetch(discovery)).toHaveLength(1);
  });
  it("schedules INBOX recent work before alphabetically earlier discovered folders", async () => {
    const a = await account();
    const service = new MailboxService(database.db);
    let inboxScheduled!: () => void, releaseInbox!: () => void;
    const scheduled = new Promise<void>((resolve) => {
      inboxScheduled = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseInbox = resolve;
    });
    const order: string[] = [];
    const discoveryService = new MailboxDiscoveryService(
      database.db,
      {
        getProviderImapAccountForWork: async () => ({ revision: "1" }),
      } as unknown as AccountsService,
      {
        listMailboxes: async () => ({
          capabilities: [],
          mailboxes: ["Archive", "INBOX", "Projects"].map((remotePath) => ({
            remotePath,
            name: remotePath,
            delimiter: "/",
            attributes: [],
            specialUse: [],
            selectable: true,
          })),
        }),
      } as unknown as MailProvider,
      service,
      {
        requestSync: async (_account: string, id: string) => {
          const mailbox = (await service.listForAccount(a)).find(
            (m) => m.id === id,
          )!;
          order.push(mailbox.remotePath);
          if (mailbox.remotePath === "INBOX") {
            inboxScheduled();
            await barrier;
          }
        },
      } as unknown as MessageService,
    );
    const work = discoveryService.run(a, "1");
    await scheduled;
    expect(order).toEqual(["INBOX"]);
    releaseInbox();
    await work;
    expect(order).toEqual(["INBOX", "Archive", "Projects"]);
  });
  it("the Gmail poller reaches accounts beyond its first 20 pending jobs", async () => {
    await ensureGmailQueue(first);
    const ids: string[] = [];
    // Previous fixtures should not participate in this isolated poller scenario.
    await database.client`update mail_accounts set enabled=false`;
    for (let i = 0; i < 25; i++) {
      const a = await account();
      await gmailState(a, false);
      ids.push(a);
    }
    const poller = new GmailPoller(first);
    try {
      await poller.start();
      expect(await first.findJobs(gmail, { queued: true })).toHaveLength(20);
    } finally {
      await poller.stop();
    }
    const nextPoller = new GmailPoller(second);
    try {
      await nextPoller.start();
      expect(await first.findJobs(gmail, { queued: true })).toHaveLength(25);
      const states =
        await database.client`select history_id from gmail_account_sync_state where account_id=any(${ids}::uuid[])`;
      expect(states.every((s) => s.history_id === "100")).toBe(true);
    } finally {
      await nextPoller.stop();
    }
  });
  it("holds only one IDLE lease per account across independent sessions", async () => {
    const a = await account(),
      b = await account();
    const acquire = createIdleAccountLease(database.client);
    const release = await acquire(a);
    try {
      await expect(acquire(a)).rejects.toBeInstanceOf(SyncLockContentionError);
      const releaseOther = await acquire(b);
      await releaseOther();
    } finally {
      await release();
    }
    const recovered = await acquire(a);
    await recovered();
  });
  it("notifies the watcher when its dedicated authority session is lost", async () => {
    const a = await account();
    let lost!: () => void;
    const loss = new Promise<void>((resolve) => {
      lost = resolve;
    });
    const release = await createIdleAccountLease(database.client)(a, lost);
    try {
      const key = `maildock-idle-account:${a}`;
      await database.client`select pg_terminate_backend(pid) from pg_locks where locktype='advisory' and granted and objsubid=1 and classid=((hashtextextended(${key},0)>>32)&4294967295)::oid and objid=(hashtextextended(${key},0)&4294967295)::oid`;
      await loss;
    } finally {
      await release();
    }
  });
});
