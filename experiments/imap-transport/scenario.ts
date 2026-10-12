import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Transform } from "node:stream";
import type { ImapFlowOptions } from "imapflow";
import {
  fixture,
  header,
  delay,
  until,
  type Handler,
  type Command,
} from "./fixture.js";
import { experiment, scenarios, type Scenario } from "./scenarios.js";

const id = process.argv[2] as Scenario;
assert(scenarios.includes(id), `Unknown scenario ${id}`);
const observations: Record<string, unknown> = {};
const rows: { uid: number; ms: number; bytes?: number }[] = [];
const sourceText = Buffer.from(
  "Zażółć gęślą jaźń — synthetic MIME \r\nSecond line.\r\n".repeat(
    id === "partial-256k" ? 12000 : 4,
  ),
);
const require = createRequire(import.meta.url);
const dependencyRequire = createRequire(
  require.resolve("imapflow/package.json"),
);
const base64 = dependencyRequire("libbase64") as {
  Decoder: new () => Transform;
};
const qp = dependencyRequire("libqp") as {
  Decoder: new () => Transform;
  encode: (value: Buffer) => string;
};
const encoded = Buffer.from(
  id === "partial-qp" ? qp.encode(sourceText) : sourceText.toString("base64"),
);
let fetchNumber = 0;
let pendingFetch: Command | undefined;
let searchNumbers: number[] = [];
let rawLiteralBytesSent = 0;
const options: Partial<ImapFlowOptions> = {};
if (id === "search-line-cap" || id === "mime-byte-cap")
  options.maxLineLength = 1024;
if (id === "header-literal-cap") options.maxLiteralSize = 256 * 1024;
if (id === "partial-256k") {
  options.maxLiteralSize = 256 * 1024;
  options.maxResponseSize = 300 * 1024;
}
if (id === "multi-literal-cap") {
  options.maxLiteralSize = 256 * 1024;
  options.maxResponseSize = 300 * 1024;
}
if (id === "metadata-aggregate" || id === "search-multi-response") {
  options.maxLiteralSize = 256 * 1024;
  options.maxResponseSize = 300 * 1024;
  options.maxLineLength = 300 * 1024;
}
if (
  id === "inactivity-fetch" ||
  id === "trickle-search" ||
  id === "trickle-absolute-10s" ||
  id === "slow-fetch"
)
  options.socketTimeout = 100;

