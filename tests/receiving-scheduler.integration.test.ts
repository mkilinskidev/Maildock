import { randomUUID } from "node:crypto";
import postgres from "postgres";
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
  type ReceivingDatabase,
} from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import {
  ReceivingScheduler,
  type ReceivingAdmission,
} from "@/modules/mail/application/receiving-scheduler";
import type { ReceivingCoordinatorConfig } from "@/modules/mail/application/receiving-coordinator";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";
import { delay, until } from "../experiments/imap-transport/fixture";

type Turn = Awaited<
  ReturnType<
    typeof import("@/modules/mail/application/receiving-inbox-turn").receiveInboxTurn
  >
>;
type MutableAccountConfig = {
  -readonly [
    K in keyof Omit<ReceivingCoordinatorConfig, "executor">
  ]: ReceivingCoordinatorConfig[K];
};
describe("isolated shared receiving scheduler", () => {
  let container: StartedTestContainer;
  let url: string;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let actor: string, generation: bigint;
  const cleanup: (() => Promise<unknown>)[] = [];
  const owner = () => ({ actor, generation });
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
    await root`create database stage3b owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/stage3b`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    actor = randomUUID();
    const [term] =
      await reader`select maildock_receiving_takeover(${actor},60000) as generation`;
    generation = BigInt(term.generation);
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const executor = (capacity: number) => {
    const exec = new ReceivingExecutor(url, capacity);
    cleanup.push(() => exec.stop());
    return exec;
  };
  async function renew(db: ReceivingDatabase) {
    const [lease] = await db.execute(
      sql`select owner,generation,expires_at>clock_timestamp() as live from receiving_coordinator where singleton for update`,
    );
    if (
      lease.owner !== actor ||
      BigInt(lease.generation as string) !== generation ||
      !lease.live
    )
      throw new Error("Fixture owner fenced");
    await db.execute(
      sql`update receiving_coordinator set expires_at=clock_timestamp()+interval '60 seconds' where singleton`,
    );
  }
  async function account(
    exec: ReceivingExecutor,
    script: WindowPeerOptions = {},
    initialize = true,
  ) {
    const id = randomUUID(),
      mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "Stage3B fixture",
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
      remotePath: "INBOX",
      name: "INBOX",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    if (initialize)
      await new ReceivingPersistence(exec).initialize(
        owner(),
        mailbox,
        { complete: true, epoch: 7n, uidNext: 1025n },
        { deadline: performance.now() + 5000 },
      );
    script.boundedMailbox = true;
    script.uids ??= [1, 129, 257, 385, 513, 641, 769, 897, 1024];
    script.uidNext ??= 1025;
    const peer = await metadataPeer(script);
    cleanup.push(peer.cleanup);
    const turns: { kind: string; turn: Turn; at: number }[] = [];
    const errors: { error: unknown; retry: number; at: number }[] = [];
    const config: MutableAccountConfig = {
      connection: peer.connection,
      owner: owner(),
      account: id,
      mailbox,
      authority: { assertCurrent: () => {}, renew },
      timing: { pollMs: 50, operationMs: 3000, retryMs: 100, maxRetryMs: 400 },
      createClient: peer.createClient,
      onTurn: (kind, turn) => turns.push({ kind, turn, at: performance.now() }),
      onError: (error, retry) =>
        errors.push({ error, retry, at: performance.now() }),
    };
    return { id, mailbox, script, peer, turns, errors, config };
  }
  type Account = Awaited<ReturnType<typeof account>>;
  function scheduler(
    accounts: Account[],
    exec: ReceivingExecutor,
    overrides: Partial<
      ConstructorParameters<typeof ReceivingScheduler>[0]
    > = {},
  ) {
    const admissions: ReceivingAdmission[] = [];
    let maxSockets = 0;
    let overlap = false;
    for (const a of accounts) {
      a.config.createClient = (options) => {
        if (a.peer.observed.some((client) => !client.isClosed)) overlap = true;
        const client = a.peer.createClient(options);
        maxSockets = Math.max(
          maxSockets,
          accounts.flatMap((a) => a.peer.observed).filter((c) => !c.isClosed)
            .length,
        );
        return client;
      };
    }
    const instance = new ReceivingScheduler({
      executor: exec,
      accounts: accounts.map((a) => a.config),
      onAdmission: (admission) => admissions.push(admission),
      ...overrides,
    });
    cleanup.push(() => instance.stop());
    instance.start();
    return { instance, admissions, resources: () => ({ maxSockets, overlap }) };
  }
  const state = async (a: Account) =>
    (
      await reader`select * from receiving_mailboxes where mailbox_id=${a.mailbox}`
    )[0];
  const placements = async (a: Account) =>
    await reader`select uid,uid_validity from receiving_current_placements where mailbox_id=${a.mailbox} order by uid`;
  async function waitFor(predicate: () => Promise<boolean>, ms = 10_000) {
    const end = performance.now() + ms;
    while (!(await predicate())) {
      if (performance.now() >= end)
        throw new Error("Stage3B durable barrier timed out");
      await delay(5);
    }
  }
  function retired(
    accounts: Account[],
    run: ReturnType<typeof scheduler>,
    limit: number,
  ) {
    expect(run.instance.snapshot.active).toBe(0);
    expect(run.resources().overlap).toBe(false);
    expect(run.resources().maxSockets).toBeLessThanOrEqual(limit);
    expect(
      Math.max(...run.admissions.map((a) => a.active)),
    ).toBeLessThanOrEqual(limit);
    expect(
      accounts.every((a) => a.peer.observed.every((c) => c.isClosed)),
    ).toBe(true);
    for (const a of accounts)
      expect(
        a.peer.commands.some((c) => /IDLE|SEARCH ALL|BODY\[\]/.test(c.command)),
      ).toBe(false);
  }

  it.each([1, 2, 4])(
    "W=%i bounds simultaneous operations and safely cancels/restarts active accounts",
    async (workers) => {
      const exec = executor(2);
      const accounts: Account[] = [];
      for (let i = 0; i < 5; i++)
        accounts.push(await account(exec, { select: "hung" }));
      const run = scheduler(accounts, exec, { tuning: { workers } });
      await until(
        () =>
          accounts
            .flatMap((a) => a.peer.commands)
            .filter((c) => /^(SELECT|EXAMINE)/.test(c.command)).length ===
          workers,
        5000,
      );
      expect(run.instance.snapshot.active).toBe(workers);
      expect(run.resources().maxSockets).toBe(workers);
      await run.instance.stop();
      retired(accounts, run, workers);
      const before = accounts.map((a) => a.peer.observed.length);
      await delay(100);
      expect(accounts.map((a) => a.peer.observed.length)).toEqual(before);
      for (const a of accounts) {
        a.script.select = undefined;
        a.script.uids!.push(1025);
        a.script.uidNext = 1026;
        expect(BigInt((await state(a)).fresh_through)).toBe(1024n);
      }
      const restarted = scheduler(accounts, exec, { tuning: { workers } });
      await waitFor(async () =>
        (await Promise.all(accounts.map(state))).every(
          (s) =>
            BigInt(s.history_before) === 1n &&
            BigInt(s.fresh_through) === 1025n,
        ),
      );
      await restarted.instance.stop();
      retired(accounts, restarted, workers);
      expect(restarted.admissions.slice(0, 5).map((a) => a.kind)).toEqual(
        Array(5).fill("fresh"),
      );
      for (const a of accounts) {
        expect(a.errors).toEqual([]);
        const rows = await placements(a);
        expect(rows.map((r) => BigInt(r.uid))).toEqual(
          a.script.uids!.map(BigInt),
        );
        expect(rows.every((r) => BigInt(r.uid_validity) === 7n)).toBe(true);
      }
    },
  );

  it.each([1, 2, 4])(
    "W=%i selects due fresh at returning history boundaries and measures durable visibility",
    async (workers) => {
      const exec = executor(2);
      let held = 0;
      const accounts: Account[] = [];
      for (let i = 0; i < 5; i++)
        accounts.push(
          await account(exec, {
            onCommand: (p, c) => {
              const range = /^UID SEARCH UID (\d+):(\d+)$/.exec(c.command);
              if (range && Number(range[2]) <= 1024) {
                held++;
                const a = accounts.find((a) => a.peer.commands.includes(c))!;
                const hits = a.script.uids!.filter(
                  (uid) => uid >= Number(range[1]) && uid <= Number(range[2]),
                );
                p.send(`* SEARCH ${hits.join(" ")}\r\n`, c);
                p.later(250, () => p.ok(c));
                return true;
              }
            },
          }),
        );
      const run = scheduler(accounts, exec, {
        tuning: { workers, historyWaitMs: 30_000 },
      });
      await until(() => held >= workers, 5000);
      const injected = performance.now(),
        offset = run.admissions.length;
      for (const a of accounts) {
        a.script.uids!.push(1025);
        a.script.uidNext = 1026;
      }
      const samples: number[] = [];
      const pending = new Set(accounts);
      await waitFor(async () => {
        for (const a of pending) {
          const [row] =
            await reader`select uid from receiving_current_placements where mailbox_id=${a.mailbox} and uid=1025`;
          if (row) {
            samples.push(performance.now() - injected);
            pending.delete(a);
          }
        }
        return pending.size === 0;
      });
      await run.instance.stop();
      retired(accounts, run, workers);
      expect(
        run.admissions.slice(offset, offset + 5).map((a) => a.kind),
      ).toEqual(Array(5).fill("fresh"));
      expect(
        new Set(run.admissions.slice(offset, offset + 5).map((a) => a.account))
          .size,
      ).toBe(5);
      expect(Math.max(...samples)).toBeLessThan(5000);
      for (const a of accounts) {
        expect(a.errors).toEqual([]);
        expect(BigInt((await state(a)).history_before)).toBeGreaterThan(1n);
      }
      process.stdout.write(
        `Stage3B fresh visibility W=${workers}: ${samples.map((n) => n.toFixed(2)).join(",")} ms\n`,
      );
    },
  );

  it.each([1, 2, 4])(
    "W=%i rotates continuously busy fresh accounts and gives repeated protected history opportunities",
    async (workers) => {
      const exec = executor(2),
        accounts: Account[] = [];
      const historyDurations: number[] = [];
      const historyWaits: number[] = [];
      const freshWaits: number[] = [];
      const admissions: ReceivingAdmission[] = [];
      for (let i = 0; i < 5; i++) {
        const a = await account(exec, {
          uids: [1, 129, 257, 385, 513, 641, 769, 897, 1024, 1025, 1153, 1281],
          uidNext: 1409,
          taggedDelay: 15,
        });
        const record = a.config.onTurn!;
        a.config.onTurn = (kind, turn) => {
          record(kind, turn);
          if (kind === "fresh") {
            // Replenish one sparse 128-UID window per serviced turn: the durable
            // frontier stays two bounded windows behind, never an infinite queue.
            a.script.uids!.push(a.script.uidNext!);
            a.script.uidNext! += 128;
          } else {
            const admission = admissions.findLast(
              (entry) => entry.account === a.id,
            )!;
            historyDurations.push(performance.now() - admission.at);
          }
        };
        accounts.push(a);
      }
      const run = scheduler(accounts, exec, {
        tuning: {
          workers,
          historyWaitMs: 100,
          historyTurnMs: 1000,
          freshWaitGuardMs: 5000,
        },
        onAdmission: (entry) => {
          admissions.push(entry);
          if (entry.kind === "history") historyWaits.push(entry.waitMs);
          else freshWaits.push(entry.waitMs);
        },
      });
      await until(
        () =>
          accounts.every(
            (a) => a.turns.filter((t) => t.kind === "history").length >= 2,
          ),
        15_000,
      );
      await run.instance.stop();
      retired(accounts, { ...run, admissions }, workers);
      expect(
        admissions
          .filter((a) => a.kind === "history")
          .every((a) => a.protectedHistory),
      ).toBe(true);
      expect(admissions.slice(0, 5).map((a) => a.kind)).toEqual(
        Array(5).fill("fresh"),
      );
      const protectedAccounts = admissions
        .filter((a) => a.protectedHistory)
        .map((a) => a.account);
      expect(protectedAccounts.slice(0, 5)).toEqual(accounts.map((a) => a.id));
      for (let i = 1; i < admissions.length; i++)
        if (admissions[i].protectedHistory)
          expect(admissions[i - 1].protectedHistory).toBe(false);
      if (workers === 1) {
        const fresh = admissions
          .filter((a) => a.kind === "fresh")
          .map((a) => a.account);
        for (let i = 0; i < fresh.length; i++)
          expect(fresh[i]).toBe(accounts[i % 5].id);
      }
      expect(Math.max(...freshWaits)).toBeLessThan(5000);
      for (const a of accounts) {
        expect(a.errors).toEqual([]);
        const saved = await state(a);
        expect(BigInt(saved.fresh_through)).toBeGreaterThan(1024n);
        expect(BigInt(saved.history_before)).toBeLessThanOrEqual(769n);
        const rows = await placements(a);
        expect(
          new Set(rows.map((r) => `${r.uid_validity}:${r.uid}`)).size,
        ).toBe(rows.length);
      }
      process.stdout.write(
        `Stage3B sustained W=${workers}: history wait=[${historyWaits.map((n) => n.toFixed(2))}]; protected cost=[${historyDurations.map((n) => n.toFixed(2))}]; fresh waits=[${freshWaits.map((n) => n.toFixed(2))}] ms\n`,
      );
    },
  );

  it("backs off one hung account independently while healthy accounts commit", async () => {
    const exec = executor(1);
    const bad = await account(exec, { select: "hung" });
    bad.config.timing = {
      pollMs: 100,
      operationMs: 300,
      retryMs: 200,
      maxRetryMs: 400,
    };
    const healthy = await account(exec, { uids: [1, 1025], uidNext: 1026 });
    const run = scheduler([bad, healthy], exec, { tuning: { workers: 2 } });
    await until(() => bad.errors.length >= 2, 5000);
    await waitFor(
      async () => BigInt((await state(healthy)).history_before) === 1n,
    );
    await run.instance.stop();
    retired([bad, healthy], run, 2);
    expect(healthy.errors).toEqual([]);
    expect(BigInt((await state(healthy)).fresh_through)).toBe(1025n);
    expect(bad.errors.slice(0, 2).map((e) => e.retry)).toEqual([200, 400]);
    expect(healthy.turns[0].at).toBeLessThan(bad.errors[0].at);
    expect(BigInt((await state(bad)).fresh_through)).toBe(1024n);
  });

  it.each(["health", "latency"] as const)(
    "history age cannot override the %s gate; recovery restores opportunities",
    async (gate) => {
      const exec = executor(1),
        a = await account(exec, {
          uids: [1, 1025, 1153, 1281],
          uidNext: 1409,
          taggedDelay: 10,
        });
      const record = a.config.onTurn!;
      a.config.onTurn = (kind, turn) => {
        record(kind, turn);
        if (kind === "fresh") {
          a.script.uids!.push(a.script.uidNext!);
          a.script.uidNext! += 128;
        }
      };
      let healthy = false;
      const run = scheduler([a], exec, {
        tuning: {
          workers: 1,
          historyWaitMs: 1,
          historyTurnMs: 1000,
          freshWaitGuardMs: gate === "latency" ? 1 : 5000,
        },
        historyAllowed: () => gate === "latency" || healthy,
      });
      await until(() => a.turns.length >= 4, 5000);
      expect(a.turns.every((t) => t.kind === "fresh")).toBe(true);
      expect(BigInt((await state(a)).history_before)).toBe(1025n);
      if (gate === "health") {
        healthy = true;
        await until(() => a.turns.some((t) => t.kind === "history"), 5000);
      }
      await run.instance.stop();
      retired([a], run, 1);
      expect(a.errors).toEqual([]);
    },
  );

  it("coalesces quiet accounts, enforces separate DB capacity, and contains diagnostic failures", async () => {
    const exec = executor(1),
      accounts: Account[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await account(exec, { uids: [], uidNext: 1 }, false);
      a.config.timing = { pollMs: 1000 };
      const record = a.config.onTurn!;
      a.config.onTurn = (kind, turn) => {
        record(kind, turn);
        throw new Error("Observer failure");
      };
      accounts.push(a);
    }
    const run = scheduler(accounts, exec, {
      tuning: { workers: 4 },
      onAdmission: () => {
        throw new Error("Observer failure");
      },
    });
    await until(() => accounts.every((a) => a.turns.length === 1), 5000);
    expect(run.instance.snapshot.limit).toBe(2);
    const connections = accounts.map((a) => a.peer.observed.length);
    await delay(200);
    expect(accounts.map((a) => a.peer.observed.length)).toEqual(connections);
    await run.instance.stop();
    expect(run.instance.snapshot.active).toBe(0);
    expect(run.resources().maxSockets).toBeLessThanOrEqual(2);
    for (const a of accounts) {
      expect(a.errors).toEqual([]);
      expect(BigInt((await state(a)).history_before)).toBe(1n);
    }
    expect(() => run.instance.start()).toThrow();
    expect(
      () =>
        new ReceivingScheduler({
          executor: exec,
          accounts: [accounts[0].config, accounts[0].config],
        }),
    ).toThrow("Duplicate");
    expect(
      () =>
        new ReceivingScheduler({
          executor: exec,
          accounts: accounts.map((a) => a.config),
          tuning: { maxAccounts: 1 },
        }),
    ).toThrow();
  });
});
