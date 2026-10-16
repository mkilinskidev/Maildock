import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { PgBoss } from "pg-boss";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
  messages,
  messageCommands,
  messageContents,
} from "@/shared/infrastructure/database/schema";
import {
  ReceivingDemand,
  ReceivingDueRepair,
} from "@/modules/mail/application/receiving-demand";
import {
  enqueueReceivingWake,
  RECEIVING_WAKE_QUEUE as queue,
  registerReceivingWakeDelivery,
} from "@/modules/mail/infrastructure/receiving-wake-jobs";
import { enqueueDelta } from "@/modules/mail/infrastructure/delta-sync-jobs";
import { enqueueBackfill } from "@/modules/mail/infrastructure/backfill-sync-jobs";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { MessageService } from "@/modules/mail/application/message-service";

async function until(predicate: () => Promise<boolean>) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Stage 4A fixture boundary deadline exceeded");
}

describe("Stage 4A durable account wakes, actual PostgreSQL/pg-boss", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let boss: PgBoss, producer: PgBoss;
  let url: string;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture-only",
        POSTGRES_DB: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const root = postgres(
      `postgres://fixture:fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/fixture`,
    );
    await root`create role lane login password 'lane-fixture-only'`;
    await root`create database stage4a owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/stage4a`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 2 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: url, persistQueueStats: false });
    producer = new PgBoss({ connectionString: url });
    boss.on("error", () => {});
    producer.on("error", () => {});
    await boss.start();
    await producer.start();
    await enqueueReceivingWake(boss, randomUUID());
  });
  beforeEach(async () => {
    await boss.deleteAllJobs(queue);
    // Hints only; no changes to authoritative facts, revisions, or lifecycle.
    await reader`update mail_accounts set receiving_due_at='infinity'`;
    await reader`update mailboxes set receiving_due_at='infinity'`;
  });
  afterEach(async () => {
    await boss.offWork(queue, { wait: true });
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
        child.kill("SIGKILL");
        await exited;
      }
    }
    children.clear();
  });
  afterAll(async () => {
    await producer?.stop();
    await boss?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });

  async function account(path = "INBOX") {
    const id = randomUUID(),
      mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Stage4A",
      email: "fixture@example.test",
      imapHost: "invalid.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyId: "fixture",
        iv: "fixture",
        ciphertext: "fixture",
        authTag: "fixture",
      },
      smtpHost: "invalid.test",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    await database.db.insert(mailboxes).values({
      id: mailbox,
      accountId: id,
      remotePath: path,
      name: path,
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    return { id, mailbox };
  }
  const demand = () =>
    new ReceivingDemand(database.db, (id) => enqueueReceivingWake(boss, id));
  async function snapshot(mailbox: string) {
    const [row] =
      await reader`select m.receiving_due_at<=clock_timestamp() as due,
      m.receiving_request_generation as generation, s.epoch,s.revision,s.fresh_through,s.history_before,
      (select count(*)::int from mailbox_messages p where p.mailbox_id=m.id) as placements,
      (select count(*)::int from notification_events e where e.mailbox_id=m.id) as events
      from mailboxes m left join receiving_mailboxes s on s.mailbox_id=m.id where m.id=${mailbox}`;
    return row;
  }
  async function completed(id: string) {
    const [row] =
      await reader`select count(*)::int as count from pgboss.job where name=${queue}
      and singleton_key=${id} and state='completed'`;
    return row.count > 0;
  }
  async function crash(
    mode: "due" | "metadata",
    a: { id: string; mailbox: string },
    actor = randomUUID(),
    generation = "0",
  ) {
    const child = fork("tests/fixtures/receiving-wake-crash.ts", [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        STAGE4A_FIXTURE: JSON.stringify({
          url,
          mode,
          account: a.id,
          mailbox: a.mailbox,
          actor,
          generation,
        }),
      },
    });
    children.add(child);
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors = (errors + String(chunk)).slice(-8000);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Crash barrier not reached: ${errors}`)),
        15000,
      );
      child.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Fixture exited before barrier: ${errors}`));
      });
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
  }

  it("process crash after due commit before send leaves independently visible demand for repair", async () => {
    const a = await account();
    await crash("due", a);
    expect(await snapshot(a.mailbox)).toMatchObject({
      due: true,
      generation: "1",
      placements: 0,
      events: 0,
      revision: null,
    });
    expect(await boss.findJobs(queue, { key: a.id })).toHaveLength(0);
    await demand().repairPage(null);
    expect(await boss.findJobs(queue, { key: a.id })).toHaveLength(1);
    expect((await snapshot(a.mailbox)).generation).toBe("1");
  });

  it("duplicate delivery and ACK leave unsynchronized work due without creating facts", async () => {
    const a = await account();
    await demand().request(a.id, a.mailbox);
    const before = await snapshot(a.mailbox);
    await registerReceivingWakeDelivery(boss, demand(), {
      notify: async () => {},
    });
    await until(() => completed(a.id));
    await boss.offWork(queue, { wait: true });
    await enqueueReceivingWake(boss, a.id);
    await registerReceivingWakeDelivery(boss, demand(), {
      notify: async () => {},
    });
    await until(
      async () =>
        (await boss.findJobs(queue, { key: a.id })).filter(
          (j) => j.state === "completed",
        ).length === 2,
    );
    expect(await snapshot(a.mailbox)).toEqual(before);
    expect(await demand().eligible(a.id)).toBe(true);
  });

  it("process crash after actual fenced metadata commit before ACK redelivers from durable state", async () => {
    const a = await account();
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_takeover(${actor},60000) as generation`;
    const exec = new ReceivingExecutor(url, 1);
    try {
      await new ReceivingPersistence(exec).initialize(
        { actor, generation: BigInt(lease.generation) },
        a.mailbox,
        { complete: true, epoch: 7n, uidNext: 2n },
        { deadline: performance.now() + 5000 },
      );
      await demand().request(a.id, a.mailbox);
      await crash("metadata", a, actor, lease.generation);
      const committed = await snapshot(a.mailbox);
      expect(committed).toMatchObject({
        due: true,
        revision: "1",
        fresh_through: "2",
        history_before: "2",
        placements: 1,
        events: 1,
      });
      const [job] = await boss.findJobs(queue, { key: a.id });
      expect(job.state).toBe("active");
      // Deterministically expire the abandoned job; actual supervisor performs retry.
      await reader`update pgboss.job set started_on=clock_timestamp()-interval '2 minutes',retry_delay=0,retry_backoff=false where id=${job.id}`;
      await boss.supervise(queue);
      expect((await boss.findJobs(queue, { key: a.id }))[0].state).toBe(
        "retry",
      );
      // supervise monitors before expiring jobs; even force:true reuses stats
      // younger than one minute. Age that fixture-only timestamp, then use the
      // actual public refresh API before starting the replacement consumer.
      await reader`update pgboss.queue set monitor_on=clock_timestamp()-interval '2 minutes' where name=${queue}`;
      await boss.getQueueStats(queue, { force: true });
      const restarted = new PgBoss({ connectionString: url });
      restarted.on("error", () => {});
      await restarted.start();
      try {
        await registerReceivingWakeDelivery(restarted, demand(), {
          notify: async () => {},
        });
        await until(() => completed(a.id));
      } finally {
        await restarted.stop();
      }
      expect(await snapshot(a.mailbox)).toEqual(committed);
    } finally {
      await exec.stop();
    }
  });

  it("lost in-process notification is repaired after restart without browser activity", async () => {
    const a = await account();
    await demand().request(a.id, a.mailbox);
    await registerReceivingWakeDelivery(boss, demand(), {
      notify: async () => {
        /* local hint lost */
      },
    });
    await until(() => completed(a.id));
    await boss.offWork(queue, { wait: true });
    await boss.deleteAllJobs(queue);
    const before = await snapshot(a.mailbox);
    const restarted = new PgBoss({ connectionString: url });
    restarted.on("error", () => {});
    await restarted.start();
    try {
      const recovered = new ReceivingDemand(database.db, (id) =>
        enqueueReceivingWake(restarted, id),
      );
      const repair = new ReceivingDueRepair(recovered, 2);
      let page;
      do {
        page = await repair.tick();
      } while (page?.next);
      expect(await restarted.findJobs(queue, { key: a.id })).toHaveLength(1);
      expect(await snapshot(a.mailbox)).toEqual(before);
    } finally {
      await restarted.stop();
    }
  });

  it("concurrent producers coalesce to one account job and preserve every request generation", async () => {
    const a = await account();
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        new ReceivingDemand(database.db, (id) =>
          enqueueReceivingWake(i % 2 ? producer : boss, id),
        ).request(a.id, a.mailbox),
      ),
    );
    expect(await boss.findJobs(queue, { key: a.id })).toHaveLength(1);
    expect(await snapshot(a.mailbox)).toMatchObject({
      generation: "16",
      due: true,
      placements: 0,
      events: 0,
    });
    const [active] = await boss.fetch(queue);
    await demand().request(a.id, a.mailbox); // Late request while delivery is active.
    await boss.complete(queue, active.id);
    expect(
      (await boss.findJobs(queue, { key: a.id })).filter(
        (j) => j.state === "created",
      ),
    ).toHaveLength(1);
    expect((await snapshot(a.mailbox)).generation).toBe("17");
  });

  it("repair reads bounded keyset pages, visits all due accounts and resumes after send failure", async () => {
    const accounts = [];
    for (let i = 0; i < 7; i++) accounts.push(await account());
    const failed = new ReceivingDemand(database.db, async () => {
      throw new Error("Unavailable queue");
    });
    expect((await failed.repairPage(null, 3)).delivered).toBe(0);
    const repair = new ReceivingDueRepair(demand(), 3);
    let pages = 0,
      page;
    do {
      page = await repair.tick();
      expect(page!.read).toBeLessThanOrEqual(3);
      pages++;
    } while (page?.next);
    expect(pages).toBeGreaterThan(2);
    for (const a of accounts) {
      expect(await boss.findJobs(queue, { key: a.id })).toHaveLength(1);
      expect(await snapshot(a.mailbox)).toMatchObject({
        due: true,
        generation: "0",
        placements: 0,
      });
    }
    await expect(demand().repairPage(null, 129)).rejects.toThrow();
  });

  it("disabled/deleted accounts and missing/foreign mailboxes are ignored at production and delivery", async () => {
    const a = await account(),
      other = await account();
    expect(await demand().request(a.id, other.mailbox)).toBe(false);
    expect(await demand().request(a.id, randomUUID())).toBe(false);
    await demand().request(a.id, a.mailbox);
    await reader`update mail_accounts set enabled=false where id=${a.id}`;
    expect(await demand().request(a.id, a.mailbox)).toBe(false);
    let called = false;
    await registerReceivingWakeDelivery(boss, demand(), {
      notify: async () => {
        called = true;
      },
    });
    await until(() => completed(a.id));
    expect(called).toBe(false);
    expect((await snapshot(a.mailbox)).generation).toBe("1");
    await boss.offWork(queue, { wait: true });
    await enqueueReceivingWake(boss, other.id);
    await reader`delete from mail_accounts where id=${other.id}`;
    await registerReceivingWakeDelivery(boss, demand(), {
      notify: async () => {
        called = true;
      },
    });
    await until(() => completed(other.id));
    expect(called).toBe(false);
    expect(await demand().eligible(other.id)).toBe(false);
  });

  it("account creation, credential change, reenablement and mailbox discovery persist due atomically", async () => {
    const a = await account();
    const [created] =
      await reader`select receiving_due_at<=clock_timestamp() as due,receiving_request_generation as generation from mail_accounts where id=${a.id}`;
    expect(created).toMatchObject({ due: true, generation: "0" });
    expect((await snapshot(a.mailbox)).due).toBe(true);
    await reader`update mail_accounts set receiving_due_at='infinity' where id=${a.id}`;
    await reader`update mail_accounts set imap_host='changed.invalid' where id=${a.id}`;
    await reader`update mail_accounts set enabled=false where id=${a.id}`;
    await reader`update mail_accounts set enabled=true where id=${a.id}`;
    const [row] =
      await reader`select receiving_due_at<=clock_timestamp() as due,receiving_request_generation as generation from mail_accounts where id=${a.id}`;
    expect(row).toMatchObject({ due: true, generation: "2" });
  });

  it("repair derives pending command/content eligibility without changing their execution or status", async () => {
    const a = await account();
    await reader`update mail_accounts set receiving_due_at='infinity' where id=${a.id}`;
    await reader`update mailboxes set selectable=false,receiving_due_at='infinity' where id=${a.mailbox}`;
    expect(await demand().eligible(a.id)).toBe(false);
    const messageId = randomUUID();
    await database.db.insert(messages).values({
      id: messageId,
      accountId: a.id,
      size: 10n,
      internalDate: new Date(),
    });
    await database.db
      .insert(messageContents)
      .values({ messageId, status: "pending" });
    expect(await demand().eligible(a.id)).toBe(true);
    await demand().repairPage(null);
    const [content] =
      await reader`select status from message_contents where message_id=${messageId}`;
    expect(content.status).toBe("pending");
    await reader`update message_contents set status='failed' where message_id=${messageId}`;
    expect(await demand().eligible(a.id)).toBe(false);
    const command = randomUUID();
    await database.db.insert(messageCommands).values({
      id: command,
      accountId: a.id,
      mailboxId: a.mailbox,
      messageId,
      action: "mark_read",
      sourcePath: "INBOX",
      sourceUidValidity: 7n,
      sourceUid: 1n,
    });
    expect(await demand().eligible(a.id)).toBe(true);
    await demand().repairPage(null);
    const [intent] =
      await reader`select status,attempts from message_commands where id=${command}`;
    expect(intent).toMatchObject({ status: "pending", attempts: 0 });
    expect(await boss.findJobs(queue, { key: a.id })).toHaveLength(1);
  });

  it("fresh eligibility is independent of history initialization and history derives from E alone", async () => {
    const fresh = await account(),
      history = await account();
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_takeover(${actor},60000) as generation`;
    const exec = new ReceivingExecutor(url, 1);
    try {
      await new ReceivingPersistence(exec).initialize(
        { actor, generation: BigInt(lease.generation) },
        history.mailbox,
        { complete: true, epoch: 7n, uidNext: 2n },
        { deadline: performance.now() + 5000 },
      );
      await reader`update mail_accounts set receiving_due_at='infinity' where id in (${fresh.id},${history.id})`;
      await reader`update mailboxes set receiving_due_at='infinity' where id in (${fresh.mailbox},${history.mailbox})`;
      expect(await demand().eligible(fresh.id)).toBe(true); // Unenrolled, no recent success.
      expect(await demand().eligible(history.id)).toBe(true); // E=2 despite future fresh hints.
      expect(await snapshot(history.mailbox)).toMatchObject({
        due: false,
        history_before: "2",
        placements: 0,
      });
      expect(await snapshot(fresh.mailbox)).toMatchObject({
        due: false,
        revision: null,
        placements: 0,
      });
    } finally {
      await exec.stop();
    }
  });

  it("requestSync/requestRecentSync/delta/backfill use account wakes for INBOX without legacy prerequisites", async () => {
    const a = await account();
    const service = new MessageService(
      database.db,
      undefined,
      undefined,
      undefined,
      { schedule: (id, mailbox) => demand().request(id, mailbox) },
    );
    expect(await service.requestSync(a.id, a.mailbox)).toBe(true);
    expect(await service.requestRecentSync(a.id, a.mailbox)).toBe(true);
    expect(await enqueueDelta(boss, a.id, a.mailbox, "idle")).toBe(true);
    expect(await enqueueBackfill(boss, a.id, a.mailbox, "999")).toBe(true);
    expect((await snapshot(a.mailbox)).generation).toBe("4");
    const [row] =
      await reader`select recent_sync_status from mailboxes where id=${a.mailbox}`;
    expect(row.recent_sync_status).toBe("not_started");
    expect(await boss.findJobs(queue, { key: a.id })).toHaveLength(1);
    const [old] =
      await reader`select count(*)::int as count from pgboss.job where name in ('mailbox-recent-sync-v1','mailbox-delta-sync-v1','mailbox-backfill-sync-v1')`;
    expect(old.count).toBe(0);
  });

  it("hint-only writes keep Stage 1 fences and worker has no new competing receiving writer", async () => {
    const a = await account();
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_takeover(${actor},60000) as generation`;
    const exec = new ReceivingExecutor(url, 1);
    try {
      await new ReceivingPersistence(exec).initialize(
        { actor, generation: BigInt(lease.generation) },
        a.mailbox,
        { complete: true, epoch: 7n, uidNext: 2n },
        { deadline: performance.now() + 5000 },
      );
      const before = await snapshot(a.mailbox);
      await demand().request(a.id, a.mailbox);
      expect(await snapshot(a.mailbox)).toEqual({ ...before, generation: "1" });
      await expect(
        reader`update mailboxes set uid_validity=8,receiving_request_generation=2 where id=${a.mailbox}`,
      ).rejects.toThrow();
      await expect(
        reader`update receiving_mailboxes set fresh_through=2 where mailbox_id=${a.mailbox}`,
      ).rejects.toThrow();
      const worker = await readFile(
        "src/composition/worker-process.ts",
        "utf8",
      );
      expect(worker).toContain("registerReceivingWakeDelivery");
      expect(worker).toContain("registerReceivingConversions");
      expect(worker).not.toMatch(
        /registerRecentSyncWorker|registerDeltaWorker|registerBackfillWorker|registerContentWorker|registerAttachmentWorker|registerMessageCommandWorker|registerSentCopyWorker|registerMailboxDiscoveryWorker/,
      );
    } finally {
      await exec.stop();
    }
  });
});
