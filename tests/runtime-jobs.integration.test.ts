import { createDatabase } from "@/shared/infrastructure/database/database";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  enqueueContent,
  ensureContentQueue,
  contentJobState,
  MESSAGE_CONTENT_QUEUE as content,
} from "@/modules/mail/infrastructure/content-jobs";
import { randomUUID } from "node:crypto";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchNextJob } from "../node_modules/pg-boss/dist/plans.js";
import {
  enqueueDelta,
  ensureDeltaQueue,
  MAILBOX_DELTA_SYNC_QUEUE as delta,
} from "@/modules/mail/infrastructure/delta-sync-jobs";
import {
  enqueueBackfill,
  ensureBackfillQueue,
  MAILBOX_BACKFILL_SYNC_QUEUE as backfill,
} from "@/modules/mail/infrastructure/backfill-sync-jobs";

describe("Phase 3G.3 real PostgreSQL queue reliability", () => {
  let container: StartedTestContainer;
  let boss: PgBoss;
  let producer: PgBoss;
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "reliability",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const connectionString = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/reliability`;
    database = createDatabase({
      databaseUrl: connectionString,
      databasePoolSize: 2,
    });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await database.client`insert into mail_accounts(id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) values(${account},'Queue fixture','owner@test.invalid','imap.test',993,'tls','owner','{}','smtp.test',465,'tls')`;
    boss = new PgBoss({ connectionString });
    producer = new PgBoss({ connectionString });
    await boss.start();
    await ensureDeltaQueue(boss);
    await ensureBackfillQueue(boss);
    await ensureContentQueue(boss);
    await producer.start();
  });
  afterAll(async () => {
    await producer?.stop();
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  const account = randomUUID();
  async function jobs(queue: string, key: string) {
    return boss.findJobs(queue, { key });
  }
  async function staleFetch(queue: string) {
    const query = fetchNextJob({
      schema: "pgboss",
      table: "job_common",
      name: queue,
      policy: "stately",
      limit: 1,
      ignoreSingletons: [],
    });
    return (await boss.getDb().executeSql(query.text, query.values)).rows;
  }

  it("coalesces content producers across active and delayed retries, and preserves expiry recovery", async () => {
    const mailboxId = randomUUID(),
      messageId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        enqueueContent(i % 2 ? producer : boss, account, mailboxId, messageId),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const [first] = await boss.fetch(content, { includeMetadata: true });
    expect(first).toBeDefined();
    expect(await contentJobState(boss, mailboxId, messageId)).toBe("fetching");
    expect(await enqueueContent(producer, account, mailboxId, messageId)).toBe(
      false,
    );
    await boss.fail(content, first.id);
    const [retry] = await jobs(content, `${mailboxId}:${messageId}`);
    expect(retry.state).toBe("retry");
    expect(retry.startAfter.valueOf()).toBeGreaterThan(Date.now());
    expect(await contentJobState(boss, mailboxId, messageId)).toBe("retrying");
    expect(await enqueueContent(producer, account, mailboxId, messageId)).toBe(
      false,
    );
    expect(await boss.fetch(content)).toHaveLength(0);
    const [attempt] = await boss.fetch(content, {
      includeMetadata: true,
      ignoreStartAfter: true,
    });
    expect(attempt.retryCount).toBe(1);
    // Simulate process loss using pg-boss's own expiration supervisor.
    await boss
      .getDb()
      .executeSql(
        "UPDATE pgboss.job SET started_on=now()-interval '16 minutes' WHERE id=$1",
        [attempt.id],
      );
    await boss.supervise(content);
    expect(await contentJobState(boss, mailboxId, messageId)).toBe("retrying");
    const [recovered] = await boss.fetch(content, {
      includeMetadata: true,
      ignoreStartAfter: true,
    });
    await boss.complete(content, recovered.id);
    expect(await contentJobState(boss, mailboxId, messageId)).toBe("terminal");
    // A newer pending write after an older completed request is a missing enqueue.
    expect(
      await contentJobState(
        boss,
        mailboxId,
        messageId,
        new Date(Date.now() + 1000),
      ),
    ).toBe("missing");
    expect(await enqueueContent(boss, account, mailboxId, messageId)).toBe(
      true,
    );
    const [manual] = await boss.fetch(content, { includeMetadata: true });
    await boss
      .getDb()
      .executeSql("UPDATE pgboss.job SET retry_limit=0 WHERE id=$1", [
        manual.id,
      ]);
    await boss.fail(content, manual.id);
    expect(await contentJobState(boss, mailboxId, messageId)).toBe("terminal");
  });
  it("documents why snapshot-based groupConcurrency is not a hard distributed account gate", async () => {
    const queue = "hotfix-group-admission-evaluation";
    await boss.createQueue(queue, { policy: "stately" });
    const group = randomUUID();
    for (let i = 0; i < 2; i++)
      await boss.send(
        queue,
        { accountId: group },
        { singletonKey: randomUUID(), group: { id: group } },
      );
    const query = fetchNextJob({
      schema: "pgboss",
      table: "job_common",
      name: queue,
      policy: "stately",
      limit: 1,
      ignoreSingletons: [],
      groupConcurrency: 1,
    });
    const tx1 = await boss.getDb().beginTransaction!();
    const tx2 = await producer.getDb().beginTransaction!();
    try {
      const first = (await tx1.db.executeSql(query.text, query.values)).rows;
      // tx1's active row is invisible to tx2's group count until commit.
      const second = (await tx2.db.executeSql(query.text, query.values)).rows;
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      await tx1.commit();
      await tx2.commit();
      await boss.complete(queue, [first[0].id, second[0].id]);
    } catch (error) {
      await tx1.rollback();
      await tx2.rollback();
      throw error;
    }
  });
  it("skips live active keys despite stale cache, runs unrelated work, then runs the durable successor", async () => {
    const key = randomUUID();
    await enqueueDelta(boss, account, key, "poll");
    const [active] = await staleFetch(delta);
    expect(active).toBeDefined();
    const incoming = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        enqueueDelta(i % 2 ? boss : producer, account, key, "idle"),
      ),
    );
    expect(incoming.filter(Boolean)).toHaveLength(1);
    expect(
      (await jobs(delta, key)).filter((j) => j.state === "created"),
    ).toHaveLength(1);
    for (let i = 0; i < 10; i++)
      expect(await staleFetch(delta)).toHaveLength(0);
    const other = randomUUID();
    await enqueueDelta(producer, account, other, "manual");
    const [unrelated] = await staleFetch(delta);
    expect(unrelated.data.mailboxId).toBe(other);
    await boss.complete(delta, unrelated.id);
    await boss.complete(delta, active.id);
    const [successor] = await staleFetch(delta);
    expect(successor.data.mailboxId).toBe(key);
    expect(successor.data.reason).toBe("idle");
    await boss.complete(delta, successor.id);
    expect(await staleFetch(delta)).toHaveLength(0);
    // Direct SQL execution above does not swallow 23505 like Manager.fetch:
    // every stale-cache fetch must actually succeed, not merely return [].
  });
  it("coalesces created requests across producers", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        enqueueDelta(i % 2 ? boss : producer, account, key, "poll"),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await jobs(delta, key)).toHaveLength(1);
    const [job] = await staleFetch(delta);
    await boss.complete(delta, job.id);
  });
  it("coalesces into retry without resetting its delay, attempts or limit", async () => {
    const key = randomUUID();
    await enqueueDelta(boss, account, key, "poll");
    const [job] = await staleFetch(delta);
    await boss.fail(delta, job.id, { message: "temporary network failure" });
    const [before] = await jobs(delta, key);
    expect(before.state).toBe("retry");
    expect(await enqueueDelta(producer, account, key, "idle")).toBe(false);
    const [after] = await jobs(delta, key);
    expect(after).toEqual(before);
    expect(after.retryLimit).toBe(4);
    expect(new Date(after.startAfter).getTime()).toBeGreaterThan(Date.now());
  });
  it("coalesces identical backfill frontiers and preserves a distinct continuation", async () => {
    const key = randomUUID();
    await enqueueBackfill(boss, account, key, "50");
    const [active] = await staleFetch(backfill);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        enqueueBackfill(i % 2 ? boss : producer, account, key, "50"),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    for (let i = 0; i < 5; i++)
      expect(await staleFetch(backfill)).toHaveLength(0);
    expect(await enqueueBackfill(producer, account, key, "25")).toBe(true);
    await boss.complete(backfill, active.id);
    const [same] = await staleFetch(backfill);
    expect(same).toBeDefined();
    await boss.complete(backfill, same.id);
    const [continuation] = await staleFetch(backfill);
    expect(continuation).toBeDefined();
    await boss.complete(backfill, continuation.id);
  });
  it("retains database uniqueness as the backstop for simultaneous claims", async () => {
    const key = randomUUID();
    await enqueueDelta(boss, account, key, "poll");
    const [first] = await staleFetch(delta);
    await enqueueDelta(producer, account, key, "idle");
    const second = (await jobs(delta, key)).find((j) => j.state === "created")!;
    // A failed active attempt and its successor are two distinct eligible rows.
    await boss.fail(delta, first.id, { message: "temporary failure" });
    const tx1 = await boss.getDb().beginTransaction!();
    const tx2 = await producer.getDb().beginTransaction!();
    // Force simultaneous claims past the selection check to exercise the index.
    await tx1.db.executeSql(
      "UPDATE pgboss.job SET state='active' WHERE id=$1",
      [first.id],
    );
    const competing = tx2.db.executeSql(
      "UPDATE pgboss.job SET state='active' WHERE id=$1",
      [second.id],
    );
    const assertion = expect(competing).rejects.toMatchObject({
      code: "23505",
      constraint: "job_common_i3",
    });
    await tx1.commit();
    await assertion;
    await tx2.rollback();
    await boss.complete(delta, first.id);
    const [remaining] = await staleFetch(delta);
    await boss.complete(delta, remaining.id);
  });
});
