import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Lane } from "./client.js";
import { record, type RecordRow } from "../imap-dovecot/model.js";
import {
  Store,
  noBarrier,
  type Barrier,
  type Owner,
  type State,
} from "./store.js";
import { validateEpoch } from "../imap-transport/hardening.js";
export type Kind = "history" | "fresh" | "repair" | "user";
export class Coordinator {
  lanes = new Map<string, Lane>();
  busy = new Set<string>();
  tokens = new Map<string, { valid: boolean }>();
  spans = new Map<string, number>();
  hints = new Set<string>();
  hintEvents = 0;
  hintFlushes = 0;
  observedNext = new Map<string, number>();
  private flushing: Promise<void> | undefined;
  emit: (event: Record<string, unknown>) => unknown = () => {};
  port = 32993;
  ports = new Map<string, number>();
  timeout = 10_000;
  leaseTtl = 30_000;
  constructor(
    readonly store: Store,
    readonly owner: Owner,
  ) {}
  async lane(account: string, path: string, end: number) {
    let lane = this.lanes.get(account);
    let opened = false;
    if (lane?.client.isClosed) {
      lane.transport.dispose();
      this.lanes.delete(account);
      lane = undefined;
    }
    if (!lane) {
      lane = await Lane.open(
        true,
        path,
        account,
        this.ports.get(account) ?? this.port,
        end,
      );
      this.lanes.set(account, lane);
      opened = true;
      lane.client.on("exists", () => {
        this.hintEvents++;
        this.hints.add(account);
      });
    }
    lane.deadline = end;
    lane.operationStartBytes = opened ? 0 : lane.bytesIn;
    if (!lane.client.mailbox || lane.client.mailbox.path !== path)
      await lane.op("SELECT", async (guard) => {
        await lane!.client.mailboxOpen(path);
        guard();
      });
    return lane;
  }
  async turn(
    account: string,
    kind: Kind,
    barrier: Barrier = noBarrier,
    path = "INBOX",
  ) {
    if (this.busy.has(account))
      throw new Error("One data operation per account");
    this.busy.add(account);
    const token = { valid: true };
    this.tokens.set(account, token);
    const start = performance.now(),
      end = start + this.timeout;
    let lane: Lane | undefined,
      before: State | undefined,
      low: number | undefined,
      high: number | undefined;
    let hits: number[] = [],
      rows: RecordRow[] = [],
      absent: number[] = [],
      searchComplete = false,
      fetchComplete = false;
    const guard = () => {
      if (!token.valid || performance.now() >= end)
        throw new Error("Expired operation token");
    };
    const timer = setTimeout(() => {
      token.valid = false;
      lane?.client.close();
    }, this.timeout);
    const event: Record<string, unknown> = {
      at: new Date().toISOString(),
      pid: process.pid,
      account,
      path,
      kind,
      owner: this.owner.owner,
      generation: this.owner.generation,
      start,
    };
    try {
      // A confirmed renewal precedes all remote commands; no DB session spans them.
      await this.store.renew(this.owner, this.leaseTtl);
      guard();
      lane = await this.lane(account, path, end);
      await lane.op("REFRESH", async (check) => {
        await lane!.client.noop();
        check();
      });
      const status = await lane.op("STATUS", async (check) => {
        const r = await lane!.client.status(path, {
          uidNext: true,
          uidValidity: true,
        });
        check();
        return r;
      });
      assert(status.uidNext && status.uidValidity);
      this.observedNext.set(account, status.uidNext);
      const epoch = String(status.uidValidity);
      if (epoch !== String(lane.epoch.uidValidity))
        throw new Error("SELECT/STATUS epoch changed; reconnect required");
      before = await this.store.initialize(
        this.owner,
        account,
        path,
        epoch,
        status.uidNext,
        end,
      );
      guard();
      event.before = before;
      let progress = kind === "history" ? before.history : before.fresh;
      const key = account + "/" + kind,
        span = this.spans.get(key) ?? 128;
      await barrier("before-search");
      guard();
      if (kind === "user") {
        const page = await this.store.tx(
          1,
          end,
          (sql) =>
            sql`select uid from current_placement where account=${account} order by uid desc limit 1`,
        );
        if (page.length) {
          const uid = Number(page[0].uid);
          await lane.op("USER FLAGS", async (check) => {
            assert(
              await lane!.client.messageFlagsAdd([uid], ["\\Flagged"], {
                uid: true,
              }),
            );
            check();
          });
          await lane.slice(uid, 64);
        }
        event.status = "PASS";
        return;
      }
      if (kind === "repair") {
        const after = before.reconcile;
        const page = await this.store.tx(
          1,
          end,
          (sql) =>
            sql`select uid from current_placement where account=${account} and uid>${after} order by uid limit 128`,
        );
        const known = page.map((r) => Number(r.uid));
        if (known.length) {
          low = known[0];
          high = known[known.length - 1];
          hits = await lane.exactSearch(known);
          absent = known.filter((uid) => !hits.includes(uid));
          progress = high;
        } else progress = 0;
      } else {
        if (kind === "history" && before.history > 1) {
          high = before.history - 1;
          low = Math.max(1, before.history - span);
          progress = low;
        } else if (kind === "fresh" && before.fresh < status.uidNext - 1) {
          low = before.fresh + 1;
          high = Math.min(status.uidNext - 1, before.fresh + span);
          progress = high;
        }
        if (low !== undefined && high !== undefined)
          hits = await lane.search(low, high);
      }
      searchComplete = true;
      await barrier("after-search");
      guard();
      if (hits.length) rows = (await lane.metadata(hits)).map(record);
      fetchComplete = true;
      await barrier("after-fetch");
      guard();
      await this.flushHints();
      validateEpoch(lane.client, lane.epoch);
      this.spans.set(key, hits.length ? 128 : Math.min(0x100000000, span * 2));
      // An omission throws above. It advances neither coverage nor deletion;
      // replay the interval with a fresh SEARCH on a fresh socket.
      event.transactionStart = new Date().toISOString();
      await this.store.commit(
        this.owner,
        before,
        kind,
        rows,
        progress,
        absent,
        end,
        guard,
        barrier,
      );
      event.commit = "confirmed";
      await barrier("after-commit");
      guard();
      event.after = await this.store.state(account, end);
      await barrier("before-ack");
      await barrier("before-schedule");
      event.status = "PASS";
    } catch (error) {
      event.status = "UNRESOLVED";
      event.reason = String(error);
      event.commit ??= "not confirmed";
      if (/budget/.test(String(error))) {
        const key = account + "/" + kind;
        this.spans.set(
          key,
          Math.max(128, Math.floor((this.spans.get(key) ?? 128) / 2)),
        );
      }
      // Fail closed and retire local transport before releasing this account.
      if (lane && !lane.client.isClosed) {
        const closed = new Promise<void>((resolve) =>
          lane!.transport.socket.once("close", resolve),
        );
        lane.client.close();
        await closed;
      }
      throw error;
    } finally {
      token.valid = false;
      clearTimeout(timer);
      Object.assign(event, {
        low,
        high,
        returned: hits.length,
        persisted: rows.length,
        absent: absent.length,
        searchComplete,
        fetchComplete,
        evidenceComplete: searchComplete && fetchComplete,
        end: performance.now(),
        durationMs: performance.now() - start,
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
      });
      if (lane) {
        event.transport = lane.operations.splice(0);
        event.commands = lane.commands.splice(0);
        event.tagged = lane.tagged.splice(0);
        event.bytesIn = lane.bytesIn;
        event.bytesOut = lane.bytesOut;
      }
      await this.emit(event);
      this.tokens.delete(account);
      this.busy.delete(account);
    }
  }
  async drain(account: string, path = "INBOX") {
    for (let attempts = 0; attempts < 10000; attempts++) {
      let state: State | undefined;
      try {
        state = await this.store.state(account);
      } catch {}
      const kind = state && state.history === 1 ? "fresh" : "history";
      await this.turn(account, kind, noBarrier, path);
      const after = await this.store.state(account);
      if (
        kind === "fresh" &&
        after.history === 1 &&
        after.fresh >= (this.observedNext.get(account) ?? Infinity) - 1
      )
        return;
    }
    throw new Error("Unresolved history exceeded bounded attempts");
  }
  async flushHints() {
    if (this.flushing) return this.flushing;
    const pending = [...this.hints];
    if (!pending.length) return;
    for (const account of pending) this.hints.delete(account);
    this.flushing = (async () => {
      for (const account of pending) {
        try {
          await this.store.due(account);
          this.hintFlushes++;
        } catch (error) {
          this.hints.add(account);
          throw error;
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }
  async repair(account: string, path = "INBOX") {
    await this.store
      .sql`update mailbox set reconcile=0 where account=${account}`;
    do {
      await this.turn(account, "repair", noBarrier, path);
    } while ((await this.store.state(account)).reconcile !== 0);
  }
  async close() {
    for (const lane of this.lanes.values()) {
      lane.deadline = performance.now() + 2000;
      try {
        await lane.close();
      } catch {
        lane.client.close();
      }
      lane.transport.dispose();
    }
    this.lanes.clear();
    this.hints.clear();
    this.observedNext.clear();
    await this.store.release(this.owner);
  }
}
