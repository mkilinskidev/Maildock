import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { PgBoss } from "pg-boss";
import type { ImapFlow } from "imapflow";

import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import type { Database } from "@/shared/infrastructure/database/database";
import {
  DeltaPoller,
  enqueueDelta,
  MAILBOX_DELTA_SYNC_QUEUE,
  registerDeltaWorker,
} from "@/modules/mail/infrastructure/delta-sync-jobs";
import {
  IdleWatcherManager,
  idleReconnectDelay,
  nextIdleReconnectBackoff,
} from "@/modules/mail/infrastructure/idle-watchers";
import {
  MAILBOX_RECENT_SYNC_QUEUE,
  registerRecentSyncWorker,
} from "@/modules/mail/infrastructure/recent-sync-jobs";
import type { DeltaSyncService } from "@/modules/mail/application/delta-sync-service";
import type { MessageService } from "@/modules/mail/application/message-service";

const accountId = "00000000-0000-4000-8000-0000000000e1";
const mailboxId = "00000000-0000-4000-8000-0000000000e2";
const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

function databaseRows<T>(rows: T[]): Database {
  const chain = {
    innerJoin: () => chain,
    where: async () => rows,
  };
  return { select: () => ({ from: () => chain }) } as unknown as Database;
}

function boss() {
  const pending = new Set<string>();
  const sent: { queue: string; data: unknown; options: unknown }[] = [];
  const value = {
    getDb: () => ({
      beginTransaction: async () => ({
        db: { executeSql: async () => ({ rows: [] }) },
        commit: async () => {},
        rollback: async () => {},
      }),
    }),
    findJobs: async (_queue: string, options: { key: string }) =>
      pending.has(options.key) ? [{}] : [],
    send: async (
      queue: string,
      data: unknown,
      options: { singletonKey: string },
    ) => {
      sent.push({ queue, data, options });
      if (pending.has(options.singletonKey)) return null;
      pending.add(options.singletonKey);
      return "job-1";
    },
  } as unknown as PgBoss;
  return { value, sent, pending };
}

class FakeIdleClient extends EventEmitter {
  capabilities = new Map<string, boolean>([["IDLE", true]]);
  connect = vi.fn(async () => undefined);
  mailboxOpen = vi.fn(async () => undefined);
  close = vi.fn(() => this.emit("close"));
}