const handler: Handler = (peer, command) => {
  const text = command.command;
  if (peer.id > 1) {
    if (text.startsWith("UID SEARCH")) {
      peer.send("* SEARCH 9\r\n", command);
      peer.ok(command);
      return true;
    }
    if (text.startsWith("UID FETCH")) {
      header(peer, command, 9);
      peer.ok(command);
      return true;
    }
    return false;
  }
  if (id === "reselect-hang" && text === "SELECT Archive") return true;
  if (text.startsWith("UID SEARCH")) {
    if (id === "hang-search" || id === "event-loop-starvation") return true;
    if (id === "trickle-search" || id === "trickle-absolute-10s") {
      const trickle = () => {
        if (peer.socket.destroyed) return;
        peer.send("* OK Still working\r\n", command);
        peer.later(25, trickle);
      };
      trickle();
      return true;
    }
    if (id === "late-network") {
      peer.later(220, () => {
        peer.send("* SEARCH 777\r\n", command);
        peer.ok(command);
      });
      return true;
    }
    searchNumbers =
      id === "search-sparse"
        ? [1, 100000, 1000000000]
        : Array.from(
            { length: id === "search-small" ? 128 : 16384 },
            (_, i) => i + 1,
          );
    if (id === "search-multi-response") {
      for (let i = 0; i < searchNumbers.length; i += 256) {
        peer.send(
          `* SEARCH ${searchNumbers.slice(i, i + 256).join(" ")}\r\n`,
          command,
        );
      }
    } else peer.send(`* SEARCH ${searchNumbers.join(" ")}\r\n`, command);
    peer.later(80, () => peer.ok(command));
    return true;
  }
  if (text === "IDLE" && id === "idle-disconnect") {
    peer.idleTag = command.tag;
    peer.send("+ Idling\r\n", command);
    peer.later(40, () => peer.socket.destroy());
    return true;
  }
  if (text === "DONE") {
    if (id === "idle-hang-done") return true;
    if (id === "done-disconnect") {
      peer.socket.destroy();
      return true;
    }
    if (id === "idle-delayed-done") {
      peer.later(150, () => peer.ok(command));
      return true;
    }
  }
  if (!text.startsWith("UID FETCH")) return false;
  fetchNumber++;
  if (id === "lock-error") {
    peer.ok(command, "NO Synthetic FETCH failure");
    return true;
  }
  if (id === "hang-fetch" || id === "inactivity-fetch" || id === "lock-cancel")
    return true;
  if (id === "disconnect-fetch") {
    header(peer, command, 1);
    peer.later(30, () => peer.socket.destroy());
    return true;
  }
  if (id === "mid-fetch" || id === "slow-fetch") {
    peer.send("* 1 FETCH (UID 1 BODY[HEADER] {4096}\r\n", command);
    if (id === "mid-fetch") {
      peer.send("Subject: unfinished", command);
      return true;
    }
    const trickle = () => {
      if (peer.socket.destroyed) return;
      peer.send("x", command);
      peer.later(25, trickle);
    };
    trickle();
    return true;
  }
  if (id.startsWith("partial-")) {
    const match = /BODY\.PEEK\[1\]<(\d+)\.(\d+)>/.exec(text);
    if (!match) {
      observations.unexpectedPartialCommand = text;
      peer.ok(command, "BAD Unsupported partial fixture command");
      return true;
    }
    const offset = Number(match[1]);
    const length = Number(match[2]);
    const body =
      id === "partial-oversized"
        ? encoded
        : encoded.subarray(offset, offset + length);
    peer.send(
      `* 1 FETCH (UID 1 BODY[1]<${id === "partial-wrong-offset" ? 99 : offset}> {${body.length}}\r\n`,
      command,
    );
    if (id === "partial-interrupted" && fetchNumber === 2) {
      peer.send(body.subarray(0, 2), command);
      peer.socket.destroy();
      return true;
    }
    peer.send(body, command);
    peer.send(")\r\n", command);
    peer.ok(command);
    return true;
  }
  if (id === "mime-depth" || id === "mime-byte-cap" || id === "mime-normal") {
    let tree = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1)';
    for (let i = 0; i < (id === "mime-depth" ? 30 : 8); i++)
      tree = `(${tree} "MIXED")`;
    if (id === "mime-byte-cap")
      tree = `(${tree} "MIXED" ("BOUNDARY" "${"x".repeat(2000)}"))`;
    peer.send(`* 1 FETCH (UID 1 BODYSTRUCTURE ${tree})\r\n`, command);
    peer.ok(command);
    return true;
  }
  if (id === "header-default" || id === "header-literal-cap") {
    const length = 1024 * 1024;
    peer.send(`* 1 FETCH (UID 1 BODY[HEADER] {${length}}\r\n`, command);
    // Give the parser time to reject the declared size BEFORE sending literal bytes.
    peer.later(60, () => {
      if (peer.socket.destroyed) return;
      rawLiteralBytesSent += length;
      peer.send(
        Buffer.from(`Subject: ${"x".repeat(length - 13)}\r\n\r\n`),
        command,
      );
      peer.send(")\r\n", command);
      peer.ok(command);
    });
    return true;
  }
  if (id === "multi-literal-cap") {
    peer.send("* 1 FETCH (UID 1 BODY[HEADER] {204800}\r\n", command);
    peer.send(Buffer.alloc(204800, "x"), command);
    rawLiteralBytesSent += 204800;
    peer.send(" BODY[1] {204800}\r\n", command);
    peer.later(60, () => {
      if (peer.socket.destroyed) return;
      peer.send(Buffer.alloc(204800, "y"), command);
      rawLiteralBytesSent += 204800;
      peer.send(")\r\n", command);
      peer.ok(command);
    });
    return true;
  }
  if (id === "metadata-aggregate") {
    for (let uid = 1; uid <= 16; uid++)
      header(peer, command, uid, Buffer.alloc(160 * 1024, "x"));
    peer.ok(command);
    return true;
  }
  if (
    id === "fetch-break" ||
    id === "fetch-paused" ||
    id === "buffered-after-close"
  ) {
    pendingFetch = command;
    for (let uid = 1; uid <= 3; uid++) header(peer, command, uid);
    if (id !== "fetch-paused") peer.later(150, () => peer.ok(command));
    return true;
  }
  for (let uid = 1; uid <= (id === "fetch-incomplete" ? 2 : 3); uid++)
    header(peer, command, uid);
  peer.later(80, () => peer.ok(command));
  return true;
};

