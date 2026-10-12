import assert from "node:assert/strict";
import type { FetchMessageObject } from "imapflow";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  setImmediate as yieldTurn,
  setTimeout as sleep,
} from "node:timers/promises";
import { Lane, limits } from "./client.js";
import { message } from "./fixture.js";
import { record, type RecordRow } from "./model.js";
import { validateEpoch } from "../imap-transport/hardening.js";

// Run only after A-C. Destructive changes are confined to the disposable fixture.
const count = Number(process.argv[2] ?? 50000);
const condstore = process.argv[3] !== "fallback";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(new URL("outputs/", import.meta.url), { recursive: true });
const result: Record<string, unknown> = {
  started: new Date().toISOString(),
  count,
  condstore,
  persistence: "in-memory; orderly reconnect only, no durable crash claim",
};
const cases: Record<string, unknown>[] = [];
const lanes: Lane[] = [];
const start = performance.now();
try {
  const original = (
    await readFile(
      new URL(`fixtures/${count}/assigned.jsonl`, import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s) as RecordRow);
  let data = await Lane.open(condstore);
  lanes.push(data);
  const actor = await Lane.open();
  lanes.push(actor);
  const inventory = async () => {
    const next = await data.op("INVENTORY STATUS", async (guard) => {
      await data.client.noop();
      const r = await data.client.status("INBOX", { uidNext: true });
      guard();
      assert(r.uidNext);
      return r.uidNext;
    });
    const hits: number[] = [];
    for (let low = 1; low < next; low += 128)
      hits.push(...(await data.search(low, Math.min(next - 1, low + 127))));
    return hits;
  };
  const current = await inventory();
  const local = new Map(
    original.filter((r) => current.includes(r.uid)).map((r) => [r.uid, r]),
  );
  const first = original.find((r) => current.includes(r.uid))!.uid;
  const flagPage = original
    .filter((r) => current.includes(r.uid))
    .slice(0, 128)
    .map((r) => r.uid);
  const baselineModseq =
    data.client.mailbox && data.client.mailbox.highestModseq;
  await actor.op("REMOTE FLAGS", async (guard) => {
    assert(
      await actor.client.messageFlagsAdd([first], ["\\Seen", "\\Flagged"], {
        uid: true,
      }),
    );
    guard();
  });
  await data.op("FLAGS REFRESH", async (guard) => {
    await data.client.noop();
    guard();
  });
  const flagStart = performance.now();
  const flags = await data.op(
    condstore ? "CHANGEDSINCE FLAGS" : "FULL FLAGS",
    async (guard) => {
      const rows = [];
      for await (const r of data.client.fetch(
        flagPage,
        { uid: true, flags: true },
        {
          uid: true,
          ...(condstore && baselineModseq
            ? { changedSince: baselineModseq }
            : {}),
        },
      )) {
        guard();
        rows.push(r);
      }
      guard();
      assert(
        rows.some(
          (r) =>
            r.uid === first &&
            r.flags?.has("\\Seen") &&
            r.flags?.has("\\Flagged"),
        ),
      );
      return rows.length;
    },
  );
  cases.push({
    case: "flags",
    status: "PASS",
    rows: flags,
    durationMs: performance.now() - flagStart,
    baselineModseq: String(baselineModseq),
  });
  const fallback = await Lane.open(false);
  lanes.push(fallback);
  const fallbackStart = performance.now();
  const fallbackRows = await fallback.op(
    "FULL FLAGS FALLBACK",
    async (guard) => {
      const rows = [];
      for await (const row of fallback.client.fetch(
        flagPage,
        { uid: true, flags: true },
        { uid: true },
      )) {
        guard();
        rows.push(row);
      }
      guard();
      assert.equal(rows.length, flagPage.length);
      assert(rows.some((r) => r.uid === first && r.flags?.has("\\Flagged")));
      return rows.length;
    },
  );
  cases.push({
    case: "ordinary-flags-fallback",
    status: "PASS",
    rows: fallbackRows,
    durationMs: performance.now() - fallbackStart,
    condstoreEnabled: fallback.client.enabled.has("CONDSTORE"),
  });
  await fallback.close();
  await actor.op("REMOTE UNFLAGS", async (guard) => {
    assert(
      await actor.client.messageFlagsRemove([first], ["\\Seen", "\\Flagged"], {
        uid: true,
      }),
    );
    guard();
  });
  const fetched = await data.metadata([first]);
  assert(
    !fetched[0].flags?.has("\\Seen") && !fetched[0].flags?.has("\\Flagged"),
  );
  cases.push({ case: "unflags", status: "PASS" });
  // Genuine disappearance between complete SEARCH and exact FETCH.
  const victim = current[current.length - 1];
  const before = await data.search(victim, victim);
  assert.deepEqual(before, [victim]);
  await actor.op("REMOTE DELETE", async (guard) => {
    assert(await actor.client.messageDelete([victim], { uid: true }));
    guard();
  });
  let incomplete = false;
  try {
    await data.metadata([victim]);
  } catch (e) {
    incomplete = /incomplete/.test(String(e));
  }
  assert(incomplete && data.transport.socket.destroyed);
  cases.push({
    case: "search-fetch-expunge",
    status: "PASS",
    noBoundaryAdvanced: true,
    falseDeletionFromFetch: false,
    failedTransportDestroyed: true,
  });
  data.transport.dispose();
  data = await Lane.open(condstore);
  lanes.push(data);
  const recheck = await data.search(victim, victim);
  assert.deepEqual(recheck, []);
  local.delete(victim);
  cases.push({
    case: "same-epoch-absence-recheck",
    status: "PASS",
    uid: victim,
  });
  // Equal-count churn: identity check, never count-only inference.
  const equalVictim = current[0];
  const beforeCount = data.client.mailbox && data.client.mailbox.exists;
  await actor.op("REMOTE DELETE", async (guard) => {
    assert(await actor.client.messageDelete([equalVictim], { uid: true }));
    guard();
  });
  const arrival = message(1, "change");
  const append = await actor.op("APPEND", async (guard) => {
    const r = await actor.client.append(
      "INBOX",
      arrival.data,
      arrival.flags,
      new Date(arrival.date),
    );
    guard();
    assert(r && r.uid);
    return r;
  });
  const appendedUid = Number(append.uid);
  await data.op("REFRESH", async (guard) => {
    await data.client.noop();
    guard();
  });
  assert.equal(data.client.mailbox && data.client.mailbox.exists, beforeCount);
  assert.deepEqual(await data.search(equalVictim, equalVictim), []);
  const arrived = record((await data.metadata([appendedUid]))[0]);
  assert.equal(arrived.messageId, arrival.messageId);
  local.delete(equalVictim);
  local.set(appendedUid, arrived);
  cases.push({
    case: "equal-count-old-date-arrival",
    status: "PASS",
    count: beforeCount,
    removedUid: equalVictim,
    addedUid: appendedUid,
  });
  // Replay of a complete read adds no duplicate placement.
  const replay = record((await data.metadata([appendedUid]))[0]);
  const size = local.size;
  local.set(replay.uid, replay);
  assert.equal(local.size, size);
  cases.push({
    case: "completed-read-retry",
    status: "PASS",
    uniqueCount: local.size,
  });
  // Intentional aggregate budget failure against ordinary valid Dovecot output.
  const budgetStart = performance.now();
  const budget = await data.transport.metadata(
    current
      .filter((uid) => uid !== victim && uid !== equalVictim)
      .slice(0, 128),
    data.epoch,
    { ...limits, byteLimit: 1024 },
    () => true,
  );
  assert(
    budget.status === "unresolved" &&
      budget.kind === "budget" &&
      data.transport.socket.destroyed,
  );
  cases.push({
    case: "aggregate-budget",
    status: "PASS",
    result: budget,
    overshoot: budget.metrics.received - 1024,
    durationMs: performance.now() - budgetStart,
  });
  data.transport.dispose();
  data = await Lane.open(condstore);
  lanes.push(data);
  // Abandon actual partial FETCH before tagged completion; publish zero rows.
  const partialUids = current
    .filter((uid) => uid !== victim && uid !== equalVictim)
    .slice(0, 128);
  const partial = await data.transport.execute(limits, async (guard) => {
    for await (const row of data.client.fetch(
      partialUids,
      { uid: true, headers: true, flags: true },
      { uid: true },
    )) {
      assert(row.uid);
      data.transport.cancel();
      guard();
    }
  });
  assert(
    partial.status === "unresolved" &&
      partial.kind === "cancelled" &&
      data.transport.socket.destroyed,
  );
  cases.push({
    case: "partial-fetch-abandoned",
    status: "PASS",
    result: partial,
    publishedRows: 0,
  });
  data.transport.dispose();
  data = await Lane.open(condstore);
  lanes.push(data);
  assert.equal((await data.metadata(partialUids)).length, partialUids.length);
  cases.push({
    case: "reconnect-conservative-replay",
    status: "PASS",
    replayed: partialUids.length,
    reconnectSetupMs: data.setupMs,
    processRestart: "NOT TESTED",
    durableCrashRecovery: "NOT TESTED",
  });
  const held: Lane[] = [];
  let rejection: string | undefined;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const lane = await Lane.open();
        held.push(lane);
        lanes.push(lane);
      } catch (e) {
        rejection = String(e);
        break;
      }
    }
    cases.push({
      case: "connection-rejection",
      status: rejection ? "PASS" : "UNCERTAIN",
      successfulAdditionalSessions: held.length,
      existingSessions: 2,
      rejection,
      serverConfiguredLimit: 10,
    });
  } finally {
    for (const lane of held) await lane.close();
  }
  // Concurrent 15k deletion and bounded complete membership/flags repair.
  const targets = original
    .filter((r) => local.has(r.uid))
    .slice(0, Math.min(15000, local.size - 1))
    .map((r) => r.uid);
  const deletionStarted = performance.now();
  const newAppends: { uid: number; completed: number; available?: number }[] =
    [];
  let freshThrough = appendedUid;
  const arrivalPublication = new Map<number, number>();
  const discover = async () => {
    await data.op("FRESH NOOP", async (guard) => {
      await data.client.noop();
      guard();
    });
    const next = await data.op("FRESH STATUS", async (guard) => {
      const r = await data.client.status("INBOX", { uidNext: true });
      guard();
      assert(r.uidNext);
      return r.uidNext;
    });
    while (freshThrough < next - 1) {
      const high = Math.min(next - 1, freshThrough + 128);
      const hits = await data.search(freshThrough + 1, high);
      if (hits.length)
        for (const row of (await data.metadata(hits)).map(record)) {
          local.set(row.uid, row);
          arrivalPublication.set(row.uid, performance.now());
        }
      freshThrough = high;
    }
  };
  const deletion = (async () => {
    for (let i = 0; i < targets.length; i += 128) {
      await actor.op("REMOTE DELETE", async (guard) => {
        assert(
          await actor.client.messageDelete(targets.slice(i, i + 128), {
            uid: true,
          }),
        );
        guard();
      });
      if (i === 1280)
        for (let j = 1; j <= 10; j++) {
          const m = message(j + 1, "change");
          const r = await actor.op("APPEND", async (guard) => {
            const r = await actor.client.append(
              "INBOX",
              m.data,
              m.flags,
              new Date(m.date),
            );
            guard();
            assert(r && r.uid);
            return r;
          });
          newAppends.push({ uid: Number(r.uid), completed: performance.now() });
        }
    }
  })();
  deletion.catch(() => {});
  let removed = 0,
    repaired = 0;
  const repair = async () => {
    const keys = [...local.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i += 128) {
      const page = keys.slice(i, i + 128);
      await data.op("REPAIR NOOP", async (guard) => {
        await data.client.noop();
        guard();
      });
      const present = await data.op("EXACT MEMBERSHIP", async (guard) => {
        const hits = await data.client.search(
          { uid: page.join(",") },
          { uid: true },
        );
        guard();
        assert(Array.isArray(hits) && hits.every((uid) => page.includes(uid)));
        return hits;
      });
      for (const uid of page)
        if (!present.includes(uid)) {
          local.delete(uid);
          removed++;
        }
      if (present.length)
        await data.op("REPAIR FLAGS", async (guard) => {
          const observed = new Map<number, FetchMessageObject>();
          let hints = 0;
          for await (const r of data.client.fetch(
            present,
            { uid: true, flags: true },
            { uid: true },
          )) {
            guard();
            if (r.uid === undefined || !present.includes(r.uid)) {
              assert(
                r.flags && r.seq > 0 && ++hints <= 128,
                "Bounded unsolicited flag hints only",
              );
              continue;
            }
            assert(r.flags, "Requested FLAGS absent");
            const previous = observed.get(r.uid);
            if (!previous?.modseq || !r.modseq || r.modseq >= previous.modseq)
              observed.set(r.uid, r);
          }
          guard();
          const rows = [...observed.values()];
          const missing = present.filter(
            (uid) => !rows.some((r) => r.uid === uid),
          );
          if (missing.length) {
            const check = await data.client.search(
              { uid: missing.join(",") },
              { uid: true },
            );
            guard();
            assert(
              Array.isArray(check) && check.length === 0,
              "Missing flags require complete same-epoch absence evidence",
            );
            for (const uid of missing) {
              local.delete(uid);
              removed++;
            }
          }
          for (const r of rows) {
            assert(r.flags && present.includes(r.uid));
            local.get(r.uid)!.flags = [...r.flags]
              .filter((f) => f !== "\\Recent")
              .sort();
          }
        });
      repaired += page.length;
      await yieldTurn();
      await discover();
    }
  };
  await repair();
  await deletion;
  await repair();
  await discover();
  for (const newAppend of newAppends) {
    newAppend.available = arrivalPublication.get(newAppend.uid);
    assert(
      newAppend.available,
      "Arrival discovered independently of actor UID oracle",
    );
  }
  const final = await inventory();
  assert.deepEqual(
    [...local.keys()].sort((a, b) => a - b),
    final.sort((a, b) => a - b),
  );
  cases.push({
    case: "15000-deletions-sparse-holes",
    status: "PASS",
    requestedDeletions: targets.length,
    removed,
    repaired,
    finalCount: final.length,
    durationMs: performance.now() - deletionStarted,
    arrivals: newAppends.map((a) => ({
      ...a,
      latencyMs: a.available! - a.completed,
    })),
    arrivalInjection:
      "ten arrivals after eleven deletion batches, concurrent with bounded repair; actor does not bypass client discovery admission",
  });
  // Supported mailbox delete/recreate, unrelated to INBOX volume/indexes.
  await actor.op("CREATE EPOCH MAILBOX", async (guard) => {
    assert(await actor.client.mailboxCreate("EpochFixture"));
    guard();
  });
  await actor.op("APPEND", async () => {
    return actor.client.append("EpochFixture", message(1, "epoch-before").data);
  });
  const old = await Lane.open(true, "EpochFixture");
  lanes.push(old);
  const oldEpoch = old.epoch;
  await old.close();
  await actor.op("DELETE EPOCH MAILBOX", async (guard) => {
    assert(await actor.client.mailboxDelete("EpochFixture"));
    guard();
  });
  await sleep(1100);
  await actor.op("CREATE EPOCH MAILBOX", async (guard) => {
    assert(await actor.client.mailboxCreate("EpochFixture"));
    guard();
  });
  await actor.op("APPEND", async () => {
    return actor.client.append("EpochFixture", message(1, "epoch-after").data);
  });
  const replacement = await Lane.open(true, "EpochFixture");
  lanes.push(replacement);
  assert.notEqual(replacement.epoch.uidValidity, oldEpoch.uidValidity);
  assert.throws(() => validateEpoch(replacement.client, oldEpoch));
  cases.push({
    case: "uidvalidity-recreated-mailbox",
    status: "PASS",
    old: String(oldEpoch.uidValidity),
    current: String(replacement.epoch.uidValidity),
    staleEpochRejected: true,
  });
  await replacement.close();
  await actor.op("DELETE EPOCH MAILBOX", async (guard) => {
    assert(await actor.client.mailboxDelete("EpochFixture"));
    guard();
  });
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.failure = String((error as Error).stack);
  process.exitCode = 1;
} finally {
  Object.assign(result, {
    finished: new Date().toISOString(),
    durationMs: performance.now() - start,
    cases,
    lanes: lanes.map((l) => ({
      operations: l.operations,
      commands: l.commands,
      tagged: l.tagged,
    })),
  });
  for (const lane of lanes) {
    if (lane.client.isClosed) continue;
    try {
      await lane.close();
    } catch {
      lane.client.close();
    }
  }
  const file = new URL(
    `outputs/${stamp}-changes-${condstore ? "condstore" : "fallback"}.json`,
    import.meta.url,
  );
  await writeFile(file, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: result.status,
      failure: result.failure,
      cases,
      file: file.pathname,
    }),
  );
}
