import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
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
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import type {
  ReceivingOperation,
  ReceivingOperationContext,
  ReceivingOperationHandlers,
  ReceivingOperationKind,
} from "@/modules/mail/application/receiving-operation";
import { ReceivingScheduler } from "@/modules/mail/application/receiving-scheduler";
import { metadataPeer } from "./fixtures/imap-metadata-peer";
import { setTimeout as delay } from "node:timers/promises";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10000;
  while (!(await check())) {
    if (performance.now() > deadline)
      throw new Error("R03 observed barrier timed out");
    await delay(5);
  }
}
const kinds: ReceivingOperationKind[] = [
  "repair",
  "bootstrap",
  "list",
  "select",
  "store",
  "move",
  "content-slice",
  "attachment-slice",
  "append",
  "exact-lookup",
  "diagnostic",
];
const connection = {
  host: "invalid.test",
  port: 993,
  security: "tls" as const,
  username: "fixture",
  credential: { kind: "password" as const, password: "ephemeral-fixture-only" },
};
function operation(
  kind: ReceivingOperationKind,
  account?: string,
  signal?: AbortSignal,
): ReceivingOperation {
  return {
    requestId: randomUUID(),
    kind,
    identity: account
      ? { account, configurationVersion: 1n }
      : { ephemeral: randomUUID() },
    deadline: performance.now() + 9000,
    signal,
    pendingId: randomUUID(),
    offset: 0,
    maxBytes: 1024,
    mimeBytes: 1024,
    ...(kind === "diagnostic" ? { diagnosticConnection: connection } : {}),
  } as ReceivingOperation;
}

