import { PgBoss } from "pg-boss";
import { createDatabase } from "../../src/shared/infrastructure/database/database";
import { ReceivingDemand } from "../../src/modules/mail/application/receiving-demand";
import { registerReceivingWakeDelivery } from "../../src/modules/mail/infrastructure/receiving-wake-jobs";
import { ReceivingExecutor } from "../../src/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "../../src/modules/mail/application/receiving-persistence";

// Disposable fixture only. Parent kills this process at the durable barrier.
const fixture = JSON.parse(process.env.STAGE4A_FIXTURE!) as {
  url: string;
  account: string;
  mailbox: string;
  mode: "due" | "metadata";
  actor: string;
  generation: string;
};
const database = createDatabase({
  databaseUrl: fixture.url,
  databasePoolSize: 1,
});
const demand = new ReceivingDemand(database.db, async () => {
  throw new Error("Wake must not be sent before crash");
});
const park = async () => {
  process.send?.("committed");
  await new Promise<void>(() => {
    setInterval(() => {}, 1000);
  });
};
if (fixture.mode === "due") {
  await demand.record(fixture.account, fixture.mailbox);
  await park();
} else {
  const boss = new PgBoss({ connectionString: fixture.url });
  boss.on("error", () => {});
  await boss.start();
  const exec = new ReceivingExecutor(fixture.url, 1);
  const persistence = new ReceivingPersistence(exec);
  await registerReceivingWakeDelivery(boss, demand, {
    notify: async () => {
      await persistence.persist(
        { actor: fixture.actor, generation: BigInt(fixture.generation) },
        fixture.mailbox,
        {
          epoch: 7n,
          revision: 0n,
          freshThrough: 1n,
          historyBefore: 2n,
          reconcileAfter: 0n,
        },
        {
          kind: "fresh",
          evidence: {
            complete: true,
            epoch: 7n,
            low: 2n,
            high: 2n,
            searched: [2n],
            confirmedAbsent: [],
          },
          metadata: [
            {
              uid: "2",
              modseq: "1",
              internalDate: "2026-10-14T00:00:00Z",
              size: "10",
              flags: [],
              hasAttachments: false,
              envelope: {
                messageId: "<stage4a@example.test>",
                subject: "Fixture",
                from: [],
                sender: [],
                replyTo: [],
                to: [],
                cc: [],
                bcc: [],
              },
            },
          ],
        },
        { deadline: performance.now() + 5000 },
      );
      await park(); // pg-boss handler has not returned/ACKed.
    },
  });
}