const f = await fixture(handler, options);
const histogram = monitorEventLoopDelay({ resolution: 5 });
histogram.enable();
let baseline = process.memoryUsage();
let peakRss = baseline.rss,
  peakHeap = baseline.heapUsed,
  peakExternal = baseline.external;
const sample = () => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
  peakExternal = Math.max(peakExternal, m.external);
};
const sampler = setInterval(sample, 2);
const startUtc = new Date().toISOString();
let operationStart = 0;
let operationEnd = 0;
let abortAt: number | null = null;
let outcome = "not-started";
let error: { message: string; code?: string } | null = null;
let failure: string | null = null;
const client = await f.connect();
observations.runtimeEntry = import.meta.resolve("imapflow");
baseline = process.memoryUsage();
peakRss = baseline.rss;
peakHeap = baseline.heapUsed;
peakExternal = baseline.external;
histogram.reset();
observations.operationStartUtc = new Date().toISOString();
const runtimeClient = client as unknown as {
  currentLock: unknown;
  streamer: { literalBuffer: Buffer[]; lineBuffer: Buffer[] };
  socket: unknown;
};
function markSettlement(value: string) {
  operationEnd = f.now();
  outcome = value;
  sample();
}
function recordError(e: unknown) {
  const value = e as Error & { code?: string };
  error = { message: value.message, code: value.code };
  markSettlement("rejected");
}
async function recover() {
  const fresh = await f.connect();
  const result = await fresh.search({ uid: "9" }, { uid: true });
  assert.deepEqual(result, [9]);
  observations.freshConnectionWorks = true;
}
async function deadline<T>(promise: Promise<T>, ms = 220) {
  // close the actual transport; do not race and abandon a live operation.
  const armedAt = f.now();
  observations.watchdogMs = ms;
  const watchdog = setTimeout(() => {
    abortAt = f.now();
    observations.watchdogLatenessMs = abortAt - armedAt - ms;
    observations.parserBufferedAtAbort = runtimeClient.streamer
      ? {
          literal: runtimeClient.streamer.literalBuffer.reduce(
            (sum, b) => sum + b.length,
            0,
          ),
          line: runtimeClient.streamer.lineBuffer.reduce(
            (sum, b) => sum + b.length,
            0,
          ),
        }
      : null;
    client.close();
  }, ms);
  if (id === "event-loop-starvation") {
    const blockedUntil = performance.now() + 180;
    while (performance.now() < blockedUntil) {
      /* Deliberate synchronous stall of timers. */
    }
  }
  try {
    const value = await promise;
    markSettlement(value === false ? "false" : "resolved");
    return value;
  } catch (e) {
    recordError(e);
    return undefined;
  } finally {
    clearTimeout(watchdog);
  }
}
try {
  operationStart = f.now();
  if (id.startsWith("search-")) {
    const interval =
      id === "search-small" || id === "search-out-of-range"
        ? "1:128"
        : id === "search-sparse"
          ? "1:1000000000"
          : "1:16384";
    observations.requestedRange = interval;
    const result = await deadline(
      client.search({ uid: interval }, { uid: true }),
    );
    observations.returnedCount = Array.isArray(result) ? result.length : null;
    if (id === "search-line-cap") assert.equal(result, false);
    else {
      assert.deepEqual(result, searchNumbers);
      observations.outOfRangeAccepted =
        id === "search-out-of-range" &&
        Array.isArray(result) &&
        result.some((uid) => uid > 128);
      const command = f.commands.find((c) =>
        c.command.startsWith("UID SEARCH"),
      )!;
      assert(command.taggedMs !== null && operationEnd >= command.taggedMs);
    }
  } else if (id === "fetch-complete" || id === "fetch-incomplete") {
    const lock = await client.getMailboxLock("INBOX");
    for await (const row of client.fetch(
      "1:3",
      { headers: true },
      { uid: true },
    ))
      rows.push({ uid: row.uid, ms: f.now(), bytes: row.headers?.length });
    markSettlement("resolved");
    assert.equal(rows.length, id === "fetch-incomplete" ? 2 : 3);
    observations.lockHeldAfterIteration = !!runtimeClient.currentLock;
    const queued = client.getMailboxLock("INBOX");
    let acquired = false;
    const tracked = queued.then((value) => {
      acquired = true;
      return value;
    });
    await client.noop();
    observations.nextCommandWorksWithHeldLock = true;
    assert.equal(acquired, false);
    observations.lockReleaseMs = f.now();
    lock.release();
    (await tracked).release();
  } else if (
    id === "fetch-break" ||
    id === "fetch-paused" ||
    id === "buffered-after-close"
  ) {
    const iterator = client.fetch("1:3", { headers: true }, { uid: true });
    const first = await iterator.next();
    assert(!first.done);
    rows.push({ uid: first.value.uid, ms: f.now() });
    let nextDone = false;
    if (id === "fetch-break") {
      await iterator.return();
      observations.iteratorReturnMs = f.now();
      const next = client.noop().then(() => {
        nextDone = true;
      });
      await delay(40);
      assert.equal(nextDone, false);
      await next;
      markSettlement("resolved");
      assert(pendingFetch!.taggedMs! >= Number(observations.iteratorReturnMs));
      observations.nextCommandAfterTagged = true;
    } else if (id === "fetch-paused") {
      const next = client.noop().then(() => {
        nextDone = true;
      });
      await delay(40);
      assert.equal(nextDone, false);
      f.peers[0].ok(pendingFetch!);
      await delay(30);
      assert.equal(nextDone, false);
      observations.taggedSentWhileConsumerPaused = true;
      await iterator.return();
      await next;
      markSettlement("resolved");
    } else {
      abortAt = f.now();
      client.close();
      try {
        await iterator.next();
        assert.fail("Buffered data accepted after close");
      } catch (e) {
        recordError(e);
      }
      await iterator.return();
      observations.bufferedRowsAcceptedAfterClose = 0;
      await recover();
      await delay(170);
    }
  } else if (id.startsWith("idle-") || id === "done-disconnect") {
    const idle = client.idle();
    await until(() => f.commands.some((c) => c.command === "IDLE"));
    await delay(10);
    if (id === "idle-disconnect") {
      await deadline(idle);
    } else {
      const next = deadline(
        client.noop(),
        id === "idle-delayed-done" ? 500 : 220,
      );
      await next;
      await idle;
      const done = f.commands.find((c) => c.command === "DONE")!;
      const noop = f.commands.find((c) => c.command === "NOOP");
      observations.noopSent = !!noop;
      if (id === "idle-delayed-done") {
        assert(noop && done.taggedMs !== null && noop.startMs >= done.taggedMs);
      } else assert.equal(noop, undefined);
    }
    await recover();
  } else if (id === "late-callback") {
    let active = { id: 1, valid: true };
    const original = active;
    let accepted = 0,
      rejected = 0;
    const old = (async () => {
      const data = await client.fetchAll(
        "1:3",
        { headers: true },
        { uid: true },
      );
      observations.oldResultBufferedCount = data.length;
      await delay(120);
      if (active === original && original.valid) accepted++;
      else rejected++;
    })();
    await until(() => observations.oldResultBufferedCount === 3);
    original.valid = false;
    abortAt = f.now();
    client.close();
    active = { id: 2, valid: true };
    await recover();
    await old;
    markSettlement("resolved");
    assert.equal(accepted, 0);
    assert.equal(rejected, 1);
    observations.applicationFenceRejected = rejected;
    observations.unfencedCallbackWouldPublish = true;
  } else if (
    id.startsWith("header-") ||
    id.startsWith("multi-literal") ||
    id.startsWith("mime-") ||
    id === "metadata-aggregate"
  ) {
    const result = await deadline(
      client.fetchAll(
        id === "metadata-aggregate" ? "1:16" : "1",
        {
          headers: !id.startsWith("mime-"),
          bodyStructure: id.startsWith("mime-"),
        },
        { uid: true },
      ),
      1000,
    );
    observations.returnedCount = result?.length ?? null;
    observations.returnedHeaderBytes =
      result?.reduce((sum, row) => sum + (row.headers?.length ?? 0), 0) ?? 0;
    observations.rawLiteralBytesSent = rawLiteralBytesSent;
    if (id === "mime-normal") {
      assert.equal(result?.length, 1);
      assert(result[0].bodyStructure?.childNodes?.length);
      observations.mimeTreeReturned = true;
    } else if (id === "header-default") {
      assert.equal(result?.[0].headers?.length, 1024 * 1024);
    } else if (id === "metadata-aggregate") {
      assert.equal(result?.length, 16);
      assert(Number(observations.returnedHeaderBytes) > 2 * 1024 * 1024);
    } else if (id === "mime-depth") {
      assert.deepEqual(result, []);
      observations.deepStructureSilentlyOmitted = true;
      assert(f.events.some((event) => event.event === "library-diagnostic"));
    } else {
      assert.equal(result, undefined);
      assert(error);
    }
    if (id === "header-literal-cap") assert.equal(rawLiteralBytesSent, 0);
    if (id === "multi-literal-cap") assert.equal(rawLiteralBytesSent, 204800);
    if (outcome !== "resolved") await recover();
  } else if (id.startsWith("partial-")) {
    const decoder =
      id === "partial-qp" ? new qp.Decoder() : new base64.Decoder();
    const decoded: Buffer[] = [];
    const raw: Buffer[] = [];
    decoder.on("data", (chunk: Buffer) => decoded.push(chunk));
    let offset = 0,
      complete = false;
    const sliceSize = id === "partial-256k" ? 256 * 1024 : 7;
    observations.sliceSize = sliceSize;
    try {
      while (offset <= encoded.length) {
        const row = await client.fetchOne(
          "1",
          { bodyParts: [{ key: "1", start: offset, maxLength: sliceSize }] },
          { uid: true },
        );
        assert(row);
        const chunk = row.bodyParts!.get("1")!;
        assert(chunk);
        rows.push({ uid: row.uid, ms: f.now(), bytes: chunk.length });
        if (id === "partial-oversized") {
          observations.libraryReturnedOversizedChunk = chunk.length;
          assert(chunk.length > 7);
          break;
        }
        if (id === "partial-wrong-offset") {
          observations.wrongOffsetAcceptedWithoutOrigin = true;
          assert.equal(chunk.length, 7);
          assert.deepEqual(chunk, encoded.subarray(0, 7));
          break;
        }
        assert(chunk.length <= sliceSize);
        assert.deepEqual(chunk, encoded.subarray(offset, offset + sliceSize));
        raw.push(chunk);
        decoder.write(chunk);
        offset += chunk.length;
        await client.noop(); // real intervening command proves each slice yields.
        if (chunk.length < sliceSize) {
          complete = true;
          break;
        }
      }
      markSettlement("resolved");
    } catch (e) {
      recordError(e);
    }
    observations.complete = complete;
    observations.rawBytes = offset;
    if (complete) {
      const finished = new Promise<void>((resolve, reject) => {
        decoder.once("end", resolve);
        decoder.once("error", reject);
      });
      decoder.end();
      await finished;
      assert.deepEqual(Buffer.concat(raw), encoded);
      assert.deepEqual(Buffer.concat(decoded), sourceText);
      observations.decodedSha256 = createHash("sha256")
        .update(Buffer.concat(decoded))
        .digest("hex");
      if (id === "partial-base64")
        observations.independentSliceDecodeCorrect = Buffer.concat(
          raw.map((chunk) => Buffer.from(chunk.toString(), "base64")),
        ).equals(sourceText);
    } else {
      decoder.destroy();
      if (id === "partial-interrupted") {
        assert(error);
        assert.equal(offset, 7);
        await recover();
      } else
        assert(
          ["partial-oversized", "partial-wrong-offset"].includes(id),
          "Unexpected incomplete progressive download",
        );
    }
  } else if (id.startsWith("lock-")) {
    const lock = await client.getMailboxLock("INBOX");
    let secondAcquired = false;
    const second = client.getMailboxLock("INBOX").then(
      (value) => {
        secondAcquired = true;
        return value;
      },
      (e) => {
        observations.pendingLockError = (e as { code?: string }).code;
        return null;
      },
    );
    try {
      const result = await deadline(
        client.fetchAll("1:3", { headers: true }, { uid: true }),
      );
      if (id === "lock-multiple") {
        assert.equal(result?.length, 3);
        await client.noop();
        await delay(20);
        assert.equal(secondAcquired, false);
        observations.lockSpansCommands = true;
      } else if (id === "lock-error") {
        assert(error);
        assert(runtimeClient.currentLock);
        await client.noop();
        assert.equal(secondAcquired, false);
        observations.lockRetainedAfterCommandError = true;
      } else {
        assert(error);
        assert.equal(runtimeClient.currentLock, false);
        await recover();
      }
    } finally {
      observations.lockReleaseMs = f.now();
      lock.release();
    }
    const secondLock = await second;
    if (secondLock) secondLock.release();
    if (id === "lock-cancel") assert.equal(secondLock, null);
  } else {
    const operation =
      id === "reselect-hang"
        ? client.mailboxOpen("Archive")
        : [
              "hang-search",
              "trickle-search",
              "trickle-absolute-10s",
              "late-network",
              "event-loop-starvation",
            ].includes(id)
          ? client.search({ uid: "1:128" }, { uid: true })
          : client.fetchAll("1:3", { headers: true }, { uid: true });
    const limit =
      id === "trickle-absolute-10s"
        ? 10000
        : id === "event-loop-starvation"
          ? 50
          : id === "late-network"
            ? 80
            : id === "trickle-search" || id === "slow-fetch"
              ? 350
              : 220;
    const result = await deadline<unknown>(operation, limit);
    assert(result === false || result === undefined);
    if (["trickle-search", "trickle-absolute-10s", "slow-fetch"].includes(id)) {
      assert(abortAt !== null);
      observations.inactivityDidNotBoundDuration =
        operationEnd - operationStart > 250;
    }
    if (id === "event-loop-starvation") {
      assert(Number(observations.watchdogLatenessMs) > 100);
    }
    if (id === "inactivity-fetch") assert.equal(abortAt, null);
    await until(() =>
      f.events.some(
        (event) => event.event === "server-close" && event.connection === 1,
      ),
    );
    await recover();
    if (id === "late-network") {
      await delay(250);
      assert(f.events.some((event) => event.event === "late-write-discarded"));
      observations.staleNetworkAccepted = false;
    }
  }
  if (!client.isClosed) {
    await client.noop();
    observations.sameConnectionWorks = true;
  }
} catch (e) {
  failure = (e as Error).stack ?? String(e);
} finally {
  const cleanupStart = f.now();
  for (const value of f.clients) value.close();
  await until(() =>
    f.peers.every((peer) =>
      f.events.some(
        (event) =>
          event.event === "server-close" && event.connection === peer.id,
      ),
    ),
  ).catch((e) => {
    failure ??= String(e);
  });
  observations.cleanupStartMs = cleanupStart;
  await f.cleanup();
  sample();
  clearInterval(sampler);
  histogram.disable();
}
const close = (name: string) =>
  f.events.find((event) => event.event === name && event.connection === 1)
    ?.ms ?? null;
