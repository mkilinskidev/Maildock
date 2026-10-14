import { PgBoss } from "pg-boss";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { z } from "zod";
import type {
  ReceivingDemand,
  ReceivingWakeTarget,
} from "../application/receiving-demand";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";

export const RECEIVING_WAKE_QUEUE = "receiving-account-wake-v1";
export const receivingWakePayload = z
  .object({ version: z.literal(1), accountId: z.uuid() })
  .strict();

async function ensureReceivingWakeQueue(boss: PgBoss) {
  await boss.createQueue(RECEIVING_WAKE_QUEUE, {
    policy: "stately",
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 60,
  });
}

export async function enqueueReceivingWake(boss: PgBoss, accountId: string) {
  await ensureReceivingWakeQueue(boss);
  return enqueueCoalescedSync(
    boss,
    RECEIVING_WAKE_QUEUE,
    receivingWakePayload.parse({ version: 1, accountId }),
    { singletonKey: accountId, priority: 10 },
  );
}

/** Transport only: R02 callers already committed intent and Stage 4A demand.
 * It must never increment generation or submit a legacy business job. */
export class PgBossReceivingWakeProducer {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-receiving-intent-wake",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }
  async send(accountId: string) {
    this.started ??= this.boss.start().then(() => undefined);
    try {
      await this.started;
    } catch (error) {
      this.started = undefined;
      throw error;
    }
    return enqueueReceivingWake(this.boss, accountId);
  }
}

/** Producer adapter for an already-started JobRuntime. The function call is
 * an independent committed statement BEFORE queue creation/send. Non-INBOX
 * execution still needs Stage 5; caller preserves its legacy business route. */
export async function requestReceivingWake(
  boss: PgBoss,
  accountId: string,
  mailboxId: string,
) {
  const { rows } = await boss
    .getDb()
    .executeSql("select * from maildock_receiving_request($1::uuid,$2::uuid)", [
      accountId,
      mailboxId,
    ]);
  const row = rows[0];
  if (!row?.accepted) return { accepted: false, inbox: false };
  if (row.inbox === true)
    try {
      await enqueueReceivingWake(boss, accountId);
    } catch {
      /* durable due survives */
    }
  return { accepted: true, inbox: row.inbox === true };
}

/** Explicit opt-in delivery registration for isolated harnesses and future
 * elected-owner integration. No scheduler, sockets, progress writes or clearing
 * due state. ACK means notification was handled, even when it was lost locally. */
export async function registerReceivingWakeDelivery(
  boss: PgBoss,
  demand: ReceivingDemand,
  target: ReceivingWakeTarget,
) {
  await ensureReceivingWakeQueue(boss);
  await boss.work(
    RECEIVING_WAKE_QUEUE,
    { localConcurrency: 1 },
    safeJobHandler("receiving-wake", async (batch) => {
      for (const job of batch) {
        const { accountId } = receivingWakePayload.parse(job.data);
        if (await demand.eligible(accountId)) await target.notify(accountId);
      }
    }),
  );
}
