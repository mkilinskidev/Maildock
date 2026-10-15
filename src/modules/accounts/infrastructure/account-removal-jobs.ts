import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AccountsService } from "../application/accounts-service";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";

const queue = "account-removal-v1";

/** Existing account rows are the durable source; queue delivery is only a hint. */
export async function registerAccountRemovalWorker(
  boss: PgBoss,
  accounts: AccountsService,
) {
  await boss.createQueue(queue, {
    retryLimit: 4,
    retryDelay: 5,
    expireInSeconds: 60,
  });
  await boss.work(
    queue,
    { localConcurrency: 1 },
    safeJobHandler("account-removal", async (batch) => {
      const { accountId } = z
        .object({ accountId: z.uuid() })
        .strict()
        .parse(batch[0]?.data);
      // Yield after a bounded number of independently committed transactions.
      // Remaining terminal rows are rediscovered by the scheduled repair job.
      for (let turn = 0; turn < 16; turn++) {
        if ((await accounts.cleanupRemoval(accountId)) < 0) break;
      }
    }),
  );
  const repairQueue = "account-removal-repair-v1";
  await boss.createQueue(repairQueue, { retryLimit: 2, expireInSeconds: 60 });
  const repair = () =>
    accounts.repairRemovals((accountId) =>
      boss.send(queue, { accountId }, { singletonKey: accountId }),
    );
  await boss.work(repairQueue, safeJobHandler("account-removal", repair));
  await boss.schedule(repairQueue, "* * * * *");
  await repair();
}
