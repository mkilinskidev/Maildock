import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import type { Transform } from "node:stream";
import { ImapFlow } from "imapflow";
import { fixture, delay, until, type Handler } from "./fixture.js";
import { TransportExperiment, classify, type Outcome } from "./hardening.js";
import { hardeningCases, type HardeningCase } from "./hardening-cases.js";

const id = process.argv[2] as HardeningCase;
assert(hardeningCases.includes(id));
assert.notEqual(
  process.env.IMAP_EXPERIMENT_PLAINTEXT,
  "1",
  "Hardening requires TLS profile",
);
const epoch = { path: "INBOX", uidValidity: 7n };
const limits = { timeoutMs: 180, byteLimit: 2 * 1024 * 1024 };
let adapter: TransportExperiment | undefined;
const diagnostics: { message?: string; code?: string }[] = [];
const capture = (entry: { msg?: string; err?: Error & { code?: string } }) => {
  if (entry.err)
    diagnostics.push({ message: entry.err.message, code: entry.err.code });
  adapter?.diagnostic(entry);
};
const source = Buffer.from("Zażółć gęślą jaźń = synthetic\r\n".repeat(3));
const require = createRequire(import.meta.url);
const dep = createRequire(require.resolve("imapflow/package.json"));
const base64 = dep("libbase64") as { Decoder: new () => Transform };
const qp = dep("libqp") as {
  Decoder: new () => Transform;
  encode: (b: Buffer) => string;
};
const encoded = Buffer.from(
  id === "slice-qp" ? qp.encode(source) : source.toString("base64"),
);
let fetches = 0;
const handler: Handler = (peer, command) => {
  const text = command.command;
  if (id === "authentication" && text.startsWith("LOGIN ")) {
    peer.ok(command, "NO [AUTHENTICATIONFAILED] Synthetic failure");
    return true;
  }
  if (peer.id > 1 && text.startsWith("UID SEARCH")) {
    peer.send("* SEARCH 9\r\n", command);
    peer.ok(command);
    return true;
  }
  if (id === "deadline-preparation" && text === "SELECT Archive") return true;
  if (id === "deadline-done" && text === "DONE") return true;
  if (text.startsWith("UID STORE")) return true; // received mutation, deliberately lost outcome
  if (text.startsWith("UID SEARCH")) {
    if (id === "search-invalid-number") {
      peer.send("* SEARCH 1e2\r\n", command);
      peer.ok(command);
      return true;
    }
    if (id === "search-esearch-rejected") {
      peer.send("* ESEARCH UID ALL 1:4294967295\r\n", command);
      peer.ok(command);
      return true;
    }
    if (
      [
        "deadline-search",
        "deadline-preparation",
        "deadline-starvation",
        "late-callback",
      ].includes(id)
    )
      return true;
    if (id.startsWith("search-trickle")) {
      const send = () => {
        if (peer.socket.destroyed) return;
        peer.send("* OK Still processing\r\n", command);
        peer.later(8, send);
      };
      send();
      return true;
    }
    const hits =
      id === "search-sparse"
        ? [1, 100000, 1000000000]
        : Array.from(
            {
              length:
                id === "search-large" ||
                id === "search-wire-budget" ||
                id === "search-parsed-overshoot"
                  ? 16384
                  : id === "search-range"
                    ? 129
                    : id === "search-identity-budget"
                      ? 129
                      : 128,
            },
            (_, i) => i + 1,
          );
    if (id === "search-multiple" || id === "search-identity-budget") {
      hits.forEach((uid, index) =>
        peer.later(index, () => peer.send(`* SEARCH ${uid}\r\n`, command)),
      );
      peer.later(140, () => peer.ok(command));
    } else {
      peer.send(`* SEARCH ${hits.join(" ")}\r\n`, command);
      peer.later(15, () => peer.ok(command));
    }
    return true;
  }
  if (!text.startsWith("UID FETCH")) return false;
  fetches++;
  if (["metadata-stall", "cancel-fetch", "socket-timeout"].includes(id))
    return true;
  if (id === "metadata-tagged-no") {
    peer.ok(command, "NO Synthetic rejection");
    return true;
  }
  if (id.startsWith("slice-") || id === "raw-wrong-origin") {
    const match = /BODY\.PEEK\[1\]<(\d+)\.(\d+)>/.exec(text);
    assert(match, `Actual partial request missing: ${text}`);
    const offset = Number(match[1]);
    const length = Number(match[2]);
    let bytes = encoded.subarray(offset, offset + length);
    if (id === "slice-oversized")
      bytes = encoded.subarray(offset, offset + length + 1);
    if (id === "slice-truncated") bytes = bytes.subarray(0, bytes.length - 1);
    const origin = ["slice-wrong-origin", "raw-wrong-origin"].includes(id)
      ? 99
      : offset;
    peer.send(
      `* 1 FETCH (UID 1 BODY[1]<${origin}> {${bytes.length}}\r\n`,
      command,
    );
    if (
      id === "slice-disconnect" ||
      (id === "slice-restart" && peer.id === 1 && fetches === 2)
    ) {
      peer.send(bytes.subarray(0, 2), command);
      peer.later(5, () => peer.socket.destroy());
      return true;
    }
    peer.send(bytes, command);
    if (id === "slice-extra") peer.send(" BODY[2]<0> {1}\r\nx", command);
    peer.send(")\r\n", command);
    peer.later(2, () => peer.ok(command));
    return true;
  }
  if (id === "metadata-literal-limit") {
    peer.send("* 1 FETCH (UID 1 BODY[HEADER] {262145}\r\n", command);
    return true;
  }
  if (id === "metadata-malformed") {
    peer.send("* 1 FETCH (UID 1 BODY[HEADER]<abc> {2}\r\nxx)\r\n", command);
    peer.ok(command);
    return true;
  }
  if (id === "metadata-lenient-syntax") {
    peer.send("* 1 FETCH (UID 1 FLAGS (\\Seen) BODY[HEADER] [)\r\n", command);
    peer.ok(command);
    return true;
  }
  const count =
    id === "metadata-aggregate" ? 16 : id === "metadata-missing" ? 2 : 3;
  for (let index = 1; index <= count; index++) {
    const uid =
      id === "metadata-duplicate" && index === 3
        ? 2
        : id === "metadata-unexpected" && index === 3
          ? 99
          : index;
    let structure = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 20 1)';
    if (id === "metadata-depth" && index === 3)
      for (let i = 0; i < 30; i++) structure = `(${structure} "MIXED")`;
    const body =
      id === "metadata-aggregate"
        ? Buffer.alloc(160 * 1024, 65)
        : Buffer.from("Subject: synthetic\r\n\r\n");
    peer.send(
      `* ${index} FETCH (UID ${uid} FLAGS (\\Seen) RFC822.SIZE 20 BODYSTRUCTURE ${structure} BODY[HEADER] {${body.length}}\r\n`,
      command,
    );
    peer.send(body, command);
    peer.send(")\r\n", command);
  }
  peer.later(15, () => peer.ok(command));
  return true;
};