const tagged = f.commands.filter(
  (c) => c.connection === 1 && /^(UID SEARCH|UID FETCH|DONE)/.test(c.command),
);
process.stdout.write(
  JSON.stringify({
    id,
    experiment: experiment(id),
    assertionStatus: failure ? "FAIL" : "PASS",
    failure,
    startUtc,
    endUtc: new Date().toISOString(),
    operationStartMs: operationStart,
    operationEndMs: operationEnd,
    operationDurationMs: operationEnd - operationStart,
    outcome,
    error,
    abortMs: abortAt,
    nativeSocketCloseMs: close("native-socket-close"),
    serverCloseMs: close("server-close"),
    abortToNativeCloseMs:
      abortAt === null || close("native-socket-close") === null
        ? null
        : close("native-socket-close")! - abortAt,
    bytesReceived: f.events
      .filter(
        (e) =>
          e.event === "received" &&
          e.connection === 1 &&
          e.ms >= operationStart &&
          e.ms <= operationEnd,
      )
      .reduce((sum, e) => sum + Number(e.detail), 0),
    taggedCompletionMs: tagged.map((c) => ({
      command: c.command,
      ms: c.taggedMs,
    })),
    baselineMemory: baseline,
    peakRss,
    peakHeap,
    peakExternal,
    rssIncrease: peakRss - baseline.rss,
    heapIncrease: peakHeap - baseline.heapUsed,
    eventLoopDelayMaxMs: histogram.max / 1e6,
    eventLoopDelayP99Ms: histogram.percentile(99) / 1e6,
    observations,
    rows,
    commands: f.commands,
    events: f.events,
  }) + "\n",
);
if (failure) process.exitCode = 1;
