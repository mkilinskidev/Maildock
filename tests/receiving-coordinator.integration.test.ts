import { randomUUID } from "node:crypto";
import postgres from "postgres";
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
import {} from "@/shared/infrastructure/database/receiving-authority";
import { sql } from "drizzle-orm";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { ReceivingCoordinator } from "@/modules/mail/application/receiving-coordinator";
import { receiveInboxTurn } from "@/modules/mail/application/receiving-inbox-turn";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { delay, until } from "../experiments/imap-transport/fixture";

const budget = (ms = 5000) => ({ deadline: performance.now() + ms });
describe("single-account autonomous receiving coordinator", () => {
  let container: StartedTestContainer;
  let url: string;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let actor: string, generation: bigint, mailbox: string, account: string;
  const cleanup: (() => Promise<unknown>)[] = [];
  const owner = () => ({ actor, generation });
  beforeAll(async () => {
    // Always disposable; deliberately ignores TEST_DATABASE_URL.
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
    await root`create database stage3a owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/stage3a`;
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
    account = randomUUID();
    mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Stage3A fixture",
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
      accountId: account,
      remotePath: "INBOX",
      name: "INBOX",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const executor = (address = url) => {
    const exec = new ReceivingExecutor(address, 1);
    cleanup.push(() => exec.stop());
    return exec;
  };
  const state = async () =>
    (
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`
    )[0];
  const count = async () =>
    Number(
      (
        await reader`select count(*) from mailbox_messages where mailbox_id=${mailbox}`
      )[0].count,
    );
  async function wire(config: WindowPeerOptions = {}) {
    const peer = await metadataPeer(config);
    cleanup.push(peer.cleanup);
    return peer;
  }
  async function initialize(exec: ReceivingExecutor) {
    await new ReceivingPersistence(exec).initialize(
      owner(),
      mailbox,
      { complete: true, epoch: 7n, uidNext: 257n },
      budget(),
    );
  }
  const options = () => ({ ...budget(9000), assertCurrent: () => {} });

  type Peer = Awaited<ReturnType<typeof wire>>;
  type Turn = Awaited<ReturnType<typeof receiveInboxTurn>>;
  async function renew(
    db: Parameters<
      ConstructorParameters<
        typeof ReceivingCoordinator
      >[0]["authority"]["renew"]
    >[0],
  ) {
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
  function coordinator(
    peer: Peer,
    exec = executor(),
    overrides: Partial<
      ConstructorParameters<typeof ReceivingCoordinator>[0]
    > = {},
  ) {
    const turns: { kind: string; turn: Turn }[] = [];
    const errors: unknown[] = [];
    const instance = new ReceivingCoordinator({
      connection: peer.connection,
      executor: exec,
      owner: owner(),
      account,
      mailbox,
      authority: { assertCurrent: () => {}, renew },
      timing: { pollMs: 150, retryMs: 50, maxRetryMs: 200, operationMs: 3000 },
      createClient: peer.createClient,
      onTurn: (kind, turn) => turns.push({ kind, turn }),
      onError: (error) => errors.push(error),
      ...overrides,
    });
    cleanup.push(() => instance.stop());
    instance.start();
    return { instance, turns, errors };
  }
  async function waitFor(predicate: () => Promise<boolean>, ms = 5000) {
    const end = performance.now() + ms;
    while (!(await predicate())) {
      if (performance.now() >= end)
        throw new Error("Durable coordinator barrier timed out");
      await delay(5);
    }
  }

  it("empty initial INBOX sleeps, then independently discovers its first arrival", async () => {
    const script: WindowPeerOptions = {
      uids: [],
      uidNext: 1,
      boundedMailbox: true,
    };
    const peer = await wire(script);
    const run = coordinator(peer, executor(), { timing: { pollMs: 400 } });
    await until(() => run.turns.length === 1, 5000);
    const connections = peer.observed.length;
    await delay(120);
    expect(peer.observed.length).toBe(connections);
    expect(BigInt((await state()).history_before)).toBe(1n);
    script.uids!.push(1);
    script.uidNext = 2;
    await waitFor(async () => (await count()) === 1);
    await run.instance.stop();
    expect(BigInt((await state()).fresh_through)).toBe(1n);
    expect(run.errors).toEqual([]);
    expect(
      peer.commands
        .filter((c) => c.command.startsWith("UID SEARCH"))
        .map((c) => c.command),
    ).toEqual(["UID SEARCH UID 1:1"]);
  });

  it("new mail is queryable before history completes; restart checks fresh first and finishes without duplicates", async () => {
    let injected = 0;
    const script: WindowPeerOptions = {
      uids: [1, 129, 257, 384],
      uidNext: 385,
      boundedMailbox: true,
      onCommand: (p, command) => {
        if (command.command === "UID SEARCH UID 257:384" && !injected) {
          script.uids!.push(385, 386);
          script.uidNext = 387;
          injected = performance.now();
          p.send("* SEARCH 257 384\r\n", command);
          p.later(200, () => p.ok(command));
          return true;
        }
      },
    };
    const peer = await wire(script);
    const first = coordinator(peer);
    await waitFor(
      async () =>
        Number(
          (
            await reader`select count(*) from receiving_current_placements where mailbox_id=${mailbox} and uid in (385,386)`
          )[0].count,
        ) === 2,
    );
    const visibilityMs = performance.now() - injected;
    const visible = await state();
    expect(BigInt(visible.history_before)).toBeGreaterThan(1n);
    await first.instance.stop();
    expect(first.errors).toEqual([]);
    console.info(
      `Stage3A fresh durable visibility: ${visibilityMs.toFixed(2)} ms; E=${visible.history_before}`,
    );
    const savedE = BigInt((await state()).history_before);
    script.uids!.push(387);
    script.uidNext = 388;
    const offset = peer.commands.length;
    const second = coordinator(peer);
    await waitFor(
      async () =>
        BigInt((await state()).history_before) === 1n &&
        BigInt((await state()).fresh_through) === 387n,
    );
    await second.instance.stop();
    expect(second.errors).toEqual([]);
    expect(second.turns[0].kind).toBe("fresh");
    expect(second.turns[0].turn.state.historyBefore).toBe(savedE);
    expect(
      peer.commands
        .slice(offset)
        .find((c) => c.command.startsWith("UID SEARCH"))?.command,
    ).toBe("UID SEARCH UID 387:387");
    expect(await count()).toBe(7);
    const [unique] =
      await reader`select count(distinct (uid_validity,uid)) as n from mailbox_messages where mailbox_id=${mailbox}`;
    expect(Number(unique.n)).toBe(7);
    // Tagged command completion and local close precede every next connection.
    for (let i = 1; i < peer.observed.length; i++)
      expect(peer.observed[i - 1].isClosed).toBe(true);
    expect(
      peer.commands.some((c) => /IDLE|SEARCH ALL|BODY\[\]/.test(c.command)),
    ).toBe(false);
  });

  it("quiet fresh probes permit successive descending historical windows", async () => {
    const peer = await wire({
      uids: [1, 129, 257],
      uidNext: 385,
      boundedMailbox: true,
    });
    const run = coordinator(peer);
    await waitFor(
      async () => BigInt((await state())?.history_before ?? 0) === 1n,
    );
    await run.instance.stop();
    expect(await count()).toBe(3);
    expect(run.turns[0].kind).toBe("fresh");
    expect(
      run.turns
        .filter((t) => t.kind === "history")
        .map((t) => t.turn.state.historyBefore),
    ).toEqual([257n, 129n, 1n]);
    expect(run.errors).toEqual([]);
  });

  it("fresh gaps and completely empty forward intervals advance F independently of E", async () => {
    const exec = executor();
    await initialize(exec);
    const peer = await wire({
      uids: [390, 512],
      uidNext: 513,
      boundedMailbox: true,
    });
    const seen: Turn[] = [];
    const run = coordinator(peer, exec, {
      onTurn: (kind, turn) => {
        if (kind === "fresh") seen.push(turn);
        if (turn.state.freshThrough === 512n) void run.instance.stop();
      },
    });
    await until(() => seen.length === 2, 5000);
    await run.instance.stop();
    expect(seen.map((t) => t.state.freshThrough)).toEqual([384n, 512n]);
    expect(seen.map((t) => t.count)).toEqual([0, 2]);
    expect(seen.every((t) => t.state.historyBefore === 257n)).toBe(true);
    expect(await count()).toBe(2);
  });

  it("repeated fresh arrivals never reset historical coverage", async () => {
    const exec = executor();
    await initialize(exec);
    const script: WindowPeerOptions = {
      uids: [257],
      uidNext: 258,
      boundedMailbox: true,
    };
    const peer = await wire(script);
    const frontiers: bigint[] = [];
    const run = coordinator(peer, exec, {
      timing: { pollMs: 1 },
      onTurn: (kind, turn) => {
        if (kind === "fresh" && turn.count) {
          frontiers.push(turn.state.historyBefore);
          if (frontiers.length < 3) {
            script.uids!.push(Number(turn.state.freshThrough + 1n));
            script.uidNext!++;
          } else void run.instance.stop();
        }
      },
    });
    await until(() => frontiers.length === 3, 5000);
    await run.instance.stop();
    expect(frontiers).toEqual([257n, 257n, 257n]);
    expect(BigInt((await state()).fresh_through)).toBe(259n);
    expect(await count()).toBe(3);
  });

  it.each(["search", "fetch"] as const)(
    "cancels during %s and admits no further work",
    async (phase) => {
      const exec = executor();
      await initialize(exec);
      const script: WindowPeerOptions = {
        uids: [257],
        uidNext: 258,
        boundedMailbox: true,
        [phase]: "hung",
      };
      const peer = await wire(script);
      const run = coordinator(peer, exec);
      await until(
        () =>
          peer.commands.some((c) =>
            c.command.startsWith(
              phase === "search" ? "UID SEARCH" : "UID FETCH",
            ),
          ),
        5000,
      );
      await run.instance.stop();
      const connections = peer.observed.length;
      await delay(100);
      expect(peer.observed.length).toBe(connections);
      expect(peer.observed.every((c) => c.isClosed)).toBe(true);
      expect(BigInt((await state()).fresh_through)).toBe(256n);
      expect(await count()).toBe(0);
    },
  );

  it("timeout retires the failed connection, backs off and reconnects current-first", async () => {
    const exec = executor();
    await initialize(exec);
    const script: WindowPeerOptions = {
      uids: [257],
      uidNext: 258,
      boundedMailbox: true,
      fetch: "hung",
    };
    const peer = await wire(script);
    const failures: number[] = [];
    const run = coordinator(peer, exec, {
      timing: { operationMs: 400, retryMs: 100, maxRetryMs: 200 },
      onError: (_e, retry) => {
        failures.push(retry);
        script.fetch = undefined;
      },
      onTurn: (_kind, turn) => {
        if (turn.count) void run.instance.stop();
      },
    });
    await waitFor(async () => (await count()) === 1);
    await run.instance.stop();
    expect(failures).toEqual([100]);
    expect(peer.observed.length).toBe(2);
    expect(peer.observed.every((c) => c.isClosed)).toBe(true);
    expect(BigInt((await state()).history_before)).toBe(257n);
  });

  it("UIDVALIDITY replacement fails closed with no old-epoch publication", async () => {
    const exec = executor();
    await initialize(exec);
    const peer = await wire({
      uids: [257],
      uidNext: 258,
      epoch: 8,
      boundedMailbox: true,
    });
    const run = coordinator(peer, exec);
    await until(() => run.errors.length === 1, 5000);
    await run.instance.stop();
    expect(BigInt((await state()).epoch)).toBe(7n);
    expect(BigInt((await state()).fresh_through)).toBe(256n);
    expect(peer.commands.some((c) => c.command.startsWith("UID SEARCH"))).toBe(
      false,
    );
    expect(await count()).toBe(0);
  });

  it("rejects the wrong account and revoked authority before opening IMAP", async () => {
    const peer = await wire({ uids: [], uidNext: 1 });
    const wrong = coordinator(peer, executor(), { account: randomUUID() });
    await until(() => wrong.errors.length === 1, 5000);
    await wrong.instance.stop();
    const revoked = coordinator(peer, executor(), {
      authority: {
        assertCurrent: () => {
          throw new Error("Revoked");
        },
        renew,
      },
    });
    await until(() => revoked.errors.length === 1, 5000);
    await revoked.instance.stop();
    expect(peer.observed).toHaveLength(0);
  });

  it("actual lost COMMIT is recovered before another fresh interval; placements are not duplicated", async () => {
    const exec = executor();
    await initialize(exec);
    await reader.unsafe(
      `CREATE FUNCTION stage3a_hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.revision=1 THEN PERFORM pg_advisory_xact_lock(818239); END IF; RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER zzz_stage3a_hold AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stage3a_hold_commit();`,
    );
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(818239)`;
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const peer = await wire({
      uids: [257],
      uidNext: 258,
      boundedMailbox: true,
    });
    const errors: unknown[] = [];
    const run = coordinator(peer, executor(relay.url), {
      timing: { operationMs: 1200, retryMs: 100 },
      onError: (error) => {
        errors.push(error);
        relay.control.drop = false;
      },
    });
    try {
      await waitFor(
        async () =>
          (
            await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
          ).length > 0,
      );
      relay.control.drop = true;
      await blocker`select pg_advisory_unlock(818239)`;
      await until(() => errors.length > 0, 5000);
      await until(
        () =>
          run.turns.some(
            (t) => t.kind === "fresh" && t.turn.state.freshThrough === 257n,
          ),
        5000,
      );
      await run.instance.stop();
      expect(errors[0]).toBeInstanceOf(ReceivingUnresolvedError);
      expect(await count()).toBe(1);
      expect(
        peer.commands.filter((c) => c.command === "UID SEARCH UID 257:257"),
      ).toHaveLength(1);
    } finally {
      await run.instance.stop();
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_stage3a_hold ON receiving_mailboxes; DROP FUNCTION stage3a_hold_commit();",
      );
    }
  });
});