const start = performance.now();
const lag = monitorEventLoopDelay({ resolution: 5 });
lag.enable();
const before = process.memoryUsage();
let peak = before;
const sampler = setInterval(() => {
  const current = process.memoryUsage();
  peak = {
    rss: Math.max(peak.rss, current.rss),
    heapUsed: Math.max(peak.heapUsed, current.heapUsed),
    heapTotal: Math.max(peak.heapTotal, current.heapTotal),
    external: Math.max(peak.external, current.external),
    arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers),
  };
}, 2);
let evidence: unknown;
let failure: string | undefined;
let f: Awaited<ReturnType<typeof fixture>> | undefined;
const operations: Outcome<unknown>[] = [];
let guarantee: "proved-profile" | "unsafe-reproduced" = "proved-profile";
try {
  if (id === "connection-refused") {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address === "object");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: address.port,
      secure: true,
      logger: false,
      connectionTimeout: 200,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      assert.fail("Connection unexpectedly succeeded");
    } catch (error) {
      assert.equal(classify(error), "connection");
      evidence = {
        kind: classify(error),
        code: (error as { code?: string }).code,
      };
    } finally {
      client.close();
    }
  } else {
    f = await fixture(
      handler,
      {
        maxLineLength: id === "search-large" ? 1024 : 300 * 1024,
        maxLiteralSize: 256 * 1024,
        maxResponseSize: 300 * 1024,
        socketTimeout: id === "socket-timeout" ? 60 : 2000,
        logger: {
          debug() {},
          trace() {},
          info() {},
          warn: capture,
          error: capture,
          fatal: capture,
        },
        ...(id === "authentication"
          ? { auth: { user: "synthetic", pass: "synthetic" } }
          : {}),
      },
      id === "authentication" ? "OK" : "PREAUTH",
    );
    if (id === "authentication") {
      try {
        await f.connect();
        assert.fail("Authentication unexpectedly succeeded");
      } catch (error) {
        assert.equal(classify(error), "authentication");
        evidence = { kind: classify(error), message: (error as Error).message };
      }
    } else {
      const client = await f.connect();
      if (id === "raw-wrong-origin") {
        const row = await client.fetchOne(
          1,
          { bodyParts: [{ key: "1", start: 0, maxLength: 7 }] },
          { uid: true },
        );
        assert(row && row.bodyParts?.get("1")?.length === 7);
        assert.deepEqual(row.bodyParts.get("1"), encoded.subarray(0, 7));
        evidence = {
          acceptedLength: 7,
          actualOrigin: 99,
          requestedOrigin: 0,
          publicOriginAvailable: false,
        };
        guarantee = "unsafe-reproduced";
      } else {
        adapter = new TransportExperiment(client);
        let result: Outcome<unknown>;
        if (id.startsWith("search-")) {
          result = await adapter.search(
            1,
            id === "search-sparse"
              ? 1000000000
              : id === "search-identity-budget" ||
                  id === "search-parsed-overshoot"
                ? 1000
                : 128,
            128,
            {
              ...limits,
              timeoutMs: id === "search-multiple" ? 500 : 180,
              byteLimit:
                id === "search-trickle-budget"
                  ? 80
                  : id === "search-wire-budget"
                    ? 1024
                    : limits.byteLimit,
            },
          );
        } else if (id.startsWith("metadata-")) {
          result = await adapter.metadata(
            Array.from(
              { length: id === "metadata-aggregate" ? 16 : 3 },
              (_, i) => i + 1,
            ),
            id === "metadata-epoch" ? { ...epoch, uidValidity: 8n } : epoch,
            limits,
            () => id !== "metadata-external-epoch",
          );
        } else if (id.startsWith("slice-")) {
          if (["slice-base64", "slice-qp", "slice-restart"].includes(id)) {
            let raw: Buffer[] = [];
            let decoded: Buffer[] = [];
            let decoder: Transform =
              id === "slice-qp" ? new qp.Decoder() : new base64.Decoder();
            decoder.on("data", (b: Buffer) => decoded.push(b));
            let offset = 0;
            let discarded = 0;
            while (offset < encoded.length) {
              const slice = await adapter.slice(
                1,
                "1",
                offset,
                Math.min(7, encoded.length - offset),
                epoch,
                limits,
              );
              operations.push(slice);
              if (slice.status !== "justified") {
                assert.equal(id, "slice-restart");
                assert.equal(discarded, 0);
                decoder.destroy();
                raw = [];
                decoded = [];
                offset = 0;
                discarded++;
                adapter.dispose();
                adapter = undefined;
                const fresh = await f.connect();
                adapter = new TransportExperiment(fresh);
                decoder = new base64.Decoder();
                decoder.on("data", (b: Buffer) => decoded.push(b));
                continue;
              }
              raw.push(slice.value);
              decoder.write(slice.value);
              offset += slice.value.length;
            }
            await new Promise<void>((resolve, reject) => {
              decoder.once("end", resolve);
              decoder.once("error", reject);
              decoder.end();
            });
            assert.deepEqual(Buffer.concat(raw), encoded);
            assert.deepEqual(Buffer.concat(decoded), source);
            assert.equal(discarded, id === "slice-restart" ? 1 : 0);
            result = operations.at(-1)!;
            evidence = {
              encodedLength: encoded.length,
              decodedLength: source.length,
              discarded,
              complete: true,
            };
          } else result = await adapter.slice(1, "1", 0, 7, epoch, limits);
        } else if (id === "cancel-fetch") {
          setTimeout(() => adapter?.cancel(), 35);
          result = await adapter.metadata([1, 2, 3], epoch, limits, () => true);
        } else if (id === "socket-timeout") {
          result = await adapter.metadata([1, 2, 3], epoch, limits, () => true);
        } else if (id === "mutation-ambiguous") {
          result = await adapter.execute(
            { ...limits, mutation: true },
            async (guard) => {
              await client.messageFlagsAdd([1], ["\\Seen"], { uid: true });
              guard();
            },
          );
        } else {
          if (id === "deadline-done") {
            const idle = client.idle();
            await until(() => f!.commands.some((c) => c.command === "IDLE"));
            result = await adapter.execute(limits, async (guard) => {
              await client.noop();
              guard();
            });
            await idle;
            assert(
              !f.commands.some((c) => c.command === "NOOP"),
              "Hung DONE must prevent NOOP reaching wire",
            );
          } else {
            let oldGuard: (() => void) | undefined;
            result = await adapter.execute(
              { ...limits, timeoutMs: id === "deadline-starvation" ? 40 : 100 },
              async (guard, remaining) => {
                oldGuard = guard;
                if (id === "deadline-preparation") {
                  await delay(40);
                  assert(remaining() < 80);
                  await client.mailboxOpen("Archive");
                  guard();
                }
                if (id === "deadline-starvation") {
                  const end = performance.now() + 140;
                  while (performance.now() < end) {}
                  guard();
                }
                const hits = await client.search(
                  { uid: "1:128" },
                  { uid: true },
                );
                guard();
                if (id === "deadline-cleanup") {
                  await delay(120);
                  guard();
                }
                return hits;
              },
            );
            if (id === "late-callback") {
              await new Promise<void>((resolve, reject) =>
                setTimeout(() => {
                  try {
                    assert.throws(() => oldGuard!(), /deadline|token/i);
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                }, 20),
              );
              evidence = { latePublicationRejected: true };
            }
            if (id === "deadline-starvation") {
              assert(result.metrics.durationMs! >= 140);
              evidence = { timerCannotPreempt: true, minimumBlockingMs: 140 };
            }
          }
        }
        if (!operations.includes(result)) operations.push(result);
        if (id === "search-parsed-overshoot") {
          assert.equal(result.metrics.maxParsedSearchTokens, 16384);
          assert.equal(result.metrics.retainedSearchIdentities, 128);
          guarantee = "unsafe-reproduced";
        }
        const success = [
          "search-dense",
          "search-sparse",
          "search-multiple",
          "metadata-complete",
          "slice-correct",
          "slice-base64",
          "slice-qp",
          "slice-restart",
        ].includes(id);
        assert.equal(
          result.status,
          success ? "justified" : "unresolved",
          JSON.stringify(result),
        );
        if (result.status === "unresolved") {
          if (id === "search-invalid-number")
            assert.equal(result.kind, "malformed");
          if (
            /deadline|late-callback/.test(id) ||
            id === "metadata-stall" ||
            id === "search-trickle-deadline" ||
            id === "mutation-ambiguous"
          )
            assert.equal(result.kind, "deadline");
          if (id === "cancel-fetch") assert.equal(result.kind, "cancelled");
          if (id === "metadata-malformed")
            assert.equal(result.kind, "malformed");
          if (id === "search-esearch-rejected")
            assert.equal(result.kind, "unresolved");
          if (id === "socket-timeout")
            assert.equal(result.kind, "socket-timeout");
          if (
            [
              "metadata-missing",
              "metadata-duplicate",
              "metadata-unexpected",
              "metadata-lenient-syntax",
            ].includes(id)
          )
            assert.equal(result.kind, "incomplete");
          if (id.includes("epoch")) assert.equal(result.kind, "epoch");
          if (
            id === "metadata-depth" ||
            id === "metadata-literal-limit" ||
            id === "search-large"
          )
            assert.equal(result.kind, "parser-limit");
          if (
            [
              "metadata-aggregate",
              "search-trickle-budget",
              "search-identity-budget",
              "search-wire-budget",
              "search-parsed-overshoot",
            ].includes(id)
          )
            assert.equal(result.kind, "budget");
          if (id === "mutation-ambiguous")
            assert.equal(result.remoteOutcome, "ambiguous");
          assert(client.isClosed);
          assert(adapter.socket.destroyed);
          await until(() =>
            f!.events.some(
              (e) => e.event === "server-close" && e.connection === 1,
            ),
          );
          adapter.dispose();
          adapter = undefined;
          const fresh = await f.connect();
          assert.deepEqual(
            await fresh.search({ uid: "9:9" }, { uid: true }),
            [9],
          );
        }
      }
      adapter?.dispose();
      adapter = undefined;
    }
  }
} catch (error) {
  failure = (error as Error).stack;
} finally {
  adapter?.client.close();
  if (f) {
    for (const client of f.clients) client.close();
    await until(
      () =>
        f!.events.filter((e) => e.event === "server-close").length ===
        f!.peers.length,
    ).catch(() => {});
    await f.cleanup();
  }
  clearInterval(sampler);
  lag.disable();
}
const value = {
  id,
  assertionStatus: failure ? "FAIL" : "PASS",
  property: guarantee,
  failure,
  elapsedMs: performance.now() - start,
  before,
  sampledPeak: peak,
  eventLoopMaxMs: lag.max / 1e6,
  operations: operations.map((result) => ({
    ...result,
    ...(result.status === "justified"
      ? {
          value: Array.isArray(result.value)
            ? { returnedCount: result.value.length }
            : Buffer.isBuffer(result.value)
              ? { returnedBytes: result.value.length }
              : undefined,
        }
      : {}),
  })),
  evidence,
  diagnostics,
  commands: f?.commands,
  events: f?.events.filter((e) => e.event !== "received"),
};
process.stdout.write(JSON.stringify(value) + "\n");
if (failure) process.exitCode = 1;
