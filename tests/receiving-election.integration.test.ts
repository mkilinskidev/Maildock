import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { PgBoss } from "pg-boss";
import { sql } from "drizzle-orm";
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
} from "@/shared/infrastructure/database/schema";
import {
  ReceivingExecutor,
  ReceivingUnresolvedError,
} from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import { ReceivingDemand } from "@/modules/mail/application/receiving-demand";
import {
  enqueueReceivingWake,
  registerReceivingWakeDelivery,
  RECEIVING_WAKE_QUEUE,
} from "@/modules/mail/infrastructure/receiving-wake-jobs";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";
import type { ReceivingOwner } from "@/shared/infrastructure/database/receiving-authority";
import type { ProviderConnection } from "@/modules/accounts/domain/mail-provider";

const budget = () => ({ deadline: performance.now() + 5000 });
async function until(predicate: () => Promise<boolean> | boolean) {
  const end = performance.now() + 10000;
  while (!(await predicate())) {
    if (performance.now() >= end) throw new Error("Stage 4B barrier timed out");
    await delay(5); // Observe a deterministic state/barrier, never time a fault.
  }
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Reply = {
  id?: number;
  result?: unknown;
  error?: string;
  event?: string;
  kind?: string;
  snapshot?: {
    phase: string;
    owner?: { actor: string; generation: string };
    scheduler?: { active: number; stopped: boolean };
  };
};

describe("Stage 4B elected receiving ownership, isolated processes/PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let url: string;
  const cleanups: (() => Promise<unknown>)[] = [];
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
    await root`create database stage4b owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/stage4b`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 5 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const executor = () => {
    const exec = new ReceivingExecutor(url, 1);
    cleanups.push(() => exec.stop());
    return exec;
  };
  async function account(withMailbox = true) {
    const id = randomUUID(),
      mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Stage4B fixture",
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
    if (withMailbox)
      await database.db.insert(mailboxes).values({
        id: mailbox,
        accountId: id,
        remotePath: "INBOX",
        name: "INBOX",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
    return { id, mailbox };
  }
  async function peer(options: WindowPeerOptions = {}) {
    options.boundedMailbox ??= true;
    const value = await metadataPeer(options);
    cleanups.push(value.cleanup);
    return value;
  }
  const owner = (reply: Reply): ReceivingOwner => ({
    actor: reply.snapshot!.owner!.actor,
    generation: BigInt(reply.snapshot!.owner!.generation),
  });
  async function snapshot(mailbox: string) {
    const [row] =
      await reader`select s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after,
      m.receiving_due_at<=clock_timestamp() as due,m.receiving_request_generation as demand_generation,
      array(select p.uid::text from receiving_current_placements p where p.mailbox_id=m.id order by p.uid) as uids,
      (select count(*)::int from mailbox_messages p where p.mailbox_id=m.id) as placements,
      (select count(*)::int from messages msg where msg.account_id=m.account_id) as messages,
      array(select concat_ws(':',e.sequence,e.mailbox_id,e.uid_validity,e.uid) from notification_events e where e.mailbox_id=m.id order by e.uid) as events
      from mailboxes m left join receiving_mailboxes s on s.mailbox_id=m.id where m.id=${mailbox}`;
    return row;
  }
  async function leaseExpired() {
    await until(
      async () =>
        (
          await reader`select expires_at<=clock_timestamp() as expired from receiving_coordinator`
        )[0].expired,
    );
  }
  async function processCoordinator(
    connection: ProviderConnection,
    leaseMs = 2000,
  ) {
    const child = fork("tests/fixtures/receiving-election-process.ts", [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        STAGE4B_FIXTURE: JSON.stringify({ url, connection, leaseMs }),
      },
    });
    const events: Reply[] = [];
    let seq = 0,
      stderr = "",
      frozenPort: number | undefined;
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("message", (message: Reply) => events.push(message));
    const command = async (command: string, account?: string) => {
      const id = ++seq;
      child.send({ id, command, account });
      await until(() => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Child exited: ${stderr}`);
        return events.some((e) => e.id === id);
      });
      const reply = events.find((e) => e.id === id)!;
      if (reply.error) throw new Error(reply.error);
      if (command === "freeze") frozenPort = reply.result as number;
      return reply;
    };
    const resume = async () => {
      if (frozenPort === undefined) return;
      await new Promise<void>((resolve, reject) => {
        const socket = connect(frozenPort!, "127.0.0.1", () =>
          socket.end("release"),
        );
        socket.once("error", reject);
        socket.once("close", () => resolve());
      });
      frozenPort = undefined;
    };
    const kill = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exited;
    };
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await resume();
        await command("stop");
        await kill();
      }
    });
    await until(() => {
      if (child.exitCode !== null)
        throw new Error(`Child startup failed: ${stderr}`);
      return events.some((e) => e.event === "ready");
    });
    return { child, command, events, resume, kill };
  }

  it("R06 two processes contest zero-mailbox bootstrap; only elected process publishes one canonical INBOX", async () => {
    const a = await account(false);
    const p1 = await peer({ uids: [], uidNext: 1 }),
      p2 = await peer({ uids: [], uidNext: 1 });
    const c1 = await processCoordinator(p1.connection),
      c2 = await processCoordinator(p2.connection);
    const results = await Promise.all([
      c1.command("elect"),
      c2.command("elect"),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual([false, true]);
    await until(
      async () =>
        (
          await reader`select count(*)::int n from receiving_mailboxes s join mailboxes m on m.id=s.mailbox_id where m.account_id=${a.id}`
        )[0].n === 1,
    );
    const followerPeer = results[0].result ? p2 : p1;
    expect(followerPeer.peers).toHaveLength(0);
    const folders =
      await reader`select m.*,s.epoch,s.revision from mailboxes m join receiving_mailboxes s on s.mailbox_id=m.id where m.account_id=${a.id}`;
    expect(folders).toHaveLength(1);
    expect(folders[0].epoch).toBe("7");
    expect(folders[0].revision).toBe("0");
  });

  it("R06 process crash during SELECT leaves no identity; successor bootstraps after locked takeover", async () => {
    const a = await account(false);
    const broken = await peer({ uids: [], uidNext: 1, select: "hung" }),
      good = await peer({ uids: [], uidNext: 1 });
    const old = await processCoordinator(broken.connection),
      next = await processCoordinator(good.connection);
    expect((await old.command("elect")).result).toBe(true);
    await until(() =>
      broken.commands.some((c) => /^(SELECT|EXAMINE) /.test(c.command)),
    );
    await old.kill();
    expect(
      await reader`select id from mailboxes where account_id=${a.id}`,
    ).toHaveLength(0);
    await leaseExpired();
    expect((await next.command("elect")).result).toBe(true);
    await until(
      async () =>
        (
          await reader`select count(*)::int n from receiving_mailboxes s join mailboxes m on m.id=s.mailbox_id where m.account_id=${a.id}`
        )[0].n === 1,
    );
    expect(
      await reader`select id from mailboxes where account_id=${a.id}`,
    ).toHaveLength(1);
  });

  it("R03 typed diagnostics use the winning process only and stale takeover clients cannot resume", async () => {
    const p1 = await peer(),
      p2 = await peer();
    const c1 = await processCoordinator(p1.connection),
      c2 = await processCoordinator(p2.connection);
    const results = await Promise.all([
      c1.command("elect"),
      c2.command("elect"),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual([false, true]);
    const elected = results[0].result ? c1 : c2,
      follower = results[0].result ? c2 : c1;
    const followerPeer = results[0].result ? p2 : p1;
    await expect(follower.command("diagnostic")).rejects.toThrow("unavailable");
    expect(
      follower.events.filter((e) => e.event === "operationClient"),
    ).toHaveLength(0);
    expect(followerPeer.peers).toHaveLength(0);
    await elected.command("diagnostic");
    expect(
      elected.events.filter((e) => e.event === "operationClient"),
    ).toHaveLength(1);
    await elected.command("freeze");
    await leaseExpired();
    expect((await follower.command("elect")).result).toBe(true);
    await follower.command("diagnostic");
    await elected.resume();
    await expect(elected.command("diagnostic")).rejects.toThrow();
    expect(
      elected.events.filter((e) => e.event === "operationClient"),
    ).toHaveLength(1);
    expect(
      follower.events.filter((e) => e.event === "operationClient"),
    ).toHaveLength(1);
  });

  it("two independent processes contend atomically; follower wakes stay passive; only elected owner admits sockets", async () => {
    const a = await account();
    const p1 = await peer({ uids: [], uidNext: 1, select: "hung" });
    const p2 = await peer({ uids: [], uidNext: 1, select: "hung" });
    const c1 = await processCoordinator(p1.connection),
      c2 = await processCoordinator(p2.connection);
    const holder = await reader.reserve();
    await holder`begin`;
    await holder`select singleton from receiving_coordinator for update`;
    const first = c1.command("elect"),
      second = c2.command("elect");
    try {
      await until(
        async () =>
          Number(
            (
              await reader`select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%maildock_receiving_acquire%'`
            )[0].count,
          ) === 2,
      );
    } finally {
      await holder`commit`;
      holder.release();
    }
    const replies = await Promise.all([first, second]);
    expect(replies.map((r) => r.result).sort()).toEqual([false, true]);
    const winning = replies[0].result ? c1 : c2,
      following = replies[0].result ? c2 : c1;
    const winningPeer = replies[0].result ? p1 : p2,
      followingPeer = replies[0].result ? p2 : p1;
    await until(() =>
      winningPeer.commands.some((c) => c.command.startsWith("SELECT")),
    );
    const boss = new PgBoss({ connectionString: url });
    boss.on("error", () => {});
    await boss.start();
    cleanups.push(() => boss.stop());
    const demand = new ReceivingDemand(database.db, (id) =>
      enqueueReceivingWake(boss, id),
    );
    await registerReceivingWakeDelivery(boss, demand, {
      notify: async (id) => {
        await following.command("notify", id);
      },
    });
    await demand.request(a.id, a.mailbox);
    await until(async () =>
      (await boss.findJobs(RECEIVING_WAKE_QUEUE, { key: a.id })).some(
        (job) => job.state === "completed",
      ),
    );
    const before = await snapshot(a.mailbox);
    await following.command("notify", a.id);
    expect(
      following.events.filter((e) => e.event === "admission"),
    ).toHaveLength(0);
    expect(followingPeer.peers).toHaveLength(0);
    expect(await snapshot(a.mailbox)).toEqual(before);
    const [lease] =
      await reader`select owner,generation from receiving_coordinator`;
    const elected = owner(replies.find((r) => r.result)!);
    expect(lease.owner).toBe(elected.actor);
    expect(BigInt(lease.generation)).toBe(elected.generation);
    await winning.command("stop");
    await until(() => winningPeer.peers.every((p) => p.socket.destroyed));
    expect((await following.command("elect")).result).toBe(true);
    expect(
      BigInt(
        (await reader`select generation from receiving_coordinator`)[0]
          .generation,
      ),
    ).toBe(elected.generation + 1n);
  });

  it("renewal keeps generation; expiry and takeover reject old renewal and old release", async () => {
    const p = await peer({ uids: [], uidNext: 1 });
    const first = await processCoordinator(p.connection, 800);
    const elected = owner(await first.command("elect"));
    expect((await first.command("renew")).result).toBe(true);
    expect(
      BigInt(
        (await reader`select generation from receiving_coordinator`)[0]
          .generation,
      ),
    ).toBe(elected.generation);
    const next = await processCoordinator(p.connection, 2000);
    await first.command("freeze");
    await leaseExpired();
    const replacement = owner(await next.command("elect"));
    expect(replacement.generation).toBe(elected.generation + 1n);
    const [delayed] =
      await reader`select maildock_receiving_renew(${elected.actor},${elected.generation.toString()},1000) as renewed,
      maildock_receiving_release(${elected.actor},${elected.generation.toString()}) as released`;
    expect(delayed).toMatchObject({ renewed: false, released: false });
    await first.resume();
    expect((await first.command("renew")).result).toBe(false);
    expect((await first.command("elect")).result).toBe(false);
    expect(
      (await reader`select owner from receiving_coordinator`)[0].owner,
    ).toBe(replacement.actor);
  });

  it("renewal rechecks database expiry after waiting for a conflicting lock", async () => {
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor},400) as generation`;
    const holder = await reader.reserve();
    await holder`begin`;
    await holder`select singleton from receiving_coordinator for update`;
    const renewal =
      reader`select maildock_receiving_renew(${actor},${lease.generation},2000) as renewed`.then(
        (rows) => rows[0],
      );
    const validation =
      reader`select maildock_receiving_validate(${actor},${lease.generation}) as live`.then(
        (rows) => rows[0],
      );
    try {
      await until(
        async () =>
          (
            await reader`select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%maildock_receiving_renew%'`
          )[0].n > 0,
      );
      await leaseExpired();
    } finally {
      await holder`commit`;
      holder.release();
    }
    expect((await renewal).renewed).toBe(false);
    expect((await validation).live).toBe(false);
  });

  it("suspended owner during FETCH loses generation; replacement publishes once and stale evidence is rejected", async () => {
    const a = await account();
    // Enroll without executing history, then hand off to the process owner.
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor},60000) as generation`;
    const staleSeed = { actor, generation: BigInt(lease.generation) };
    const exec = executor();
    await new ReceivingPersistence(exec).initialize(
      staleSeed,
      a.mailbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await reader`select maildock_receiving_release(${actor},${lease.generation})`;
    const oldPeer = await peer({ uids: [2], uidNext: 3, fetch: "hung" });
    const old = await processCoordinator(oldPeer.connection, 2000);
    const stale = owner(await old.command("elect"));
    await until(() =>
      oldPeer.commands.some((c) => c.command.startsWith("UID FETCH")),
    );
    await old.command("freeze");
    const before = await snapshot(a.mailbox);
    const newPeer = await peer({ uids: [1, 2], uidNext: 3 });
    const next = await processCoordinator(newPeer.connection);
    await leaseExpired();
    const replacement = owner(await next.command("elect"));
    await until(async () => (await snapshot(a.mailbox)).history_before === "1");
    const committed = await snapshot(a.mailbox);
    expect(committed).toMatchObject({
      epoch: "7",
      fresh_through: "2",
      history_before: "1",
      revision: "2",
      uids: ["1", "2"],
      placements: 2,
      messages: 2,
    });
    expect(committed.events).toHaveLength(1);
    expect(replacement.generation).toBe(stale.generation + 1n);
    await expect(
      new ReceivingPersistence(exec).persist(
        stale,
        a.mailbox,
        {
          epoch: 7n,
          revision: 0n,
          freshThrough: 1n,
          historyBefore: 2n,
          reconcileAfter: 0n,
        },
        {
          kind: "fresh",
          evidence: {
            complete: true,
            epoch: 7n,
            low: 2n,
            high: 2n,
            searched: [2n],
            confirmedAbsent: [],
          },
          metadata: [
            {
              uid: "2",
              modseq: "1",
              internalDate: "2026-10-14T00:00:00Z",
              size: "100",
              flags: [],
              hasAttachments: false,
              envelope: {
                messageId: "<stage2-2@example.test>",
                subject: "Stale owner metadata",
                from: [],
                sender: [],
                replyTo: [],
                to: [],
                cc: [],
                bcc: [],
              },
            },
          ],
        },
        budget(),
      ),
    ).rejects.toMatchObject({ cause: { message: "Receiving owner fenced" } });
    await old.resume();
    expect((await old.command("renew")).result).toBe(false);
    expect((await old.command("snapshot")).snapshot?.phase).toBe("lost");
    await until(() => oldPeer.peers.every((p) => p.socket.destroyed));
    expect(await snapshot(a.mailbox)).toEqual(committed);
    expect(before).toMatchObject({
      revision: "0",
      fresh_through: "1",
      uids: [],
      events: [],
    });
  });

  it("process crash reconstructs committed F/E and due; restarted generation grants fresh before history", async () => {
    const a = await account();
    const oldPeer = await peer({
      uids: [1, 2],
      uidNext: 3,
      onCommand: (_p, c) => c.command === "UID SEARCH UID 1:2",
    });
    const old = await processCoordinator(oldPeer.connection, 1000);
    const term = owner(await old.command("elect"));
    await until(() =>
      oldPeer.commands.some((c) => c.command === "UID SEARCH UID 1:2"),
    );
    await old.kill();
    const before = await snapshot(a.mailbox);
    expect(before).toMatchObject({
      epoch: "7",
      fresh_through: "2",
      history_before: "3",
      revision: "0",
      due: true,
    });
    const nextPeer = await peer({ uids: [1, 2, 3], uidNext: 4 });
    const next = await processCoordinator(nextPeer.connection);
    await leaseExpired();
    expect(owner(await next.command("elect")).generation).toBe(
      term.generation + 1n,
    );
    await until(async () => (await snapshot(a.mailbox)).history_before === "1");
    expect(next.events.find((e) => e.event === "admission")).toMatchObject({
      admission: { kind: "fresh" },
    });
    expect(
      nextPeer.commands.find((c) => c.command.startsWith("UID SEARCH"))
        ?.command,
    ).toBe("UID SEARCH UID 3:3");
    expect(await snapshot(a.mailbox)).toMatchObject({
      revision: "2",
      fresh_through: "3",
      history_before: "1",
      uids: ["1", "2", "3"],
      placements: 3,
      messages: 3,
      due: true,
    });
    expect((await snapshot(a.mailbox)).events).toHaveLength(1);
  });

  it("missing and duplicate wakes retain unique facts while live pages settle due", async () => {
    const a = await account();
    const script: WindowPeerOptions = { uids: [], uidNext: 1 };
    const p = await peer(script);
    const c = await processCoordinator(p.connection);
    await c.command("elect");
    await until(async () => (await snapshot(a.mailbox)).epoch === "7");
    // Initial empty enrollment. A durable request deliberately delivers no hint.
    script.uids!.push(1);
    script.uidNext = 2;
    const demand = new ReceivingDemand(database.db, async () => {});
    await demand.record(a.id, a.mailbox);
    await until(async () => (await snapshot(a.mailbox)).fresh_through === "1");
    const committed = await snapshot(a.mailbox);
    await Promise.all(
      Array.from({ length: 4 }, () => c.command("notify", a.id)),
    );
    await until(() => c.events.filter((e) => e.event === "turn").length >= 3);
    const observed = await snapshot(a.mailbox);
    // Only R15 scheduling/repair state may change after the same metadata result.
    // All canonical identities, F/E and unique arrival events remain identical.
    expect(observed).toEqual({
      ...committed,
      revision: observed.revision,
      reconcile_after: observed.reconcile_after,
      due: false,
    });
    expect(BigInt(observed.revision)).toBeGreaterThan(
      BigInt(committed.revision),
    );
    expect(["0", "1"]).toContain(observed.reconcile_after);
    expect(committed).toMatchObject({
      revision: "1",
      uids: ["1"],
      placements: 1,
      messages: 1,
      due: true,
      demand_generation: "1",
    });
    expect(committed.events).toHaveLength(1);
  });

  it("ownership loss during shutdown retires FETCH and stale release cannot retire replacement", async () => {
    const a = await account();
    const p = await peer({ uids: [1], uidNext: 2, fetch: "hung" });
    const old = await processCoordinator(p.connection);
    const stale = owner(await old.command("elect"));
    await until(() =>
      p.commands.some((c) => c.command.startsWith("UID FETCH")),
    );
    // Fixture clock fault: expire lease without waiting; no writer transaction is held.
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [next] =
      await reader`select maildock_receiving_acquire(${actor},60000) as generation`;
    await old.command("stop");
    await until(() => p.peers.every((p) => p.socket.destroyed));
    expect(
      (
        await reader`select owner,generation,expires_at>clock_timestamp() as live from receiving_coordinator`
      )[0],
    ).toMatchObject({ owner: actor, generation: next.generation, live: true });
    expect(BigInt(next.generation)).toBe(stale.generation + 1n);
    expect(await snapshot(a.mailbox)).toMatchObject({
      epoch: "7",
      revision: "0",
      uids: [],
      events: [],
      due: true,
    });
  });

  it("takeover waits for old pre-COMMIT lock; expiry before logical authority rolls progress back", async () => {
    const p = await peer({ uids: [], uidNext: 1 });
    const old = await processCoordinator(p.connection, 1500);
    const term = owner(await old.command("elect")); // No candidates yet.
    const a = await account(),
      exec = executor();
    await new ReceivingPersistence(exec).initialize(
      term,
      a.mailbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await old.command("freeze");
    const ready = barrier(),
      resume = barrier();
    const transaction = exec
      .transaction(async (db) => {
        await db.execute(
          sql`select maildock_receiving_claim(${term.actor}::uuid,${term.generation}::bigint,${a.mailbox}::uuid,7,0,1,2,0)`,
        );
        await db.execute(
          sql`update receiving_mailboxes set fresh_through=2,revision=1 where mailbox_id=${a.mailbox}::uuid`,
        );
        ready.release();
        await resume.promise;
      }, budget())
      .catch((error) => error);
    await ready.promise;
    const next = await processCoordinator(p.connection);
    await leaseExpired();
    const acquisition = next.command("elect");
    try {
      await until(
        async () =>
          (
            await reader`select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%maildock_receiving_acquire%'`
          )[0].n > 0,
      );
      expect(await snapshot(a.mailbox)).toMatchObject({
        revision: "0",
        fresh_through: "1",
      });
    } finally {
      resume.release();
    }
    expect(await transaction).toBeInstanceOf(ReceivingUnresolvedError);
    expect(owner(await acquisition).generation).toBe(term.generation + 1n);
    await next.command("stop");
    expect(await snapshot(a.mailbox)).toMatchObject({
      revision: "0",
      fresh_through: "1",
      uids: [],
      events: [],
    });
    await old.resume();
  });

  it("candidate identity/capacity errors fail closed and no loader runs on follower", async () => {
    const a = await account(),
      p = await peer();
    let loaded = 0;
    const exec = executor();
    const actor = randomUUID();
    const [term] =
      await reader`select maildock_receiving_acquire(${actor},60000) as generation`;
    const c = new ElectedReceivingCoordinator({
      executor: exec,
      loadAccount: async (_db, candidate) => {
        loaded++;
        return {
          ...candidate,
          account: randomUUID(),
          connection: p.connection,
        };
      },
    });
    cleanups.push(() => c.stop());
    expect(await c.elect()).toBe(false);
    await c.notify(a.id);
    expect(loaded).toBe(0);
    await reader`select maildock_receiving_release(${actor},${term.generation})`;
    await expect(c.elect()).rejects.toThrow("identity mismatch");
    expect(c.snapshot.phase).toBe("lost");
    expect(p.peers).toHaveLength(0);
    await c.stop();
    await account();
    const limited = new ElectedReceivingCoordinator({
      executor: exec,
      maxAccounts: 1,
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: p.connection,
      }),
    });
    cleanups.push(() => limited.stop());
    await expect(limited.elect()).rejects.toThrow("capacity exceeded");
    expect(p.peers).toHaveLength(0);
  });

  it("authorized post-L COMMIT orders before a waiting process takeover", async () => {
    const p = await peer({ uids: [], uidNext: 1 });
    const old = await processCoordinator(p.connection, 1500);
    const next = await processCoordinator(p.connection);
    const term = owner(await old.command("elect"));
    const a = await account(),
      exec = executor();
    await new ReceivingPersistence(exec).initialize(
      term,
      a.mailbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await old.command("freeze");
    const holder = await reader.reserve();
    await holder`select pg_advisory_lock(417284)`;
    await reader.unsafe(`
      CREATE FUNCTION stage4b_arm_hold() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN
        PERFORM set_config('stage4b.hold','true',true); RETURN pg_backend_pid(); END $$;
      CREATE FUNCTION stage4b_hold_after_l() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('stage4b.hold',true)='true' THEN PERFORM pg_advisory_xact_lock(417284); END IF;
        RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_stage4b_after_l AFTER UPDATE ON receiving_mailboxes
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stage4b_hold_after_l();
    `);
    let pid = 0;
    const commit = exec
      .transaction(async (db) => {
        await db.execute(
          sql`select maildock_receiving_claim(${term.actor}::uuid,${term.generation}::bigint,${a.mailbox}::uuid,7,0,1,2,0)`,
        );
        await db.execute(
          sql`update receiving_mailboxes set fresh_through=2,revision=1 where mailbox_id=${a.mailbox}::uuid`,
        );
        const [row] = await db.execute(sql`select stage4b_arm_hold() as pid`);
        pid = Number(row.pid);
      }, budget())
      .then(
        () => true,
        (error: unknown) => error,
      );
    let acquisition: Promise<Reply> | undefined;
    try {
      await until(
        async () =>
          pid > 0 &&
          (
            await reader`select count(*)::int n from pg_stat_activity where pid=${pid} and wait_event='advisory'`
          )[0].n > 0,
      );
      await leaseExpired();
      acquisition = next.command("elect");
      await until(
        async () =>
          (
            await reader`select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%maildock_receiving_acquire%'`
          )[0].n > 0,
      );
      expect(await snapshot(a.mailbox)).toMatchObject({
        revision: "0",
        fresh_through: "1",
      });
      await holder`select pg_advisory_unlock(417284)`;
      expect(await commit).toBe(true);
      expect(owner(await acquisition).generation).toBe(term.generation + 1n);
      await next.command("stop");
      expect(await snapshot(a.mailbox)).toMatchObject({
        revision: "1",
        fresh_through: "2",
        history_before: "2",
        reconcile_after: "0",
        uids: [],
        events: [],
      });
    } finally {
      await holder`select pg_advisory_unlock(417284)`;
      holder.release();
      await commit;
      await acquisition?.catch(() => undefined);
      await reader.unsafe(
        "DROP TRIGGER zzz_stage4b_after_l ON receiving_mailboxes; DROP FUNCTION stage4b_hold_after_l(); DROP FUNCTION stage4b_arm_hold();",
      );
      await old.resume();
    }
  });

  it("wake received during an active fresh turn survives its result and prompts another fresh check", async () => {
    const a = await account(),
      exec = executor();
    const actor = randomUUID();
    const [seed] =
      await reader`select maildock_receiving_acquire(${actor},60000) as generation`;
    await new ReceivingPersistence(exec).initialize(
      { actor, generation: BigInt(seed.generation) },
      a.mailbox,
      { complete: true, epoch: 7n, uidNext: 1n },
      budget(),
    );
    await reader`select maildock_receiving_release(${actor},${seed.generation})`;
    const reached = barrier();
    let resume: (() => void) | undefined;
    const script: WindowPeerOptions = {
      uids: [1],
      uidNext: 2,
      onCommand: (p, cmd) => {
        if (cmd.command === "UID SEARCH UID 1:1") {
          resume = () => {
            p.send("* SEARCH 1\r\n", cmd);
            p.ok(cmd);
          };
          reached.release();
          return true;
        }
      },
    };
    const p = await peer(script);
    const c = new ElectedReceivingCoordinator({
      executor: exec,
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: p.connection,
        createClient: p.createClient,
        timing: { pollMs: 60000 },
      }),
    });
    cleanups.push(() => c.stop());
    await c.elect();
    await reached.promise;
    await new ReceivingDemand(database.db, async () => {}).record(
      a.id,
      a.mailbox,
    );
    await c.notify(a.id);
    script.uids!.push(2);
    script.uidNext = 3;
    resume!();
    await until(async () => (await snapshot(a.mailbox)).fresh_through === "2");
    expect(await snapshot(a.mailbox)).toMatchObject({
      revision: "2",
      uids: ["1", "2"],
      demand_generation: "1",
      due: true,
    });
    expect((await snapshot(a.mailbox)).events).toHaveLength(2);
  });

  it("lease loss revokes active receiving SQL locally; takeover waits for the old backend and publishes once", async () => {
    const a = await account(),
      exec = executor();
    const actor = randomUUID();
    const [seed] =
      await reader`select maildock_receiving_acquire(${actor},60000) as generation`;
    await new ReceivingPersistence(exec).initialize(
      { actor, generation: BigInt(seed.generation) },
      a.mailbox,
      { complete: true, epoch: 7n, uidNext: 1n },
      budget(),
    );
    await reader`select maildock_receiving_release(${actor},${seed.generation})`;
    const holder = await reader.reserve();
    await holder`select pg_advisory_lock(417285)`;
    await reader.unsafe(`
      CREATE FUNCTION stage4b_wait_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(417285); RETURN NEW; END $$;
      CREATE TRIGGER zzz_stage4b_publish BEFORE UPDATE ON receiving_mailboxes
        FOR EACH ROW EXECUTE FUNCTION stage4b_wait_publish();
    `);
    const p = await peer({ uids: [1], uidNext: 2 });
    const old = new ElectedReceivingCoordinator({
      executor: exec,
      leaseMs: 1500,
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: p.connection,
        createClient: p.createClient,
      }),
    });
    const next = new ElectedReceivingCoordinator({
      executor: executor(),
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: p.connection,
        createClient: p.createClient,
      }),
    });
    cleanups.push(
      () => old.stop(),
      () => next.stop(),
    );
    let acquisition: Promise<boolean> | undefined;
    try {
      await old.elect();
      const term = old.snapshot.owner!;
      await until(
        async () =>
          (
            await reader`select count(*)::int n from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
          )[0].n > 0,
      );
      await until(
        () =>
          old.snapshot.phase === "lost" && old.snapshot.scheduler?.active === 0,
      );
      expect(old.snapshot.scheduler?.stopped).toBe(true);
      expect(await snapshot(a.mailbox)).toMatchObject({
        revision: "0",
        fresh_through: "0",
        placements: 0,
        messages: 0,
        events: [],
      });
      // Local SQL transport retired, but old backend still owns its SHARE lock.
      expect(
        (
          await reader`select count(*)::int n from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
        )[0].n,
      ).toBe(1);
      await leaseExpired();
      acquisition = next.elect();
      await until(
        async () =>
          (
            await reader`select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%maildock_receiving_acquire%'`
          )[0].n > 0,
      );
      await holder`select pg_advisory_unlock(417285)`;
      expect(await acquisition).toBe(true);
      expect(next.snapshot.owner!.generation).toBe(term.generation + 1n);
      await until(
        async () => (await snapshot(a.mailbox)).fresh_through === "1",
      );
      await next.stop();
      expect(await snapshot(a.mailbox)).toMatchObject({
        revision: "1",
        fresh_through: "1",
        uids: ["1"],
        placements: 1,
        messages: 1,
        due: true,
      });
      expect((await snapshot(a.mailbox)).events).toHaveLength(1);
    } finally {
      await holder`select pg_advisory_unlock(417285)`;
      holder.release();
      await acquisition?.catch(() => undefined);
      await old.stop();
      await next.stop();
      await reader.unsafe(
        "DROP TRIGGER zzz_stage4b_publish ON receiving_mailboxes; DROP FUNCTION stage4b_wait_publish();",
      );
    }
  });
});
