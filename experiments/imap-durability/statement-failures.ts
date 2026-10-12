import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { Lane } from "./client.js";
import { fixture, compare } from "./support.js";
import { record } from "../imap-dovecot/model.js";
const account = "p3-sql-fault-" + randomUUID();
await fixture(account, 32);
const actor = await Lane.open(true, "INBOX", account),
  store = new Store();
await store.setup();
const owner = await store.acquire(randomUUID());
assert(owner);
const c = new Coordinator(store, owner),
  result: Record<string, unknown> = { at: new Date().toISOString(), account };
try {
  assert(actor.client.mailbox);
  const before = await store.initialize(
    owner,
    account,
    "INBOX",
    String(actor.epoch.uidValidity),
    actor.client.mailbox.uidNext,
    performance.now() + 2000,
  );
  const rows = (
    await actor.metadata(Array.from({ length: 32 }, (_, i) => i + 1))
  ).map(record);
  const bad = rows.map((row, i) =>
    i === 1 ? { ...row, size: 2147483648 } : row,
  );
  await assert.rejects(
    store.commit(
      owner,
      before,
      "history",
      bad,
      1,
      [],
      performance.now() + 2000,
      () => {},
    ),
    /integer|range/,
  );
  assert.equal((await store.placements(account)).length, 0);
  assert.equal((await store.state(account)).history, 33);
  await assert.rejects(
    store.commit(
      owner,
      before,
      "history",
      rows,
      0,
      [],
      performance.now() + 2000,
      () => {},
    ),
    /check constraint/,
  );
  assert.equal((await store.placements(account)).length, 0);
  assert.equal((await store.state(account)).history, 33);
  // A different mailbox cannot repurpose this account's durable identity.
  await assert.rejects(
    store.initialize(
      owner,
      account,
      "Other",
      String(actor.epoch.uidValidity + 1n),
      1,
      performance.now() + 2000,
    ),
    /one bound mailbox/,
  );
  assert.equal((await store.state(account)).epoch, before.epoch);
  await c.drain(account);
  Object.assign(result, {
    status: "PASS",
    metadataStatementRollback: true,
    frontierStatementRollback: true,
    wrongMailboxRejected: true,
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
    new URL("outputs/statement-failures.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
