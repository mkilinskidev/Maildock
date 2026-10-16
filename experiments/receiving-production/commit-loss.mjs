// Disposable Compose ONLY: actual normal worker, real COMMIT, one lost reply.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getConfig } from "/app/dist-worker/shared/infrastructure/config/config.js";
import { createWorkerDatabase } from "/app/dist-worker/shared/infrastructure/database/database-worker.js";
import { MessageContentService } from "/app/dist-worker/modules/mail/application/message-content-service.js";
const database = createWorkerDatabase(getConfig()),
  db = database.client;
const state = JSON.parse(
  await readFile("/r16-evidence/smoke-state.json", "utf8"),
);
const evidence = { started: new Date().toISOString(), result: "PARTIAL" };
const watchdog = setTimeout(() => process.exit(2), 90_000);
const peer = () => fetch("http://127.0.0.1:1995/").then((r) => r.json());
async function until(check, ms = 20_000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(5);
  }
  throw new Error("Compose COMMIT-loss barrier deadline");
}
const blocker = await db.reserve();
let transaction = false,
  installed = false;
try {
  const [source] =
    await db`select p.message_id,p.mailbox_id from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${state.maildock} and p.uid=2`;
  assert(source);
  const [owner] =
    await db`select owner,generation,expires_at>clock_timestamp() as live from receiving_coordinator where singleton`;
  assert(owner.live && owner.owner);
  evidence.owner = owner;
  evidence.source = source;
  evidence.beforePeer = await peer();
  const [base] =
    await db`select revision,fresh_through,history_before from receiving_mailboxes where mailbox_id=${source.mailbox_id}`;
  evidence.before = base;
  await blocker`select pg_advisory_lock(883116)`;
  // Audit only the target ready publication; claim and fresh repair cannot arm it.
  await db.unsafe(`CREATE TABLE r16_commit_audit(revision bigint,attempt jsonb);
    CREATE FUNCTION r16_commit_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.mailbox_id='${source.mailbox_id}'::uuid AND EXISTS(SELECT FROM message_contents WHERE message_id='${source.message_id}'::uuid AND status='ready') THEN
      INSERT INTO r16_commit_audit SELECT NEW.revision,receiving_attempt FROM message_contents WHERE message_id='${source.message_id}'::uuid;
      PERFORM pg_advisory_xact_lock(883116);
    END IF; RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER zzz_r16_commit_hold AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r16_commit_hold();`);
  installed = true;
  await new MessageContentService(database.db).request(
    state.maildock,
    source.mailbox_id,
    source.message_id,
  );
  evidence.durableDemand = (
    await db`select status,updated_at from message_contents where message_id=${source.message_id}`
  )[0];
  const waiting = await until(
    async () =>
      (
        await db`select pid,query from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
      )[0],
  );
  assert.match(waiting.query, /commit/i);
  evidence.committingBackend = waiting;
  const armed = await fetch("http://127.0.0.1:1996/", {
    method: "POST",
    body: JSON.stringify({ pid: waiting.pid }),
  });
  assert(armed.ok);
  await blocker`select pg_advisory_unlock_all()`;
  const committed = await until(
    async () =>
      (
        await db`select status,receiving_attempt from message_contents where message_id=${source.message_id} and status='ready'`
      )[0],
  );
  evidence.committed = committed;
  evidence.peerAfterCommit = await peer();
  evidence.committedState = (
    await db`select revision,fresh_through,history_before from receiving_mailboxes where mailbox_id=${source.mailbox_id}`
  )[0];
  await blocker`begin`;
  transaction = true;
  await blocker`select * from receiving_mailboxes where mailbox_id=${source.mailbox_id} for update`;
  const [{ pid: blockingPid }] = await blocker`select pg_backend_pid() as pid`;
  evidence.lockedRecovery = await until(
    async () =>
      (
        await db`select pid,query,pg_blocking_pids(pid) as blockers from pg_stat_activity where application_name='maildock-receiving-stage1' and ${blockingPid}::int=any(pg_blocking_pids(pid))`
      )[0],
  );
  evidence.loss = await fetch("http://127.0.0.1:1996/").then((r) => r.json());
  assert.deepEqual(
    evidence.loss.dropped.map((d) => d.tag),
    ["COMMIT", "ReadyForQuery"],
  );
  assert(evidence.loss.dropped.every((d) => d.pid === waiting.pid));
  evidence.peerDuringRecovery = await peer();
  assert.equal(
    evidence.peerDuringRecovery.literalBytes,
    evidence.peerAfterCommit.literalBytes,
  );
  await blocker`commit`;
  transaction = false;
  await until(
    async () =>
      !(
        await db`select pid from pg_stat_activity where pid=${evidence.lockedRecovery.pid}`
      ).length,
  );
  // Remove observation trigger before later legitimate quiet repair revisions.
  await db.unsafe(
    "DROP TRIGGER zzz_r16_commit_hold ON receiving_mailboxes; DROP FUNCTION r16_commit_hold();",
  );
  installed = false;
  const audit = await db`select * from r16_commit_audit order by revision`;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].attempt, committed.receiving_attempt);
  const [after] =
    await db`select status,receiving_attempt from message_contents where message_id=${source.message_id}`;
  assert.deepEqual(after, committed);
  for (const key of ["store", "move", "append", "smtp"])
    assert.equal((await peer())[key], evidence.beforePeer[key]);
  evidence.audit = audit;
  evidence.after = after;
  state.commitLoss = { source, committed, counters: evidence.beforePeer };
  await writeFile(
    "/r16-evidence/smoke-state.json",
    JSON.stringify(state, null, 2),
  );
  evidence.result = "PASS";
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  if (transaction) await blocker`rollback`;
  await blocker`select pg_advisory_unlock_all()`;
  blocker.release();
  if (installed)
    await db.unsafe(
      "DROP TRIGGER IF EXISTS zzz_r16_commit_hold ON receiving_mailboxes; DROP FUNCTION IF EXISTS r16_commit_hold();",
    );
  await writeFile(
    "/r16-evidence/compose-commit-loss.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
  clearTimeout(watchdog);
  await database.client.end({ timeout: 0 });
}
