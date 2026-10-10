import type { Logger } from "pino";
import { observeSyncDelivery } from "./sync-diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { receiveJobRevision } from "./receive-job-policy";
import type { GmailSyncService } from "../application/gmail-sync-service";

export const GMAIL_SYNC_QUEUE = "gmail-account-sync-v1";
const payload = z
  .object({
    version: z.literal(1),
    accountId: z.uuid(),
    accountRevision: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export async function ensureGmailQueue(boss: PgBoss) {
  await boss.createQueue(GMAIL_SYNC_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 180,
  });
}
export async function enqueueGmail(boss: PgBoss, accountId: string) {
  const accountRevision = await receiveJobRevision(boss, accountId);
  const db = boss.getDb();
  await db.executeSql(
    `insert into public.gmail_account_sync_state(account_id,account_revision) values($1,$2) on conflict(account_id) do update set needs_work=true, next_attempt_at=case when gmail_account_sync_state.error_category is null then now() else gmail_account_sync_state.next_attempt_at end`,
    [accountId, accountRevision],
  );
  await ensureGmailQueue(boss);
  return (
    (await boss.send(
      GMAIL_SYNC_QUEUE,
      { version: 1, accountId, accountRevision },
      { singletonKey: accountId, priority: 5 },
    )) !== null
  );
}
export class PgBossGmailScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-gmail-enqueue",
    });
    this.boss.on("error", () => undefined);
  }
  async schedule(accountId: string) {
    this.started ??= this.boss.start().then(() => ensureGmailQueue(this.boss));
    await this.started;
    return enqueueGmail(this.boss, accountId);
  }
}
export class GmailPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private readonly boss: PgBoss) {}
  async start() {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      1000,
    );
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
  private poll() {
    if (this.running) return this.running;
    this.running = (async () => {
      const result = await this.boss
        .getDb()
        .executeSql(
          `select a.id from public.mail_accounts a left join public.gmail_account_sync_state s on s.account_id=a.id where a.receive_transport='gmail' and a.enabled and a.oauth_status='connected' and (s.account_id is null or s.account_revision<>a.work_revision or s.next_attempt_at is null or s.next_attempt_at<=now()) order by s.updated_at nulls first limit 20`,
          [],
        );
      for (const row of result.rows) await enqueueGmail(this.boss, row.id);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
export async function registerGmailWorker(
  boss: PgBoss,
  service: GmailSyncService,
  signal?: AbortSignal,
  logger?: Pick<Logger, "debug">,
) {
  await ensureGmailQueue(boss);
  await boss.work(
    GMAIL_SYNC_QUEUE,
    { localConcurrency: 2, includeMetadata: true },
    safeJobHandler("delta-sync", async (batch) => {
      const request = payload.parse(batch[0]?.data);
      await observeSyncDelivery(
        logger,
        batch[0],
        {
          accountId: request.accountId,
          transport: "gmail",
          phase: "account_sync",
          reason: "unknown",
        },
        () => service.run(request.accountId, request.accountRevision, signal),
      );
    }),
  );
}
