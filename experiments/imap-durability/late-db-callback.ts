import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { fixture, compare } from "./support.js";
const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
  account = "p3-late-db-" + randomUUID();
await fixture(account, 32);
const store = new Store(1);
await store.setup();
const owner = await store.acquire(randomUUID());
assert(owner);
const c = new Coordinator(store, owner),
  events: Record<string, unknown>[] = [];
c.emit = (e) => {
  events.push(e);
};
const result: Record<string, unknown> = {
  stamp,
  storeHash: createHash("sha256")
    .update(await readFile(new URL("store.ts", import.meta.url)))
    .digest("hex"),
};
let releaseOld!: () => void,
  releaseNew!: () => void,
  oldReady!: () => void,
  newReady!: () => void;
const oldBarrier = new Promise<void>((r) => (oldReady = r)),
  newBarrier = new Promise<void>((r) => (newReady = r));
try {
  const old = c
    .turn(account, "history", async (point) => {
      if (point === "after-insertion") {
        oldReady();
        await new Promise<void>((r) => (releaseOld = r));
      }
    })
    .catch((error) => String(error));
  await oldBarrier;
  result.oldOutcome = await old;
  const replacement = c.turn(account, "history", async (point) => {
    if (point === "before-commit") {
      newReady();
      await new Promise<void>((r) => (releaseNew = r));
    }
  });
  await newBarrier;
  releaseOld();
  await new Promise((r) => setTimeout(r, 100));
  releaseNew();
  await replacement;
  const state = await store.state(account),
    rows = await store.placements(account);
  result.observed = { state, count: rows.length };
  assert.equal(
    rows.length,
    32,
    "Late cancelled transaction callback must not roll back a later writer",
  );
  assert.equal(state.history, 1);
  let preparedReady!: () => void,
    releasePrepared!: () => void,
    lazyRejected = false;
  const preparedBarrier = new Promise<void>(
    (resolve) => (preparedReady = resolve),
  );
  const held = store
    .tx(1, performance.now() + 5000, async (sql) => {
      const query = sql`delete from placement where account=${account}`;
      preparedReady();
      await new Promise<void>((resolve) => (releasePrepared = resolve));
      try {
        await query;
      } catch (error) {
        lazyRejected = /Cancelled database transaction scope/.test(
          String(error),
        );
        throw error;
      }
    })
    .catch((error) => String(error));
  await preparedBarrier;
  await held;
  await c.turn(account, "fresh");
  releasePrepared();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    lazyRejected,
    "A prepared query must also be fenced at execution time",
  );
  assert.equal((await store.placements(account)).length, 32);
  result.lazyQueryCallbackRejected = true;
  Object.assign(result, { status: "PASS", ...(await compare(store, account)) });
} catch (error) {
  result.status = "FAIL";
  result.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  releaseOld?.();
  releaseNew?.();
  await c.close();
  await store.close();
  await writeFile(
    new URL(`outputs/${stamp}-late-db-callback.json`, import.meta.url),
    JSON.stringify({ ...result, events }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
