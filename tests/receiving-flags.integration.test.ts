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
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import {
  ReceivingPublication,
  type PublicationSource,
} from "@/modules/mail/application/receiving-publication";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import type { ReceivingCoordinatorConfig } from "@/modules/mail/application/receiving-coordinator";
import type { ReceivingAdmission } from "@/modules/mail/application/receiving-scheduler";
import {
  MessageCommandService,
  type MessageAction,
} from "@/modules/mail/application/message-command-service";
import {
  fixture,
  type Peer,
  type Command,
} from "../experiments/imap-transport/fixture";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { metadataPeer } from "./fixtures/imap-metadata-peer";

const budget = () => ({ deadline: performance.now() + 5000 });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() >= end)
      throw new Error("Flag fixture barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("R10 owned flag execution", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let url: string, account: string, message: string;
  let source: PublicationSource;
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
    await root`create database receiving_flags owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_flags`;
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
      displayName: "Flags",
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
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  async function row(id: string) {
    const [row] =
      await reader`select c.*,p.flags,p.modseq,s.revision,s.fresh_through,s.history_before,s.reconcile_after
      from message_commands c join mailbox_messages p on p.id=c.placement_id
      join receiving_mailboxes s on s.mailbox_id=c.mailbox_id where c.id=${id}`;
    return row;
  }
  async function create(action: MessageAction = "mark_read") {
    const service = new MessageCommandService(
      database.db,
      async () => {
        throw new Error("Legacy enqueue forbidden");
      },
      async () => {},
    );
    return (await service.create(account, source.mailbox, message, action)).id;
  }
  async function inbox(uidNext: bigint) {
    const id = randomUUID();
    await database.db.insert(mailboxes).values({
      id,
      accountId: account,
      name: "INBOX",
      remotePath: "INBOX",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const [lease] =
      await reader`select owner,generation from receiving_coordinator`;
    await new ReceivingPersistence(executor).initialize(
      { actor: lease.owner, generation: BigInt(lease.generation) },
      id,
      { complete: true, epoch: 7n, uidNext },
      budget(),
    );
  }
  async function harness(
    input: {
      condstore?: boolean;
      conflict?: "OK" | "NO";
      disconnect?: boolean;
      automatic?: boolean;
      epoch?: number;
      corrupt?: "missing-flags" | "wrong-uid" | "duplicate" | "no-completion";
      onStore?: (p: Peer, c: Command) => Promise<void>;
      beforePublish?: () => Promise<void>;
      beforeClient?: () => Promise<void>;
      hangRead?: boolean;
      metadata?: Awaited<ReturnType<typeof metadataPeer>>;
      onTurn?: ReceivingCoordinatorConfig["onTurn"];
      onError?: ReceivingCoordinatorConfig["onError"];
      onAdmission?: (admission: ReceivingAdmission) => void;
    } = {},
  ) {
    const flags = new Set(["\\Answered", "$Custom"]);
    let modseq = 10n,
      stores = 0,
      reads = 0,
      committedBeforeStore = false;
    const peer = await fixture(
      (p, c) => {
        if (/^(LOGIN|AUTHENTICATE)/.test(c.command)) {
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("ENABLE")) {
          p.send("* ENABLED CONDSTORE\r\n", c);
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("SELECT")) {
          p.send(
            `* 1 EXISTS\r\n* FLAGS (\\Seen \\Flagged \\Answered)\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Answered \\*)] Flags\r\n* OK [UIDVALIDITY ${input.epoch ?? 7}] Epoch\r\n* OK [UIDNEXT 2] Next\r\n${input.condstore ? `* OK [HIGHESTMODSEQ ${modseq}] Highest\r\n` : ""}`,
            c,
          );
          p.ok(c, "OK [READ-WRITE] Selected");
          return true;
        }
        if (c.command.startsWith("UID FETCH")) {
          reads++;
          if (input.hangRead) {
            p.socket.destroy();
            return true;
          }
          const response = `* 1 FETCH (UID ${input.corrupt === "wrong-uid" ? 99 : 1}${input.corrupt === "missing-flags" ? "" : ` FLAGS (${[...flags].join(" ")})`}${input.condstore ? ` MODSEQ (${modseq})` : ""})\r\n`;
          p.send(response, c);
          if (input.corrupt === "duplicate") p.send(response, c);
          if (input.corrupt === "no-completion") p.socket.destroy();
          else p.ok(c);
          return true;
        }
        if (c.command.startsWith("UID STORE")) {
          stores++;
          void (async () => {
            const [receipt] =
              await reader`select status,attempts,receiving_attempt from message_commands where account_id=${account} order by created_at desc limit 1`;
            committedBeforeStore =
              receipt.status === "executing" &&
              receipt.attempts === 1 &&
              receipt.receiving_attempt.phase === "claimed";
            expect(executor.snapshot.executing).toBe(0);
            await input.onStore?.(p, c);
            if (input.conflict) {
              flags.add("$Concurrent");
              modseq++;
              p.ok(c, `${input.conflict} [MODIFIED 1] Conflict`);
              return;
            }
            const flag = c.command.includes("\\Seen") ? "\\Seen" : "\\Flagged";
            if (c.command.includes("+FLAGS")) flags.add(flag);
            else flags.delete(flag);
            modseq++;
            if (input.disconnect) p.socket.destroy();
            else p.ok(c);
          })();
          return true;
        }
        return false;
      },
      {},
      "OK",
      `IMAP4rev1 AUTH=PLAIN${input.condstore ? " ENABLE CONDSTORE" : ""}`,
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
      tuning: { workers: 2, historyWaitMs: 1, historyTurnMs: 1000 },
      onAdmission: input.onAdmission,
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: input.metadata?.connection ?? connection,
        createClient: input.metadata?.createClient,
        onTurn: input.onTurn,
        onError: input.onError,
        timing: input.onTurn ? { pollMs: 1 } : undefined,
      }),
      loadOperationConnection: async () => {
        await input.beforeClient?.();
        return connection;
      },
      operationHandlers: {
        store: { flags: true },
        "exact-lookup": { flags: true },
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
    // Protocol/race cases submit deterministic single units. The dedicated
    // discovery case below exercises the unmodified durable selector.
    if (!input.automatic) coordinator.dispatchFlagCommands = async () => {};
    cleanup.push(() => coordinator.stop());
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    expect(await coordinator.elect()).toBe(true);
    const submit = (
      id: string,
      kind: "store" | "exact-lookup" = "store",
      signal?: AbortSignal,
    ) =>
      coordinator.submit({
        kind,
        pendingId: id,
        requestId: randomUUID(),
        deadline: performance.now() + 9000,
        signal,
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: 1n,
        },
      });
    return {
      coordinator,
      submit,
      peer,
      flags,
      counters: () => ({ stores, reads, committedBeforeStore }),
    };
  }

  it.each(["mark_read", "mark_unread", "flag", "unflag"] as const)(
    "%s reaches exact UID STORE and settles canonical flags",
    async (action) => {
      const id = await create(action);
      const f = await harness();
      if (action === "mark_unread") f.flags.add("\\Seen");
      if (action === "unflag") f.flags.add("\\Flagged");
      await f.submit(id);
      const result = await row(id);
      expect(result.status).toBe("succeeded");
      expect(result.flags).toEqual([...f.flags]);
      expect(result.flags).toContain("\\Answered");
      expect(result.flags).toContain("$Custom");
      expect(result.revision).toBe("3");
      expect([
        result.fresh_through,
        result.history_before,
        result.reconcile_after,
      ]).toEqual(["1", "1", "0"]);
      expect(f.counters()).toMatchObject({
        stores: 1,
        reads: 2,
        committedBeforeStore: true,
      });
      expect(
        f.peer.commands.find((c) => c.command.startsWith("UID STORE"))?.command,
      ).toMatch(/^UID STORE 1 [+-]FLAGS/);
      const [counts] =
        await reader`select (select count(*) from messages where account_id=${account}) as messages,
      (select count(*) from mailbox_messages where mailbox_id=${source.mailbox}) as placements,
      (select count(*) from notification_events where account_id=${account}) as notifications`;
      expect(counts).toMatchObject({
        messages: "1",
        placements: "1",
        notifications: "0",
      });
    },
  );
  it("uses correctly evidenced CONDSTORE with the fresh MODSEQ", async () => {
    const id = await create();
    const f = await harness({ condstore: true });
    await f.submit(id);
    expect(
      f.peer.commands.find((c) => c.command.startsWith("UID STORE"))?.command,
    ).toContain("1 (UNCHANGEDSINCE 10) +FLAGS");
    expect((await row(id)).modseq).toBe("11");
  });
  it.each(["OK", "NO"] as const)(
    "%s MODIFIED is conflict with no overwrite or blind retry",
    async (conflict) => {
      const id = await create();
      const f = await harness({ condstore: true, conflict });
      await f.submit(id);
      expect(await row(id)).toMatchObject({
        status: "failed",
        error: "flag_conflict",
        flags: ["\\Answered", "$Custom"],
      });
      expect(f.flags.has("$Concurrent")).toBe(true);
      expect(f.flags.has("\\Seen")).toBe(false);
      expect(f.counters().stores).toBe(1);
    },
  );
  it("recovers a lost STORE response by an owned read, keeping the original attempt", async () => {
    const id = await create();
    const f = await harness({ disconnect: true, condstore: true });
    await expect(f.submit(id)).rejects.toThrow();
    const uncertain = await row(id);
    expect(uncertain.error).toBe("uncertain_remote_execution");
    f.flags.add("$Concurrent");
    await f.submit(id, "exact-lookup");
    const result = await row(id);
    expect(result.status).toBe("succeeded");
    expect(result.flags).toContain("$Concurrent");
    expect(result.receiving_attempt.id).toBe(uncertain.receiving_attempt.id);
    expect(result.attempts).toBe(1);
    expect(f.counters().stores).toBe(1);
  });
  it("an uncertain mutation whose desired flag differs terminates as conflict without STORE", async () => {
    const id = await create();
    const f = await harness({ disconnect: true });
    await expect(f.submit(id)).rejects.toThrow();
    f.flags.delete("\\Seen");
    await f.submit(id, "exact-lookup");
    expect(await row(id)).toMatchObject({
      status: "failed",
      error: "flag_conflict",
      attempts: 1,
    });
    expect(f.counters().stores).toBe(1);
  });
  it("reconciliation is bounded to three failed read opportunities", async () => {
    const id = await create();
    const f = await harness({ hangRead: true });
    const publication = new ReceivingPublication(executor);
    await publication.claim(
      f.coordinator.snapshot.owner!,
      source,
      "command",
      id,
      budget(),
    );
    for (let i = 0; i < 3; i++)
      await expect(f.submit(id, "exact-lookup")).rejects.toThrow();
    const reads = f.counters().reads;
    await expect(f.submit(id, "exact-lookup")).rejects.toThrow();
    expect(f.counters().reads).toBe(reads);
    expect(f.counters().stores).toBe(0);
    expect((await row(id)).receiving_attempt.observations).toBe("3");
  });
  it.each([
    "missing-flags",
    "wrong-uid",
    "duplicate",
    "no-completion",
  ] as const)("rejects %s FETCH evidence before mutation", async (corrupt) => {
    const id = await create();
    const f = await harness({ corrupt });
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.counters().stores).toBe(0);
    expect((await row(id)).status).toBe("failed");
  });
  it("SELECT epoch mismatch prevents any STORE", async () => {
    const id = await create();
    const f = await harness({ epoch: 8 });
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.counters().stores).toBe(0);
  });
  it("the durable selector discovers commands even after a missed wake", async () => {
    const id = await create();
    const f = await harness({ automatic: true });
    await until(async () => (await row(id)).status === "succeeded");
    expect(f.counters().stores).toBe(1);
  });
  it("legacy enrolled runner cannot construct a provider client", async () => {
    const id = await create();
    const service = new MessageCommandService(
      database.db,
      async () => {},
      async () => {},
    );
    await service.run(id);
    expect((await row(id)).status).toBe("pending");
  });
  it("uncertainty retains the optimistic projection and blocks a competing intent", async () => {
    const id = await create();
    const f = await harness({ disconnect: true });
    await expect(f.submit(id)).rejects.toThrow();
    expect(await row(id)).toMatchObject({
      status: "executing",
      error: "uncertain_remote_execution",
      completed_at: null,
    });
    const [projection] =
      await reader`select flags from message_placement_projection where message_id=${message}`;
    expect(projection.flags).toContain("\\Seen");
    expect((await row(id)).flags).not.toContain("\\Seen");
    await expect(create("unflag")).rejects.toThrow("already in progress");
    await f.submit(id, "exact-lookup");
    const [settled] =
      await reader`select flags from message_placement_projection where message_id=${message}`;
    expect(settled.flags).toEqual((await row(id)).flags);
  });
  it("a post-claim configuration change fences construction with zero mutations", async () => {
    const id = await create();
    let loads = 0;
    const f = await harness({
      beforeClient: async () => {
        if (++loads === 2)
          await reader`update mail_accounts set imap_host='replacement.test' where id=${account}`;
      },
    });
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.peer.peers).toHaveLength(0);
    expect(f.counters().stores).toBe(0);
  });
  it("actual metadata sockets and STORE share account C=1 with W=2", async () => {
    await inbox(1n);
    const entered = barrier(),
      release = barrier();
    const metadata = await metadataPeer({
      uids: [],
      uidNext: 1,
      boundedMailbox: true,
      onCommand: (p, c) => {
        if (c.command.startsWith("SELECT")) {
          entered.release();
          void release.promise.then(() => {
            p.send(
              "* 0 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT 1] Next\r\n",
              c,
            );
            p.ok(c, "OK [READ-WRITE] Selected");
          });
          return true;
        }
      },
    });
    cleanup.push(metadata.cleanup);
    const id = await create();
    const f = await harness({ metadata });
    await entered.promise;
    const pending = f.submit(id);
    await until(() => f.coordinator.snapshot.scheduler?.pending === 1);
    expect(f.peer.peers).toHaveLength(0);
    expect(f.counters().stores).toBe(0);
    release.release();
    await pending;
    expect(metadata.observed.every((client) => !client.usable)).toBe(true);
    expect((await row(id)).status).toBe("succeeded");
  });
  it("newer canonical facts reject stale publication and require a fresh owned read", async () => {
    const id = await create();
    const f = await harness({
      beforePublish: async () => {
        const [state] =
          await reader`select revision from receiving_mailboxes where mailbox_id=${source.mailbox}`;
        await new ReceivingPersistence(executor).persist(
          f.coordinator.snapshot.owner!,
          source.mailbox,
          { ...source.state, revision: BigInt(state.revision) },
          {
            kind: "repair",
            complete: true,
            epoch: 7n,
            known: [1n],
            present: [1n],
            flags: [{ uid: "1", flags: ["$Newer"] }],
            wrap: false,
          },
          budget(),
        );
      },
    });
    await expect(f.submit(id)).rejects.toThrow();
    expect((await row(id)).flags).toEqual(["$Newer"]);
    expect((await row(id)).status).toBe("executing");
    // Stop the old fixture so its retirement callback cannot mutate canonical
    // state again; the new owner obtains new remote evidence.
    await f.coordinator.stop();
    const next = await harness();
    next.flags.add("\\Seen");
    next.flags.add("$Newer");
    await next.submit(id, "exact-lookup");
    expect((await row(id)).status).toBe("succeeded");
    expect((await row(id)).flags).toContain("$Newer");
    expect(next.counters().stores).toBe(0);
  });
  it("sustained actual STORE traffic preserves fresh and protected history opportunities", async () => {
    await inbox(1025n);
    const script = {
      uids: [1, 1024],
      uidNext: 1025,
      boundedMailbox: true,
    };
    const metadata = await metadataPeer(script);
    cleanup.push(metadata.cleanup);
    const admissions: string[] = [],
      errors: string[] = [];
    let fresh = 0,
      history = 0;
    const f = await harness({
      metadata,
      onError: (error) => errors.push(String(error)),
      onAdmission: (admission) => admissions.push(admission.kind),
      onTurn: (kind) => {
        if (kind === "fresh") {
          fresh++;
          script.uids.push(script.uidNext++);
        } else history++;
      },
    });
    for (let i = 0; i < 8; i++) {
      const id = await create(i % 2 ? "unflag" : "flag");
      await f.submit(id);
      expect((await row(id)).status).toBe("succeeded");
    }
    expect(admissions[0]).toBe("fresh");
    expect(fresh, errors.join("\n")).toBeGreaterThan(1);
    expect(history).toBeGreaterThan(0);
    expect(f.counters().stores).toBe(8);
    expect(admissions.filter((kind) => kind === "store")).toHaveLength(8);
    expect(admissions.indexOf("history")).toBeLessThan(
      admissions.lastIndexOf("store"),
    );
  });
  it("locked SQL helper and unadmitted reconciliation cannot create authority", async () => {
    const id = await create();
    const f = await harness();
    const owner = f.coordinator.snapshot.owner!;
    const evidence = reader.json({
      complete: true,
      epoch: "7",
      uid: "1",
      flags: ["\\Seen"],
      modseq: null,
    });
    await expect(reader`select maildock_receiving_command_result_locked(${owner.actor}::uuid,${String(owner.generation)}::bigint,
      ${source.mailbox}::uuid,'{"epoch":"7","revision":"1","freshThrough":"1","historyBefore":"1","reconcileAfter":"0"}'::jsonb,
      1,${id}::uuid,${randomUUID()}::uuid,${evidence}::jsonb)`).rejects.toThrow(
      "locked authority",
    );
    await expect(f.submit(id, "exact-lookup")).rejects.toThrow();
    expect(f.peer.peers).toHaveLength(0);
  });
  it("a second mutation admission cannot replay an executing command", async () => {
    const id = await create();
    const f = await harness();
    await new ReceivingPublication(executor).claim(
      f.coordinator.snapshot.owner!,
      source,
      "command",
      id,
      budget(),
    );
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.peer.peers).toHaveLength(0);
    f.flags.add("\\Seen");
    await f.submit(id, "exact-lookup");
    expect((await row(id)).status).toBe("succeeded");
    expect(f.counters().stores).toBe(0);
  });
  it("crash after STORE before publication resumes by reading after takeover", async () => {
    const id = await create();
    const entered = barrier(),
      release = barrier();
    const f = await harness({
      beforePublish: async () => {
        entered.release();
        await release.promise;
      },
    });
    const controller = new AbortController();
    const pending = f.submit(id, "store", controller.signal);
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    controller.abort();
    release.release();
    await rejection;
    expect((await row(id)).status).toBe("executing");
    await f.coordinator.stop();
    const next = await harness();
    next.flags.add("\\Seen");
    await next.submit(id, "exact-lookup");
    expect((await row(id)).status).toBe("succeeded");
    expect(next.counters().stores).toBe(0);
  });
  it("old result publication is fenced after owner takeover", async () => {
    const id = await create();
    const entered = barrier(),
      release = barrier();
    const f = await harness({
      beforePublish: async () => {
        entered.release();
        await release.promise;
      },
    });
    const pending = f.submit(id);
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    await reader`select maildock_receiving_acquire(${actor}::uuid,60000)`;
    release.release();
    await rejection;
    expect((await row(id)).status).toBe("executing");
  });
  it("configuration replacement between STORE and result cannot publish old flags", async () => {
    const id = await create();
    const f = await harness({
      beforePublish: async () => {
        await reader`update mail_accounts set imap_host='changed.test' where id=${account}`;
      },
    });
    await expect(f.submit(id)).rejects.toThrow();
    expect((await row(id)).status).toBe("executing");
    expect((await row(id)).flags).not.toContain("\\Seen");
  });
  it.each(["claim", "result"] as const)(
    "lost %s COMMIT acknowledgement is resolved without a duplicate STORE",
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
                ? "maildock_receiving_attempt_claim"
                : "maildock_receiving_command_result",
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
      const id = await create();
      const f = await harness();
      const pending = f.submit(id);
      // A committed row is not an authorized recovery observation until the
      // conflicting mailbox lock can be taken by the fresh backend.
      if (phase === "result") {
        await until(async () => (await row(id)).status === "succeeded");
        const held = await reader.reserve();
        await held`begin`;
        try {
          await held`select id from mailboxes where id=${source.mailbox} for update`;
          await until(async () => {
            const [activity] =
              await reader`select exists(select 1 from pg_stat_activity
              where datname='receiving_flags' and wait_event_type='Lock'
              and query like '%maildock_receiving_attempt_recover%') as waiting`;
            return activity.waiting === true;
          });
          expect(f.counters().stores).toBe(1);
        } finally {
          await held`commit`;
          held.release();
        }
      }
      await pending;
      expect(once).toBe(false);
      expect((await row(id)).status).toBe("succeeded");
      expect(f.counters().stores).toBe(1);
      expect((await row(id)).attempts).toBe(1);
    },
  );
});
