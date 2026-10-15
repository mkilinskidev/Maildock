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
describe("R06 owned INBOX bootstrap and epoch replacement", () => {
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
        options: { kind, ...budget(ms), signal, assertCurrent() {} },
      },
      wire.createClient,
    );
  }
  async function seed(attachment = false) {
    const wire = await peer({ uids: [1], uidNext: 2, attachment });
    await turn(wire);
    const old = await turn(wire, "history");
    mailbox = (await snapshot()).id;
    return old.state;
  }
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  }
  async function holdSelect(options: WindowPeerOptions = {}) {
    const selected = barrier(),
      go = barrier();
    const wire = await peer({
      ...options,
      onCommand(p, c) {
        if (/^(SELECT|EXAMINE) /.test(c.command)) {
          selected.release();
          void go.promise.then(() => {
            p.send(
              `* 0 EXISTS\r\n* FLAGS ()\r\n* OK [UIDVALIDITY ${options.epoch ?? 7}] Epoch\r\n* OK [UIDNEXT ${options.uidNext ?? 1}] Next\r\n`,
              c,
            );
            p.ok(c);
          });
          return true;
        }
      },
    });
    cleanup.push(async () => go.release());
    return { wire, selected, go };
  }
  it("elected bounded candidate admission bootstraps a zero-mailbox account and restart resumes history", async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const wire = await peer({ uids: [1], uidNext: 2 });
    const turns: string[] = [];
    const create = () => {
      const elected = new ElectedReceivingCoordinator({
        executor: executor(),
        tuning: { workers: 1 },
        loadAccount: async (_db, candidate) => ({
          ...candidate,
          connection: wire.connection,
          createClient: wire.createClient,
          timing: { pollMs: 30000 },
          onTurn: (kind) => turns.push(kind),
        }),
      });
      cleanup.push(() => elected.stop());
      return elected;
    };
    const first = create();
    expect(await first.elect()).toBe(true);
    await until(
      async () =>
        (
          await reader`select count(*)::int n from receiving_current_placements p join mailboxes m on m.id=p.mailbox_id where m.account_id=${account}`
        )[0].n === 1,
      5000,
    );
    await first.stop();
    const saved = await snapshot();
    expect((await rows()).length).toBe(1);
    expect(saved.epoch).toBe("7");
    expect(saved.recent_sync_uid_validity).toBeNull();
    const next = create();
    expect(await next.elect()).toBe(true);
    await until(() => turns.filter((k) => k === "fresh").length >= 2, 5000);
    await next.stop();
    expect((await snapshot()).id).toBe(saved.id);
  });
  it("empty INBOX UIDNEXT=1 commits exact F/E/R and preserves durable account demand", async () => {
    const savedDemand = (
      await reader`select receiving_request_generation,receiving_due_at from mail_accounts where id=${account}`
    )[0];
    const result = await turn(await peer({ uids: [], uidNext: 1 }));
    expect(result.state).toEqual({
      epoch: 7n,
      revision: 0n,
      freshThrough: 0n,
      historyBefore: 1n,
      reconcileAfter: 0n,
    });
    const saved = await snapshot();
    expect(saved.receiving_request_generation).toBe(
      savedDemand.receiving_request_generation,
    );
    expect(saved.receiving_due_at).toEqual(savedDemand.receiving_due_at);
    expect((await rows()).length).toBe(1);
  });
  it.each(["missing-next", "hung"] as const)(
    "%s SELECT creates no canonical identity",
    async (select) => {
      await expect(
        turn(
          await peer({ select, uids: [], uidNext: 1 }),
          "fresh",
          executor(),
          undefined,
          250,
        ),
      ).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    },
  );
  it.each(["0", "-1", "xyz", "4294967296", "7] Epoch\r\n* OK [UIDVALIDITY 8"])(
    "invalid or duplicated UIDVALIDITY %s is rejected",
    async (epoch) => {
      const wire = await peer({
        onCommand(p, c) {
          if (/^(SELECT|EXAMINE) /.test(c.command)) {
            p.send(
              `* 0 EXISTS\r\n* FLAGS ()\r\n* OK [UIDVALIDITY ${epoch}] Epoch\r\n* OK [UIDNEXT 1] Next\r\n`,
              c,
            );
            p.ok(c);
            return true;
          }
        },
      });
      await expect(turn(wire)).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    },
  );
  it.each(["0", "xyz", "4294967297"])(
    "invalid UIDNEXT %s is rejected",
    async (next) => {
      const wire = await peer({
        onCommand(p, c) {
          if (/^(SELECT|EXAMINE) /.test(c.command)) {
            p.send(
              `* 0 EXISTS\r\n* FLAGS ()\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT ${next}] Next\r\n`,
              c,
            );
            p.ok(c);
            return true;
          }
        },
      });
      await expect(turn(wire)).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    },
  );
  it("inconsistent SELECT counts and failed tagged completion create no identity", async () => {
    await expect(turn(await peer({ uids: [1], uidNext: 1 }))).rejects.toThrow();
    const wire = await peer({
      onCommand(p, c) {
        if (/^(SELECT|EXAMINE) /.test(c.command)) {
          p.ok(c, "NO Select refused");
          return true;
        }
      },
    });
    await expect(turn(wire)).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });
  it("cancellation before publication leaves no enrollment", async () => {
    const held = await holdSelect();
    const abort = new AbortController();
    const result = turn(held.wire, "fresh", executor(), abort.signal);
    const checked = expect(result).rejects.toThrow();
    await held.selected.promise;
    abort.abort();
    await checked;
    held.go.release();
    expect(await rows()).toHaveLength(0);
  });
  it("configuration change during SELECT rejects stale bootstrap", async () => {
    const held = await holdSelect();
    const result = turn(held.wire);
    const checked = expect(result).rejects.toThrow();
    await held.selected.promise;
    await reader`update mail_accounts set imap_host='changed.test' where id=${account}`;
    held.go.release();
    await checked;
    expect(await rows()).toHaveLength(0);
  });
  it("disable/re-enable ABA during SELECT rejects stale bootstrap", async () => {
    const held = await holdSelect();
    const result = turn(held.wire);
    const checked = expect(result).rejects.toThrow();
    await held.selected.promise;
    await reader`update mail_accounts set enabled=false where id=${account}`;
    await reader`update mail_accounts set enabled=true where id=${account}`;
    held.go.release();
    await checked;
    expect(await rows()).toHaveLength(0);
  });
  it("request arriving during bootstrap remains durable", async () => {
    const held = await holdSelect();
    const result = turn(held.wire);
    await held.selected.promise;
    await reader`select * from maildock_receiving_request(${account},null)`;
    const before = (
      await reader`select receiving_request_generation,receiving_due_at from mail_accounts where id=${account}`
    )[0];
    held.go.release();
    await result;
    expect((await snapshot()).receiving_request_generation).toBe(
      before.receiving_request_generation,
    );
    expect((await snapshot()).receiving_due_at).toEqual(
      before.receiving_due_at,
    );
  });
  it("takeover during SELECT rejects the former owner's publication", async () => {
    const held = await holdSelect();
    const result = turn(held.wire);
    const checked = expect(result).rejects.toThrow();
    await held.selected.promise;
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`select maildock_receiving_takeover(${randomUUID()},60000)`;
    held.go.release();
    await checked;
    expect(await rows()).toHaveLength(0);
  });
  it("UIDVALIDITY replacement stops before FETCH, hides old rows and restarts fresh-first", async () => {
    const old = await seed();
    const wire = await peer({ epoch: 8, uids: [1], uidNext: 2 });
    const replacement = await turn(wire, "history");
    expect(replacement.state).toEqual({
      epoch: 8n,
      revision: old.revision + 1n,
      freshThrough: 1n,
      historyBefore: 2n,
      reconcileAfter: 0n,
    });
    expect(replacement.moreFresh).toBe(true);
    expect(wire.commands.some((c) => c.command.startsWith("UID FETCH"))).toBe(
      false,
    );
    expect(
      (
        await reader`select count(*)::int n from receiving_current_placements where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(0);
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(1);
    // Reconstruct from committed state before first new-epoch FETCH.
    await turn(wire);
    await turn(wire, "history");
    expect(
      (
        await reader`select uid_validity from receiving_current_placements where mailbox_id=${mailbox}`
      )[0].uid_validity,
    ).toBe("8");
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(2);
    await expect(
      new ReceivingPersistence(executor()).persist(
        owner(),
        mailbox,
        old,
        { kind: "epoch", complete: true, epoch: 9n, uidNext: 2n },
        budget(),
      ),
    ).rejects.toThrow();
  });
  it("configuration rebind with repeated epoch/UID retains old placements and publishes distinct new facts", async () => {
    await seed();
    await reader`update mail_accounts set imap_host='rebound.test' where id=${account}`;
    const wire = await peer({ uids: [1], uidNext: 2 });
    await turn(wire);
    expect(wire.commands.some((c) => c.command.startsWith("UID FETCH"))).toBe(
      false,
    );
    expect((await snapshot()).configuration_binding).toBe("2");
    expect(
      (
        await reader`select count(*)::int n from receiving_current_placements where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(0);
    await turn(wire);
    const current = await turn(wire, "history");
    expect(
      (
        await reader`select configuration_binding from mailbox_messages where mailbox_id=${mailbox} order by configuration_binding`
      ).map((r) => r.configuration_binding),
    ).toEqual(["1", "2"]);
    expect(
      (
        await reader`select count(*)::int n from receiving_current_placements where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(1);
    await new ReceivingPersistence(executor()).persist(
      owner(),
      mailbox,
      current.state,
      {
        kind: "repair",
        complete: true,
        epoch: 7n,
        known: [1n],
        present: [1n],
        flags: [{ uid: "1", flags: ["\\Flagged"] }],
        wrap: false,
      },
      budget(),
    );
    expect(
      (
        await reader`select configuration_binding,flags from mailbox_messages where mailbox_id=${mailbox} order by configuration_binding`
      ).map((r) => [r.configuration_binding, r.flags]),
    ).toEqual([
      ["1", ["\\Seen"]],
      ["2", ["\\Flagged"]],
    ]);
  });
  it("delayed old FETCH cannot publish after a separately committed epoch replacement", async () => {
    const old = await seed();
    const fetched = barrier(),
      go = barrier();
    const wire = await peer({
      uids: [2],
      uidNext: 3,
      onCommand(p, c) {
        if (c.command.startsWith("UID FETCH")) {
          const ok = p.ok.bind(p);
          p.ok = (command, status) => {
            if (command === c) {
              fetched.release();
              void go.promise.then(() => ok(command, status));
            } else ok(command, status);
          };
        }
      },
    });
    const result = turn(wire);
    const checked = result.then(
      () => {
        throw new Error("Stale FETCH published");
      },
      (error) => {
        const messages: string[] = [];
        for (let cause = error; cause; cause = cause.cause)
          messages.push(cause.message);
        expect(messages.join(" ")).toContain(
          "Receiving epoch revision progress fenced",
        );
      },
    );
    await fetched.promise;
    await new ReceivingPersistence(executor()).persist(
      owner(),
      mailbox,
      old,
      { kind: "epoch", complete: true, epoch: 8n, uidNext: 3n },
      budget(),
    );
    go.release();
    await checked;
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(1);
  });
  it("sparse UID space resolves empty bounded history intervals without fabricated messages", async () => {
    const wire = await peer({ uids: [], uidNext: 1000 });
    await turn(wire);
    const history = await turn(wire, "history");
    expect(history.state.historyBefore).toBe(872n);
    expect(history.count).toBe(0);
  });
  it("crash before bootstrap COMMIT rolls back both identity and enrollment", async () => {
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(883106)`;
    await reader.unsafe(`CREATE FUNCTION r06_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(883106); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_r06_hold AFTER INSERT ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r06_hold();`);
    const result = turn(await peer({ uids: [], uidNext: 1 }));
    const checked = expect(result).rejects.toBeInstanceOf(
      ReceivingUnresolvedError,
    );
    try {
      let pid = 0;
      await until(async () => {
        const waiting =
          await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`;
        pid = waiting[0]?.pid as number;
        return !!pid;
      });
      expect(await rows()).toHaveLength(0);
      await reader`select pg_terminate_backend(${pid})`;
      await checked;
      expect(await rows()).toHaveLength(0);
      expect(
        (
          await reader`select count(*)::int n from receiving_mailboxes where mailbox_id=${mailbox}`
        )[0].n,
      ).toBe(0);
    } finally {
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_r06_hold ON receiving_mailboxes; DROP FUNCTION r06_hold();",
      );
    }
    await turn(await peer({ uids: [], uidNext: 1 }));
    expect(await rows()).toHaveLength(1);
  });
  it("lost bootstrap COMMIT response recovers under locks without duplicate mailbox identity", async () => {
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(883107)`;
    await reader.unsafe(`CREATE FUNCTION r06_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(883107); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_r06_hold AFTER INSERT ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r06_hold();`);
    const wire = await peer({ uids: [], uidNext: 1 });
    const result = turn(wire, "fresh", executor(relay.url), undefined, 1200);
    const checked = expect(result).rejects.toBeInstanceOf(
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
      await until(async () => (await rows()).length === 1);
      await checked;
      relay.control.drop = false;
      mailbox = randomUUID(); // Replacement process has no retained proposed UUID.
      await turn(wire);
      expect(await rows()).toHaveLength(1);
      expect((await snapshot()).revision).toBe("0");
    } finally {
      relay.control.drop = false;
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_r06_hold ON receiving_mailboxes; DROP FUNCTION r06_hold();",
      );
    }
  });
  it("publication waiting for account lock rechecks configuration after the concurrent editor commits", async () => {
    const held = await holdSelect();
    const result = turn(held.wire);
    const checked = expect(result).rejects.toThrow();
    await held.selected.promise;
    const editor = await reader.reserve();
    await editor`begin`;
    await editor`update mail_accounts set imap_host='after-wait.test' where id=${account}`;
    try {
      held.go.release();
      await until(
        async () =>
          (
            await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event_type='Lock'`
          ).length > 0,
      );
      await editor`commit`;
      await checked;
      expect(await rows()).toHaveLength(0);
    } finally {
      await editor`rollback`;
      editor.release();
    }
  });
  it("a failed account bootstrap backs off while another account receives metadata", async () => {
    const [original] =
      await reader`select * from mail_accounts where id=${account}`;
    const healthy = randomUUID();
    await database.db.insert(mailAccounts).values({
      ...(
        await database.db
          .select()
          .from(mailAccounts)
          .where(sql`id=${account}::uuid`)
      )[0],
      id: healthy,
    });
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const bad = await peer({
      onCommand(p, c) {
        if (/^(SELECT|EXAMINE) /.test(c.command)) {
          p.ok(c, "NO Bad account");
          return true;
        }
      },
    });
    const good = await peer({ uids: [1], uidNext: 2 });
    let failures = 0;
    const elected = new ElectedReceivingCoordinator({
      executor: executor(),
      tuning: { workers: 1 },
      loadAccount: async (_db, c) => ({
        ...c,
        connection: (c.account === healthy ? good : bad).connection,
        createClient: (c.account === healthy ? good : bad).createClient,
        timing: { pollMs: 30000, retryMs: 1000, maxRetryMs: 1000 },
        onError: () => {
          failures++;
        },
      }),
    });
    cleanup.push(() => elected.stop());
    await elected.elect();
    await until(
      async () =>
        (
          await reader`select count(*)::int n from receiving_current_placements p join mailboxes m on m.id=p.mailbox_id where m.account_id=${healthy}`
        )[0].n === 1,
    );
    await elected.stop();
    expect(failures).toBeGreaterThanOrEqual(1);
    expect(await rows()).toHaveLength(0);
    expect(original.id).toBe(account);
  });
  it.each(["epoch", "configuration"])(
    "old content, attachment and command requests keep their original identity after %s replacement",
    async (replacement) => {
      await seed(true);
      const [p] =
        await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
      const [attachment] =
        await reader`select id from message_attachments where message_id=${p.message_id}`;
      await reader`select maildock_receiving_content_request(${account},${mailbox},${p.message_id})`;
      await reader`select maildock_receiving_attachment_request(${account},${attachment.id})`;
      await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding,original_flags)
      values(${randomUUID()},${account},${mailbox},${p.id},${p.message_id},'mark_unread','INBOX',7,1,1,${p.flags}::text[])`;
      const before =
        await reader`select to_jsonb(c) data from message_contents c where message_id=${p.message_id}
      union all select to_jsonb(a) from message_attachments a where id=${attachment.id}
      union all select to_jsonb(c) from message_commands c where message_id=${p.message_id}`;
      if (replacement === "configuration")
        await reader`update mail_accounts set imap_host='request-rebind.test' where id=${account}`;
      await turn(
        await peer({
          uids: [1],
          uidNext: 2,
          epoch: replacement === "epoch" ? 8 : 7,
          attachment: true,
        }),
      );
      const after =
        await reader`select to_jsonb(c) data from message_contents c where message_id=${p.message_id}
      union all select to_jsonb(a) from message_attachments a where id=${attachment.id}
      union all select to_jsonb(c) from message_commands c where message_id=${p.message_id}`;
      expect(after).toEqual(before);
      await expect(
        reader`select maildock_receiving_content_request(${account},${mailbox},${p.message_id})`,
      ).rejects.toThrow();
      await expect(
        reader`select maildock_receiving_attachment_request(${account},${attachment.id})`,
      ).rejects.toThrow();
    },
  );
  it("fresh metadata in the new epoch becomes visible after the replacement restart", async () => {
    await seed();
    const script: WindowPeerOptions = { epoch: 8, uids: [1], uidNext: 2 };
    const wire = await peer(script);
    await turn(wire); // committed replacement, no FETCH
    script.uids!.push(2);
    script.uidNext = 3;
    const fresh = await turn(wire);
    expect(fresh.count).toBe(1);
    expect(fresh.state.freshThrough).toBe(2n);
    expect(
      (
        await reader`select uid,uid_validity from receiving_current_placements where mailbox_id=${mailbox}`
      ).map((r) => [r.uid, r.uid_validity]),
    ).toEqual([["2", "8"]]);
    expect(
      (
        await reader`select count(*)::int n from mailbox_messages where mailbox_id=${mailbox}`
      )[0].n,
    ).toBe(2);
  });
  it("lost epoch replacement COMMIT is recovered before the first new-epoch FETCH", async () => {
    const old = await seed();
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(883108)`;
    await reader.unsafe(`CREATE FUNCTION r06_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.epoch<>OLD.epoch THEN PERFORM pg_advisory_xact_lock(883108); END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_r06_hold AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r06_hold();`);
    const wire = await peer({ uids: [1], uidNext: 2, epoch: 8 });
    const result = turn(wire, "fresh", executor(relay.url), undefined, 1200);
    const checked = expect(result).rejects.toBeInstanceOf(
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
      await until(async () => (await snapshot()).epoch === "8");
      await checked;
      expect(wire.commands.some((c) => c.command.startsWith("UID FETCH"))).toBe(
        false,
      );
      relay.control.drop = false;
      const recovered = await turn(wire);
      expect(recovered.state.revision).toBe(old.revision + 1n);
      await turn(wire, "history");
      expect(
        (
          await reader`select uid_validity from receiving_current_placements where mailbox_id=${mailbox}`
        )[0].uid_validity,
      ).toBe("8");
    } finally {
      relay.control.drop = false;
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_r06_hold ON receiving_mailboxes; DROP FUNCTION r06_hold();",
      );
    }
  });
  it("shared elected scheduler observes a replacement during history and admits fresh before new history", async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const script: WindowPeerOptions = {
      uids: [1, 129],
      uidNext: 257,
      epoch: 7,
    };
    const wire = await peer(script);
    let switched = false;
    const after: string[] = [];
    const elected = new ElectedReceivingCoordinator({
      executor: executor(),
      tuning: { workers: 1 },
      loadAccount: async (_db, c) => ({
        ...c,
        connection: wire.connection,
        createClient: wire.createClient,
        timing: { pollMs: 30000 },
        onTurn: (kind, result) => {
          if (result.identityTransition) {
            expect(kind).toBe("history");
            switched = true;
            return;
          }
          if (switched) after.push(kind);
          else if (kind === "history") script.epoch = 8;
        },
      }),
    });
    cleanup.push(() => elected.stop());
    await elected.elect();
    await until(() => after.length > 0);
    await elected.stop();
    expect(after[0]).toBe("fresh");
    expect((await snapshot()).epoch).toBe("8");
  });
});
