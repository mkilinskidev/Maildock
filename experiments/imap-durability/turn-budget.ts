import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Lane } from "./client.js";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { message } from "./fixture.js";
import { compare } from "./support.js";
const account = "p3-turn-budget-" + randomUUID(),
  store = new Store();
await store.setup();
const actor = await Lane.open(true, "INBOX", account);
for (let i = 1; i <= 8; i++) {
  const m = message(i, account),
    data = Buffer.from(
      m.data
        .toString()
        .replace(
          /^Subject:[^\r\n]*\r\n/m,
          "Subject: " + String(i) + "x".repeat(100 * 1024) + "\r\n",
        ),
    );
  await actor.op("APPEND", async (guard) => {
    const r = await actor.client.append("INBOX", data, m.flags);
    guard();
    assert(r && r.uid);
    return r;
  });
}
const owner = await store.acquire(randomUUID());
assert(owner);
const c = new Coordinator(store, owner),
  events: Record<string, unknown>[] = [];
c.emit = (e) => {
  events.push(e);
};
const result: Record<string, unknown> = {
  at: new Date().toISOString(),
  account,
};
try {
  await assert.rejects(
    c.turn(account, "history", async (point) => {
      if (point === "after-search") {
        const lane = c.lanes.get(account)!;
        for (let repeat = 0; repeat < 3; repeat++)
          await lane.metadata([1, 2, 3, 4, 5, 6, 7, 8]);
      }
    }),
    /budget/,
  );
  assert.equal((await store.state(account)).history, 9);
  assert.equal((await store.placements(account)).length, 0);
  const failed = events.find((e) => e.status === "UNRESOLVED")!;
  const operations = failed.transport as {
    metrics: { received: number; rejectedChunk: number; maxChunk: number };
  }[];
  const totalInput = operations.reduce((sum, o) => sum + o.metrics.received, 0);
  assert(totalInput > 2 * 1024 * 1024);
  assert(operations.some((o) => o.metrics.rejectedChunk > 0));
  await c.drain(account);
  Object.assign(result, {
    status: "PASS",
    budget: 2 * 1024 * 1024,
    totalInput,
    receivedOvershoot: totalInput - 2 * 1024 * 1024,
    frontierAdvancedOnFailure: false,
    ...(await compare(store, account)),
  });
} catch (error) {
  result.status = "FAIL";
  result.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  await actor.close();
  await c.close();
  await store.close();
  await writeFile(
    new URL("outputs/turn-budget.json", import.meta.url),
    JSON.stringify({ ...result, events }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
