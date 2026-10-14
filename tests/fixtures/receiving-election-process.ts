import { Worker } from "node:worker_threads";
import { ImapFlow } from "imapflow";
import { ReceivingExecutor } from "../../src/shared/infrastructure/database/receiving-executor";
import { ElectedReceivingCoordinator } from "../../src/modules/mail/application/receiving-election";
import type { ProviderConnection } from "../../src/modules/accounts/domain/mail-provider";

const fixture = JSON.parse(process.env.STAGE4B_FIXTURE!) as {
  url: string;
  connection: ProviderConnection;
  leaseMs: number;
};
const executor = new ReceivingExecutor(fixture.url, 1);
const send = (value: unknown) =>
  process.send?.(
    JSON.parse(
      JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
const coordinator = new ElectedReceivingCoordinator({
  executor,
  leaseMs: fixture.leaseMs,
  tuning: { workers: 1 },
  loadAccount: async (_db, candidate) => ({
    ...candidate,
    connection: fixture.connection,
    timing: { pollMs: 1000, operationMs: 3000, retryMs: 100, maxRetryMs: 200 },
    createClient: (options) =>
      new ImapFlow({ ...options, tls: { rejectUnauthorized: false } }),
    onTurn: (kind, turn) => send({ event: "turn", kind, turn }),
    onError: (error) => send({ event: "turnError", error: String(error) }),
  }),
  onAdmission: (admission) => send({ event: "admission", admission }),
});

process.on(
  "message",
  (message: { id: number; command: string; account?: string }) => {
    void (async () => {
      try {
        let result: unknown;
        if (message.command === "freeze") {
          // Deterministic process suspension: a helper thread receives the remote
          // release barrier while the coordinator event loop cannot run timers,
          // socket callbacks or renewals. No fixed suspension sleep.
          const shared = new SharedArrayBuffer(4);
          const flag = new Int32Array(shared);
          const worker = new Worker(
            `
          const { workerData, parentPort } = require('node:worker_threads');
          const net = require('node:net');
          const flag = new Int32Array(workerData);
          const server = net.createServer(socket => {
            socket.once('data', () => { Atomics.store(flag,0,1); Atomics.notify(flag,0); socket.end(); server.close(); });
          });
          server.listen(0,'127.0.0.1', () => parentPort.postMessage(server.address().port));
        `,
            { eval: true, workerData: shared },
          );
          const port = await new Promise<number>((resolve) =>
            worker.once("message", resolve),
          );
          send({ id: message.id, result: port });
          while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
          send({ event: "resumed" });
          return;
        }
        if (message.command === "elect") result = await coordinator.elect();
        else if (message.command === "renew")
          result = await coordinator.renew();
        else if (message.command === "notify")
          await coordinator.notify(message.account!);
        else if (message.command === "stop") {
          await coordinator.stop();
          await executor.stop();
        } else if (message.command !== "snapshot")
          throw new Error("Unknown fixture command");
        send({ id: message.id, result, snapshot: coordinator.snapshot });
      } catch (error) {
        send({ id: message.id, error: String(error) });
      }
    })();
  },
);
send({ event: "ready" });
