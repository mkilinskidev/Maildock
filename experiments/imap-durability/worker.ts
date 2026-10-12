import { Store, databaseUrl } from "./store.js";
import { Coordinator, type Kind } from "./coordinator.js";
import { randomUUID } from "node:crypto";
const config = JSON.parse(process.argv[2]) as {
  mode: string;
  account: string;
  path?: string;
  point?: string;
  ttl?: number;
  kind?: Kind;
  owner?: { owner: string; generation: number };
  url?: string;
};
const store = new Store(1, config.url ?? databaseUrl);
let coordinator: Coordinator | undefined;
const send = (value: object) => process.send?.(value);
process.on("disconnect", () => process.exit(2));
try {
  const owner =
    config.owner ?? (await store.acquire(randomUUID(), config.ttl ?? 2000));
  if (!owner) {
    send({ event: "denied", pid: process.pid });
  } else {
    send({ event: "acquired", pid: process.pid, ...owner });
    coordinator = new Coordinator(store, owner);
    coordinator.leaseTtl = config.ttl ?? 2000;
    coordinator.emit = (e) => send({ event: "operation", ...e });
    if (config.mode === "lease") {
      send({ event: "barrier", point: "lease-held", pid: process.pid });
      const command = await new Promise<string>((resolve) =>
        process.once("message", (m) => resolve(String(m))),
      );
      if (command === "renew") {
        await store.renew(owner, config.ttl ?? 2000);
        send({ event: "renewed" });
        await new Promise<void>((resolve) =>
          process.once("message", () => resolve()),
        );
      }
    } else if (config.mode === "drain")
      await coordinator.drain(config.account, config.path);
    else
      await coordinator.turn(
        config.account,
        config.kind ?? "history",
        async (point) => {
          if (point === config.point) {
            send({ event: "barrier", point, pid: process.pid });
            await new Promise<void>((resolve) =>
              process.once("message", () => resolve()),
            );
          }
        },
        config.path,
      );
    send({ event: "completed", pid: process.pid });
  }
} catch (error) {
  send({ event: "failure", error: String(error), pid: process.pid });
  process.exitCode = 1;
} finally {
  await coordinator?.close();
  await store.close();
  process.removeAllListeners("disconnect");
  process.disconnect?.();
}