function watchers(
  rows: {
    accountId: string;
    mailboxId: string;
    remotePath: string;
    capabilities: string[];
  }[],
  makeClient: () => FakeIdleClient,
) {
  const jobs = boss();
  const accounts = {
    getProviderImapAccountForWork: async () => ({
      accountId,
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        credential: { kind: "password", password: "secret" },
      },
    }),
  } as unknown as AccountsService;
  const writes = { update: vi.fn(), delete: vi.fn(), insert: vi.fn() };
  const db = Object.assign(databaseRows(rows), writes);
  const manager = new IdleWatcherManager(
    db,
    accounts,
    jobs.value,
    logger,
    makeClient as unknown as (
      options: ConstructorParameters<typeof ImapFlow>[0],
    ) => ImapFlow,
  );
  return { manager, jobs, writes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Phase 1E delta scheduling and IDLE", () => {
  it("F11 IDLE logs retain opaque IDs and omit mail labels", async () => {
    vi.useFakeTimers();
    const client = new FakeIdleClient();
    const rows = [
      {
        accountId,
        mailboxId,
        remotePath: "INBOX",
        capabilities: ["IDLE"],
        accountName: "Hotmail",
        accountEmail: "owner@example.test",
      },
    ];
    const { manager, writes } = watchers(rows, () => client);
    await manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mail.idle_connected",
        accountId,
        mailboxId,
      }),
      expect.any(String),
    );
    expect(writes.insert).not.toHaveBeenCalled();
    await manager.stop();
    const failed = new FakeIdleClient();
    failed.connect.mockRejectedValueOnce(Error("secret"));
    const next = watchers(rows, () => failed);
    await next.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mail.idle_disconnected",
        accountId,
        mailboxId,
      }),
      expect.any(String),
    );
    expect(next.writes.insert).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        vi.mocked(logger.info).mock.calls,
        vi.mocked(logger.warn).mock.calls,
      ]),
    ).not.toMatch(
      /accountName|accountEmail|mailboxPath|owner@example.test|Hotmail|INBOX|secret/,
    );
    await next.manager.stop();
  });
  it("uses a mailbox singleton key to reject duplicate pending delta jobs", async () => {
    const jobs = boss();
    expect(await enqueueDelta(jobs.value, accountId, mailboxId, "poll")).toBe(
      true,
    );
    expect(await enqueueDelta(jobs.value, accountId, mailboxId, "idle")).toBe(
      false,
    );
    expect(jobs.sent).toEqual([
      {
        queue: MAILBOX_DELTA_SYNC_QUEUE,
        data: { version: 1, accountId, mailboxId, reason: "poll" },
        options: {
          singletonKey: mailboxId,
          priority: 10,
          db: expect.any(Object),
        },
      },
    ]);
  });

  it("polls initialized eligible mailboxes and coalesces pending jobs", async () => {
    const jobs = boss();
    const poller = new DeltaPoller(
      databaseRows([{ accountId, mailboxId }]),
      jobs.value,
      60,
    );
    await poller.start();
    poller.stop();
    expect(jobs.sent).toHaveLength(1);
    await poller.start();
    poller.stop();
    expect(jobs.sent).toHaveLength(1);
    expect(jobs.pending.size).toBe(1);
    expect(
      jobs.sent.every(
        (call) => (call.data as { reason: string }).reason === "poll",
      ),
    ).toBe(true);
  });

  it("runs recent and delta workers through the same mailbox lock callback", async () => {
    const handlers = new Map<
      string,
      (jobs: { data: unknown }[]) => Promise<void>
    >();
    const jobs = {
      createQueue: async () => undefined,
      work: async (
        name: string,
        _options: unknown,
        handler: (jobs: { data: unknown }[]) => Promise<void>,
      ) => {
        handlers.set(name, handler);
      },
    } as unknown as PgBoss;
    const locked: string[] = [];
    const withLock = async (id: string, work: () => Promise<void>) => {
      locked.push(id);
      await work();
    };
    const recent = {
      runRecentSync: vi.fn(async () => undefined),
    } as unknown as MessageService;
    const delta = {
      run: vi.fn(async () => undefined),
    } as unknown as DeltaSyncService;
    await registerRecentSyncWorker(jobs, recent, 1, withLock);
    await registerDeltaWorker(jobs, delta, 1, withLock);
    await handlers.get(MAILBOX_RECENT_SYNC_QUEUE)!([
      {
        data: { version: 1, accountId, mailboxId },
      },
    ]);
    await handlers.get(MAILBOX_DELTA_SYNC_QUEUE)!([
      {
        data: { version: 1, accountId, mailboxId, reason: "poll" },
      },
    ]);
    expect(locked).toEqual([mailboxId, mailboxId]);
    expect(recent.runRecentSync).toHaveBeenCalledOnce();
    expect(delta.run).toHaveBeenCalledOnce();
  });

  it.each(["exists", "flags", "expunge", "mailboxClose"] as const)(
    "%s only schedules a delta; rapid events coalesce",
    async (event) => {
      vi.useFakeTimers();
      const client = new FakeIdleClient();
      const { manager, jobs, writes } = watchers(
        [{ accountId, mailboxId, remotePath: "INBOX", capabilities: ["IDLE"] }],
        () => client,
      );
      await manager.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(jobs.sent).toHaveLength(1); // initial connection
      client.emit(event, { seq: 42 });
      client.emit(event, { seq: 42 });
      expect(jobs.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(jobs.sent).toHaveLength(1);
      expect(jobs.sent[0]?.data).toMatchObject({ reason: "idle" });
      expect(jobs.pending.size).toBe(1);
      expect(writes.update).not.toHaveBeenCalled();
      expect(writes.delete).not.toHaveBeenCalled();
      expect(writes.insert).not.toHaveBeenCalled();
      await manager.stop();
      expect(client.close).toHaveBeenCalled();
    },
  );

  it("watches only an IDLE capable INBOX and never opens noneligible mailboxes", async () => {
    vi.useFakeTimers();
    const clients: FakeIdleClient[] = [];
    const { manager } = watchers(
      [
        { accountId, mailboxId, remotePath: "INBOX", capabilities: ["IDLE"] },
        {
          accountId,
          mailboxId: "archive",
          remotePath: "Archive",
          capabilities: ["IDLE"],
        },
        {
          accountId,
          mailboxId: "no-idle",
          remotePath: "Other",
          capabilities: [],
        },
      ],
      () => {
        const client = new FakeIdleClient();
        clients.push(client);
        return client;
      },
    );
    await manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.mailboxOpen).toHaveBeenCalledWith("INBOX", {
      readOnly: true,
    });
    await manager.stop();
  });

  it("does not maintain a connection when the server lacks IDLE", async () => {
    vi.useFakeTimers();
    const client = new FakeIdleClient();
    client.capabilities.clear();
    const { manager, jobs } = watchers(
      [{ accountId, mailboxId, remotePath: "INBOX", capabilities: ["IDLE"] }],
      () => client,
    );
    await manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.close).toHaveBeenCalled();
    expect(client.mailboxOpen).not.toHaveBeenCalled();
    expect(jobs.sent).toHaveLength(0);
    await manager.stop();
  });

  it("reconnects after close with backoff and stop cancels reconnect sleep", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clients: FakeIdleClient[] = [];
    const { manager, jobs } = watchers(
      [{ accountId, mailboxId, remotePath: "INBOX", capabilities: ["IDLE"] }],
      () => {
        const client = new FakeIdleClient();
        clients.push(client);
        return client;
      },
    );
    await manager.start();
    await vi.advanceTimersByTimeAsync(0);
    // Network error events stay owned by IDLE; close drives its reconnect loop.
    clients[0]!.emit(
      "error",
      Object.assign(Error("Socket timeout"), { code: "ETIMEOUT" }),
    );
    clients[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);
    expect(jobs.sent).toHaveLength(1);
    clients[1]!.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
    expect(clients[1]?.close).toHaveBeenCalled();
  });

  it("caps exponential reconnect backoff and its jitter", () => {
    let backoff = 1_000;
    const values = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      values.push(idleReconnectDelay(backoff, 1));
      backoff = nextIdleReconnectBackoff(backoff);
    }
    expect(values.slice(0, 4)).toEqual([1_500, 3_000, 6_000, 12_000]);
    expect(values.at(-1)).toBe(450_000);
    expect(Math.max(...values)).toBe(450_000);
  });
});
