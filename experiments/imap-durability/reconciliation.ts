import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { Lane } from "./client.js";
import {
  fixture,
  oracle,
  compare,
  child,
  expire,
  stopChildren,
} from "./support.js";
import { message } from "./fixture.js";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const events: Record<string, unknown>[] = [],
  cases: Record<string, unknown>[] = [];
const store = new Store(2);
await store.setup();
const run = async (name: string, work: () => Promise<object>) => {
  try {
    cases.push({ name, status: "PASS", ...(await work()) });
    console.log(JSON.stringify(cases[cases.length - 1]));
  } catch (error) {
    cases.push({ name, status: "FAIL", error: String((error as Error).stack) });
    throw error;
  }
};
try {
  await run("search-fetch-missing-sparse-and-wake-CAS", async () => {
    const account = "p3-reconcile-" + stamp;
    await fixture(account, 384);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    c.emit = (e) => events.push(e);
    const actor = await Lane.open(true, "INBOX", account);
    try {
      await assert.rejects(
        c.turn(account, "history", async (point) => {
          if (point === "after-search")
            await actor.op("DELETE", async (guard) => {
              await actor.client.messageDelete([300], { uid: true });
              guard();
            });
        }),
        /incomplete/,
      );
      assert.equal((await store.state(account)).history, 385);
      assert.equal((await store.placements(account)).length, 0);
      await c.drain(account);
      await actor.op("DELETE", async (guard) => {
        await actor.client.messageDelete([1, 9, 127, 128, 129], { uid: true });
        guard();
      });
      const a = await actor.op("APPEND", async (guard) => {
        const r = await actor.client.append(
          "INBOX",
          message(1, "equal-count-" + stamp).data,
        );
        guard();
        assert(r && r.uid);
        return r;
      });
      const before = await store.state(account),
        stale = (await store.placements(account)).find((r) => r.uid === 1)!;
      await c.turn(account, "fresh", async (point) => {
        if (point === "after-fetch") await store.due(account);
      });
      const [due] =
        await store.sql`select fresh_due<=clock_timestamp() due from mailbox where account=${account}`;
      assert(due.due, "Late wake must remain due");
      await c.repair(account);
      await assert.rejects(
        store.commit(
          owner,
          before,
          "history",
          [stale],
          before.history,
          [],
          performance.now() + 2000,
          () => {},
        ),
        /revision fenced/,
      );
      assert(!(await store.placements(account)).some((r) => r.uid === 1));
      await actor.op("FLAGS", async (guard) => {
        await actor.client.messageFlagsSet([2, 3], ["\\Seen", "\\Flagged"], {
          uid: true,
        });
        guard();
      });
      await c.repair(account);
      return {
        omittedFetchAdvanced: false,
        staleResurrectionAccepted: false,
        lateWakeRetained: true,
        newUid: Number(a.uid),
        ...(await compare(store, account)),
      };
    } finally {
      await actor.close();
      await c.close();
    }
  });
  await run("persistent-oversized-UID-exposed-without-skip", async () => {
    const account = "p3-poison-" + stamp;
    await fixture(account, 1);
    const actor = await Lane.open(true, "INBOX", account);
    const huge = Buffer.from(
      "From: fixture@example.invalid\r\nTo: fixture@example.invalid\r\nMessage-ID: <poison-" +
        stamp +
        "@maildock.invalid>\r\nSubject: " +
        "x".repeat(300 * 1024) +
        "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nPoison fixture\r\n",
    );
    await actor.op("APPEND", async (guard) => {
      const r = await actor.client.append("INBOX", huge);
      guard();
      assert(r && r.uid);
      return r;
    });
    await actor.op("APPEND", async (guard) => {
      await actor.client.append("INBOX", message(3, account).data);
      guard();
    });
    assert.deepEqual(await actor.search(1, 3), [1, 2, 3]);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    c.emit = (e) => {
      events.push(e);
    };
    try {
      for (let retry = 0; retry < 2; retry++) {
        await assert.rejects(
          c.turn(account, "history"),
          /parser-limit|budget|LiteralTooLarge/,
        );
        assert.equal((await store.state(account)).history, 4);
        assert.equal((await store.placements(account)).length, 0);
      }
      const unresolved = {
        history: (await store.state(account)).history,
        stillPresent: await actor.search(2, 2),
      };
      await actor.op("DELETE", async (guard) => {
        await actor.client.messageDelete([2], { uid: true });
        guard();
      });
      await c.drain(account);
      return {
        expectedUnresolved: true,
        unresolved,
        skipped: false,
        ...(await compare(store, account)),
      };
    } finally {
      await actor.close();
      await c.close();
    }
  });
  await run("equal-count-delete-plus-arrival", async () => {
    const account = "p3-equal-" + stamp;
    await fixture(account, 128);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    c.emit = (e) => events.push(e);
    const actor = await Lane.open(true, "INBOX", account);
    try {
      await c.drain(account);
      await actor.op("DELETE", async (guard) => {
        await actor.client.messageDelete([1], { uid: true });
        guard();
      });
      await actor.op("APPEND", async (guard) => {
        await actor.client.append("INBOX", message(1, "equal-" + stamp).data);
        guard();
      });
      await c.turn(account, "fresh");
      await c.repair(account);
      const r = await compare(store, account);
      assert.equal(r.identities, 128);
      return r;
    } finally {
      await actor.close();
      await c.close();
    }
  });
  await run("uidvalidity-reset-buffered-old-fetch", async () => {
    const account = "p3-epoch-" + stamp,
      path = "Epoch";
    await fixture(account, 128, path);
    const firstOwner = await store.acquire(randomUUID());
    assert(firstOwner);
    const first = new Coordinator(store, firstOwner);
    await first.drain(account, path);
    await first.close();
    const old = child(
      {
        mode: "turn",
        kind: "repair",
        account,
        path,
        point: "after-fetch",
        ttl: 1500,
      },
      events,
    );
    await old.until("barrier", "after-fetch");
    const before = await store.state(account),
      oldRows = (await oracle(account, path)).rows;
    const actor = await Lane.open(true, "INBOX", account);
    await actor.op("DELETE MAILBOX", async (guard) => {
      assert(await actor.client.mailboxDelete(path));
      guard();
    });
    await new Promise((r) => setTimeout(r, 1100));
    await actor.op("CREATE MAILBOX", async (guard) => {
      assert(await actor.client.mailboxCreate(path));
      guard();
    });
    await actor.op("APPEND", async (guard) => {
      await actor.client.append(path, message(1, "new-epoch-" + stamp).data);
      guard();
    });
    await actor.close();
    await expire(store);
    const replacement = child({ mode: "drain", account, path }, events);
    assert.equal((await replacement.exited).code, 0);
    const current = await store.state(account);
    assert.notEqual(before.epoch, current.epoch);
    const [{ count }] =
      await store.sql`select count(*) count from placement where account=${account} and epoch=${before.epoch}`;
    assert.equal(
      Number(count),
      128,
      "Old physical rows hidden by active epoch",
    );
    old.proc.send("resume");
    const failure = await old.until("failure");
    assert.equal((await old.exited).code, 1);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    await assert.rejects(
      store.commit(
        owner,
        before,
        "history",
        oldRows.slice(0, 128),
        1,
        [],
        performance.now() + 2000,
        () => {},
      ),
      /Epoch/,
    );
    await store.release(owner);
    return {
      beforeEpoch: before.epoch,
      afterEpoch: current.epoch,
      oldCallbackRejected: failure,
      ...(await compare(store, account, path)),
    };
  });
  await run("restart-during-membership-reconciliation", async () => {
    const account = "p3-repair-crash-" + stamp;
    await fixture(account, 384);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    await c.drain(account);
    await c.close();
    const actor = await Lane.open(true, "INBOX", account);
    await actor.op("DELETE", async (guard) => {
      await actor.client.messageDelete([1, 2, 3, 200], { uid: true });
      guard();
    });
    await actor.close();
    const w = child(
      { mode: "turn", kind: "repair", account, point: "during-frontier" },
      events,
    );
    await w.until("barrier", "during-frontier");
    assert.equal((await store.state(account)).reconcile, 0);
    assert.equal((await store.placements(account)).length, 384);
    w.proc.kill("SIGKILL");
    await w.exited;
    await expire(store);
    const replacementOwner = await store.acquire(randomUUID());
    assert(replacementOwner);
    const replacement = new Coordinator(store, replacementOwner);
    replacement.emit = (e) => events.push(e);
    try {
      await replacement.repair(account);
      return await compare(store, account);
    } finally {
      await replacement.close();
    }
  });
  await run("15000-deletions-with-independent-new-arrivals", async () => {
    const account = "p3-load-0";
    const remote = await oracle(account);
    assert(remote.rows.length >= 50000);
    const owner = await store.acquire(randomUUID());
    assert(owner);
    const c = new Coordinator(store, owner);
    c.emit = (e) => events.push(e);
    const actor = await Lane.open(true, "INBOX", account);
    const targets = remote.rows.slice(0, 15000).map((r) => r.uid),
      arrivals: { uid: number; completed: number; available?: number }[] = [];
    const publications = new Map<number, number>();
    const start = performance.now();
    try {
      await c.drain(account);
      const deletion = (async () => {
        for (let i = 0; i < targets.length; i += 128) {
          await actor.op("DELETE", async (guard) => {
            await actor.client.messageDelete(targets.slice(i, i + 128), {
              uid: true,
            });
            guard();
          });
          if (i === 1280)
            for (let j = 1; j <= 10; j++) {
              const r = await actor.op("APPEND", async (guard) => {
                const r = await actor.client.append(
                  "INBOX",
                  message(j, "deletions-" + stamp).data,
                );
                guard();
                assert(r && r.uid);
                return r;
              });
              arrivals.push({
                uid: Number(r.uid),
                completed: performance.now(),
              });
            }
        }
      })();
      deletion.catch(() => {});
      for (let pass = 0; pass < 2; pass++) {
        await store.sql`update mailbox set reconcile=0 where account=${account}`;
        do {
          try {
            await c.turn(account, "repair");
          } catch (error) {
            events.push({ event: "repair-retry", error: String(error) });
            continue;
          }
          await c.turn(account, "fresh");
          const state = await store.state(account);
          for (const a of arrivals)
            if (a.uid <= state.fresh && !publications.has(a.uid))
              publications.set(a.uid, performance.now());
        } while ((await store.state(account)).reconcile !== 0);
        await deletion;
      }
      await c.turn(account, "fresh");
      for (const a of arrivals) {
        a.available = publications.get(a.uid);
        assert(a.available);
      }
      return {
        deletions: targets.length,
        durationMs: performance.now() - start,
        arrivals,
        worstArrivalMs: Math.max(
          ...arrivals.map((a) => a.available! - a.completed),
        ),
        ...(await compare(store, account)),
      };
    } finally {
      await actor.close();
      await c.close();
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  stopChildren();
  await store.close();
  await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
  await writeFile(
    new URL(`outputs/${stamp}-reconciliation.json.gz`, import.meta.url),
    gzipSync(JSON.stringify({ stamp, cases, events }, null, 2)),
  );
  await writeFile(
    new URL("outputs/reconciliation-summary.json", import.meta.url),
    JSON.stringify({ stamp, cases }, null, 2) + "\n",
  );
}
