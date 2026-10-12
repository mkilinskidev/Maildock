import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { Store } from "./store.js";
import { Proxy } from "./proxy.js";
import { child, fixture, expire, compare } from "./support.js";
const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
  account = "p3-uncertain-" + stamp;
const store = new Store();
await store.setup();
await fixture(account, 256);
const proxy = new Proxy(35433);
const port = await proxy.listen();
const events: Record<string, unknown>[] = [],
  results: Record<string, unknown> = { started: stamp };
try {
  const w = child(
    {
      mode: "turn",
      account,
      point: "before-commit",
      ttl: 30000,
      url: `postgres://phase3:disposable-phase3-only@127.0.0.1:${port}/phase3`,
    },
    events,
  );
  await w.until("barrier", "before-commit");
  const observed = new Promise<void>(
    (resolve) => (proxy.commitObserved = resolve),
  );
  proxy.dropCommit = true;
  w.proc.send("resume");
  await observed;
  const durable = await store.state(account),
    rows = await store.placements(account);
  assert.equal(durable.history, 129);
  assert.equal(rows.length, 128);
  w.proc.kill("SIGKILL");
  await w.exited;
  await proxy.close();
  await expire(store);
  const fresh = child({ mode: "drain", account }, events);
  assert.equal((await fresh.exited).code, 0);
  Object.assign(results, {
    status: "PASS",
    commitResponseSuppressed: true,
    durableBeforeKill: { state: durable, count: rows.length },
    ...(await compare(store, account)),
  });
  // DB backend loss while the old IMAP transport is still locally open.
  const owner = await store.acquire(randomUUID());
  assert(owner);
  const disconnected = new Store(1);
  const [{ pid }] = await disconnected.sql`select pg_backend_pid() pid`;
  await store.sql`select pg_terminate_backend(${pid})`;
  // A new connection can recover, but generation authority must still be checked.
  await store.release(owner);
  const next = await store.acquire(randomUUID());
  assert(next);
  await assert.rejects(
    disconnected.tx(0, performance.now() + 2000, (sql) =>
      disconnected.fence(sql, owner),
    ),
    /fenced/,
  );
  await store.release(next);
  await disconnected.close();
  results.databaseReconnectStaleFence =
    "PASS (DB backend terminated; IMAP-open partition tested separately)";
} catch (error) {
  results.status = "FAIL";
  results.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  await proxy.close().catch(() => {});
  await store.close();
  await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
  const evidence = JSON.stringify({ ...results, events }, null, 2) + "\n";
  await writeFile(
    new URL(`outputs/${stamp}-commit-uncertainty.json`, import.meta.url),
    evidence,
  );
  await writeFile(
    new URL("outputs/commit-uncertainty.json", import.meta.url),
    evidence,
  );
  console.log(JSON.stringify(results));
}
