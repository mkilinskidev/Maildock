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
import { mailAccounts } from "@/shared/infrastructure/database/schema";
import {
  ReceivingExecutor,
  ReceivingUnresolvedError,
} from "@/shared/infrastructure/database/receiving-executor";
import { sql } from "drizzle-orm";
import { ReceivingDemand } from "@/modules/mail/application/receiving-demand";
import {
  claimReceiving,
  recoverReceiving,
} from "@/shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import { receiveInboxTurn } from "@/modules/mail/application/receiving-inbox-turn";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { setTimeout as delay } from "node:timers/promises";
async function until(predicate: () => Promise<boolean> | boolean, ms = 5000) {
  const end = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() >= end)
      throw new Error("R06 barrier deadline exceeded");
    await delay(5);
  }
}

const budget = (ms = 5000) => ({ deadline: performance.now() + ms });
describe("R15 durable settlement and quiet INBOX membership", () => {
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
    await root`create database r06 owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/r06`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
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
  const snapshot = async () =>
    (
      await reader`
    select m.id,m.recent_sync_uid_validity,s.*,a.receiving_request_generation,a.receiving_due_at
    from mail_accounts a join mailboxes m on m.account_id=a.id
    join receiving_mailboxes s on s.mailbox_id=m.id where a.id=${account}`
    )[0];
  const rows = async () =>
    await reader`select * from mailboxes where account_id=${account}`;
  async function peer(options: WindowPeerOptions = {}) {
    options.boundedMailbox = true;
    const wire = await metadataPeer(options);
    cleanup.push(wire.cleanup);
    return wire;
  }
  type Peer = Awaited<ReturnType<typeof peer>>;
  async function turn(
    wire: Peer,
    kind: "fresh" | "history" = "fresh",
    exec = executor(),
    signal?: AbortSignal,
    ms = 3000,
  ) {
    return receiveInboxTurn(
      {
        connection: wire.connection,
        executor: exec,
        owner: owner(),
        account,
        mailbox,
        bootstrap: true,
        options: {
          kind,
          windowSize: kind === "history" ? 32 : undefined,
          ...budget(ms),
          signal,
          assertCurrent() {},
        },
      },
      wire.createClient,
    );
  }
  async function placements() {
    return reader`select uid,flags,modseq from receiving_current_placements where mailbox_id=${mailbox} order by uid`;
  }
  async function seedMany(uids = [1, 2], uidNext = Math.max(...uids) + 1) {
    const options: WindowPeerOptions = { uids, uidNext, boundedMailbox: true };
    const wire = await peer(options);
    await turn(wire);
    mailbox = (await snapshot()).id;
    while (BigInt((await snapshot()).history_before) > 1n)
      await turn(wire, "history");
    return { options, wire };
  }
  async function start(wire: Peer, pollMs = 80) {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const coordinator = new ElectedReceivingCoordinator({
      executor: executor(),
      leaseMs: 600,
      tuning: { workers: 1 },
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: wire.connection,
        createClient: wire.createClient,
        timing: { pollMs, retryMs: 80, maxRetryMs: 160 },
      }),
    });
    cleanup.push(() => coordinator.stop());
    expect(await coordinator.elect()).toBe(true);
    return coordinator;
  }
  it.each(["external deletion", "external MOVE"])(
    "observes %s without a new UID, wake or API call",
    async () => {
      const { options, wire } = await seedMany();
      const coordinator = await start(wire);
      await until(async () => BigInt((await snapshot()).revision) >= 2n);
      options.uids!.splice(0, 1);
      await until(async () => (await placements()).length === 1);
      expect((await placements())[0].uid).toBe("2");
      expect(options.uidNext).toBe(3);
      expect(
        wire.commands.some((c) => /UID SEARCH UID 1,2/.test(c.command)),
      ).toBe(true);
      await coordinator.stop();
    },
  );
  it("observes external flags with unchanged count and UIDNEXT while idle", async () => {
    const { options, wire } = await seedMany([1]);
    const coordinator = await start(wire);
    options.flags = ["\\Flagged"];
    await until(async () =>
      (await placements())[0]?.flags.includes("\\Flagged"),
    );
    expect(options.uidNext).toBe(2);
    expect(await placements()).toHaveLength(1);
    await coordinator.stop();
  });
  it("new UID discovery and historical backlog retain independent progress", async () => {
    const { options, wire } = await seedMany([1]);
    options.uids!.push(2);
    options.uidNext = 3;
    const result = await turn(wire);
    expect(result.state.freshThrough).toBe(2n);
    expect((await placements()).map((r) => r.uid)).toEqual(["1", "2"]);
  });
  it("lost delivery retains demand and the quiet cycle settles only its mailbox generation", async () => {
    const { wire } = await seedMany([1]);
    const demand = new ReceivingDemand(database.db, async () => {
      throw new Error("lost wake");
    });
    expect(await demand.request(account, mailbox)).toBe(true);
    const before = await snapshot();
    const coordinator = await start(wire);
    await until(
      async () =>
        (
          await reader`select receiving_due_at>clock_timestamp() done from mailboxes where id=${mailbox}`
        )[0].done,
    );
    const after = await snapshot();
    expect(after.receiving_request_generation).toBe(
      before.receiving_request_generation,
    );
    // An INBOX read does not settle account topology obligations.
    expect(
      (
        await reader`select receiving_due_at<=clock_timestamp() due from mail_accounts where id=${account}`
      )[0].due,
    ).toBe(true);
    await coordinator.stop();
  });
  it("a newer request made during network I/O is not cleared by old publication", async () => {
    const { options, wire } = await seedMany([1]);
    let release!: () => void;
    let reached = false;
    options.onCommand = (p, cmd) => {
      if (!cmd.command.startsWith("UID SEARCH")) return;
      reached = true;
      release = () => {
        p.send("* SEARCH 1\r\n", cmd);
        p.ok(cmd);
      };
      return true;
    };
    const work = turn(wire);
    await until(() => reached);
    await reader`select maildock_receiving_request(${account},${mailbox})`;
    release();
    await work;
    expect(
      (
        await reader`select receiving_due_at<=clock_timestamp() due from mailboxes where id=${mailbox}`
      )[0].due,
    ).toBe(true);
  });
  it.each(["no", "absent", "duplicate"] as const)(
    "incomplete or failed SEARCH %s cannot remove placements or settle demand",
    async (search) => {
      const { options, wire } = await seedMany([1, 2]);
      options.search = search;
      const before = await snapshot();
      await expect(turn(wire)).rejects.toThrow();
      expect(await placements()).toHaveLength(2);
      expect((await snapshot()).revision).toBe(before.revision);
    },
  );
  it.each(["missing", "no", "duplicate", "incomplete"] as const)(
    "incomplete FETCH %s is not absence evidence",
    async (fetch) => {
      const { options, wire } = await seedMany([1, 2]);
      options.fetch = fetch;
      await expect(turn(wire)).rejects.toThrow();
      expect(await placements()).toHaveLength(2);
    },
  );
  it("reconciles a large mailbox through bounded exact durable pages without new messages", async () => {
    const { options, wire } = await seedMany(
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
    options.uids!.splice(149, 1);
    options.flags = ["\\Flagged"];
    const before = await snapshot();
    await turn(wire);
    expect((await snapshot()).reconcile_after).toBe("128");
    expect(await placements()).toHaveLength(300);
    await turn(wire);
    expect(await placements()).toHaveLength(299);
    await turn(wire);
    await turn(wire);
    const after = await snapshot();
    expect(after.reconcile_after).toBe("0");
    expect(after.fresh_through).toBe(before.fresh_through);
    expect(after.history_before).toBe(before.history_before);
    expect(
      (await placements()).every((r) => r.flags.includes("\\Flagged")),
    ).toBe(true);
  });
  it("UIDVALIDITY replacement retains old physical placements but never treats it as deletions", async () => {
    const { options, wire } = await seedMany();
    options.epoch = 8;
    options.uids!.length = 0;
    const result = await turn(wire);
    expect(result.identityTransition).toBe(true);
    expect(await placements()).toHaveLength(0);
    expect(
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`,
    ).toHaveLength(2);
  });
  it("pending optimistic commands keep canonical flags until their own settlement", async () => {
    const { options, wire } = await seedMany([1]);
    const [p] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding,original_flags)
      values(${randomUUID()},${account},${mailbox},${p.id},${p.message_id},'mark_unread','INBOX',7,1,1,${p.flags}::text[])`;
    options.flags = ["\\Flagged"];
    await turn(wire);
    expect((await placements())[0].flags).toEqual(["\\Seen"]);
  });
  it.each(["configuration", "takeover", "disable"])(
    "rejects %s during observation without settling",
    async (change) => {
      const { options, wire } = await seedMany([1]);
      let release!: () => void;
      let reached = false;
      options.onCommand = (p, cmd) => {
        if (!cmd.command.startsWith("UID SEARCH")) return;
        reached = true;
        release = () => {
          p.send("* SEARCH\r\n", cmd);
          p.ok(cmd);
        };
        return true;
      };
      const work = turn(wire);
      const checked = expect(work).rejects.toThrow();
      await until(() => reached);
      if (change === "configuration")
        await reader`update mail_accounts set imap_host='new.test' where id=${account}`;
      else if (change === "disable")
        await reader`update mail_accounts set enabled=false where id=${account}`;
      else {
        await reader`update receiving_coordinator set expires_at='-infinity'`;
        await reader`select maildock_receiving_takeover(${randomUUID()},60000)`;
      }
      release();
      await checked;
      expect(
        await reader`select * from mailbox_messages where mailbox_id=${mailbox}`,
      ).toHaveLength(1);
    },
  );
  it("disabled membership retires and re-enable with changed configuration reloads without restarting", async () => {
    const { wire } = await seedMany([1]);
    const coordinator = await start(wire);
    await reader`update mail_accounts set enabled=false where id=${account}`;
    await coordinator.refreshMembership();
    await until(() => coordinator.snapshot.scheduler?.active === 0);
    await coordinator.refreshMembership();
    const count = wire.commands.length;
    await delay(180);
    expect(wire.commands.length).toBe(count);
    await reader`update mail_accounts set enabled=true,imap_host='replacement.test' where id=${account}`;
    await coordinator.refreshMembership();
    await until(async () => (await snapshot()).configuration_binding === "2");
    await until(async () => (await placements()).length === 1);
    await coordinator.stop();
  });
  it("finite quiet cadence does not spin on an empty mailbox", async () => {
    const wire = await peer({ uids: [], uidNext: 1 });
    await turn(wire);
    const coordinator = await start(wire, 100);
    await delay(420);
    await coordinator.stop();
    const selects = wire.commands.filter((c) =>
      /^(SELECT|EXAMINE) /.test(c.command),
    );
    expect(selects.length).toBeGreaterThanOrEqual(2);
    expect(selects.length).toBeLessThanOrEqual(7);
    expect(
      wire.commands.filter((c) => c.command.startsWith("UID FETCH")),
    ).toHaveLength(0);
  });
  it.each([false, true])(
    "CONDSTORE advertised%s only publishes actual negotiated MODSEQ",
    async (enabled) => {
      await seedMany([1]);
      const next = await peer({
        uids: [1],
        uidNext: 2,
        modseq: 9,
        capabilities: `IMAP4rev1 CONDSTORE ${enabled ? "ENABLE QRESYNC" : ""}`,
      });
      await turn(next);
      const fetch = next.commands.find((c) =>
        c.command.startsWith("UID FETCH"),
      );
      // Installed adapter enables extensions via ENABLE, never CAPABILITY alone.
      expect(fetch?.command.includes("MODSEQ")).toBe(enabled);
      expect((await placements())[0].modseq).toBe(enabled ? "9" : null);
    },
  );
  it("restart/takeover resumes quiet reconciliation and retains a lost live wake", async () => {
    const { options, wire } = await seedMany([1]);
    const first = await start(wire, 100);
    await until(async () => (await snapshot()).reconcile_after === "1");
    await first.stop();
    options.flags = ["\\Flagged"];
    const demand = new ReceivingDemand(database.db, async () => {
      throw new Error("lost");
    });
    expect(await demand.request(account, mailbox)).toBe(true);
    const second = await start(wire, 100);
    await until(async () =>
      (await placements())[0]?.flags.includes("\\Flagged"),
    );
    await second.stop();
  });
  it("interrupted observation publishes nothing and remains discoverable on the next read", async () => {
    const { options, wire } = await seedMany([1]);
    const before = await snapshot();
    let reached = false;
    options.onCommand = (_p, cmd) => {
      if (cmd.command.startsWith("UID SEARCH")) {
        reached = true;
        return true;
      }
    };
    const cancellation = new AbortController();
    const work = turn(wire, "fresh", executor(), cancellation.signal);
    const checked = expect(work).rejects.toThrow();
    await until(() => reached);
    cancellation.abort();
    await checked;
    expect((await snapshot()).revision).toBe(before.revision);
    expect(await placements()).toHaveLength(1);
    options.onCommand = undefined;
    options.uids!.length = 0;
    await turn(wire);
    expect(await placements()).toHaveLength(0);
  });
  it("a delayed membership observation cannot undo a newer published revision", async () => {
    const { options, wire } = await seedMany([1]);
    const exec = executor();
    const old = await recoverReceiving(exec, owner(), mailbox, budget());
    let release!: () => void;
    let reached = false;
    options.onCommand = (p, cmd) => {
      if (cmd.command.startsWith("UID SEARCH")) {
        reached = true;
        release = () => {
          p.send("* SEARCH\r\n", cmd);
          p.ok(cmd);
        };
        return true;
      }
    };
    const work = turn(wire);
    const checked = expect(work).rejects.toThrow();
    await until(() => reached);
    await new ReceivingPersistence(exec).persist(
      owner(),
      mailbox,
      old,
      {
        kind: "repair",
        complete: true,
        epoch: old.epoch,
        known: [1n],
        present: [1n],
        flags: [{ uid: "1", flags: ["\\Flagged"] }],
        wrap: false,
      },
      budget(),
    );
    release();
    await checked;
    expect((await placements())[0].flags).toEqual(["\\Flagged"]);
  });
  it("lost publication COMMIT response is recovered under conflicting locks without replaying a frontier", async () => {
    const { options, wire } = await seedMany([1]);
    options.flags = ["\\Flagged"];
    const before = await snapshot();
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(883115)`;
    await reader.unsafe(`CREATE FUNCTION r15_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(883115); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_r15_hold AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r15_hold();`);
    let recoveryLock = false;
    const work = turn(wire, "fresh", executor(relay.url), undefined, 1200);
    const checked = expect(work).rejects.toBeInstanceOf(
      ReceivingUnresolvedError,
    );
    try {
      await until(
        async () =>
          (
            await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
          ).length > 0,
      );
      relay.control.drop = true;
      await blocker`select pg_advisory_unlock_all()`;
      await until(async () =>
        (await placements())[0]?.flags.includes("\\Flagged"),
      );
      await checked;
      relay.control.drop = false;
      await blocker`begin`;
      recoveryLock = true;
      await blocker`select * from receiving_mailboxes where mailbox_id=${mailbox} for update`;
      const recovery = recoverReceiving(executor(), owner(), mailbox, budget());
      await until(
        async () =>
          (
            await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event_type='Lock'`
          ).length > 0,
      );
      await blocker`commit`;
      recoveryLock = false;
      const recovered = await recovery;
      expect(recovered.revision).toBe(BigInt(before.revision) + 1n);
      expect(recovered.freshThrough).toBe(BigInt(before.fresh_through));
      expect(recovered.historyBefore).toBe(BigInt(before.history_before));
      expect(
        wire.commands.filter((c) => /STORE|MOVE|APPEND/.test(c.command)),
      ).toHaveLength(0);
    } finally {
      relay.control.drop = false;
      if (recoveryLock) await blocker`rollback`;
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_r15_hold ON receiving_mailboxes; DROP FUNCTION r15_hold();",
      );
    }
  });
  it("empty observation settles only an exact current source and never increments coverage", async () => {
    const wire = await peer({ uids: [], uidNext: 1 });
    await turn(wire);
    mailbox = (await snapshot()).id;
    const before = await snapshot();
    await turn(wire);
    const after = await snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.fresh_through).toBe(before.fresh_through);
    expect(
      (
        await reader`select receiving_due_at>clock_timestamp() done from mailboxes where id=${mailbox}`
      )[0].done,
    ).toBe(true);
    const exec = executor();
    const state = await recoverReceiving(exec, owner(), mailbox, budget());
    await expect(
      new ReceivingPersistence(exec).settleEmptyObservation(
        owner(),
        mailbox,
        { ...state, revision: state.revision + 1n },
        { account, configuration: 1n, lifecycle: 1n },
        0n,
        15000,
        budget(),
      ),
    ).rejects.toThrow();
  });
  it("empty observation authority rejects mixed canonical publication atomically", async () => {
    const wire = await peer({ uids: [], uidNext: 1 });
    await turn(wire);
    mailbox = (await snapshot()).id;
    const exec = executor();
    const state = await recoverReceiving(exec, owner(), mailbox, budget());
    const captured = JSON.stringify(
      Object.fromEntries(Object.entries(state).map(([k, v]) => [k, String(v)])),
    );
    await expect(
      exec.transaction(async (db) => {
        await db.execute(sql`select maildock_receiving_observation_due(${actor}::uuid,${generation}::bigint,${mailbox}::uuid,
        ${account}::uuid,1,1,${captured}::jsonb,0,15000)`);
        await db.execute(
          sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${mailbox}::uuid`,
        );
      }, budget()),
    ).rejects.toThrow();
    expect((await snapshot()).revision).toBe("0");
  });
  it("an unrelated VANISHED on a non-resumed selection is never removal evidence", async () => {
    const { wire } = await seedMany([1]);
    const next = await peer({
      uids: [1],
      uidNext: 2,
      modseq: 9,
      capabilities: "IMAP4rev1 ENABLE CONDSTORE QRESYNC",
      qresync: true,
      onCommand(p, cmd) {
        if (/^(SELECT|EXAMINE) /.test(cmd.command))
          p.send("* VANISHED (EARLIER) 1\r\n", cmd);
      },
    });
    await turn(next);
    expect(await placements()).toHaveLength(1);
    expect(
      next.commands.some(
        (c) => c.command.startsWith("ENABLE") && c.command.includes("QRESYNC"),
      ),
    ).toBe(true);
    expect(
      next.commands.some((c) => /^(SELECT|EXAMINE).*QRESYNC/.test(c.command)),
    ).toBe(false);
    expect(wire.commands.length).toBeGreaterThan(0);
  });

  it("heartbeat discovers a newly enabled account and its INBOX without restarting", async () => {
    const { wire } = await seedMany([1]);
    const coordinator = await start(wire, 500);
    const [template] = await database.db
      .select()
      .from(mailAccounts)
      .where(sql`id=${account}::uuid`);
    const added = randomUUID();
    await database.db.insert(mailAccounts).values({
      ...template,
      id: added,
      enabled: false,
      email: "added@example.test",
    });
    await reader`update mail_accounts set enabled=true where id=${added}`;
    await until(
      async () =>
        (
          await reader`select * from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${added}`
        ).length === 1,
    );

    await coordinator.stop();
  });
  it("removed accounts disappear from elected membership without resurrection", async () => {
    const { wire } = await seedMany([1]);
    const coordinator = await start(wire, 500);
    await until(() => coordinator.snapshot.scheduler?.active === 0);
    await reader`select maildock_receiving_terminal_remove(${account},1,1)`;
    await until(
      async () =>
        !(await reader`select * from mail_accounts where id=${account}`).length,
    );
    await delay(260);
    const count = wire.commands.length;
    await delay(260);
    expect(wire.commands.length).toBe(count);
    expect(await rows()).toHaveLength(0);
    await coordinator.stop();
  });
  it("129 eligible accounts fail closed before constructing a receiving socket", async () => {
    const { wire } = await seedMany([1]);
    const [template] = await database.db
      .select()
      .from(mailAccounts)
      .where(sql`id=${account}::uuid`);
    await database.db.insert(mailAccounts).values(
      Array.from({ length: 128 }, (_, i) => ({
        ...template,
        id: randomUUID(),
        email: `overflow-${i}@example.test`,
      })),
    );
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const count = wire.commands.length;
    const coordinator = new ElectedReceivingCoordinator({
      executor: executor(),
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: wire.connection,
        createClient: wire.createClient,
      }),
    });
    cleanup.push(() => coordinator.stop());
    await expect(coordinator.elect()).rejects.toThrow("capacity exceeded");
    expect(wire.commands.length).toBe(count);
  });
  it.each([false, true])(
    "flag keysets advance beyond a full page (terminal=%s)",
    async (terminal) => {
      const { options, wire } = await seedMany(
        Array.from({ length: 34 }, (_, i) => i + 1),
      );
      const pp =
        await reader`select * from mailbox_messages where mailbox_id=${mailbox} order by uid`;
      const ids: string[] = [];
      for (const p of pp) {
        const id = randomUUID();
        ids.push(id);
        await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding,original_flags,created_at)
        values(${id},${account},${mailbox},${p.id},${p.message_id},'mark_unread','INBOX',7,${p.uid},1,${p.flags}::text[],
          timestamptz '2000-01-01' - ${generation.toString()}::bigint*interval '1 day' + ${ids.length}*interval '1 millisecond')`;
      }
      if (terminal) {
        const exec = executor();
        const old = await recoverReceiving(exec, owner(), mailbox, budget());
        await new ReceivingPersistence(exec).persist(
          owner(),
          mailbox,
          old,
          {
            kind: "repair",
            complete: true,
            epoch: old.epoch,
            known: pp.map((p) => BigInt(p.uid)),
            present: [33n, 34n],
            flags: [
              { uid: "33", flags: ["\\Seen"] },
              { uid: "34", flags: ["\\Seen"] },
            ],
            wrap: false,
          },
          budget(),
          { account, configuration: 1n, lifecycle: 1n },
          { generation: 0n, pollMs: 15000 },
        );
        for (const id of ids.slice(0, 32))
          await exec.transaction(
            (db) =>
              db.execute(sql`
        select maildock_receiving_repair_intent(${actor}::uuid,${generation}::bigint,${account}::uuid,1,1,'command',${id}::uuid)`),
            budget(),
          );
        expect(
          await reader`select * from message_commands where account_id=${account} and status='failed'`,
        ).toHaveLength(32);
      }
      options.select = "hung";
      await reader`update receiving_coordinator set expires_at='-infinity'`;
      const coordinator = new ElectedReceivingCoordinator({
        executor: executor(),
        tuning: { workers: 1 },
        loadAccount: async (_db, candidate) => ({
          ...candidate,
          connection: wire.connection,
          createClient: wire.createClient,
        }),
        loadOperationConnection: async () => wire.connection,
        operationHandlers: {
          store: { flags: true },
          "exact-lookup": { flags: true },
        },
      });
      cleanup.push(() => coordinator.stop());
      const submitted: string[] = [];
      const submit = coordinator.submit.bind(coordinator);
      coordinator.submit = (operation) => {
        if ("pendingId" in operation) submitted.push(operation.pendingId);
        return submit(operation);
      };
      await coordinator.elect();
      await coordinator.dispatchFlagCommands();
      await coordinator.dispatchFlagCommands();
      expect(submitted).toEqual(terminal ? [ids[32]] : [ids[0], ids[32]]);
      expect(coordinator.snapshot.scheduler?.pending).toBe(terminal ? 1 : 2);
      expect(wire.commands.some((c) => c.command.startsWith("UID STORE"))).toBe(
        false,
      );
      await coordinator.stop();
    },
  );
  it("external removal retains pending command provenance without blocking membership publication", async () => {
    const { options, wire } = await seedMany([1]);
    const [p] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    const command = randomUUID();
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding,original_flags)
      values(${command},${account},${mailbox},${p.id},${p.message_id},'mark_unread','INBOX',7,1,1,${p.flags}::text[])`;
    options.uids!.length = 0;
    await turn(wire);
    expect(await placements()).toHaveLength(0);
    const [intent] =
      await reader`select * from message_commands where id=${command}`;
    expect(intent.status).toBe("pending");
    expect(intent.source_uid).toBe("1");
    expect(intent.source_uid_validity).toBe("7");
    expect(intent.placement_id).toBeNull();
    expect(intent.attempts).toBe(0);
    expect(intent.receiving_attempt).toBeNull();
  });

  it("reference release requires claimed scope and rolls back unless the placement is removed", async () => {
    await seedMany([1]);
    const [p] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    const command = randomUUID();
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding,original_flags)
      values(${command},${account},${mailbox},${p.id},${p.message_id},'mark_unread','INBOX',7,1,1,${p.flags}::text[])`;
    const exec = executor();
    const old = await recoverReceiving(exec, owner(), mailbox, budget());
    await expect(
      exec.transaction(
        (db) =>
          db.execute(
            sql`select maildock_receiving_membership_references(${mailbox}::uuid,${old.revision}::bigint,7,1,'["1"]'::jsonb)`,
          ),
        budget(),
      ),
    ).rejects.toThrow();
    await expect(
      exec.transaction(async (db) => {
        await claimReceiving(db, owner(), mailbox, old);
        await db.execute(
          sql`select maildock_receiving_membership_references(${mailbox}::uuid,${old.revision}::bigint,7,1,'["1"]'::jsonb)`,
        );
        await db.execute(
          sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${mailbox}::uuid`,
        );
      }, budget()),
    ).rejects.toThrow();
    expect(await placements()).toHaveLength(1);
    expect(
      (
        await reader`select placement_id from message_commands where id=${command}`
      )[0].placement_id,
    ).toBe(p.id);
    expect((await snapshot()).revision).toBe(old.revision.toString());
  });
});
