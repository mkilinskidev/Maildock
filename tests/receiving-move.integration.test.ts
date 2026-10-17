import * as diagnostics from "@/shared/infrastructure/logging/receiving-diagnostics";
import {
  ReceivingBoundedPublication,
  type DataAuthority,
} from "@/modules/mail/application/receiving-bounded-publication";
import { sql } from "drizzle-orm";
import { ReceivingPublication } from "@/modules/mail/application/receiving-publication";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { ImapFlow } from "imapflow";
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
  vi,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { type PublicationSource } from "@/modules/mail/application/receiving-publication";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import {
  MessageCommandService,
  type MessageAction,
} from "@/modules/mail/application/message-command-service";
import {
  fixture,
  type Peer,
  type Command,
} from "../experiments/imap-transport/fixture";

const budget = () => ({ deadline: performance.now() + 5000 });
async function until(check: () => Promise<boolean> | boolean) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() >= end)
      throw new Error("Flag fixture barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("R14 owner routed MOVE and bounded repair", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let url: string, account: string, message: string;
  let source: PublicationSource;
  let destination: string;
  const cleanup: (() => Promise<unknown>)[] = [];
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
    await root`create database receiving_move owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_move`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 4 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 2);
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    const owner = { actor, generation: BigInt(lease.generation) };
    account = randomUUID();
    const mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "MOVE",
      imapCapabilities: ["MOVE", "UIDPLUS"],
      email: "flags@example.test",
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
      name: "Source",
      remotePath: "Source",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const persistence = new ReceivingPersistence(executor);
    await persistence.initialize(
      owner,
      mailbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await persistence.persist(
      owner,
      mailbox,
      {
        epoch: 7n,
        revision: 0n,
        freshThrough: 1n,
        historyBefore: 2n,
        reconcileAfter: 0n,
      },
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 1n,
          high: 1n,
          searched: [1n],
          confirmedAbsent: [],
        },
        metadata: [
          {
            uid: "1",
            internalDate: "2026-01-01T00:00:00Z",
            size: "10",
            hasAttachments: false,
            flags: ["\\Answered", "$Custom"],
            envelope: {
              messageId: `<${account}@example.test>`,
              subject: "Flags",
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
    );
    const [placement] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    message = placement.message_id;
    destination = randomUUID();
    await database.db.insert(mailboxes).values({
      id: destination,
      accountId: account,
      name: "Archive",
      remotePath: "Archive",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await persistence.initialize(
      owner,
      destination,
      { complete: true, epoch: 9n, uidNext: 43n },
      budget(),
    );
    await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'archive',${destination},'manual'),(${account},'trash',${destination},'manual')`;
    source = {
      mailbox,
      configuration: 1n,
      state: {
        epoch: 7n,
        revision: 1n,
        freshThrough: 1n,
        historyBefore: 1n,
        reconcileAfter: 0n,
      },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  async function row(id: string) {
    const [row] = await reader`select * from message_commands where id=${id}`;
    return row;
  }
  async function create(action: MessageAction = "archive") {
    const service = new MessageCommandService(
      database.db,
      async () => {
        throw new Error("Legacy enqueue forbidden");
      },
      async () => {},
    );
    return (await service.create(account, source.mailbox, message, action)).id;
  }
  async function harness(
    input: {
      workers?: number;
      mode?: string;
      automatic?: boolean;
      beforePublish?: () => Promise<void>;
      onMove?: (p: Peer, c: Command) => Promise<void>;
      beforeClient?: () => Promise<void>;
    } = {},
  ) {
    let moved = false,
      moves = 0,
      targetReads = 0,
      claimed = false;
    const selected = new Map<number, string>();
    const peer = await fixture(
      (p, c) => {
        if (c.command === "NAMESPACE") {
          p.send('* NAMESPACE (("Personal/" "/")) NIL NIL\r\n', c);
          p.ok(c);
          return true;
        }
        if (/^(LOGIN|AUTHENTICATE)/.test(c.command)) {
          p.ok(c);
          return true;
        }
        if (/^(SELECT|EXAMINE)/.test(c.command)) {
          const target = c.command.includes("Archive");
          selected.set(p.id, target ? "target" : "source");
          const epoch = target ? 9 : input.mode === "source-epoch" ? 8 : 7;
          p.send(
            `* ${target ? 1 : moved ? 0 : 1} EXISTS\r\n* FLAGS (\\Seen \\Answered)\r\n* OK [PERMANENTFLAGS (\\Seen \\Answered \\*)] Flags\r\n* OK [UIDVALIDITY ${epoch}] Epoch\r\n* OK [UIDNEXT ${target ? 43 : 2}] Next\r\n`,
            c,
          );
          p.ok(
            c,
            c.command.startsWith("SELECT")
              ? "OK [READ-WRITE] Selected"
              : "OK [READ-ONLY] Selected",
          );
          return true;
        }
        if (c.command.startsWith("UID SEARCH")) {
          p.send("* SEARCH 42 43\r\n", c);
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("UID FETCH")) {
          const target = selected.get(p.id) === "target";
          if (target) targetReads++;
          if (target && input.mode === "target-lost" && targetReads === 1) {
            p.socket.destroy();
            return true;
          }
          if ((target && moved) || (!target && !moved))
            p.send(
              `* ${target ? 12 : 1} FETCH (UID ${input.mode === "wrong-uid" ? 99 : target ? 42 : 1} FLAGS (\\Answered $Custom))\r\n`,
              c,
            );
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("UID MOVE")) {
          moves++;
          moved = true;
          void (async () => {
            const [r] =
              await reader`select status,attempts,receiving_attempt from message_commands where account_id=${account} order by created_at desc limit 1`;
            claimed =
              r.status === "executing" &&
              r.attempts === 1 &&
              r.receiving_attempt.phase === "claimed";
            expect(executor.snapshot.executing).toBe(0);
            await input.onMove?.(p, c);
            if (input.mode === "lost") {
              p.socket.destroy();
              return;
            }
            const mapping =
              input.mode === "no-copyuid"
                ? ""
                : `[COPYUID ${input.mode === "bad-epoch" ? 10 : 9} ${input.mode === "bad-source" ? 2 : 1} ${input.mode === "bad-uid" ? 0 : input.mode === "uid-set" ? "42:43" : 42}] `;
            if (input.mode === "duplicate")
              p.send("* OK [COPYUID 9 1 42] Mapping\r\n", c);
            if (input.mode === "untagged") {
              p.send("* OK [COPYUID 9 1 42] Mapping\r\n", c);
              p.ok(c);
            } else p.ok(c, "OK " + mapping + "Moved");
          })();
          return true;
        }
        return false;
      },
      {},
      "OK",
      `IMAP4rev1 AUTH=PLAIN UIDPLUS${input.mode === "unsupported" ? "" : " MOVE"}${input.mode === "namespace" ? " NAMESPACE" : ""}`,
    );
    cleanup.push(peer.cleanup);
    const connection = {
      host: peer.endpoint.host,
      port: peer.endpoint.port,
      security: "tls" as const,
      username: "fixture",
      credential: { kind: "password" as const, password: "fixture-only" },
    };
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: { workers: input.workers ?? 2 },
      loadAccount: async (_db, c) => ({ ...c, connection }),
      loadOperationConnection: async () => {
        await input.beforeClient?.();
        return connection;
      },
      operationHandlers: {
        move: { move: true },
        "exact-lookup": { move: true },
        repair: { repair: true },
        select: { topology: "select" },
      },
      createOperationClient: (options) => {
        const client = new ImapFlow({
          ...options,
          tls: { rejectUnauthorized: false },
        });
        if (input.beforePublish) {
          const retire = client.retireReceiving.bind(client);
          let once = true;
          client.retireReceiving = async () => {
            await retire();
            if (once) {
              once = false;
              await input.beforePublish!();
            }
          };
        }
        return client;
      },
    });
    if (!input.automatic) {
      coordinator.dispatchMoveCommands = async () => {};
      coordinator.dispatchRepairs = async () => {};
    }
    cleanup.push(() => coordinator.stop());
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    expect(await coordinator.elect()).toBe(true);
    const submit = (id: string, kind: "move" | "exact-lookup" = "move") =>
      coordinator.submit({
        kind,
        pendingId: id,
        lookup: kind === "exact-lookup" ? "move" : undefined,
        requestId: randomUUID(),
        deadline: performance.now() + 9000,
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: 1n,
        },
      });
    const repair = (
      id: string,
      repairKind: "command" | "content" | "attachment" | "sent" = "command",
    ) =>
      coordinator.submit({
        kind: "repair",
        pendingId: id,
        repairKind,
        requestId: randomUUID(),
        deadline: performance.now() + 9000,
        identity: { account, configurationVersion: 1n },
      });
    return {
      peer,
      coordinator,
      submit,
      repair,
      counters: () => ({ moves, targetReads, claimed }),
    };
  }

  it.each(["archive", "trash"] as const)(
    "%s uses the original UID and mapped destination",
    async (action) => {
      const id = await create(action),
        f = await harness();
      const [projected] =
        await reader`select action_hidden from message_placement_projection where message_id=${message}`;
      expect(projected.action_hidden).toBe(true);
      await f.submit(id);
      const r = await row(id);
      expect(r.status).toBe("succeeded");
      expect(r.destination_uid).toBe("42");
      expect(r.destination_uid_validity).toBe("9");
      expect(f.counters()).toEqual({ moves: 1, targetReads: 1, claimed: true });
      expect(
        f.peer.commands
          .filter((c) => c.command.startsWith("UID MOVE"))
          .map((c) => c.command),
      ).toEqual(["UID MOVE 1 Archive"]);
      const placements =
        await reader`select mailbox_id,uid,uid_validity,message_id from mailbox_messages where message_id=${message}`;
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({
        mailbox_id: destination,
        uid: "42",
        uid_validity: "9",
        message_id: message,
      });
      const states =
        await reader`select fresh_through,history_before,reconcile_after from receiving_mailboxes where mailbox_id in (${source.mailbox},${destination}) order by fresh_through`;
      expect(states).toEqual([
        { fresh_through: "1", history_before: "1", reconcile_after: "0" },
        { fresh_through: "42", history_before: "43", reconcile_after: "0" },
      ]);
      expect(
        f.peer.commands.some((c) =>
          /EXPUNGE|COPY|STORE|DELETE|CLOSE/.test(c.command),
        ),
      ).toBe(false);
    },
  );
  it("confirmed MOVE without COPYUID removes source without inventing destination metadata", async () => {
    const id = await create(),
      f = await harness({ mode: "no-copyuid" });
    await f.submit(id);
    const r = await row(id);
    expect(r.status).toBe("succeeded");
    expect(r.destination_uid).toBeNull();
    expect(r.destination_uid_validity).toBeNull();
    expect(r.receiving_attempt.phase).toBe("awaiting_uid");
    expect(
      await reader`select * from mailbox_messages where message_id=${message}`,
    ).toHaveLength(0);
    const [due] =
      await reader`select receiving_due_at<=clock_timestamp() as due from mailboxes where id=${destination}`;
    expect(due.due).toBe(true);
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.counters().moves).toBe(1);
  });
  it("accepts one correlated untagged COPYUID followed by tagged success", async () => {
    const id = await create(),
      f = await harness({ mode: "untagged" });
    await f.submit(id);
    expect((await row(id)).destination_uid).toBe("42");
  });
  it.each(["bad-epoch", "bad-source", "bad-uid", "uid-set", "duplicate"])(
    "rejects %s COPYUID evidence and retains uncertainty",
    async (mode) => {
      const id = await create(),
        f = await harness({ mode });
      await expect(f.submit(id)).rejects.toThrow();
      expect((await row(id)).error).toBe("uncertain_remote_execution");
      expect((await row(id)).destination_uid).toBeNull();
      expect(
        await reader`select * from mailbox_messages where mailbox_id=${destination}`,
      ).toHaveLength(0);
      expect(f.counters().moves).toBe(1);
    },
  );
  it.each(["source-epoch", "wrong-uid", "unsupported"])(
    "fails before execution on %s",
    async (mode) => {
      const id = await create(),
        f = await harness({ mode });
      await expect(f.submit(id)).rejects.toThrow();
      expect(f.counters().moves).toBe(0);
      expect((await row(id)).error).toBe("failed_before_execution");
      expect(
        f.peer.commands.some((c) => /COPY|STORE|EXPUNGE|CLOSE/.test(c.command)),
      ).toBe(false);
    },
  );
  it("lost MOVE reply never replays and source disappearance stays uncertain", async () => {
    const events = vi.spyOn(diagnostics, "receivingDiagnostic");
    const id = await create(),
      f = await harness({ mode: "lost" });
    await expect(f.submit(id)).rejects.toThrow();
    const attempt = (await row(id)).receiving_attempt.id;
    expect(
      events.mock.calls.some(
        ([event]) =>
          event.event === "receiving.operation" &&
          event.stage === "messageMove" &&
          event.category === "mutation_outcome_unknown" &&
          event.disposition === "recover",
      ),
    ).toBe(true);
    await f.submit(id, "exact-lookup");
    expect((await row(id)).error).toBe("uncertain_remote_execution");
    expect((await row(id)).receiving_attempt.id).toBe(attempt);
    expect(f.counters().moves).toBe(1);
    expect(
      f.peer.commands.some((c) => c.command.startsWith("UID SEARCH")),
    ).toBe(false);
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.counters().moves).toBe(1);
  });
  it("persisted COPYUID proves exact read-only reconciliation after a failed target read", async () => {
    const id = await create(),
      f = await harness({ mode: "target-lost" });
    await expect(f.submit(id)).rejects.toThrow();
    expect((await row(id)).receiving_attempt.moveProof.uid).toBe("42");
    await f.submit(id, "exact-lookup");
    expect((await row(id)).status).toBe("succeeded");
    expect(f.counters().moves).toBe(1);
  });
  it("manual mapping wins over special-use topology", async () => {
    const other = randomUUID();
    await database.db.insert(mailboxes).values({
      id: other,
      accountId: account,
      name: "Other",
      remotePath: "Other",
      specialUse: ["\\Archive"],
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const id = await create(),
      f = await harness();
    await f.submit(id);
    expect((await row(id)).destination_mailbox_id).toBe(destination);
  });
  it.each(["missing", "unselectable"])(
    "rejects a %s destination before creating a command",
    async (mode) => {
      await reader`alter table mailboxes disable trigger receiving_update_guard`;
      try {
        if (mode === "missing")
          await reader`update mailboxes set lifecycle_status='missing' where id=${destination}`;
        else
          await reader`update mailboxes set selectable=false where id=${destination}`;
      } finally {
        await reader`alter table mailboxes enable trigger receiving_update_guard`;
      }
      await expect(create()).rejects.toThrow();
      expect(
        await reader`select * from message_commands where account_id=${account}`,
      ).toHaveLength(0);
    },
  );
  it("changed mapping before execution cannot retarget the command", async () => {
    const id = await create(),
      f = await harness();
    await reader`delete from mailbox_roles where account_id=${account} and role='archive'`;
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.counters().moves).toBe(0);
    await f.repair(id);
    expect((await row(id)).status).toBe("failed");
    expect((await row(id)).destination_mailbox_id).toBe(destination);
  });
  it("changed mapping after mutation fences publication", async () => {
    const id = await create(),
      f = await harness({
        beforePublish: async () => {
          await reader`delete from mailbox_roles where account_id=${account} and role='archive'`;
        },
      });
    await expect(f.submit(id)).rejects.toThrow();
    expect((await row(id)).status).not.toBe("succeeded");
    expect(f.counters().moves).toBe(1);
    await f.repair(id);
    expect((await row(id)).error).toBe("uncertain_remote_execution");
  });
  it("legacy runner refuses an enrolled MOVE command", async () => {
    const id = await create(),
      service = new MessageCommandService(
        database.db,
        async () => {},
        async () => {},
      );
    await service.run(id);
    expect((await row(id)).status).toBe("pending");
    expect((await row(id)).attempts).toBe(0);
  });
  it("three uncertain observations exhaust without resetting mutation or read budgets", async () => {
    const id = await create(),
      f = await harness({ mode: "lost" });
    await expect(f.submit(id)).rejects.toThrow();
    for (let i = 0; i < 3; i++) await f.submit(id, "exact-lookup");
    await expect(f.submit(id, "exact-lookup")).rejects.toThrow();
    await f.repair(id);
    const r = await row(id);
    expect(r.receiving_attempt.phase).toBe("repair_terminal");
    expect(r.receiving_attempt.observations).toBe(3);
    expect(r.attempts).toBe(1);
    expect(f.counters().moves).toBe(1);
  });
  it("automatic bounded discovery runs MOVE through elected admission", async () => {
    const id = await create(),
      f = await harness({ automatic: true });
    await until(async () => (await row(id)).status === "succeeded");
    expect(f.counters().moves).toBe(1);
  });

  it.each(["claim", "result"] as const)(
    "recovers lost %s COMMIT under destination locks without another MOVE",
    async (phase) => {
      let target = false,
        once = true;
      const relay = await receivingResponseRelay(url, (bytes) => {
        if (bytes.includes(Buffer.from("application_name"))) {
          relay.control.drop = false;
          target = false;
        }
        if (
          bytes.includes(
            Buffer.from(
              phase === "claim"
                ? "maildock_receiving_move_claim"
                : "maildock_receiving_move_result",
            ),
          )
        )
          target = true;
        if (once && target && bytes.includes(Buffer.from("commit\0"))) {
          relay.control.drop = true;
          once = false;
        }
      });
      cleanup.push(relay.close);
      await executor.stop();
      executor = new ReceivingExecutor(relay.url, 2);
      cleanup.push(async () => {
        await executor.stop();
        executor = new ReceivingExecutor(url, 2);
      });
      const id = await create(),
        f = await harness(),
        pending = f.submit(id);
      void pending.catch(() => {});
      await until(
        async () =>
          (await row(id)).status ===
          (phase === "claim" ? "executing" : "succeeded"),
      );
      const held = await reader.reserve();
      await held`begin`;
      try {
        await held`select id from mailboxes where id=${destination} for update`;
        await until(
          async () =>
            (
              await reader`select exists(select from pg_stat_activity where datname='receiving_move' and wait_event_type='Lock' and query like '%maildock_receiving_data_recover%') as waiting`
            )[0].waiting === true,
        );
        expect(f.counters().moves).toBe(phase === "claim" ? 0 : 1);
      } finally {
        await held`commit`;
        held.release();
      }
      await pending;
      expect(once).toBe(false);
      expect((await row(id)).status).toBe("succeeded");
      expect(f.counters().moves).toBe(1);
    },
  );
  it("owner takeover rejects stale result and read-only recovery retains the original attempt", async () => {
    let replacement: Awaited<ReturnType<typeof harness>> | undefined;
    const id = await create(),
      f = await harness({
        beforePublish: async () => {
          await reader`update receiving_coordinator set expires_at='-infinity'`;
          replacement = await harness();
        },
      });
    await expect(f.submit(id)).rejects.toThrow();
    expect((await row(id)).status).toBe("executing");
    const original = (await row(id)).receiving_attempt;
    await replacement!.submit(id, "exact-lookup");
    expect((await row(id)).status).toBe("failed");
    expect((await row(id)).receiving_attempt.id).toBe(original.id);
    expect(replacement!.counters().moves).toBe(0);
    expect(f.counters().moves).toBe(1);
  });
  it.each(["configuration", "epoch"] as const)(
    "%s replacement fences old MOVE publication and terminalizes the obsolete attempt",
    async (kind) => {
      const id = await create(),
        f = await harness({
          beforePublish: async () => {
            if (kind === "configuration")
              await reader`update mail_accounts set imap_host='replacement.test' where id=${account}`;
            else {
              const [lease] =
                await reader`select owner,generation from receiving_coordinator`;
              const [state] =
                await reader`select * from receiving_mailboxes where mailbox_id=${source.mailbox}`;
              await new ReceivingPersistence(executor).persist(
                { actor: lease.owner, generation: BigInt(lease.generation) },
                source.mailbox,
                {
                  epoch: BigInt(state.epoch),
                  revision: BigInt(state.revision),
                  freshThrough: BigInt(state.fresh_through),
                  historyBefore: BigInt(state.history_before),
                  reconcileAfter: BigInt(state.reconcile_after),
                },
                {
                  kind: "epoch",
                  complete: true,
                  epoch: 8n,
                  uidNext: 2n,
                },
                budget(),
              );
            }
          },
        });
      await expect(f.submit(id)).rejects.toThrow();
      expect((await row(id)).status).not.toBe("succeeded");
      expect(f.counters().moves).toBe(1);
      const [a] =
        await reader`select configuration_version from mail_accounts where id=${account}`;
      await f.coordinator.submit({
        kind: "repair",
        repairKind: "command",
        pendingId: id,
        requestId: randomUUID(),
        deadline: performance.now() + 9000,
        identity: {
          account,
          configurationVersion: BigInt(a.configuration_version),
        },
      });
      expect((await row(id)).receiving_attempt.phase).toBe("repair_terminal");
      expect((await row(id)).error).toBe("uncertain_remote_execution");
    },
  );
  async function currentSource() {
    const [r] =
      await reader`select * from receiving_mailboxes where mailbox_id=${source.mailbox}`;
    return {
      ...source,
      state: {
        epoch: BigInt(r.epoch),
        revision: BigInt(r.revision),
        freshThrough: BigInt(r.fresh_through),
        historyBefore: BigInt(r.history_before),
        reconcileAfter: BigInt(r.reconcile_after),
      },
    };
  }
  async function currentOwner() {
    const [r] =
      await reader`select owner,generation from receiving_coordinator`;
    return { actor: r.owner, generation: BigInt(r.generation) };
  }
  it("exhausted flag reconciliation terminates diagnostically and preserves counters and canonical flags", async () => {
    const id = await create("mark_read"),
      owner = await currentOwner(),
      publication = new ReceivingPublication(executor);
    await publication.claim(
      owner,
      await currentSource(),
      "command",
      id,
      budget(),
    );
    for (let i = 0; i < 3; i++) {
      const state = JSON.stringify((await currentSource()).state, (_, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      await executor.transaction(async (db) => {
        await db.execute(
          sql`select maildock_receiving_flag_resume(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${state}::jsonb,1::bigint,${id}::uuid)`,
        );
      }, budget());
    }
    const f = await harness();
    await f.repair(id);
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.receiving_attempt.observations).toBe("3");
    expect(r.attempts).toBe(1);
    expect(r.receiving_attempt.repairReason).toBe(
      "receiving_attempts_exhausted",
    );
    const [p] =
      await reader`select flags from mailbox_messages where message_id=${message}`;
    expect(p.flags).toEqual(["\\Answered", "$Custom"]);
    expect(f.peer.commands).toHaveLength(0);
    expect(await create("mark_unread")).not.toBe(id);
  });
  it("exhausted content restart chain becomes failed while an explicit later request remains possible", async () => {
    await reader`insert into message_contents(message_id,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding) values(${message},'pending',${source.mailbox},7,1,1)`;
    const owner = await currentOwner(),
      publication = new ReceivingPublication(executor);
    for (let i = 0; i < 3; i++)
      await publication.contentClaim(
        owner,
        await currentSource(),
        "content",
        message,
        budget(),
      );
    const f = await harness();
    await f.repair(message, "content");
    const [r] =
      await reader`select * from message_contents where message_id=${message}`;
    expect(r.status).toBe("failed");
    expect(r.receiving_attempt.reads).toBe("3");
    expect(r.plain_text).toBeNull();
    expect(f.peer.commands).toHaveLength(0);
    await reader`update message_contents set status='pending',error=null,updated_at=clock_timestamp() where message_id=${message}`;
    expect(
      (
        await reader`select status from message_contents where message_id=${message}`
      )[0].status,
    ).toBe("pending");
  });
  it("repair refuses another account intent without changing its durable facts", async () => {
    const id = await create(),
      f = await harness();
    const before = await row(id);
    const other = randomUUID();
    await reader`insert into mail_accounts select (jsonb_populate_record(null::mail_accounts,to_jsonb(a)||jsonb_build_object('id',${other}::text,'email',${other + "@example.test"}::text))).* from mail_accounts a where a.id=${account}`;
    await expect(
      executor.transaction(async (db) => {
        const owner = await currentOwner();
        await db.execute(
          sql`select maildock_receiving_repair_intent(${owner.actor}::uuid,${owner.generation}::bigint,${other}::uuid,1::bigint,1::bigint,'command',${id}::uuid)`,
        );
      }, budget()),
    ).rejects.toThrow();
    expect(await row(id)).toEqual(before);
    expect(f.peer.commands).toHaveLength(0);
  });

  it("owned destination enrollment uses SELECT only before the first MOVE", async () => {
    const target = randomUUID();
    await database.db.insert(mailboxes).values({
      id: target,
      accountId: account,
      name: "Archive2",
      remotePath: "Archive2",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await reader`update mailbox_roles set mailbox_id=${target} where account_id=${account} and role='archive'`;
    const id = await create(),
      f = await harness({ automatic: true });
    await until(
      async () =>
        (
          await reader`select * from receiving_mailboxes where mailbox_id=${target}`
        ).length === 1,
    );
    await until(() => f.coordinator.snapshot.scheduler?.active === 0);
    await f.coordinator.notify(account); // empty keyset page wraps
    await f.coordinator.notify(account);
    await until(async () => (await row(id)).status === "succeeded");
    expect((await row(id)).destination_mailbox_id).toBe(target);
    expect(f.counters().moves).toBe(1);
    expect(
      f.peer.commands.some((c) => c.command.startsWith("UID SEARCH")),
    ).toBe(false);
    const [b] =
      await reader`select recent_sync_status,backfill_status from mailboxes where id=${target}`;
    expect(b).toEqual({
      recent_sync_status: "not_started",
      backfill_status: "not_started",
    });
  });
  it("duplicate remote Message-ID candidates never establish uncertain MOVE success", async () => {
    const id = await create(),
      f = await harness({ mode: "lost" });
    await expect(f.submit(id)).rejects.toThrow();
    await f.submit(id, "exact-lookup");
    expect((await row(id)).status).toBe("failed");
    expect((await row(id)).destination_uid).toBeNull();
    expect(
      f.peer.commands.some((c) => c.command.startsWith("UID SEARCH")),
    ).toBe(false);
    expect(f.counters().moves).toBe(1);
  });
  it("MOVE and repair share W=1 and account C=1 until actual socket retirement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const id = await create(),
      f = await harness({
        workers: 1,
        onMove: async () => {
          await gate;
        },
      });
    const moving = f.submit(id);
    void moving.catch(() => {});
    await until(() => f.counters().moves === 1);
    const repairing = f.repair(id);
    void repairing.catch(() => {});
    try {
      await until(() => f.coordinator.snapshot.scheduler?.pending === 1);
      expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
      expect(f.peer.peers).toHaveLength(1);
    } finally {
      release();
    }
    await Promise.all([moving, repairing]);
    expect((await row(id)).status).toBe("succeeded");
    expect(f.peer.peers).toHaveLength(1);
  });
  it("missing request-time MOVE capability returns the existing unsupported error without intent creation", async () => {
    await reader`update mail_accounts set imap_capabilities='{}' where id=${account}`;
    await expect(create()).rejects.toThrow("IMAP MOVE is unavailable");
    expect(
      await reader`select * from message_commands where account_id=${account}`,
    ).toHaveLength(0);
  });
  it("exhausted attachment read restart chain fails without publishing bytes or resetting reads", async () => {
    const attachment = randomUUID();
    // Descriptor-only fixture seed; remote result paths still use actual R04 claims.
    await reader`alter table message_attachments disable trigger receiving_write_guard`;
    try {
      await reader`insert into message_attachments(id,message_id,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding,part_id,content_type,inline,visible,status) values(${attachment},${message},${source.mailbox},7,1,1,'2','application/octet-stream',false,true,'not_fetched')`;
    } finally {
      await reader`alter table message_attachments enable trigger receiving_write_guard`;
    }
    await reader`update message_attachments set status='pending' where id=${attachment}`;
    const publication = new ReceivingPublication(executor),
      owner = await currentOwner();
    for (let i = 0; i < 3; i++)
      await publication.attachmentClaim(
        owner,
        await currentSource(),
        "attachment",
        attachment,
        budget(),
      );
    const f = await harness();
    await f.repair(attachment, "attachment");
    const [r] =
      await reader`select * from message_attachments where id=${attachment}`;
    expect(r.status).toBe("failed");
    expect(r.blob_id).toBeNull();
    expect(r.receiving_attempt.reads).toBe("3");
    expect(f.peer.commands).toHaveLength(0);
  });
  it("automatic repair detects obsolete source configuration without executing a new mutation", async () => {
    const id = await create();
    await reader`update mail_accounts set imap_host='replacement.test' where id=${account}`;
    const f = await harness({ automatic: true });
    await until(async () => (await row(id)).status === "failed");
    expect(f.counters().moves).toBe(0);
    expect((await row(id)).attempts).toBe(0);
  });

  it("post-claim role change is revalidated before constructing the IMAP socket", async () => {
    let validations = 0;
    const id = await create(),
      f = await harness({
        beforeClient: async () => {
          if (++validations === 2)
            await reader`delete from mailbox_roles where account_id=${account} and role='archive'`;
        },
      });
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.peer.peers).toHaveLength(0);
    expect((await row(id)).error).toBe("failed_before_execution");
  });
  it("repeated pending Archive requests coalesce the original durable command", async () => {
    const id = await create();
    expect(await create()).toBe(id);
    const f = await harness();
    await f.submit(id);
    expect(f.counters().moves).toBe(1);
    expect(
      await reader`select * from message_commands where account_id=${account}`,
    ).toHaveLength(1);
  });
  it("obsolete uncertain Sent APPEND becomes diagnostic without SMTP or APPEND replay", async () => {
    const id = randomUUID(),
      owner = await currentOwner();
    await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'sent',${destination},'manual')`;
    await reader`insert into outgoing_messages(id,account_id,"from","to",cc,bcc,subject,plain_text,message_id,mime_base64,status,sent_copy_policy,sent_copy_status,sent_copy_mailbox_id,sent_copy_path) values(${id},${account},'{}','[{}]','[]','[]','Sent','Sent',${"<" + id + "@example.test>"},${Buffer.from("immutable").toString("base64")},'sent','maildock','pending',${destination},'Archive')`;
    const a: DataAuthority = {
      owner,
      account,
      configuration: 1n,
      lifecycle: 1n,
      scopes: [
        {
          mailbox: destination,
          path: "Archive",
          configuration: 1n,
          state: {
            epoch: 9n,
            revision: 0n,
            freshThrough: 42n,
            historyBefore: 43n,
            reconcileAfter: 0n,
          },
        },
      ],
    };
    const publication = new ReceivingBoundedPublication(executor),
      attempt = randomUUID();
    await publication.claim(a, "append", id, budget(), attempt);
    const advanced = {
      ...a,
      scopes: [
        { ...a.scopes[0], state: { ...a.scopes[0].state, revision: 1n } },
      ],
    };
    await publication.fail(
      advanced,
      "append",
      id,
      attempt,
      "uncertain_remote_execution",
      budget(),
    );
    await reader`delete from mailbox_roles where account_id=${account} and role='sent'`;
    const f = await harness();
    await f.repair(id, "sent");
    const [r] = await reader`select * from outgoing_messages where id=${id}`;
    expect(r.status).toBe("sent");
    expect(r.sent_copy_status).toBe("uncertain");
    expect(r.receiving_attempt.phase).toBe("repair_terminal");
    expect(r.receiving_attempt.id).toBe(attempt);
    expect(f.peer.commands).toHaveLength(0);
  });

  it.each(["content", "attachment"] as const)(
    "automatic repair discovers exhausted %s intents through bounded pages",
    async (kind) => {
      let id = message;
      if (kind === "content")
        await reader`insert into message_contents(message_id,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding) values(${message},'pending',${source.mailbox},7,1,1)`;
      else {
        id = randomUUID();
        await reader`alter table message_attachments disable trigger receiving_write_guard`;
        try {
          await reader`insert into message_attachments(id,message_id,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding,part_id,content_type,inline,visible,status) values(${id},${message},${source.mailbox},7,1,1,'2','application/octet-stream',false,true,'not_fetched')`;
        } finally {
          await reader`alter table message_attachments enable trigger receiving_write_guard`;
        }
        await reader`update message_attachments set status='pending' where id=${id}`;
      }
      const publication = new ReceivingPublication(executor),
        owner = await currentOwner();
      for (let i = 0; i < 3; i++) {
        if (kind === "content")
          await publication.contentClaim(
            owner,
            await currentSource(),
            "content",
            id,
            budget(),
          );
        else
          await publication.attachmentClaim(
            owner,
            await currentSource(),
            "attachment",
            id,
            budget(),
          );
      }
      const f = await harness({ automatic: true });
      await until(async () => {
        const rows =
          kind === "content"
            ? await reader`select status from message_contents where message_id=${id}`
            : await reader`select status from message_attachments where id=${id}`;
        return rows[0].status === "failed";
      });
      expect(f.peer.commands).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "automatic special-use MOVE requires an unambiguous active destination (ambiguous=%s)",
    async (ambiguous) => {
      await reader`alter table mailboxes disable trigger receiving_update_guard`;
      try {
        await reader`update mailboxes set special_use=ARRAY[chr(92)||'Archive'] where id=${destination}`;
      } finally {
        await reader`alter table mailboxes enable trigger receiving_update_guard`;
      }
      await reader`update mailbox_roles set source='special_use' where account_id=${account} and role='archive'`;
      const id = await create();
      if (ambiguous)
        await database.db.insert(mailboxes).values({
          id: randomUUID(),
          accountId: account,
          name: "Other Archive",
          remotePath: "Other Archive",
          specialUse: ["\\Archive"],
          selectable: true,
          firstDiscoveredAt: new Date(),
          lastDiscoveredAt: new Date(),
        });
      const f = await harness();
      if (ambiguous) {
        await expect(f.submit(id)).rejects.toThrow();
        expect(f.peer.peers).toHaveLength(0);
        await f.repair(id);
        expect((await row(id)).error).toBe(
          "The configured system mailbox or IMAP MOVE is unavailable.",
        );
      } else {
        await f.submit(id);
        expect((await row(id)).status).toBe("succeeded");
      }
    },
  );
  it("terminal repair cannot authorize mixed canonical writes and rolls back atomically", async () => {
    const id = await create(),
      owner = await currentOwner();
    await reader`update mail_accounts set imap_host='obsolete.test' where id=${account}`;
    const before = await row(id);
    await expect(
      executor.transaction(async (db) => {
        await db.execute(
          sql`select maildock_receiving_repair_intent(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,2::bigint,1::bigint,'command',${id}::uuid)`,
        );
        await db.execute(
          sql`update mailbox_messages set flags='{}' where message_id=${message}::uuid`,
        );
      }, budget()),
    ).rejects.toThrow();
    expect(await row(id)).toEqual(before);
    expect(
      (
        await reader`select flags from mailbox_messages where message_id=${message}`
      )[0].flags,
    ).toEqual(["\\Answered", "$Custom"]);
  });

  it("personal namespace cannot retarget frozen shared paths", async () => {
    const id = await create(),
      f = await harness({ mode: "namespace" });
    await f.submit(id);
    expect((await row(id)).status).toBe("succeeded");
    expect(f.peer.commands.some((c) => c.command === "NAMESPACE")).toBe(true);
    expect(
      f.peer.commands
        .filter((c) => /^(SELECT|EXAMINE|UID MOVE)/.test(c.command))
        .some((c) => c.command.includes("Personal/")),
    ).toBe(false);
  });
});
