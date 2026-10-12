import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { Lane } from "./client.js";
import { message } from "./fixture.js";
import { record } from "../imap-dovecot/model.js";
import { Store } from "./store.js";
export const exec = promisify(execFile);
export const compose = [
  "compose",
  "-f",
  "experiments/imap-durability/compose.yaml",
];
const children = new Set<ReturnType<typeof fork>>();
export function stopChildren() {
  for (const proc of children) proc.kill("SIGKILL");
}
export function child(config: object, events: Record<string, unknown>[]) {
  const proc = fork(
    fileURLToPath(new URL("worker.ts", import.meta.url)),
    [JSON.stringify(config)],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.add(proc);
  proc.once("exit", () => children.delete(proc));
  const received: Record<string, unknown>[] = [];
  let stderr = "";
  proc.stderr?.on("data", (b) => (stderr += b.toString()));
  const subscribers = new Set<() => void>();
  proc.on("message", (message) => {
    const e = message as Record<string, unknown>;
    received.push(e);
    events.push({ at: new Date().toISOString(), ...e });
    for (const cb of subscribers) cb();
  });
  const exited = new Promise<{
    code: number | null;
    signal: string | null;
    stderr: string;
  }>((resolve) =>
    proc.once("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  const until = async (event: string, point?: string) => {
    const check = () =>
      received.find(
        (e) =>
          event.split("|").includes(String(e.event)) &&
          (!point || e.point === point),
      );
    if (check()) return check()!;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const cb = () => {
        const found = check();
        if (found) {
          clearTimeout(timer);
          subscribers.delete(cb);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        subscribers.delete(cb);
        reject(
          new Error(
            `Worker barrier timeout: ${event}/${point}; ${stderr}; ${JSON.stringify(received.slice(-2))}`,
          ),
        );
      }, 20000);
      subscribers.add(cb);
    });
  };
  return { proc, received, exited, until };
}
export async function expire(store: Store) {
  const end = performance.now() + 45_000;
  for (;;) {
    const [row] =
      await store.sql`select expires<=clock_timestamp() expired,greatest(0,extract(epoch from (expires-clock_timestamp()))*1000) remaining from coordinator`;
    if (row.expired) return;
    if (performance.now() >= end)
      throw new Error("Lease expiry not observed in PostgreSQL");
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(25, Math.min(500, Number(row.remaining) + 50)),
      ),
    );
  }
}
export async function fixture(account: string, count: number, path = "INBOX") {
  const actor = await Lane.open(true, "INBOX", account);
  try {
    if (path !== "INBOX")
      await actor.op("CREATE", async (guard) => {
        await actor.client.mailboxCreate(path);
        guard();
      });
    for (let i = 1; i <= count; i++)
      await actor.op("APPEND", async (guard) => {
        const m = message(i, account);
        const r = await actor.client.append(
          path,
          m.data,
          m.flags,
          new Date(m.date),
        );
        guard();
        assert(r && r.uid);
        return r;
      });
  } finally {
    await actor.close();
  }
}
export async function oracle(account: string, path = "INBOX") {
  const lane = await Lane.open(true, path, account);
  const start = performance.now();
  try {
    const next = lane.client.mailbox && lane.client.mailbox.uidNext;
    assert(next);
    const rows = [];
    for (let low = 1; low < next; low += 128) {
      const uids = await lane.search(low, Math.min(next - 1, low + 127));
      if (uids.length) rows.push(...(await lane.metadata(uids)).map(record));
    }
    return {
      epoch: String(lane.epoch.uidValidity),
      next,
      rows,
      durationMs: performance.now() - start,
    };
  } finally {
    await lane.close();
  }
}
export async function compare(
  store: Store,
  account: string,
  path = "INBOX",
  flags = true,
) {
  const remote = await oracle(account, path),
    local = await store.placements(account),
    state = await store.state(account);
  assert.equal(state.epoch, remote.epoch);
  assert.equal(new Set(local.map((r) => r.uid)).size, local.length);
  const projection = (r: (typeof local)[number]) =>
    flags ? r : { ...r, flags: [] };
  assert.deepEqual(
    local.map(projection),
    remote.rows.sort((a, b) => a.uid - b.uid).map(projection),
  );
  assert.equal(state.history, 1);
  assert.equal(state.fresh, remote.next - 1);
  return {
    identities: local.length,
    epoch: state.epoch,
    history: state.history,
    fresh: state.fresh,
    missing: 0,
    duplicates: 0,
    oracleMs: remote.durationMs,
  };
}
