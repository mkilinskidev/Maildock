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
  syncCandidatesSql,
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
    const claimed = result.flat();
    // The mismatching queue can win the try-lock and defer while the matching
    // queue observes contention. Both empty polls are valid; its next normal
    // opportunity must claim exactly one job and still exclude this account.
    if (!claimed.length) {
      claimed.push(...(await fetch(recent)), ...(await fetch(delta, second)));
    }
    expect(claimed).toHaveLength(1);
    expect(await fetch(recent)).toHaveLength(0);
    expect(await fetch(delta, second)).toHaveLength(0);
  });
  it("settles leftover jobs of deleted accounts without blocking healthy accounts", async () => {
    const removed = await account(),
      healthy = await account();
    const stale = await send(discovery, removed);
    await database.client`update pgboss.job set created_on=now()-interval '1 minute' where id=${stale}`;
    await database.client`delete from mail_accounts where id=${removed}`;
    await send(delta, healthy, await mailbox(healthy, "INBOX"));
    const [job] = await fetch(discovery);
    expect(job.id).toBe(stale);
    await first.complete(discovery, job.id);
    expect((await fetch(delta))[0].data.accountId).toBe(healthy);
  });
  it("ignores stale singleton statistics while preserving live singleton exclusion", async () => {
    const a = await account(),
      healthy = await account();
    const inbox = await mailbox(a, "INBOX");
    const key = inbox;
    await first.send(
      delta,
      { accountId: a, mailboxId: inbox },
      { singletonKey: key },
    );
    const [active] = await fetch(delta);
    // Supervision writes this advisory hint while the delivery is active. A
    // newly-started process loads that value into its 60-second queue cache.
    await database.client`update pgboss.queue set singletons_active=array[${key}] where name=${delta}`;
    const connectionString = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/admission`;
    const cached = new PgBoss({ connectionString, supervise: false });
    await cached.start();
    const restore = installSyncAdmission(cached, 2);
    try {
      await first.send(
        delta,
        { accountId: a, mailboxId: inbox },
        { singletonKey: key },
      );
      expect(await fetch(delta, cached)).toHaveLength(0); // Actual authority remains.
      await first.complete(delta, active.id);
      await send(recent, healthy, await mailbox(healthy, "Projects"));
      const [successor] = await fetch(delta, cached);
      expect(successor.data.accountId).toBe(a);
      await cached.complete(delta, successor.id);
      expect(await fetch(recent, cached)).toHaveLength(1);
    } finally {
      restore();
      await cached.stop();
      await database.client`update pgboss.queue set singletons_active=null where name=${delta}`;
    }
  });
  it("checks installed enum ordering and preserves expiration recovery", async () => {
    const isolation = await first
      .getDb()
      .executeSql("show transaction_isolation");
    expect(isolation.rows[0].transaction_isolation).toBe("read committed");
    const states =
      await database.client`select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='pgboss' and t.typname='job_state' order by enumsortorder`;
    expect(states.map((row) => row.enumlabel)).toEqual([
      "created",
      "retry",
      "active",
      "completed",
      "cancelled",
      "failed",
    ]);
    const a = await account(),
      b = await account();
    await send(delta, a, await mailbox(a, "INBOX"));
    const [job] = await fetch(delta);
    await database.client`update pgboss.job set started_on=now()-interval '16 minutes' where id=${job.id}`;
    await first.supervise(delta);
    expect(await fetch(delta)).toHaveLength(0);
    await send(delta, b, await mailbox(b, "INBOX"));
    expect((await fetch(delta))[0].data.accountId).toBe(b);
  });
  it("rolls back an actual claim when fairness persistence fails", async () => {
    const a = await account();
    const id = await send(delta, a, await mailbox(a, "INBOX"));
    const db = first.getDb();
    const begin = db.beginTransaction!;
    // Reinstall so the adapter captures this fault-injecting transaction factory.
    restoreFirst();
    db.beginTransaction = async () => {
      const tx = await begin.call(db);
      const execute = tx.db.executeSql.bind(tx.db);
      tx.db.executeSql = (sql, values) => {
        if (sql.includes("insert into public.sync_account_admission"))
          throw new Error("fixture fairness persistence failure");
        return execute(sql, values);
      };
      return tx;
    };
    restoreFirst = installSyncAdmission(first, 2);
    try {
      await expect(fetch(delta)).rejects.toThrow(
        "fixture fairness persistence failure",
      );
      const [job] = await first.findJobs(delta, { id: id! });
      expect(job.state).toBe("created");
      expect(job.startedOn).toBeNull();
      expect(job.priority).toBe(10);
      expect(job.retryCount).toBe(0);
      expect(
        await database.client`select * from sync_account_admission`,
      ).toHaveLength(0);
    } finally {
      restoreFirst();
      db.beginTransaction = begin;
      restoreFirst = installSyncAdmission(first, 2);
    }
    expect((await fetch(delta))[0].id).toBe(id);
  });
  it("profiles admission with many folders and retained terminal jobs", async () => {
    const ids = await Promise.all(Array.from({ length: 50 }, () => account()));
    await database.client`insert into mailboxes(id,account_id,remote_path,name,selectable,first_discovered_at,last_discovered_at)
      select gen_random_uuid(),a.id,case when i=0 then 'INBOX' else 'Folder_'||i end,'Fixture',true,now(),now()
      from mail_accounts a cross join generate_series(0,100) i where a.id=any(${ids}::uuid[])`;
    const folders =
      await database.client`select id,account_id,remote_path from mailboxes where account_id=any(${ids}::uuid[])`;
    const groups = new Map<
      string,
      { data: { accountId: string; mailboxId: string }; singletonKey: string }[]
    >();
    for (const [i, folder] of folders.entries()) {
      const queue =
        folder.remote_path === "INBOX"
          ? delta
          : [recent, delta, backfill][i % 3];
      const rows = groups.get(queue) ?? [];
      rows.push({
        data: { accountId: folder.account_id, mailboxId: folder.id },
        singletonKey: folder.id,
      });
      groups.set(queue, rows);
    }
    for (const [queue, jobs] of groups) await first.insert(queue, jobs);
    await first.insert(
      discovery,
      Array.from({ length: 20000 }, () => ({
        data: { accountId: ids[0] },
        singletonKey: randomUUID(),
      })),
    );
    await database.client`update pgboss.job set state='completed' where name=${discovery}`;
    await database.client`analyze pgboss.job_common`;
    await database.client`analyze mailboxes`;
    const profiles = [];
    for (let i = 0; i < 3; i++) {
      const result = await first
        .getDb()
        .executeSql(
          `explain (analyze,buffers,format json) ${syncCandidatesSql}`,
          [[...SYNC_QUEUES], 2],
        );
      const plan = result.rows[0]["QUERY PLAN"][0];
      const scans: number[] = [];
      function inspect(node: Record<string, unknown>) {
        if (node["CTE Name"] === "candidates")
          scans.push(Number(node["Actual Loops"]));
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          inspect(child);
      }
      inspect(plan.Plan);
      profiles.push({
        executionMs: plan["Execution Time"],
        planningMs: plan["Planning Time"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
        sharedReadBlocks: plan.Plan["Shared Read Blocks"],
        plan: JSON.stringify(plan.Plan),
        maxCandidateScanLoops: Math.max(0, ...scans),
      });
    }
    console.info(
      "admission profile",
      JSON.stringify({
        accounts: 50,
        eligible: folders.length,
        terminal: 20000,
        samples: profiles.map((sample) => ({
          executionMs: sample.executionMs,
          planningMs: sample.planningMs,
          sharedHitBlocks: sample.sharedHitBlocks,
          sharedReadBlocks: sample.sharedReadBlocks,
          maxCandidateScanLoops: sample.maxCandidateScanLoops,
        })),
        usesReadyIndex: profiles[0].plan.includes("job_common_i11"),
      }),
    );
    // A backfill check must not rescan the whole materialized backlog per job.
    expect(profiles.every((sample) => sample.maxCandidateScanLoops <= 1)).toBe(
      true,
    );
    expect((await fetch(delta))[0]).toBeDefined();
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
    expect(order[0]).toBe("INBOX");
    // The remaining P1 requests run concurrently; their completion order is free.
    expect(order.slice(1).sort()).toEqual(["Archive", "Projects"]);
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
