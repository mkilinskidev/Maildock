import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";

import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { MessageService } from "../application/message-service";
import type { RecentSyncScheduler } from "../application/recent-sync-scheduler";
import { recentSyncPriority } from "../application/initial-inbox-sync";
import { FRESH_DEFER_SECONDS } from "../application/inbox-first-policy";
import { MailboxBusyError } from "./mailbox-lock";
import { higherPriorityWorkWaiting } from "./sync-admission";
import { MAILBOX_RECENT_SYNC_QUEUE } from "./sync-queues";

export { MAILBOX_RECENT_SYNC_QUEUE };

export const recentSyncPayloadSchema = z
  .object({
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
  })
  .strict();

async function ensureQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAILBOX_RECENT_SYNC_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 15 * 60,
    expireInSeconds: 15 * 60,
  });
}

/** All recent producers use this transaction, including deferred successors and repair. */
export async function enqueueRecent(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  mode: "request" | "defer" | "repair" = "request",
): Promise<boolean> {
  const db = boss.getDb();
  if (!db.beginTransaction)
    throw new Error("Recent enqueue requires transactions.");
  const tx = await db.beginTransaction();
  try {
    await tx.db.executeSql(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`maildock-sync-enqueue:${MAILBOX_RECENT_SYNC_QUEUE}:${mailboxId}`],
    );
    const jobs = await boss.findJobs(MAILBOX_RECENT_SYNC_QUEUE, {
      key: mailboxId,
      db: tx.db,
    });
    if (
      jobs.some(
        (job) =>
          job.state === "created" ||
          job.state === "retry" ||
          (mode === "repair" && job.state === "active"),
      )
    ) {
      await tx.commit();
      return false;
    }
    const { rows } = await tx.db.executeSql(
      "SELECT remote_path FROM mailboxes WHERE id = $1 AND account_id = $2",
      [mailboxId, accountId],
    );
    const mailbox = rows[0] as { remote_path: string } | undefined;
    if (!mailbox)
      throw new Error("Recent mailbox does not exist for this account.");
    const id = await boss.send(
      MAILBOX_RECENT_SYNC_QUEUE,
      { version: 1, accountId, mailboxId },
      {
        singletonKey: mailboxId,
        priority: recentSyncPriority(mailbox.remote_path),
        ...(mode === "defer" ? { startAfter: FRESH_DEFER_SECONDS } : {}),
        db: tx.db,
      },
    );
    if (!id) throw new Error("Recent enqueue did not create a durable job.");
    await tx.commit();
    return true;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export class PgBossRecentSyncScheduler implements RecentSyncScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;

  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-message-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }

  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureQueue(this.boss);
    })();
    return this.started;
  }

  async schedule(accountId: string, mailboxId: string): Promise<boolean> {
    await this.start();
    return enqueueRecent(this.boss, accountId, mailboxId);
  }
}

export async function registerRecentSyncWorker(
  boss: PgBoss,
  service: MessageService,
  concurrency: number,
  withLock: (
    mailboxId: string,
    work: () => Promise<void>,
  ) => Promise<void> = async (_mailboxId, work) => work(),
): Promise<void> {
  await ensureQueue(boss);
  await boss.work(
    MAILBOX_RECENT_SYNC_QUEUE,
    { localConcurrency: concurrency },
    safeJobHandler("recent-sync", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Recent sync received an empty batch.");
      const payload = recentSyncPayloadSchema.parse(job.data);
      const successor = async () => {
        // Commit a successor before acknowledging this job. Failed send throws,
        // preserving pg-boss retry; repair also covers a crash between these steps.
        await enqueueRecent(
          boss,
          payload.accountId,
          payload.mailboxId,
          "defer",
        );
      };
      const defer = async () => {
        if (
          !(await service.shouldDeferInitialRecent(
            payload.accountId,
            payload.mailboxId,
          )) &&
          !(await higherPriorityWorkWaiting(
            boss,
            payload.accountId,
            payload.mailboxId,
            "fresh",
          ))
        )
          return false;
        await successor();
        return true;
      };
      if (await defer()) return;
      try {
        await withLock(payload.mailboxId, async () => {
          if (await defer()) return;
          await service.runRecentSync(payload.accountId, payload.mailboxId);
        });
      } catch (error) {
        // Busy is not a sync failure: nothing ran. Requeue shortly instead of
        // consuming exponential retry; the lock holder finishes first.
        if (!(error instanceof MailboxBusyError)) throw error;
        await successor();
      }
    }),
  );
}
