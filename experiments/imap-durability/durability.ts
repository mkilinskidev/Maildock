import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import {
  child,
  fixture,
  compare,
  expire,
  oracle,
  stopChildren,
  exec,
  compose,
} from "./support.js";
import { Lane } from "./client.js";
const store = new Store(2);
await store.setup();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const events: Record<string, unknown>[] = [],
  cases: Record<string, unknown>[] = [];
const run = async (name: string, work: () => Promise<object>) => {
  try {
    const result = await work();
    cases.push({ name, status: "PASS", ...result });
    console.log(JSON.stringify(cases[cases.length - 1]));
  } catch (error) {
    cases.push({ name, status: "FAIL", error: String((error as Error).stack) });
    throw error;
  }
};
try {
  await run("persistence-smoke", async () => {
    const account = "p3-smoke-" + stamp;
    await fixture(account, 32);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    c.emit = (e) => events.push(e);
    try {
      await c.drain(account);
      return await compare(store, account);
    } finally {
      await c.close();
    }
  });
  const account = "p3-crash-" + stamp;
  await fixture(account, 384);
  const truth = await oracle(account);
  const boundaries = [
    "before-search",
    "after-search",
    "after-fetch",
    "during-insertion",
    "after-insertion",
    "before-frontier",
    "during-frontier",
    "after-commit",
    "before-ack",
    "before-schedule",
  ];
  for (const point of boundaries)
    await run("crash-" + point, async () => {
      await store.sql`delete from placement where account=${account}`;
      await store.sql`delete from mailbox where account=${account}`;
      const w = child({ mode: "turn", account, point }, events);
      await w.until("barrier", point);
      // Independent DB reader while the worker is still stopped at the barrier.
      const state = await store.state(account),
        placements = await store.placements(account);
      const committed = [
        "after-commit",
        "before-ack",
        "before-schedule",
      ].includes(point);
      assert.equal(state.history, committed ? truth.next - 128 : truth.next);
      assert.equal(placements.length, committed ? 128 : 0);
      w.proc.kill("SIGKILL");
      const termination = await w.exited;
      await expire(store);
      const recovery = child({ mode: "drain", account }, events);
      const outcome = await recovery.exited;
      assert.equal(outcome.code, 0, outcome.stderr);
      const result = await compare(store, account);
      return {
        point,
        truthCount: truth.rows.length,
        observedBeforeKill: { state, count: placements.length },
        termination,
        recovery: outcome,
        ...result,
      };
    });
  await run("simultaneous-leadership-renewal-release", async () => {
    const a = child({ mode: "lease", account, ttl: 1500 }, events),
      b = child({ mode: "lease", account, ttl: 1500 }, events);
    await Promise.all([a.until("acquired|denied"), b.until("acquired|denied")]);
    const winners = [a, b].filter((w) =>
      w.received.some((e) => e.event === "acquired"),
    );
    assert.equal(winners.length, 1);
    const loser = [a, b].find((w) => w !== winners[0])!;
    assert(loser.received.some((e) => e.event === "denied"));
    const win = winners[0],
      first = win.received.find((e) => e.event === "acquired")!;
    win.proc.send("renew");
    await win.until("renewed");
    win.proc.send("release");
    assert.equal((await win.exited).code, 0);
    await loser.exited;
    const next = await store.acquire(randomUUID());
    assert(next && next.generation > Number(first.generation));
    await store.release(next);
    return {
      generation: Number(first.generation),
      nextGeneration: next.generation,
      winners: 1,
    };
  });
  await run("expired-fetch-takeover-and-stale-commit", async () => {
    await store.sql`delete from placement where account=${account}`;
    await store.sql`delete from mailbox where account=${account}`;
    const old = child(
      { mode: "turn", account, point: "after-fetch", ttl: 1000 },
      events,
    );
    await old.until("barrier", "after-fetch");
    const [{ pid }] =
      await store.sql`select pid from pg_stat_activity where application_name=${"phase3-" + old.proc.pid} limit 1`;
    await store.sql`select pg_terminate_backend(${pid})`;
    events.push({
      event: "old-db-backend-terminated-imap-remains-open",
      workerPid: old.proc.pid,
      backendPid: pid,
      at: new Date().toISOString(),
    });
    await expire(store);
    const replacement = child({ mode: "drain", account }, events);
    assert.equal((await replacement.exited).code, 0);
    old.proc.send("resume");
    const rejection = await old.until("failure");
    assert.match(String(rejection.error), /fenced/);
    assert.equal((await old.exited).code, 1);
    return {
      oldCallbackRejected: rejection,
      ...(await compare(store, account)),
    };
  });
  await run("lease-expiry-inside-transaction", async () => {
    const owner = await store.acquire(randomUUID(), 200);
    assert(owner);
    const state = await store.state(account);
    await assert.rejects(
      store.commit(
        owner,
        state,
        "fresh",
        [],
        state.fresh,
        [],
        performance.now() + 2000,
        () => {},
        async (point) => {
          if (point === "after-insertion")
            await store.sql`select pg_sleep(0.3)`;
        },
      ),
      /fenced/,
    );
    assert.equal((await store.state(account)).revision, state.revision);
    await store.release(owner);
    return { rolledBack: true };
  });
  await run("remote-rejection-during-takeover", async () => {
    const old = child(
      { mode: "turn", account, point: "after-fetch", ttl: 1000 },
      events,
    );
    await old.until("barrier", "after-fetch");
    const held: Lane[] = [];
    try {
      for (let i = 0; i < 9; i++)
        held.push(await Lane.open(true, "INBOX", account));
      const sessions = (
        await exec("docker", [
          ...compose,
          "exec",
          "-T",
          "dovecot",
          "doveadm",
          "who",
        ])
      ).stdout;
      await expire(store);
      const owner = await store.acquire(randomUUID());
      assert(owner);
      const c = new Coordinator(store, owner);
      c.emit = (e) => events.push(e);
      const before = await store.state(account);
      await assert.rejects(c.turn(account, "fresh"));
      assert.equal((await store.state(account)).revision, before.revision);
      await c.close();
      old.proc.kill("SIGKILL");
      await old.exited;
      for (const lane of held) await lane.close();
      const replacement = child({ mode: "drain", account }, events);
      assert.equal((await replacement.exited).code, 0);
      return {
        remoteSessionsDuringTakeover: sessions,
        replacementInitiallyRejected: true,
        noAuthoritativeCommit: true,
        ...(await compare(store, account)),
      };
    } finally {
      old.proc.kill("SIGKILL");
      for (const lane of held) if (!lane.client.isClosed) lane.client.close();
    }
  });
  await run("expiry-at-COMMIT-server-trigger", async () => {
    const owner = await store.acquire(randomUUID(), 300);
    assert(owner);
    const before = await store.state(account);
    await assert.rejects(
      store.commit(
        owner,
        before,
        "fresh",
        [],
        before.fresh,
        [],
        performance.now() + 2000,
        () => {},
        async (point) => {
          if (point === "before-commit")
            await new Promise((r) => setTimeout(r, 400));
        },
      ),
      /COMMIT authority fenced/,
    );
    assert.equal((await store.state(account)).revision, before.revision);
    await store.release(owner);
    return { lateCommitRejectedInPostgres: true };
  });
  await run("database-total-deadline-and-settlement", async () => {
    const start = performance.now();
    await assert.rejects(
      store.tx(1, start + 200, (sql) => sql`select pg_sleep(2)`),
    );
    const [{ answer }] = await store.sql`select 42 answer`;
    assert.equal(answer, 42);
    return { durationMs: performance.now() - start, nextQuerySucceeded: true };
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  stopChildren();
  await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
  await writeFile(
    new URL(`outputs/${stamp}-durability.json.gz`, import.meta.url),
    gzipSync(JSON.stringify({ started: stamp, cases, events }, null, 2)),
  );
  await writeFile(
    new URL("outputs/durability-summary.json", import.meta.url),
    JSON.stringify({ started: stamp, cases }, null, 2) + "\n",
  );
  await store.close();
}
