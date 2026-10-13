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
  ReceivingUnresolvedError,
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
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
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
    // Fixture-only atomic publication oracle, independently read through reader.
    await reader.unsafe(`
      CREATE TABLE stage3b_audit (mailbox uuid, epoch bigint, old_epoch bigint,
        revision bigint, old_f bigint, new_f bigint, old_e bigint, new_e bigint, uids bigint[]);
      CREATE FUNCTION stage3b_audit_progress() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO stage3b_audit SELECT NEW.mailbox_id, NEW.epoch, OLD.epoch, NEW.revision,
          OLD.fresh_through, NEW.fresh_through, OLD.history_before, NEW.history_before,
          ARRAY(SELECT uid FROM mailbox_messages WHERE mailbox_id=NEW.mailbox_id
            AND uid_validity=NEW.epoch AND ((uid>OLD.fresh_through AND uid<=NEW.fresh_through)
              OR (uid>=NEW.history_before AND uid<OLD.history_before)) ORDER BY uid);
        RETURN NEW;
      END $$;
      CREATE TRIGGER stage3b_audit AFTER UPDATE ON receiving_mailboxes
        FOR EACH ROW EXECUTE FUNCTION stage3b_audit_progress();
    `);
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
    type Observation = {
      active: boolean;
      freshDue: number;
      historySince?: number;
      historyBefore?: bigint;
    };
    const observed = new Map<string, Observation>(
      accounts.map((a) => [
        a.id,
        { active: false, freshDue: 0 } as Observation,
      ]),
    );
    const decisions: {
      admission: ReceivingAdmission;
      observed: Map<string, Observation>;
    }[] = [];
    let maxSockets = 0;
    let overlap = false;
    for (const a of accounts) {
      // Observe completion and actual socket ownership outside the selector.
      // Atomic DB audit below independently verifies the reported publications.
      const completed = a.config.onTurn;
      a.config = {
        ...a.config,
        onTurn: (kind, turn) => {
          const prior = observed.get(a.id)!;
          const now = performance.now();
          observed.set(a.id, {
            active: false,
            freshDue:
              kind === "fresh"
                ? turn.moreFresh
                  ? now
                  : now + (a.config.timing?.pollMs ?? 15_000)
                : prior.freshDue,
            historyBefore: turn.state.historyBefore,
            historySince:
              turn.state.historyBefore > 1n
                ? kind === "history"
                  ? now
                  : (prior.historySince ?? now)
                : undefined,
          });
          completed?.(kind, turn);
        },
      };
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
      ...overrides,
      onAdmission: (admission) => {
        decisions.push({
          admission,
          observed: new Map(
            [...observed].map(([id, value]) => [id, { ...value }]),
          ),
        });
        observed.get(admission.account)!.active = true;
        admissions.push(admission);
        overrides.onAdmission?.(admission);
      },
    });
    cleanup.push(() => instance.stop());
    instance.start();
    return {
      instance,
      admissions,
      decisions,
      resources: () => ({ maxSockets, overlap }),
    };
  }
  const state = async (a: Account) =>
    (
      await reader`select * from receiving_mailboxes where mailbox_id=${a.mailbox}`
    )[0];
  const placements = async (a: Account) =>
    await reader`select uid,uid_validity from receiving_current_placements where mailbox_id=${a.mailbox} order by uid`;
  async function verifyPublication(a: Account) {
    const audit =
      await reader`select * from stage3b_audit where mailbox=${a.mailbox} order by revision`;
    let f = 1024n,
      e = 1025n,
      revision = 0n;
    for (const row of audit) {
      expect(BigInt(row.epoch)).toBe(7n);
      expect(BigInt(row.old_epoch)).toBe(7n);
      expect(BigInt(row.revision)).toBe(++revision);
      expect(BigInt(row.old_f)).toBe(f);
      expect(BigInt(row.old_e)).toBe(e);
      const nextF = BigInt(row.new_f),
        nextE = BigInt(row.new_e);
      const fresh = nextF > f;
      if (fresh) {
        expect(nextF - f).toBeLessThanOrEqual(128n);
        expect(nextE).toBe(e);
      } else {
        expect(nextF).toBe(f);
        expect(nextE).toBe(e > 128n ? e - 128n : 1n);
      }
      const low = fresh ? f + 1n : nextE,
        high = fresh ? nextF : e - 1n;
      const hits = a.script
        .uids!.filter((uid) => BigInt(uid) >= low && BigInt(uid) <= high)
        .sort((x, y) => x - y);
      expect(row.uids.map(BigInt)).toEqual(hits.map(BigInt));
      const search = a.peer.commands.find(
        (c) =>
          c.command === `UID SEARCH UID ${low}:${high}` && c.taggedMs !== null,
      );
      expect(search).toBeDefined();
      if (hits.length)
        expect(
          a.peer.commands.some(
            (c) =>
              c.connection === search!.connection &&
              c.command.startsWith("UID FETCH") &&
              c.taggedMs !== null,
          ),
        ).toBe(true);
      f = nextF;
      e = nextE;
    }
    const saved = await state(a);
    expect(BigInt(saved.epoch)).toBe(7n);
    expect(BigInt(saved.fresh_through)).toBe(f);
    expect(BigInt(saved.history_before)).toBe(e);
    expect(BigInt(saved.revision)).toBe(revision);
    const rows = await placements(a);
    const expected = a.script
      .uids!.filter(
        (uid) =>
          (uid <= 1024 && BigInt(uid) >= e) ||
          (uid >= 1025 && BigInt(uid) <= f),
      )
      .sort((x, y) => x - y);
    expect(rows.map((r) => BigInt(r.uid))).toEqual(expected.map(BigInt));
    expect(rows.every((r) => BigInt(r.uid_validity) === 7n)).toBe(true);
    expect(new Set(rows.map((r) => `${r.uid_validity}:${r.uid}`)).size).toBe(
      rows.length,
    );
    return audit;
  }
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

  it.each([1, 2])(
    "isolated DB waiter handoff supports sequential borrowers at D=%i",
    async (capacity) => {
      const exec = executor(capacity);
      let held = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const errors: unknown[] = [];
      const visits: number[] = [];
      const borrowers = Array.from({ length: capacity * 2 }, (_, actor) =>
        (async () => {
          for (let turn = 0; turn < 6; turn++) {
            try {
              await exec.transaction(
                async (db) => {
                  const [row] = await db.execute(
                    sql`select ARRAY['\\Seen','a,b']::text[] as flags`,
                  );
                  expect(row.flags).toEqual(["\\Seen", "a,b"]);
                  visits.push(actor);
                  if (turn === 0 && actor < capacity) {
                    held++;
                    await barrier;
                  }
                },
                { deadline: performance.now() + 5000 },
              );
            } catch (error) {
              errors.push(error);
            }
          }
        })(),
      );
      try {
        await until(() => held === capacity, 5000);
        release();
        await Promise.all(borrowers);
        expect(errors).toEqual([]);
        expect(visits.length).toBe(capacity * 2 * 6);
      } finally {
        release();
        await Promise.all(borrowers);
      }
    },
  );

  it("isolated DB cancellation after handoff returns its reserved slot", async () => {
    const exec = executor(1),
      abort = new AbortController();
    let release!: () => void,
      ready = false;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const first = exec.transaction(
      async (db) => {
        await db.execute(sql`select 1`);
        ready = true;
        await barrier;
      },
      { deadline: performance.now() + 5000 },
    );
    await until(() => ready, 5000);
    let cancelledEntered = false;
    const cancelled = exec
      .transaction(
        async () => {
          cancelledEntered = true;
        },
        { deadline: performance.now() + 5000, signal: abort.signal },
      )
      .catch((error) => error);
    // The retiring borrower's continuation runs before the bounded waiter's
    // continuation. Cancellation must return even a synchronously granted slot.
    const cancellation = first.then(() => abort.abort());
    release();
    await cancellation;
    expect(await cancelled).toBeInstanceOf(ReceivingUnresolvedError);
    expect(cancelledEntered).toBe(false);
    expect(
      await exec.transaction(
        async (db) => (await db.execute(sql`select 32 as answer`))[0].answer,
        { deadline: performance.now() + 2000 },
      ),
    ).toBe(32);
  });

  it("isolated DB cancellation during driver type discovery has no detached rejection", async () => {
    const abort = new AbortController();
    let discovered = false;
    let bytesSeen = "";
    const relay = await receivingResponseRelay(url, (bytes) => {
      bytesSeen = (bytesSeen + bytes.toString("utf8")).slice(-4096);
      if (!discovered && bytesSeen.includes("pg_catalog.pg_type")) {
        discovered = true;
        relay.control.drop = true;
        setTimeout(() => abort.abort(), 0);
      }
    });
    cleanup.push(relay.close);
    const exec = new ReceivingExecutor(relay.url, 1);
    cleanup.push(() => exec.stop());
    const result = await exec
      .transaction(
        async () => {
          throw new Error("Business work must not start");
        },
        { deadline: performance.now() + 2000, signal: abort.signal },
      )
      .catch((error) => error);
    expect(discovered).toBe(true);
    expect(result).toBeInstanceOf(ReceivingUnresolvedError);
    // Vitest reports every unhandled rejection independently of this assertion.
    await delay(50);
    relay.control.drop = false;
    expect(
      await exec.transaction(
        async (db) => (await db.execute(sql`select 1 as answer`))[0].answer,
        { deadline: performance.now() + 2000 },
      ),
    ).toBe(1);
  });

  it.each(
    [1, 2, 4].flatMap((workers) =>
      [1, 2].map((capacity) => ({ workers, capacity })),
    ),
  )(
    "targeted startup barrier W=$workers D=$capacity grants all fresh opportunities before history",
    async ({ workers, capacity }) => {
      const exec = executor(capacity),
        accounts: Account[] = [];
      for (let i = 0; i < 5; i++) {
        const a = await account(exec, {
          uids: [1, 1025, 1153, 1281],
          uidNext: 1409,
          taggedDelay: 15,
        });
        const record = a.config.onTurn!;
        a.config.onTurn = (kind, turn) => {
          record(kind, turn);
          if (kind === "fresh") {
            a.script.uids!.push(a.script.uidNext!);
            a.script.uidNext! += 128;
          }
        };
        accounts.push(a);
      }
      const run = scheduler(accounts, exec, {
        tuning: { workers, historyWaitMs: 1, historyTurnMs: 1000 },
      });
      await until(
        () => accounts.some((a) => a.turns.some((t) => t.kind === "history")),
        10_000,
      );
      await run.instance.stop();
      retired(accounts, run, Math.min(workers, 2 * capacity));
      const firstHistory = run.admissions.findIndex(
        (a) => a.kind === "history",
      );
      expect(firstHistory).toBeGreaterThanOrEqual(accounts.length);
      expect(run.admissions.slice(0, 5).map((a) => a.account)).toEqual(
        accounts.map((a) => a.id),
      );
      expect(run.admissions.slice(0, 5).map((a) => a.kind)).toEqual(
        Array(5).fill("fresh"),
      );
      for (const a of accounts) expect(a.errors).toEqual([]);
    },
  );

  it.each([1, 2, 4])(
    "targeted startup barrier W=%i cannot be held by unavailable accounts",
    async (workers) => {
      const exec = executor(2),
        bad = await account(exec, { select: "hung" });
      bad.config.timing = {
        pollMs: 50,
        operationMs: 300,
        retryMs: 200,
        maxRetryMs: 400,
      };
      const healthy: Account[] = [];
      for (let i = 0; i < 3; i++) {
        const a = await account(exec);
        a.config.timing = { pollMs: 1000 };
        healthy.push(a);
      }
      const accounts = [bad, ...healthy];
      const run = scheduler(accounts, exec, {
        tuning: { workers, historyWaitMs: 1 },
      });
      await until(
        () =>
          bad.errors.length >= 2 &&
          healthy.every((a) => a.turns.some((t) => t.kind === "history")),
        5000,
      );
      await run.instance.stop();
      retired(accounts, run, workers);
      const firstHistory = run.admissions.findIndex(
        (a) => a.kind === "history",
      );
      expect(
        new Set(
          run.admissions
            .slice(0, firstHistory)
            .filter((a) => a.kind === "fresh")
            .map((a) => a.account),
        ).size,
      ).toBe(accounts.length);
      expect(bad.errors.slice(0, 2).map((e) => e.retry)).toEqual([200, 400]);
      for (const a of healthy) expect(a.errors).toEqual([]);
    },
  );

  it.each([1, 2])(
    "targeted recovery D=%i aborts active accounts and rediscovers fresh before history",
    async (capacity) => {
      const exec = executor(capacity),
        accounts: Account[] = [];
      for (let i = 0; i < 5; i++)
        accounts.push(await account(exec, { select: "hung" }));
      const limit = 2 * capacity;
      const run = scheduler(accounts, exec, { tuning: { workers: 4 } });
      await until(
        () =>
          accounts.filter((a) =>
            a.peer.commands.some((c) => /^(SELECT|EXAMINE)/.test(c.command)),
          ).length === limit,
        5000,
      );
      await Promise.all([run.instance.stop(), run.instance.stop()]);
      retired(accounts, run, limit);
      const before = accounts.map((a) => a.peer.observed.length);
      await delay(50);
      expect(accounts.map((a) => a.peer.observed.length)).toEqual(before);
      for (const a of accounts) {
        a.script.select = undefined;
        a.script.uids!.push(1025);
        a.script.uidNext = 1026;
        // Fresh recovery is independently tested; history completion remains in
        // the preserved original acceptance scenario.
        a.config.timing = { pollMs: 1000 };
      }
      const restarted = scheduler(accounts, exec, {
        tuning: { workers: 4, historyWaitMs: 1 },
      });
      await waitFor(async () =>
        (await Promise.all(accounts.map(state))).every(
          (s) => BigInt(s.fresh_through) === 1025n,
        ),
      );
      await restarted.instance.stop();
      retired(accounts, restarted, limit);
      expect(restarted.admissions.slice(0, 5).map((a) => a.kind)).toEqual(
        Array(5).fill("fresh"),
      );
      for (const a of accounts) {
        expect(a.errors).toEqual([]);
        const rows = await placements(a);
        expect(rows.filter((r) => BigInt(r.uid) === 1025n)).toHaveLength(1);
        expect(rows.every((r) => BigInt(r.uid_validity) === 7n)).toBe(true);
      }
    },
  );

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
      // D11 / architecture 14.4: current-first durable recovery is independent
      // of finishing eight history windows while fresh probes are due at 50 ms.
      const restarted = scheduler(accounts, exec, {
        tuning: { workers },
        historyAllowed: () => false,
      });
      await waitFor(async () => {
        const states = await Promise.all(accounts.map(state));
        for (const s of states) {
          expect(BigInt(s.epoch)).toBe(7n);
          expect(
            BigInt(s.history_before),
            "recovery must discover current mail before historical continuation",
          ).toBe(1025n);
        }
        return states.every((s) => BigInt(s.fresh_through) === 1025n);
      });
      await restarted.instance.stop();
      retired(accounts, restarted, workers);
      expect(restarted.admissions.slice(0, 5).map((a) => a.kind)).toEqual(
        Array(5).fill("fresh"),
      );
      for (const a of accounts) {
        const saved = await state(a);
        expect(BigInt(saved.epoch)).toBe(7n);
        expect(BigInt(saved.fresh_through)).toBe(1025n);
        expect(BigInt(saved.history_before)).toBe(1025n);
        expect((await placements(a)).map((r) => BigInt(r.uid))).toEqual([
          1025n,
        ]);
        expect(a.errors).toEqual([]);
      }
      // H1: full completion is still required, under an explicitly serviceable
      // quiet profile: no second probe is due during the unchanged 10 s barrier.
      // This changes fixture eligibility, not an operation/test deadline.
      for (const a of accounts)
        a.config.timing = { ...a.config.timing, pollMs: 30_000 };
      const history = scheduler(accounts, exec, { tuning: { workers } });
      await waitFor(async () =>
        (await Promise.all(accounts.map(state))).every(
          (s) =>
            BigInt(s.history_before) === 1n &&
            BigInt(s.fresh_through) === 1025n,
        ),
      ).catch(async (error) => {
        for (const a of accounts)
          expect(
            BigInt((await state(a)).history_before),
            "controlled quiet fixture must commit complete historical E",
          ).toBe(1n);
        throw error;
      });
      await history.instance.stop();
      retired(accounts, history, workers);
      expect(history.admissions.slice(0, 5).map((a) => a.kind)).toEqual(
        Array(5).fill("fresh"),
      );
      for (const a of accounts) {
        const audit = await verifyPublication(a);
        expect(
          audit
            .filter((r) => BigInt(r.new_e) < BigInt(r.old_e))
            .map((r) => BigInt(r.new_e)),
        ).toEqual([897n, 769n, 641n, 513n, 385n, 257n, 129n, 1n]);
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
      const held: (() => void)[] = [];
      const initialFresh = new Set<string>();
      const accounts: Account[] = [];
      for (let i = 0; i < 5; i++)
        accounts.push(
          await account(exec, {
            onCommand: (p, c) => {
              const range = /^UID SEARCH UID (\d+):(\d+)$/.exec(c.command);
              if (range && Number(range[2]) <= 1024) {
                const a = accounts.find((a) => a.peer.commands.includes(c))!;
                const hits = a.script.uids!.filter(
                  (uid) => uid >= Number(range[1]) && uid <= Number(range[2]),
                );
                p.send(`* SEARCH ${hits.join(" ")}\r\n`, c);
                // A real tagged command barrier, not an assumption that a
                // 50 ms poll leaves spare capacity. Later history stays held
                // until stop so fresh visibility precedes complete history.
                held.push(() => p.ok(c));
                return true;
              }
            },
          }),
        );
      for (const a of accounts) {
        a.config.timing = { ...a.config.timing, pollMs: 500 };
        const record = a.config.onTurn!;
        a.config.onTurn = (kind, turn) => {
          record(kind, turn);
          if (kind === "fresh") initialFresh.add(a.id);
        };
      }
      const run = scheduler(accounts, exec, {
        tuning: { workers, historyWaitMs: 30_000 },
        historyAllowed: () => initialFresh.size === accounts.length,
      });
      await until(() => held.length === workers, 5000);
      expect(run.instance.snapshot.active).toBe(workers);
      const injected = performance.now();
      for (const a of accounts) {
        a.script.uids!.push(1025);
        a.script.uidNext = 1026;
      }
      // Every account's 500 ms poll is now due while W is occupied. None can
      // start magically before a command/retirement boundary returns a slot.
      await delay(550);
      for (const a of accounts) {
        const saved = await state(a);
        expect(BigInt(saved.epoch)).toBe(7n);
        expect(BigInt(saved.fresh_through)).toBe(1024n);
        expect(BigInt(saved.history_before)).toBe(1025n);
        expect(await placements(a)).toEqual([]);
      }
      const released = performance.now();
      held.splice(0, workers).forEach((release) => release());
      const priorityViolations = () =>
        run.decisions.filter(
          ({ admission, observed }) =>
            admission.at >= released &&
            admission.kind === "history" &&
            [...observed.values()].some(
              (a) => !a.active && a.freshDue <= admission.at - 2,
            ),
        );
      const samples: number[] = [];
      const pending = new Set(accounts);
      await waitFor(async () => {
        expect(
          priorityViolations(),
          "ordinary history cannot bypass an available due fresh account",
        ).toEqual([]);
        for (const a of pending) {
          const [row] =
            await reader`select uid from receiving_current_placements where mailbox_id=${a.mailbox} and uid=1025`;
          if (row) {
            const saved = await state(a);
            expect(BigInt(saved.epoch)).toBe(7n);
            expect(BigInt(saved.fresh_through)).toBe(1025n);
            expect(BigInt(saved.history_before)).toBeGreaterThan(1n);
            samples.push(performance.now() - injected);
            pending.delete(a);
          }
        }
        return pending.size === 0;
      });
      await run.instance.stop();
      retired(accounts, run, workers);
      expect(
        priorityViolations(),
        "ordinary history cannot bypass an available due fresh account",
      ).toEqual([]);
      for (const decision of run.decisions)
        expect(decision.observed.get(decision.admission.account)!.active).toBe(
          false,
        );
      expect(Math.max(...samples)).toBeLessThan(5000);
      for (const a of accounts) {
        await verifyPublication(a);
        expect(
          (await placements(a))
            .filter((r) => BigInt(r.uid) === 1025n)
            .map((r) => BigInt(r.uid_validity)),
        ).toEqual([7n]);
        expect(a.errors).toEqual([]);
        expect(BigInt((await state(a)).history_before)).toBeGreaterThan(1n);
      }
      process.stdout.write(
        `Stage3B fresh visibility W=${workers}: ${samples.map((n) => n.toFixed(2)).join(",")} ms\n`,
      );
    },
  );

  it.each([1, 2, 4])(
    "W=%i selects oldest safe protected history and rotates exact age ties",
    async (workers) => {
      const exec = executor(2);
      const accounts = await Promise.all(
        Array.from({ length: 3 }, () => account(exec)),
      );
      const instance = new ReceivingScheduler({
        executor: exec,
        accounts: accounts.map((a) => a.config),
        tuning: { workers, historyWaitMs: 100, historyTurnMs: 1000 },
      });
      // Deterministic boundary probe: no running turn or clock rounding can
      // obscure the distinction between outstanding age and exact age ties.
      const candidates = instance["accounts"];
      for (const [index, a] of candidates.entries()) {
        a.initialFreshGranted = true;
        a.freshDue = 900;
        a.historySince = index === 0 ? 800 : 700;
      }
      const choose = () => instance["select"](1000);
      expect(choose()?.account.config.account).toBe(accounts[1].id);
      expect(choose()?.account.config.account).toBe(accounts[2].id);
      candidates[1].active = true;
      candidates[2].retryAt = 1001;
      expect(choose()?.account.config.account).toBe(accounts[0].id);
      candidates[1].active = false;
      candidates[2].retryAt = 0;
      instance["protectedActive"] = true;
      expect(choose()?.kind).toBe("fresh");
      instance["protectedActive"] = false;
      instance["lastProtected"] = true;
      expect(choose()?.kind).toBe("fresh");
      instance["lastProtected"] = false;
      candidates.forEach((a) => (a.freshDue = -5000));
      expect(choose()?.kind).toBe("fresh");
      candidates.forEach((a) => (a.freshDue = 1001));
      // Ordinary spare-capacity history still uses the unfiltered rotation.
      instance["historyCursor"] = 0;
      expect(choose()?.account.config.account).toBe(accounts[0].id);
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
      // H3's eight-account profile leaves real candidate choices even at W=4.
      for (let i = 0; i < 8; i++) {
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
      // D06 / validation H2-H4: actual committed E must advance repeatedly,
      // not merely a callback counter or a fixed first-registration order.
      await waitFor(async () => {
        verifyRotation();
        return (await Promise.all(accounts.map(state))).every(
          (s) => BigInt(s.history_before) <= 769n,
        );
      }, 15_000).catch(async (error) => {
        const snapshots = await Promise.all(
          accounts.map(async (a) => {
            const s = await state(a);
            return {
              account: a.id,
              f: String(s.fresh_through),
              e: String(s.history_before),
              revision: String(s.revision),
              historyAdmissions: run.admissions.filter(
                (entry) => entry.account === a.id && entry.kind === "history",
              ).length,
              errors: a.errors.map(({ error }) =>
                error instanceof Error ? error.message : String(error),
              ),
            };
          }),
        );
        throw new Error(
          `Durable history fairness failed W=${workers}: ${JSON.stringify(snapshots)}`,
          { cause: error },
        );
      });
      await run.instance.stop();
      retired(accounts, { ...run, admissions }, workers);
      expect(
        admissions
          .filter((a) => a.kind === "history")
          .every((a) => a.protectedHistory),
      ).toBe(true);
      expect(admissions.slice(0, accounts.length).map((a) => a.kind)).toEqual(
        Array(accounts.length).fill("fresh"),
      );
      function verifyRotation() {
        let cursor = 0;
        let choices = 0,
          maxSkipped = 0;
        const skipped = new Map(accounts.map((a) => [a.id, 0]));
        const rotationViolations: string[] = [];
        const safeOpportunities = new Map(accounts.map((a) => [a.id, 0]));
        for (const { admission, observed } of run.decisions) {
          if (admission.kind !== "history") continue;
          // Completion observers are slightly later than scheduler completion.
          // A 2 ms exclusion band omits ambiguous threshold-edge candidates;
          // Fully eligible older accounts must never be bypassed. Exact age
          // ties use cyclic rotation; the boundary probe above tests those
          // without the observer's completion-clock skew.
          const eligible = accounts.filter((a) => {
            const o = observed.get(a.id)!;
            return (
              !o.active &&
              o.historyBefore! > 1n &&
              o.historySince !== undefined &&
              admission.at - o.historySince >= 102
            );
          });
          const selected = accounts.findIndex(
            (a) => a.id === admission.account,
          );
          if (eligible.some((a) => a.id !== admission.account)) choices++;
          const selectedSince = observed.get(admission.account)!.historySince!;
          for (const a of eligible)
            if (observed.get(a.id)!.historySince! + 2 < selectedSince)
              rotationViolations.push(a.id);
          for (
            let index = cursor;
            index !== selected;
            index = (index + 1) % accounts.length
          )
            if (
              eligible.some(
                (a) =>
                  a.id === accounts[index].id &&
                  observed.get(a.id)!.historySince === selectedSince,
              )
            )
              rotationViolations.push(accounts[index].id);
          for (const a of accounts) {
            if (!eligible.includes(a) || a.id === admission.account)
              skipped.set(a.id, 0);
            else {
              skipped.set(a.id, skipped.get(a.id)! + 1);
              safeOpportunities.set(a.id, safeOpportunities.get(a.id)! + 1);
            }
            expect(
              skipped.get(a.id),
              "continuously eligible history must be served within one account rotation",
            ).toBeLessThan(accounts.length);
            maxSkipped = Math.max(maxSkipped, skipped.get(a.id)!);
          }
          cursor = (selected + 1) % accounts.length;
        }
        expect(
          rotationViolations,
          "oldest available fully-aged history wins; exact ties rotate",
        ).toEqual([]);
        return { choices, maxSkipped };
      }
      const rotation = verifyRotation();
      expect(
        rotation.choices,
        "fairness must exercise available alternative accounts, including W=4",
      ).toBeGreaterThan(0);
      for (let i = 1; i < admissions.length; i++)
        if (admissions[i].protectedHistory)
          expect(admissions[i - 1].protectedHistory).toBe(false);
      if (workers === 1) {
        const fresh = admissions
          .filter((a) => a.kind === "fresh")
          .map((a) => a.account);
        for (let i = 0; i < fresh.length; i++)
          expect(fresh[i]).toBe(accounts[i % accounts.length].id);
      }
      expect(Math.max(...freshWaits)).toBeLessThan(5000);
      const durableHistory: {
        admissions: number;
        commits: number;
        e: string;
      }[] = [];
      for (const a of accounts) {
        const audit = await verifyPublication(a);
        const history = audit.filter((r) => BigInt(r.new_e) < BigInt(r.old_e));
        expect(history.length).toBeGreaterThanOrEqual(2);
        expect(history.slice(0, 2).map((r) => BigInt(r.new_e))).toEqual([
          897n,
          769n,
        ]);
        expect(
          audit
            .filter((r) => BigInt(r.new_f) > BigInt(r.old_f))
            .every((r) => BigInt(r.new_f) - BigInt(r.old_f) === 128n),
        ).toBe(true);
        expect(a.errors).toEqual([]);
        const saved = await state(a);
        durableHistory.push({
          admissions: admissions.filter(
            (entry) => entry.account === a.id && entry.kind === "history",
          ).length,
          commits: history.length,
          e: String(saved.history_before),
        });
        expect(BigInt(saved.fresh_through)).toBeGreaterThan(1024n);
        expect(BigInt(saved.history_before)).toBeLessThanOrEqual(769n);
        const rows = await placements(a);
        expect(
          new Set(rows.map((r) => `${r.uid_validity}:${r.uid}`)).size,
        ).toBe(rows.length);
      }
      process.stdout.write(
        `Stage3B sustained W=${workers}: durable history=${JSON.stringify(durableHistory)}; eligible choices=${rotation.choices}, max skipped=${rotation.maxSkipped}; history wait=[${historyWaits.map((n) => n.toFixed(2))}]; protected cost=[${historyDurations.map((n) => n.toFixed(2))}]; fresh waits=[${freshWaits.map((n) => n.toFixed(2))}] ms\n`,
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