describe("R03 unified elected admission with disposable PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let url: string;
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
    await root`create database r03 owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/r03`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 4 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  async function account(withMailbox = false) {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "R03 fixture",
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
        id: randomUUID(),
        accountId: id,
        remotePath: "INBOX",
        name: "INBOX",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
    return id;
  }
  function owner(
    d: number,
    w: number,
    handlers: ReceivingOperationHandlers,
    retiring?: ReturnType<typeof barrier>,
  ) {
    const executor = new ReceivingExecutor(url, d);
    cleanup.push(() => executor.stop());
    let constructed = 0,
      live = 0,
      peak = 0;
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: { workers: w },
      loadAccount: async (_db, candidate) => ({ ...candidate, connection }),
      loadOperationConnection: async () => connection,
      operationHandlers: handlers,
      createOperationClient: () => {
        constructed++;
        live++;
        peak = Math.max(peak, live);
        const emitter = new EventEmitter();
        let retired: Promise<void> | undefined;
        return Object.assign(emitter, {
          socket: { marker: "private-fixture-transport" },
          connect: async () => undefined,
          fetch: async function* () {
            yield { uid: 1 };
          },
          retireReceiving: () =>
            (retired ??= (async () => {
              await retiring?.promise;
              live--;
            })()),
        }) as unknown as ImapFlow;
      },
    });
    cleanup.push(() => coordinator.stop());
    return {
      coordinator,
      executor,
      counts: () => ({ constructed, live, peak }),
    };
  }

  it.each([
    [1, 1],
    [2, 1],
    [4, 1],
    [1, 2],
    [2, 2],
    [4, 2],
  ])(
    "W=%i D=%i: every kind shares W/C/D, including bootstrap before mailbox",
    async (w, d) => {
      const accounts = [
        await account(),
        await account(),
        await account(),
        await account(),
      ];
      const release = barrier();
      const started: string[] = [];
      const activeAccounts = new Set<string>();
      const handlers = Object.fromEntries(
        kinds.map((kind) => [
          kind,
          async (op: ReceivingOperation, ctx: ReceivingOperationContext) => {
            const key =
              "account" in op.identity
                ? op.identity.account
                : op.identity.ephemeral;
            expect(activeAccounts.has(key)).toBe(false);
            activeAccounts.add(key);
            started.push(op.kind);
            await ctx.client.connect();
            await release.promise;
            await ctx.retireSocket();
            await ctx.transaction(async (db) => {
              await db.execute(sql`select 1`);
            });
            activeAccounts.delete(key);
          },
        ]),
      ) as ReceivingOperationHandlers;
      const fixture = owner(d, w, handlers);
      cleanup.push(async () => release.release());
      expect(await fixture.coordinator.elect()).toBe(true);
      const tasks = kinds.map((kind, index) =>
        fixture.coordinator.submit(
          operation(kind, accounts[index % accounts.length]),
        ),
      );
      const limit = Math.min(w, 2 * d - 1);
      await until(() => started.length === limit);
      expect(fixture.coordinator.snapshot.scheduler?.active).toBe(limit);
      expect(fixture.counts().live).toBe(limit);
      expect(await fixture.coordinator.renew()).toBe(true);
      expect(fixture.counts().constructed).toBe(limit); // independent route would exceed this barrier
      release.release();
      await Promise.all(tasks);
      expect(new Set(started)).toEqual(new Set(kinds));
      expect(fixture.counts().peak).toBeLessThanOrEqual(limit);
      expect(fixture.counts().live).toBe(0);
    },
  );

  it("cancellation holds W and C through both handler and actual socket retirement", async () => {
    const accountId = await account();
    const handlerRelease = barrier(),
      socketRelease = barrier(),
      entered = barrier();
    const cancellation = new AbortController();
    let calls = 0;
    const fixture = owner(
      1,
      1,
      {
        diagnostic: async (_op, ctx) => {
          calls++;
          entered.release();
          await ctx.client.connect();
          await handlerRelease.promise;
        },
      },
      socketRelease,
    );
    cleanup.push(async () => {
      handlerRelease.release();
      socketRelease.release();
    });
    await fixture.coordinator.elect();
    const first = fixture.coordinator.submit(
      operation("diagnostic", accountId, cancellation.signal),
    );
    const rejected = expect(first).rejects.toThrow("retired");
    await entered.promise;
    const second = fixture.coordinator.submit(
      operation("diagnostic", accountId),
    );
    cancellation.abort();
    expect(fixture.counts().live).toBe(1);
    expect(fixture.coordinator.snapshot.scheduler?.active).toBe(1);
    expect(calls).toBe(1);
    handlerRelease.release();
    // Renewal is an independent SQL barrier proving the event loop ran after cancellation.
    await fixture.coordinator.renew();
    expect(calls).toBe(1);
    expect(fixture.counts().live).toBe(1);
    socketRelease.release();
    await rejected;
    await second;
    expect(calls).toBe(2);
    expect(fixture.counts().peak).toBe(1);
  });

  it("ephemeral tests consume W without durable accounts; follower and expired owner construct zero new clients", async () => {
    const fixture = owner(1, 1, {
      diagnostic: async (_op, ctx) => {
        await ctx.client.connect();
      },
    });
    const follower = owner(1, 1, { diagnostic: async () => undefined });
    await fixture.coordinator.elect();
    expect(await follower.coordinator.elect()).toBe(false);
    await expect(
      follower.coordinator.submit(operation("diagnostic")),
    ).rejects.toThrow("unavailable");
    expect(follower.coordinator.snapshot.phase).toBe("follower");
    const before = (await reader`select count(*) from mail_accounts`)[0].count;
    await fixture.coordinator.submit(operation("diagnostic"));
    expect((await reader`select count(*) from mail_accounts`)[0].count).toBe(
      before,
    );
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await expect(
      fixture.coordinator.submit(operation("diagnostic")),
    ).rejects.toThrow();
    expect(fixture.counts().constructed).toBe(1);
    expect(follower.counts().constructed).toBe(0);
  });

  it("queued cancellation during locked renewal cannot remove or resurrect another request", async () => {
    const fixture = owner(1, 1, { diagnostic: async () => {} });
    await fixture.coordinator.elect();
    const held = await reader.reserve();
    let released = false;
    await held`begin`;
    await held`select singleton from receiving_coordinator for update`;
    const cancellation = new AbortController();
    const first = fixture.coordinator.submit(
      operation("diagnostic", undefined, cancellation.signal),
    );
    const rejected = expect(first).rejects.toThrow("cancelled");
    try {
      await until(
        async () =>
          Number(
            (
              await reader`select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%maildock_receiving_renew%'`
            )[0].count,
          ) === 1,
      );
      const second = fixture.coordinator.submit(operation("diagnostic"));
      cancellation.abort();
      await rejected;
      expect(fixture.coordinator.snapshot.scheduler?.pending).toBe(1);
      expect(fixture.counts().constructed).toBe(0);
      await held`commit`;
      held.release();
      released = true;
      await second;
      expect(fixture.counts().constructed).toBe(1);
    } finally {
      if (!released) {
        await held`rollback`.catch(() => {});
        held.release();
      }
    }
  });

  it("deadline signals cancellation but capacity stays held until socket and handler settle", async () => {
    const timedOut = barrier(),
      release = barrier(),
      socket = barrier();
    const fixture = owner(
      1,
      1,
      {
        diagnostic: async (_op, ctx) => {
          ctx.signal.addEventListener("abort", () => timedOut.release(), {
            once: true,
          });
          await release.promise;
        },
      },
      socket,
    );
    cleanup.push(async () => {
      release.release();
      socket.release();
    });
    await fixture.coordinator.elect();
    const first = fixture.coordinator.submit({
      ...operation("diagnostic"),
      deadline: performance.now() + 500,
    });
    const rejected = expect(first).rejects.toThrow("retired");
    await until(() => fixture.counts().constructed === 1);
    const second = fixture.coordinator.submit(operation("diagnostic"));
    await timedOut.promise;
    expect(fixture.coordinator.snapshot.scheduler?.active).toBe(1);
    expect(fixture.counts().constructed).toBe(1);
    release.release();
    await fixture.coordinator.renew();
    expect(fixture.counts().constructed).toBe(1);
    socket.release();
    await rejected;
    await second;
    expect(fixture.counts().peak).toBe(1);
  });

  it("shutdown waits for typed retirement and a replacement never resumes the old client", async () => {
    const entered = barrier(),
      release = barrier();
    let captured!: ReceivingOperationContext;
    const old = owner(1, 1, {
      diagnostic: async (_op, ctx) => {
        captured = ctx;
        entered.release();
        await release.promise;
        ctx.assertCurrent();
      },
    });
    cleanup.push(async () => release.release());
    await old.coordinator.elect();
    const oldTerm = old.coordinator.snapshot.owner!;
    const pending = old.coordinator.submit(operation("diagnostic"));
    const rejected = expect(pending).rejects.toThrow("retired");
    await entered.promise;
    const stopping = old.coordinator.stop();
    await until(() => old.counts().live === 0);
    expect(old.coordinator.snapshot.scheduler?.active).toBe(1);
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const next = owner(1, 1, { diagnostic: async () => {} });
    await next.coordinator.elect();
    expect(next.coordinator.snapshot.owner!.generation).toBe(
      oldTerm.generation + 1n,
    );
    expect(() => captured.client.connect()).toThrow("retired");
    await next.coordinator.submit(operation("diagnostic"));
    release.release();
    await rejected;
    await stopping;
    expect(old.counts().constructed).toBe(1);
    expect(next.counts().constructed).toBe(1);
    expect(await next.coordinator.renew()).toBe(true);
  });

  it("changed configuration and disabled lifecycle fail before provider construction", async () => {
    const id = await account();
    const fixture = owner(1, 1, { list: async () => undefined });
    await fixture.coordinator.elect();
    await reader`update mail_accounts set imap_host='changed.invalid.test' where id=${id}`;
    await expect(
      fixture.coordinator.submit(operation("list", id)),
    ).rejects.toThrow("configuration");
    const current = {
      ...operation("list", id),
      identity: { account: id, configurationVersion: 2n },
    };
    await reader`update mail_accounts set enabled=false where id=${id}`;
    await expect(fixture.coordinator.submit(current)).rejects.toThrow(
      "lifecycle",
    );
    expect(fixture.counts().constructed).toBe(0);
  });

  it("diagnostic RPC admission binds saved/ephemeral requests to the captured elected term", async () => {
    const id = await account();
    const fixture = owner(1, 1, {
      diagnostic: async () => ({ success: true }),
    });
    await fixture.coordinator.elect();
    const expectedOwner = fixture.coordinator.snapshot.owner!;
    const request = {
      requestId: randomUUID(),
      expectedOwner,
      identity: { account: id, configurationVersion: 1n },
      deadline: performance.now() + 9000,
    };
    await expect(
      fixture.coordinator.diagnose({
        ...request,
        expectedOwner: {
          ...expectedOwner,
          generation: expectedOwner.generation + 1n,
        },
      }),
    ).rejects.toThrow("owner unavailable");
    expect(fixture.counts().constructed).toBe(0);
    expect(await fixture.coordinator.diagnose(request)).toEqual({
      success: true,
    });
    await fixture.coordinator.diagnose({
      ...request,
      requestId: randomUUID(),
      identity: { ephemeral: randomUUID() },
      connection,
    });
    expect(fixture.counts().constructed).toBe(2);
  });

  it("helpers cannot reconnect, obtain raw socket, use SQL during network, or resume a settled lifetime", async () => {
    const id = await account();
    let captured!: ReceivingOperationContext;
    let iterator!: ReturnType<ReceivingOperationContext["client"]["fetch"]>;
    const fixture = owner(1, 1, {
      list: async (_op, ctx) => {
        captured = ctx;
        iterator = ctx.client.fetch("1", { uid: true });
        expect(
          Object.getOwnPropertyDescriptor(ctx.client, "socket"),
        ).toBeUndefined();
        expect(Object.isFrozen(ctx.client)).toBe(true);
        await ctx.client.connect();
        expect(() => ctx.client.connect()).toThrow("reconnect");
        expect(() => Reflect.get(ctx.client, "socket")).toThrow("unowned");
        expect(() => ctx.transaction(async () => undefined)).toThrow(
          "retired socket",
        );
      },
    });
    await fixture.coordinator.elect();
    await fixture.coordinator.submit(operation("list", id));
    expect(() => captured.client.connect()).toThrow("retired");
    expect(() => captured.transaction(async () => undefined)).toThrow(
      "retired",
    );
    await expect(iterator.next()).rejects.toThrow("retired");
    expect(fixture.counts().constructed).toBe(1);
  });

  it("saturated D=1 reserves control admission but missed renewal deadline fails closed", async () => {
    const fixture = owner(1, 1, { diagnostic: async () => undefined });
    await fixture.coordinator.elect();
    const entered = barrier(),
      release = barrier();
    cleanup.push(async () => release.release());
    const occupied = fixture.executor.transaction(
      async (db) => {
        await db.execute(sql`select 1`);
        entered.release();
        await release.promise;
      },
      { deadline: performance.now() + 9000 },
    );
    await entered.promise;
    expect(await fixture.coordinator.renew()).toBe(false); // 2-second control deadline; no assumed spare runner
    expect(fixture.coordinator.snapshot.phase).toBe("lost");
    await expect(
      fixture.coordinator.submit(operation("diagnostic")),
    ).rejects.toThrow();
    expect(fixture.counts().constructed).toBe(0);
    release.release();
    await occupied;
  });

  it("D=2 publication saturation plus renewal stays within two executing/two waiting", async () => {
    const ids = [await account(), await account(), await account()];
    const release = barrier();
    let entered = 0;
    const fixture = owner(2, 4, {
      list: async (_op, ctx) => {
        await ctx.retireSocket();
        await ctx.transaction(async (db) => {
          await db.execute(sql`select 1`);
          entered++;
          await release.promise;
        });
      },
    });
    cleanup.push(async () => release.release());
    await fixture.coordinator.elect();
    const tasks = ids.map((id) =>
      fixture.coordinator.submit(operation("list", id)),
    );
    await until(
      () =>
        entered === 2 &&
        fixture.executor.snapshot.executing === 2 &&
        fixture.executor.snapshot.waiting === 1,
    );
    tasks.forEach((task) => {
      void task.catch(() => undefined);
    });
    const renewal = fixture.coordinator.renew();
    await until(() => fixture.executor.snapshot.waiting === 2);
    expect(fixture.executor.snapshot).toEqual({
      executing: 2,
      waiting: 2,
      capacity: 2,
    });
    expect(
      Number(
        (
          await reader`select count(*) from pg_stat_activity where application_name='maildock-receiving-stage1' and state='idle in transaction'`
        )[0].count,
      ),
    ).toBe(2);
    release.release();
    expect(await renewal).toBe(true);
    await Promise.all(tasks);
  });

  it("continuous fresh traffic and sustained user slices both progress with protected history", async () => {
    const id = await account(true);
    const script = { boundedMailbox: true, uidNext: 1025, uids: [1, 1024] };
    const peer = await metadataPeer(script);
    cleanup.push(peer.cleanup);
    const executor = new ReceivingExecutor(url, 1);
    cleanup.push(() => executor.stop());
    const admissions: string[] = [];
    let userActive = false,
      fresh = 0,
      history = 0;
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: { workers: 1, historyWaitMs: 1, historyTurnMs: 1000 },
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: peer.connection,
        createClient: peer.createClient,
        timing: { pollMs: 1, operationMs: 3000 },
        onTurn: (kind) => {
          expect(userActive).toBe(false);
          if (kind === "fresh") {
            fresh++;
            script.uidNext++;
            script.uids.push(script.uidNext - 1);
          } else history++;
        },
      }),
      loadOperationConnection: async () => connection,
      operationHandlers: {
        "content-slice": async (_op, ctx) => {
          userActive = true;
          await ctx.client.connect();
          await ctx.retireSocket();
          await ctx.transaction(async (db) => {
            await db.execute(sql`select 1`);
          });
          userActive = false;
        },
      },
      createOperationClient: () =>
        Object.assign(new EventEmitter(), {
          connect: async () => {},
          retireReceiving: async () => {},
        }) as unknown as ImapFlow,
      onAdmission: (admission) => admissions.push(admission.kind),
    });
    cleanup.push(() => coordinator.stop());
    await coordinator.elect();
    // Keep demand sustained by submitting the next validated slice at each
    // settlement. Each unit captures its own deadline, including queue wait.
    for (let index = 0; index < 24; index++)
      await coordinator.submit(operation("content-slice", id));
    await coordinator.stop();
    expect(admissions[0]).toBe("fresh");
    expect(fresh).toBeGreaterThan(1);
    expect(history).toBeGreaterThan(1);
    expect(admissions.filter((kind) => kind === "content-slice")).toHaveLength(
      24,
    );
    expect(admissions.indexOf("history")).toBeLessThan(6);
    // With continuous arrivals, user opportunities never form consecutive turns.
    expect(
      admissions.some(
        (kind, index) =>
          kind === "content-slice" && admissions[index + 1] === "content-slice",
      ),
    ).toBe(false);
    expect(
      Number(
        (
          await reader`select count(*) from mailbox_messages p join mailboxes m on m.id=p.mailbox_id where m.account_id=${id}`
        )[0]?.count ?? 0,
      ),
    ).toBeGreaterThan(0);
  });

  it("oversized slices/APPEND and missing registered bodies are rejected before construction", async () => {
    const id = await account();
    const fixture = owner(1, 1, {
      "content-slice": async () => {},
      append: async () => {},
    });
    await fixture.coordinator.elect();
    await expect(
      fixture.coordinator.submit({
        ...operation("content-slice", id),
        kind: "content-slice",
        pendingId: randomUUID(),
        offset: 0,
        maxBytes: 5 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("unit budget");
    await expect(
      fixture.coordinator.submit({
        ...operation("attachment-slice", id),
        kind: "attachment-slice",
        pendingId: randomUUID(),
        offset: 0,
        maxBytes: 256 * 1024 + 1,
      }),
    ).rejects.toThrow("unit budget");
    await expect(
      fixture.coordinator.submit({
        ...operation("append", id),
        kind: "append",
        pendingId: randomUUID(),
        mimeBytes: 25 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("MIME policy");
    await expect(
      fixture.coordinator.submit(operation("store", id)),
    ).rejects.toThrow("unavailable");
    expect(fixture.counts().constructed).toBe(0);
  });

  it("startup metadata precedes saved diagnostics and they never overlap C=1", async () => {
    const id = await account(true);
    const peer = await metadataPeer({
      boundedMailbox: true,
      uidNext: 1,
      uids: [],
    });
    cleanup.push(peer.cleanup);
    const executor = new ReceivingExecutor(url, 1);
    cleanup.push(() => executor.stop());
    const admissions: string[] = [];
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: { workers: 1 },
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: peer.connection,
        createClient: peer.createClient,
        timing: { pollMs: 60000 },
      }),
      operationHandlers: {
        diagnostic: async () => {
          await until(() => peer.peers.every((p) => p.socket.destroyed));
          expect(peer.peers.every((p) => p.socket.destroyed)).toBe(true);
        },
      },
      createOperationClient: () =>
        Object.assign(new EventEmitter(), {
          retireReceiving: async () => undefined,
        }) as unknown as ImapFlow,
      onAdmission: (admission) => admissions.push(admission.kind),
    });
    cleanup.push(() => coordinator.stop());
    await coordinator.elect();
    await coordinator.submit(operation("diagnostic", id));
    expect(admissions.slice(0, 2)).toEqual(["fresh", "diagnostic"]);
  });

  it("selection alternates user/current opportunities while preserving protected history", async () => {
    // Pure selector oracle supplements the elected DB tests; no fake election evidence.
    const executor = new ReceivingExecutor(url, 1);
    cleanup.push(() => executor.stop());
    const id = randomUUID();
    const scheduler = new ReceivingScheduler({
      executor,
      accounts: [
        {
          account: id,
          mailbox: randomUUID(),
          connection,
          owner: { actor: randomUUID(), generation: 1n },
          authority: { assertCurrent: () => {}, renew: async () => {} },
        },
      ],
      tuning: { workers: 1, historyWaitMs: 100, historyTurnMs: 100 },
      operations: {
        handlers: { diagnostic: async () => {} },
        boundary: {
          owner: { actor: randomUUID(), generation: 1n },
          executor,
          assertCurrent: () => {},
          validate: async () => connection,
        },
      },
    });
    cleanup.push(() => scheduler.stop());
    const account = scheduler["accounts"][0];
    account.initialFreshGranted = true;
    account.freshDue = 900;
    account.historySince = 500;
    const queued = scheduler.submit(operation("diagnostic"));
    const rejected = expect(queued).rejects.toThrow("retired");
    expect(scheduler["select"](1000)?.kind).toBe("history");
    scheduler["lastProtected"] = true;
    expect(scheduler["select"](1000)?.pending).toBeDefined();
    scheduler["lastUser"] = true;
    expect(scheduler["select"](1000)?.kind).toBe("fresh");
    scheduler["lastProtected"] = false;
    expect(scheduler["select"](1000)?.kind).toBe("history");
    scheduler.start();
    await scheduler.stop();
    await rejected;
  });
});
