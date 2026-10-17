import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";

import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import type { BackfillSyncService } from "../application/backfill-sync-service";
import { MailboxBusyError } from "./mailbox-lock";
import { higherPriorityWorkWaiting } from "./sync-admission";
import {
  MAILBOX_BACKFILL_SYNC_QUEUE,
  MAILBOX_DELTA_SYNC_QUEUE,
  MAILBOX_RECENT_SYNC_QUEUE,
} from "./sync-queues";
import { HISTORY_DEFER_SECONDS } from "../application/inbox-first-policy";

export { MAILBOX_BACKFILL_SYNC_QUEUE };
const payloadSchema = z
  .object({ version: z.literal(1), accountId: z.uuid(), mailboxId: z.uuid() })
  .strict();

export async function ensureBackfillQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAILBOX_BACKFILL_SYNC_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 900,
  });
}

export async function enqueueBackfill(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  frontier?: string | null,
  startAfter?: number,
): Promise<boolean> {
  return enqueueBackfillKey(
    boss,
    accountId,
    mailboxId,
    `${mailboxId}:${frontier ?? "initial"}`,
    startAfter,
  );
}

function enqueueBackfillKey(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  singletonKey: string,
  startAfter?: number,
): Promise<boolean> {
  return enqueueCoalescedSync(
    boss,
    MAILBOX_BACKFILL_SYNC_QUEUE,
    { version: 1, accountId, mailboxId },
    { singletonKey, ...(startAfter === undefined ? {} : { startAfter }) },
    { accountId, mailboxId, kind: "history" },
  );
}

export async function registerBackfillWorker(
  boss: PgBoss,
  service: BackfillSyncService,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
): Promise<void> {
  await ensureBackfillQueue(boss);
  await boss.work(
    MAILBOX_BACKFILL_SYNC_QUEUE,
    { localConcurrency: 1, includeMetadata: true },
    safeJobHandler("backfill-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Backfill received an empty batch.");
      const payload = payloadSchema.parse(job.data);
      const { accountId, mailboxId } = payload;
      const key =
        (job as { singletonKey?: string | null }).singletonKey ??
        `${mailboxId}:initial`;
      // Any queued fresh run of this mailbox (also a delayed retry) or more
      // urgent fresh work of this account goes first. History never outranks
      // INBOX fresh work, including INBOX history.
      const yields = async () => {
        const [recent, delta] = await Promise.all([
          boss.findJobs(MAILBOX_RECENT_SYNC_QUEUE, {
            key: mailboxId,
            queued: true,
          }),
          boss.findJobs(MAILBOX_DELTA_SYNC_QUEUE, {
            key: mailboxId,
            queued: true,
          }),
        ]);
        return (
          recent.length > 0 ||
          delta.length > 0 ||
          (await higherPriorityWorkWaiting(
            boss,
            accountId,
            mailboxId,
            "history",
          ))
        );
      };
      // Yield commits a delayed successor with the same key (stately keeps it
      // behind this active run); the checkpoint is unchanged and the poller
      // still repairs a crash before this send.
      const successor = () =>
        enqueueBackfillKey(
          boss,
          accountId,
          mailboxId,
          key,
          HISTORY_DEFER_SECONDS,
        );
      if (await yields()) {
        await successor();
        return;
      }
      let more: string | null = null;
      let yielded = false;
      try {
        await withLock(mailboxId, async () => {
          if (await yields()) {
            yielded = true;
            return;
          }
          more = await service.run(accountId, mailboxId);
        });
      } catch (error) {
        if (!(error instanceof MailboxBusyError)) throw error;
        yielded = true;
      }
      if (yielded) {
        await successor();
        return;
      }
      // The active singleton still owns its key. A fresh key permits exactly one
      // continuation; the poller repairs a crash between commit and enqueue.
      if (more) await enqueueBackfill(boss, accountId, mailboxId, more, 5);
    }),
  );
}

export class BackfillPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly database: Database,
    private readonly boss: PgBoss,
  ) {}
  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      60_000,
    );
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.database
        .select({
          accountId: mailboxes.accountId,
          mailboxId: mailboxes.id,
          frontier: mailboxes.backfillFrontierUid,
        })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.enabled, true),
            eq(mailboxes.selectable, true),
            eq(mailboxes.lifecycleStatus, "active"),
            eq(mailboxes.recentSyncStatus, "success"),
            ne(mailboxes.backfillStatus, "complete"),
          ),
        );
      for (const row of rows)
        await enqueueBackfill(
          this.boss,
          row.accountId,
          row.mailboxId,
          row.frontier?.toString(),
        );
    } finally {
      this.running = false;
    }
  }
}
