import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import {
  enqueueBackfill,
  MAILBOX_BACKFILL_SYNC_QUEUE,
  registerBackfillWorker,
} from "@/modules/mail/infrastructure/backfill-sync-jobs";
import {
  enqueueDelta,
  MAILBOX_DELTA_SYNC_QUEUE,
} from "@/modules/mail/infrastructure/delta-sync-jobs";
import { MAILBOX_RECENT_SYNC_QUEUE } from "@/modules/mail/infrastructure/recent-sync-jobs";
import type { BackfillSyncService } from "@/modules/mail/application/backfill-sync-service";

describe("Phase 1G job priority", () => {
  it("enqueues backfill below delta and identifies each frontier", async () => {
    const sent: {
      queue: string;
      options: { priority?: number; singletonKey?: string };
    }[] = [];
    const boss = {
      getDb: () => ({
        beginTransaction: async () => ({
          db: { executeSql: async () => ({ rows: [] }) },
          commit: async () => {},
          rollback: async () => {},
        }),
      }),
      findJobs: async () => [],
      send: async (
        queue: string,
        _data: unknown,
        options: { priority?: number; singletonKey?: string },
      ) => {
        sent.push({ queue, options });
        return "job";
      },
    } as unknown as PgBoss;
    const accountId = "00000000-0000-4000-8000-000000000001";
    const mailboxId = "00000000-0000-4000-8000-000000000002";
    await enqueueDelta(boss, accountId, mailboxId, "poll");
    await enqueueBackfill(boss, accountId, mailboxId, "50");
    expect(sent).toEqual([
      {
        queue: MAILBOX_DELTA_SYNC_QUEUE,
        options: {
          singletonKey: mailboxId,
          priority: 10,
          db: expect.any(Object),
        },
      },
      {
        queue: MAILBOX_BACKFILL_SYNC_QUEUE,
        options: {
          singletonKey: `${mailboxId}:50`,
          priority: -10,
          db: expect.any(Object),
        },
      },
    ]);
  });

  it("yields queued recent or delta work before taking the mailbox lock", async () => {
    const accountId = "00000000-0000-4000-8000-000000000001";
    const mailboxId = "00000000-0000-4000-8000-000000000002";
    let handler!: (batch: { data: unknown }[]) => Promise<void>;
    let queued = MAILBOX_RECENT_SYNC_QUEUE;
    let entered = false;
    const boss = {
      createQueue: async () => undefined,
      work: async (
        _name: string,
        _options: unknown,
        callback: typeof handler,
      ) => {
        handler = callback;
      },
      findJobs: async (name: string) => (name === queued ? [{}] : []),
      send: async () => "job",
    } as unknown as PgBoss;
    const service = {
      run: async () => {
        entered = true;
        return null;
      },
    } as unknown as BackfillSyncService;
    await registerBackfillWorker(boss, service, async (_id, work) => {
      entered = true;
      await work();
    });
    const job = [{ data: { version: 1, accountId, mailboxId } }];
    await handler(job);
    expect(entered).toBe(false);
    queued = MAILBOX_DELTA_SYNC_QUEUE;
    await handler(job);
    expect(entered).toBe(false);
    queued = "";
    await handler(job);
    expect(entered).toBe(true);
  });
});
