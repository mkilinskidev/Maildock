import { createLogger } from "../../../shared/infrastructure/logging/logger";
import { logFailure } from "../../../shared/infrastructure/logging/diagnostics";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import type { MessageCommandService } from "../application/message-command-service";
import { commandBusyDelaySeconds } from "../application/inbox-first-policy";
import {
  enqueueDeduplicated,
  ensureHeartbeatQueue,
} from "./deduplicated-enqueue";
import { MailboxBusyError } from "./mailbox-lock";

export const MESSAGE_COMMAND_QUEUE = "message-command-v1";
export async function ensureMessageCommandQueue(boss: PgBoss) {
  await ensureHeartbeatQueue(boss, MESSAGE_COMMAND_QUEUE, {
    retryLimit: 4,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 900,
  });
}
const commandPayload = z
  .object({
    commandId: z.uuid(),
    deferrals: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * The single producer path for command jobs (API, poller, busy continuation).
 *
 * - "request": any queued or active job suppresses the send (a dead worker's
 *   job leaves `active` through the pg-boss heartbeat, see deduplicated-enqueue);
 * - "continue": called by the command's own active job, so only a queued
 *   (created/retry) job counts; at most one successor exists.
 */
export function enqueueMessageCommand(
  boss: PgBoss,
  id: string,
  options: {
    mode?: "request" | "continue";
    startAfter?: number;
    deferrals?: number;
  } = {},
): Promise<boolean> {
  return enqueueDeduplicated(
    boss,
    MESSAGE_COMMAND_QUEUE,
    { commandId: id },
    {
      commandId: id,
      ...(options.deferrals ? { deferrals: options.deferrals } : {}),
    },
    {
      singletonKey: id,
      ignoreActive: options.mode === "continue",
      ...(options.startAfter === undefined
        ? {}
        : { startAfter: options.startAfter }),
    },
  );
}
export class PgBossMessageCommandScheduler {
  private readonly boss: PgBoss;
  private started?: Promise<void>;
  constructor(config: Pick<AppConfig, "databaseUrl">) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      application_name: "maildock-web-command-enqueue",
    });
    this.boss.on("error", (error) =>
      logFailure(createLogger({ logLevel: "info" }), error, "jobs", "runtime"),
    );
  }
  async enqueue(id: string) {
    this.started ??= (async () => {
      await this.boss.start();
      await ensureMessageCommandQueue(this.boss);
    })();
    await this.started;
    await enqueueMessageCommand(this.boss, id);
  }
}
export async function registerMessageCommandWorker(
  boss: PgBoss,
  service: MessageCommandService,
  withLock: (mailboxId: string, work: () => Promise<void>) => Promise<void>,
) {
  await ensureMessageCommandQueue(boss);
  await boss.work(
    MESSAGE_COMMAND_QUEUE,
    { localConcurrency: 4 },
    safeJobHandler("message-command", async (batch) => {
      const { commandId, deferrals = 0 } = commandPayload.parse(batch[0]?.data);
      const mailboxId = await service.mailboxId(commandId);
      if (!mailboxId) return;
      let started = false;
      try {
        await withLock(mailboxId, async () => {
          started = true;
          await service.run(commandId);
        });
      } catch (error) {
        // Busy before run() started is not an operation failure: attempts and
        // pg-boss retry are untouched. The lock is already released, so no
        // connection or worker slot waits; one short, jittered successor
        // continues the same durable command. A failed send throws, which
        // falls back to the normal pg-boss retry (work is never dropped).
        if (started || !(error instanceof MailboxBusyError)) throw error;
        await enqueueMessageCommand(boss, commandId, {
          mode: "continue",
          startAfter: commandBusyDelaySeconds(deferrals),
          deferrals: deferrals + 1,
        });
      }
    }),
  );
}
export class MessageCommandPoller {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly boss: PgBoss,
    private readonly service: MessageCommandService,
  ) {}
  async start() {
    await this.poll();
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      30_000,
    );
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  private async poll() {
    // Same producer path as the API: queued/retry/active jobs are not duplicated.
    for (const id of await this.service.pendingIds())
      await enqueueMessageCommand(this.boss, id).catch(() => undefined);
  }
}
