import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { Proxy } from "./proxy.js";
import { Store } from "./store.js";
const proxy = new Proxy(35433);
const port = await proxy.listen();
proxy.hold = true;
const store = new Store(
    1,
    `postgres://phase3:disposable-phase3-only@127.0.0.1:${port}/phase3`,
  ),
  result: Record<string, unknown> = { started: new Date().toISOString() };
try {
  const start = performance.now();
  await assert.rejects(store.tx(1, start + 200, (sql) => sql`select 1`));
  result.deadlineMs = performance.now() - start;
  proxy.hold = false;
  proxy.reset();
  const [{ answer }] = await store.tx(
    1,
    performance.now() + 2000,
    (sql) => sql`select 42 answer`,
  );
  assert.equal(answer, 42);
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  await store.close();
  await proxy.close();
  await writeFile(
    new URL("outputs/db-startup-deadline.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
