import { withPerformance } from "../../../shared/infrastructure/logging/performance";
import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { ContentScheduler } from "../application/content-scheduler";
import type { MessageContentService } from "../application/message-content-service";

export const MESSAGE_CONTENT_QUEUE = "message-content-fetch-v1";
const payload = z
  .object({
    version: z.literal(1),
    accountId: z.uuid(),
    mailboxId: z.uuid(),
    messageId: z.uuid(),
  })
  .strict();

export async function ensureContentQueue(boss: PgBoss) {
  await boss.createQueue(MESSAGE_CONTENT_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 900,
  });
}

/** Serialize every producer and coalesce across all live stately states. */
export async function enqueueContent(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
  messageId: string,
) {
  const database = boss.getDb();
  if (!database.beginTransaction)
    throw new Error("Content enqueue requires transactions.");
  // Resolve pg-boss queue metadata before reserving transaction connections.
  // Its lazy queue-cache lookup uses the pool even when send/findJobs receives db.
  await boss.findJobs(MESSAGE_CONTENT_QUEUE, {
    key: `${mailboxId}:${messageId}`,
  });
  const transaction = await database.beginTransaction();
  const key = `${mailboxId}:${messageId}`;
  try {
    await transaction.db.executeSql(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`maildock-content-enqueue:${key}`],
    );
    const jobs = await boss.findJobs(MESSAGE_CONTENT_QUEUE, {
      key,
      db: transaction.db,
    });
    const live = jobs.some((job) =>
      ["created", "retry", "active"].includes(job.state),
    );
    const id = live
      ? null
      : await boss.send(
          MESSAGE_CONTENT_QUEUE,
          { version: 1, accountId, mailboxId, messageId },
          { singletonKey: key, db: transaction.db },
        );
    await transaction.commit();
    return id !== null;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function contentJobState(
  boss: PgBoss,
  mailboxId: string,
  messageId: string,
  pendingSince?: Date,
) {
  const jobs = await boss.findJobs(MESSAGE_CONTENT_QUEUE, {
    key: `${mailboxId}:${messageId}`,
  });
  if (jobs.some((job) => job.state === "active")) return "fetching" as const;
  if (jobs.some((job) => job.state === "retry")) return "retrying" as const;
  if (jobs.some((job) => job.state === "created")) return "pending" as const;
  return jobs.some(
    (job) =>
      !pendingSince || (job.completedOn && job.completedOn >= pendingSince),
  )
    ? ("terminal" as const)
    : ("missing" as const);
}

export class PgBossContentScheduler implements ContentScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-content-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }
  private start() {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureContentQueue(this.boss);
    })();
    return this.started;
  }
  async schedule(accountId: string, mailboxId: string, messageId: string) {
    await this.start();
    return enqueueContent(this.boss, accountId, mailboxId, messageId);
  }
  async state(mailboxId: string, messageId: string, pendingSince?: Date) {
    await this.start();
    return contentJobState(this.boss, mailboxId, messageId, pendingSince);
  }
}

export async function registerContentWorker(
  boss: PgBoss,
  service: MessageContentService,
) {
  await ensureContentQueue(boss);
  await boss.work(
    MESSAGE_CONTENT_QUEUE,
    { localConcurrency: 1, includeMetadata: true },
    safeJobHandler("message-content", async (batch) => {
      const job = batch[0];
      if (!job) throw new Error("Content fetch received an empty batch.");
      const request = payload.parse(job.data);
      const metadata = job as JobWithMetadata;
      await withPerformance(
        "content",
        () =>
          service.run(
            request.accountId,
            request.mailboxId,
            request.messageId,
            metadata.retryCount + 1,
          ),
        metadata.retryCount + 1,
        {
          eligibilityDelayMs: Math.max(
            0,
            metadata.startedOn.valueOf() - metadata.startAfter.valueOf(),
          ),
          originalQueueAgeMs: Math.max(
            0,
            metadata.startedOn.valueOf() - metadata.createdOn.valueOf(),
          ),
        },
      );
    }),
  );
}
