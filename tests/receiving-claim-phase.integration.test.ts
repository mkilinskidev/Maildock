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
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import type { ReceivingOwner } from "@/shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import {
  ReceivingPublication,
  type PublicationSource,
} from "@/modules/mail/application/receiving-publication";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import type {
  ReceivingOperationContext,
  ReceivingPreNetworkContext,
} from "@/modules/mail/application/receiving-operation";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import { metadataPeer } from "./fixtures/imap-metadata-peer";

const budget = () => ({ deadline: performance.now() + 5000 });
describe("R04 owned pre-network claim phase", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let publication: ReceivingPublication;
  let owner: ReceivingOwner;
  let source: PublicationSource;
  let account: string, message: string, command: string, attachment: string;
  let url: string;
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
    await root`create database receiving_phase owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_phase`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 2);
    publication = new ReceivingPublication(executor);
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    owner = { actor, generation: BigInt(lease.generation) };
    account = randomUUID();
    const mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Publication fixture",
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
            flags: [],
            hasAttachments: true,
            envelope: {
              messageId: `<${account}@example.test>`,
              subject: "Fixture",
              from: [],
              sender: [],
              replyTo: [],
              to: [],
              cc: [],
              bcc: [],
            },
            mimeStructure: {
              part: "1",
              type: "application/pdf",
              disposition: "attachment",
              filename: "fixture.pdf",
              encoding: "base64",
              size: "10",
              contentId: null,
              parameters: {},
              dispositionParameters: {},
              children: [],
            },
          },
        ],
      },
      budget(),
    );
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
    const [placement] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    message = placement.message_id;
    command = randomUUID();
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding)
      values(${command},${account},${mailbox},${placement.id},${message},'mark_read','Source',7,1,1)`;
    await reader`select maildock_receiving_content_request(${account}::uuid,${mailbox}::uuid,${message}::uuid)`;
    const [descriptor] =
      await reader`select id from message_attachments where message_id=${message}`;
    attachment = descriptor.id;
    await reader`select maildock_receiving_attachment_request(${account}::uuid,${attachment}::uuid)`;
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
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
      if (performance.now() > end)
        throw new Error("Claim phase barrier timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  async function commandRow() {
    const [r] =
      await reader`select status,error,attempts,receiving_attempt from message_commands where id=${command}`;
    return r;
  }
  async function harness(
    input: {
      workers?: number;
      prepare?: (
        ctx: ReceivingPreNetworkContext,
        claim: () => Promise<void>,
      ) => Promise<void>;
      execute?: (ctx: ReceivingOperationContext) => Promise<void>;
      retirement?: ReturnType<typeof barrier>;
      disconnectMutation?: boolean;
      hangMutation?: boolean;
      mutationSeen?: () => void;
      connectionLoad?: () => Promise<void>;
    } = {},
  ) {
    const peer = await metadataPeer({
      uids: [1],
      uidNext: 2,
      epoch: 7,
      onCommand: (p, cmd) => {
        if (cmd.command.startsWith("UID STORE")) {
          input.mutationSeen?.();
          if (input.hangMutation) return true;
          if (input.disconnectMutation) p.socket.destroy();
          else p.ok(cmd);
          return true;
        }
      },
    });
    cleanup.push(peer.cleanup);
    let constructed = 0,
      confirmed = false;
    let context: ReceivingOperationContext | undefined;
    let preContext: ReceivingPreNetworkContext | undefined;
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: { workers: input.workers ?? 1 },
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: peer.connection,
      }),
      loadOperationConnection: async () => {
        await input.connectionLoad?.();
        return peer.connection;
      },
      createOperationClient: (options) => {
        expect(confirmed).toBe(true);
        expect(executor.snapshot.executing).toBe(0);
        constructed++;
        const client = peer.createClient(options);
        if (input.retirement) {
          const retire = client.retireReceiving.bind(client);
          client.retireReceiving = async () => {
            await input.retirement!.promise;
            await retire();
          };
        }
        return client;
      },
      operationHandlers: {
        store: {
          preNetwork: async (_op, ctx) => {
            preContext = ctx;
            expect(Object.hasOwn(ctx, "client")).toBe(false);
            expect(Object.hasOwn(ctx, "transaction")).toBe(false);
            const claim = async () => {
              await ctx.claim(source);
              const r = await commandRow();
              expect(r.status).toBe("executing");
              expect(r.attempts).toBe(1);
              expect(peer.peers).toHaveLength(0);
              confirmed = true;
            };
            if (input.prepare) await input.prepare(ctx, claim);
            else await claim();
          },
          execute: async (_op, ctx) => {
            context = ctx;
            if (input.execute) await input.execute(ctx);
            else {
              expect(ctx.phase).toBe("NETWORK");
              expect(ctx.claim?.attempt.id).toBe(
                (await commandRow()).receiving_attempt.id,
              );
              expect(() => ctx.transaction(async () => {})).toThrow(
                "requires retired socket",
              );
              await expect(
                ctx.publication.commandResult({
                  complete: true,
                  epoch: 7n,
                  uid: 1n,
                  flags: ["\\Seen"],
                  modseq: null,
                }),
              ).rejects.toThrow("retired socket");
              await ctx.client.connect();
              await ctx.client.mailboxOpen("Source");
              await ctx.client.messageFlagsAdd("1", ["\\Seen"], { uid: true });
              await ctx.retireSocket();
              expect(ctx.phase).toBe("NETWORK_RETIRED");
              await ctx.publication.commandResult({
                complete: true,
                epoch: 7n,
                uid: 1n,
                flags: ["\\Seen"],
                modseq: null,
              });
            }
          },
        },
        diagnostic: async (_op, ctx) => {
          await ctx.retireSocket();
        },
      },
    });
    cleanup.push(() => coordinator.stop());
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    expect(await coordinator.elect()).toBe(true);
    owner = coordinator.snapshot.owner!;
    const submit = (signal?: AbortSignal) =>
      coordinator.submit({
        kind: "store",
        pendingId: command,
        requestId: randomUUID(),
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: source.configuration,
        },
        deadline: performance.now() + 9000,
        signal,
      });
    return {
      submit,
      coordinator,
      peer,
      constructed: () => constructed,
      context: () => context!,
      preContext: () => preContext!,
    };
  }

  it.each([1, 2])(
    "D=%i: claim commits before one installed client; result settles after retirement",
    async (capacity) => {
      await executor.stop();
      executor = new ReceivingExecutor(url, capacity);
      publication = new ReceivingPublication(executor);
      cleanup.push(async () => {
        await executor.stop();
        executor = new ReceivingExecutor(url, 2);
        publication = new ReceivingPublication(executor);
      });
      const f = await harness();
      await f.submit();
      expect(f.constructed()).toBe(1);
      expect(
        f.peer.commands.filter((c) => c.command.startsWith("UID STORE")),
      ).toHaveLength(1);
      expect((await commandRow()).status).toBe("succeeded");
      const [r] =
        await reader`select revision,fresh_through,history_before,reconcile_after from receiving_mailboxes where mailbox_id=${source.mailbox}`;
      expect(r).toEqual({
        revision: "3",
        fresh_through: "1",
        history_before: "1",
        reconcile_after: "0",
      });
      expect(f.coordinator.snapshot.scheduler?.active).toBe(0);
      expect(executor.snapshot.executing).toBe(0);
      expect(f.context().phase).toBe("SETTLED");
      expect(() => f.context().client.connect()).toThrow("retired");
      expect(() => f.preContext().claim(source)).toThrow("retired");
    },
  );
  it("stale or swallowed failed claim creates zero clients", async () => {
    source = { ...source, state: { ...source.state, revision: 0n } };
    const f = await harness({
      prepare: async (ctx) => {
        await ctx.claim(source).catch(() => undefined);
      },
    });
    await expect(f.submit()).rejects.toThrow("settled matching claim");
    expect(f.constructed()).toBe(0);
    expect(f.peer.peers).toHaveLength(0);
    expect((await commandRow()).status).toBe("pending");
  });
  it("pre-network recovery of an old executing row never authorizes remote replay", async () => {
    await publication.claim(owner, source, "command", command, budget());
    const f = await harness({
      prepare: async (ctx) => {
        const recovered = await ctx.recover(source);
        expect(recovered.intent.status).toBe("executing");
      },
    });
    await expect(f.submit()).rejects.toThrow("settled matching claim");
    expect(f.constructed()).toBe(0);
    expect((await commandRow()).attempts).toBe(1);
  });
  it("simultaneous and detached claim work fail closed before client construction", async () => {
    const held = await reader.reserve();
    await held`begin`;
    await held`select id from mailboxes where id=${source.mailbox} for update`;
    const entered = barrier();
    let detached: Promise<unknown> | undefined;
    const f = await harness({
      prepare: async (ctx) => {
        detached = ctx.claim(source).catch((error) => error);
        expect(() => ctx.recover(source)).toThrow("serial");
        expect(() => ctx.claim(source)).toThrow("single-use");
        entered.release();
      },
    });
    const rejected = expect(f.submit()).rejects.toThrow(
      "settled matching claim",
    );
    try {
      await entered.promise;
      await until(() => executor.snapshot.executing > 0);
      expect(f.constructed()).toBe(0);
      expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
    } finally {
      await held`rollback`;
      held.release();
    }
    await rejected;
    await detached;
    expect(f.constructed()).toBe(0);
  });
  it("cancellation during blocked claim retains allocation through SQL settlement and creates zero clients", async () => {
    const ready = barrier(),
      resume = barrier();
    const abort = new AbortController();
    const f = await harness({
      prepare: async (_ctx, claim) => {
        ready.release();
        await resume.promise;
        await claim();
      },
    });
    const held = await reader.reserve();
    const pending = f.submit(abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    await ready.promise;
    await held`begin`;
    await held`select id from mailboxes where id=${source.mailbox} for update`;
    try {
      resume.release();
      await until(async () =>
        Boolean(
          (
            await reader`select 1 from pg_stat_activity where query like '%maildock_receiving_attempt_claim%' and wait_event_type='Lock'`
          )[0],
        ),
      );
      abort.abort();
      expect(f.constructed()).toBe(0);
      expect(f.peer.peers).toHaveLength(0);
      expect(executor.snapshot.executing).toBeLessThanOrEqual(2);
    } finally {
      await held`rollback`;
      held.release();
    }
    await rejected;
    expect(f.constructed()).toBe(0);
    expect((await commandRow()).status).toBe("pending");
  });
  it.each(["configuration", "disable", "disable-ABA"])(
    "post-claim %s change prevents construction",
    async (change) => {
      const f = await harness({
        prepare: async (_ctx, claim) => {
          await claim();
          if (change === "configuration")
            await reader`update mail_accounts set imap_host='replacement.invalid' where id=${account}`;
          else {
            await reader`update mail_accounts set enabled=false where id=${account}`;
            if (change === "disable-ABA")
              await reader`update mail_accounts set enabled=true where id=${account}`;
          }
        },
      });
      await expect(f.submit()).rejects.toThrow();
      expect(f.constructed()).toBe(0);
      expect((await commandRow()).status).toBe("executing");
    },
  );
  it("takeover queued during claim prevents old-term execution", async () => {
    const ready = barrier(),
      resume = barrier();
    const f = await harness({
      prepare: async (_ctx, claim) => {
        ready.release();
        await resume.promise;
        await claim();
      },
    });
    const pending = f.submit();
    const rejected = expect(pending).rejects.toThrow();
    await ready.promise;
    const held = await reader.reserve();
    await held`begin`;
    await held`select singleton from receiving_coordinator for update`;
    await held`update receiving_coordinator set expires_at='-infinity'`;
    const nextActor = randomUUID();
    const takeover =
      reader`select maildock_receiving_takeover(${nextActor}::uuid,60000) as term`.then(
        (r) => r[0],
      );
    try {
      await until(async () =>
        Boolean(
          (
            await reader`select 1 from pg_stat_activity where query like 'select maildock_receiving_takeover%' and wait_event_type='Lock'`
          )[0],
        ),
      );
      resume.release();
      await until(async () =>
        Boolean(
          (
            await reader`select 1 from pg_stat_activity where query like '%maildock_receiving_attempt_claim%' and wait_event_type='Lock'`
          )[0],
        ),
      );
    } finally {
      await held`commit`;
      held.release();
    }
    expect(BigInt((await takeover).term)).toBeGreaterThan(owner.generation);
    await rejected;
    expect(f.constructed()).toBe(0);
    expect((await commandRow()).status).toBe("pending");
  });
  it("local pre-network failure uses authorized failure settlement without constructing a client", async () => {
    const f = await harness({
      prepare: async (_ctx, claim) => {
        await claim();
        throw new Error("fixture local preparation failed");
      },
    });
    await expect(f.submit()).rejects.toThrow(
      "fixture local preparation failed",
    );
    expect(f.constructed()).toBe(0);
    expect((await commandRow()).error).toBe("failed_before_execution");
    expect((await commandRow()).status).toBe("failed");
  });
  async function loseClaimAcknowledgement() {
    let claimConnection = false,
      once = true;
    const relay = await receivingResponseRelay(url, (bytes) => {
      if (bytes.includes(Buffer.from("application_name"))) {
        relay.control.drop = false;
        claimConnection = false;
      }
      if (bytes.includes(Buffer.from("maildock_receiving_attempt_claim")))
        claimConnection = true;
      if (once && claimConnection && bytes.includes(Buffer.from("commit\0"))) {
        relay.control.drop = true;
        once = false;
      }
    });
    cleanup.push(relay.close);
    await executor.stop();
    executor = new ReceivingExecutor(relay.url, 2);
    publication = new ReceivingPublication(executor);
    cleanup.push(async () => {
      await executor.stop();
      executor = new ReceivingExecutor(url, 2);
      publication = new ReceivingPublication(executor);
    });
    return relay;
  }
  it("unknown actual claim COMMIT reply is recovered before construction and wire execution", async () => {
    await loseClaimAcknowledgement();
    const f = await harness();
    const pending = f.submit();
    await until(async () => (await commandRow()).status === "executing");
    expect(f.constructed()).toBe(0);
    expect(f.peer.peers).toHaveLength(0);
    await pending;
    expect(f.constructed()).toBe(1);
    expect((await commandRow()).status).toBe("succeeded");
    expect((await commandRow()).attempts).toBe(1);
    expect(
      f.peer.commands.filter((c) => c.command.startsWith("UID STORE")),
    ).toHaveLength(1);
  });
  it("unresolved locked claim recovery creates zero clients and never reclaims", async () => {
    await loseClaimAcknowledgement();
    const f = await harness();
    const pending = f.submit();
    const rejected = expect(pending).rejects.toThrow();
    await until(async () => (await commandRow()).status === "executing");
    const held = await reader.reserve();
    await held`begin`;
    await held`select id from mailboxes where id=${source.mailbox} for update`;
    try {
      await until(async () =>
        Boolean(
          (
            await reader`select 1 from pg_stat_activity where query like '%maildock_receiving_attempt_recover%' and wait_event_type='Lock'`
          )[0],
        ),
      );
      expect(f.constructed()).toBe(0);
      expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
      await rejected;
      expect(f.constructed()).toBe(0);
    } finally {
      await held`rollback`;
      held.release();
    }
    expect((await commandRow()).status).toBe("executing");
    expect((await commandRow()).attempts).toBe(1);
  });
  it("lost mutation response settles uncertainty after retirement and never retries", async () => {
    const f = await harness({ disconnectMutation: true });
    await expect(f.submit()).rejects.toThrow();
    const row = await commandRow();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("uncertain_remote_execution");
    expect(row.receiving_attempt.phase).toBe("uncertain_remote_execution");
    expect(
      f.peer.commands.filter((c) => c.command.startsWith("UID STORE")),
    ).toHaveLength(1);
    source = { ...source, state: { ...source.state, revision: 3n } };
    await expect(f.submit()).rejects.toThrow();
    expect(f.constructed()).toBe(1);
    expect(
      f.peer.commands.filter((c) => c.command.startsWith("UID STORE")),
    ).toHaveLength(1);
  });
  it("cancellation after wire mutation retains executing uncertainty and forbids replay", async () => {
    const sent = barrier(),
      abort = new AbortController();
    const f = await harness({ hangMutation: true, mutationSeen: sent.release });
    const pending = f.submit(abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    await sent.promise;
    abort.abort();
    await rejected;
    expect((await commandRow()).status).toBe("executing");
    expect((await commandRow()).attempts).toBe(1);
    expect(f.context().phase).toBe("SETTLED");
    expect(() =>
      f.context().client.messageFlagsAdd("1", ["\\Seen"], { uid: true }),
    ).toThrow("retired");
    source = { ...source, state: { ...source.state, revision: 2n } };
    await expect(f.submit()).rejects.toThrow();
    expect(f.constructed()).toBe(1);
    expect(
      f.peer.commands.filter((c) => c.command.startsWith("UID STORE")),
    ).toHaveLength(1);
  });
  it("blocked actual retirement retains W/C and forbids publication and late network calls", async () => {
    const retirement = barrier(),
      retiring = barrier();
    let published = false;
    const f = await harness({
      workers: 2,
      retirement,
      execute: async (ctx) => {
        await ctx.client.connect();
        const retired = ctx.retireSocket();
        retiring.release();
        expect(ctx.phase).toBe("RETIRING");
        await expect(
          ctx.publication.fail("failed_before_execution"),
        ).rejects.toThrow("retired socket");
        expect(() => ctx.transaction(async () => {})).toThrow(
          "requires retired socket",
        );
        expect(() => ctx.client.noop()).toThrow("retired");
        await retired;
        await ctx.publication.fail("failed_before_execution");
        published = true;
      },
    });
    const first = f.submit();
    try {
      await retiring.promise;
      const second = f.coordinator.submit({
        kind: "diagnostic",
        requestId: randomUUID(),
        identity: { account, configurationVersion: 1n },
        deadline: performance.now() + 9000,
      });
      await until(() => f.coordinator.snapshot.scheduler?.pending === 1);
      expect(f.coordinator.snapshot.scheduler?.active).toBe(1);
      expect(f.constructed()).toBe(1);
      expect(published).toBe(false);
      expect((await commandRow()).status).toBe("executing");
      retirement.release();
      await first;
      await second;
    } finally {
      retirement.release();
      await first.catch(() => undefined);
    }
    expect(f.constructed()).toBe(2);
    expect(published).toBe(true);
  });
  it("blocked matching result cannot admit another SQL scope or revive network activity", async () => {
    const f = await harness({
      execute: async (ctx) => {
        await ctx.client.connect();
        await ctx.client.mailboxOpen("Source");
        await ctx.client.messageFlagsAdd("1", ["\\Seen"], { uid: true });
        await ctx.retireSocket();
        const held = await reader.reserve();
        await held`begin`;
        await held`select id from message_commands where id=${command} for update`;
        const result = ctx.publication.commandResult({
          complete: true,
          epoch: 7n,
          uid: 1n,
          flags: ["\\Seen"],
          modseq: null,
        });
        try {
          await until(async () =>
            Boolean(
              (
                await reader`select 1 from pg_stat_activity where query like '%maildock_receiving_command_result%' and wait_event_type='Lock'`
              )[0],
            ),
          );
          expect(ctx.phase).toBe("RESULT_PUBLICATION");
          await expect(
            ctx.publication.fail("uncertain_remote_execution"),
          ).rejects.toThrow("retired socket");
          expect(() => ctx.transaction(async () => {})).toThrow("serial scope");
          expect(() => ctx.client.noop()).toThrow("retired");
          expect(executor.snapshot.executing).toBe(1);
          expect(executor.snapshot.waiting).toBe(0);
        } finally {
          await held`rollback`;
          held.release();
        }
        await result;
      },
    });
    await f.submit();
    expect((await commandRow()).status).toBe("succeeded");
    expect((await commandRow()).attempts).toBe(1);
  });
});
