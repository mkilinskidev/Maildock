import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { connect, type Socket } from "node:net";
import type { RecordRow } from "../imap-dovecot/model.js";

export type Owner = { owner: string; generation: number };
export type State = {
  account: string;
  path: string;
  epoch: string;
  fresh: number;
  history: number;
  reconcile: number;
  revision: number;
  wake: number;
};
export type Barrier = (point: string) => Promise<void>;
export const noBarrier: Barrier = async () => {};
export const databaseUrl =
  "postgres://phase3:disposable-phase3-only@127.0.0.1:35433/phase3";
export class Store {
  sql;
  waits: number[] = [];
  transactions: number[] = [];
  private sockets = new Map<number, Socket>();
  private allSockets = new Set<Socket>();
  private active = 0;
  private waiting: {
    priority: number;
    end: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  constructor(
    readonly capacity = 2,
    url = databaseUrl,
  ) {
    const parsed = new URL(url);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/phase3" ||
      parsed.username !== "phase3"
    )
      throw new Error("Only isolated Phase 3 database allowed");
    // Pinned postgres.js socket factory. Retain native socket keyed by the real
    // BackendKeyData PID so a deadline can settle even a lost COMMIT response.
    const socket = async () => {
      const s = connect(Number(parsed.port), parsed.hostname);
      s.setNoDelay(true);
      this.allSockets.add(s);
      s.once("close", () => this.allSockets.delete(s));
      const connectTimer = setTimeout(
        () => s.destroy(new Error("Database connect deadline")),
        2000,
      );
      await new Promise<void>((resolve, reject) => {
        s.once("connect", resolve);
        s.once("error", reject);
      }).finally(() => clearTimeout(connectTimer));
      let buffer = Buffer.alloc(0),
        pid: number | undefined;
      const identify = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const size = buffer.readInt32BE(1) + 1;
          if (size < 5 || size > 1024 * 1024)
            throw new Error("Invalid PostgreSQL startup frame");
          if (buffer.length < size) return;
          if (buffer[0] === 75 && size === 13) {
            pid = buffer.readInt32BE(5);
            this.sockets.set(pid, s);
            s.removeListener("data", identify);
            buffer = Buffer.alloc(0);
            return;
          }
          buffer = buffer.subarray(size);
        }
      };
      s.on("data", identify);
      s.once("close", () => {
        if (pid) this.sockets.delete(pid);
      });
      return s;
    };
    const options = {
      max: capacity,
      ssl: false,
      connect_timeout: 2,
      idle_timeout: 0,
      connection: {
        application_name: "phase3-" + process.pid,
        statement_timeout: 2000,
        lock_timeout: 2000,
      },
      onnotice: () => {},
      socket,
    };
    this.sql = postgres(url, options);
  }
  async admission(priority: number, end: number) {
    const start = performance.now();
    if (end <= start) throw new Error("DB admission deadline");
    if (this.active < this.capacity) this.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const entry = {
          priority,
          end,
          resolve,
          reject,
          timer: setTimeout(() => {
            this.waiting = this.waiting.filter((e) => e !== entry);
            reject(new Error("DB pool admission deadline"));
          }, end - start),
        };
        this.waiting.push(entry);
        this.waiting.sort((a, b) => a.priority - b.priority);
      });
    this.waits.push(performance.now() - start);
    if (this.waits.length > 20000) this.waits.shift();
    return () => {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else this.active--;
    };
  }
  async tx<T>(
    priority: number,
    end: number,
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ) {
    const release = await this.admission(priority, end);
    const start = performance.now();
    let native: Socket | undefined;
    let reserved: postgres.ReservedSql | undefined;
    let valid = true;
    const transactionEnd = Math.min(end, start + 2000);
    const guard = () => {
      if (!valid || performance.now() >= transactionEnd)
        throw new Error("Cancelled database transaction scope");
    };
    const timer = setTimeout(
      () => {
        valid = false;
        const error = new Error(
          "Database total deadline; commit outcome uncertain",
        );
        if (native) native.destroy(error);
        else for (const socket of this.allSockets) socket.destroy(error);
      },
      Math.max(1, transactionEnd - performance.now()),
    );
    let onClose: () => void = () => {};
    try {
      reserved = await this.sql.reserve();
      guard();
      const [{ pid }] = await reserved`select pg_backend_pid() pid`;
      native = this.sockets.get(Number(pid));
      if (!native || native.destroyed)
        throw new Error("Database native socket identity missing");
      // Own BEGIN/COMMIT/ROLLBACK explicitly. postgres.js begin(callback) can
      // retire its connection while a paused callback still holds the old SQL
      // handle; its later automatic ROLLBACK can affect a reused connection.
      const closed = new Promise<never>((_, reject) => {
        onClose = () => {
          valid = false;
          reject(
            new Error(
              "Database native socket retired; commit outcome uncertain",
            ),
          );
        };
        native!.once("close", onClose);
      });
      closed.catch(() => {});
      await reserved`begin`;
      guard();
      const remaining = Math.max(
        1,
        Math.floor(transactionEnd - performance.now()),
      );
      await reserved`select set_config('statement_timeout', ${String(remaining)}, true), set_config('lock_timeout', ${String(remaining)}, true), set_config('idle_in_transaction_session_timeout', '5000', true)`;
      const guardedResult = (value: unknown) => {
        if (
          !value ||
          typeof value !== "object" ||
          typeof Reflect.get(value, "then") !== "function"
        )
          return value;
        return new Proxy(value, {
          get(target, key) {
            const method = Reflect.get(target, key);
            return typeof method === "function"
              ? (...args: unknown[]) => {
                  guard();
                  return Reflect.apply(method, target, args);
                }
              : method;
          },
        });
      };
      const scoped = new Proxy(reserved, {
        apply(target, thisArg, args) {
          guard();
          return guardedResult(Reflect.apply(target, thisArg, args));
        },
        get(target, key) {
          const value = Reflect.get(target, key);
          return typeof value === "function"
            ? (...args: unknown[]) => {
                guard();
                return guardedResult(Reflect.apply(value, target, args));
              }
            : value;
        },
      }) as unknown as postgres.TransactionSql;
      const pending = Promise.resolve(work(scoped));
      pending.catch(() => {});
      const result = await Promise.race([pending, closed]);
      guard();
      await reserved`commit`;
      return result;
    } catch (error) {
      valid = false;
      if (reserved && native && !native.destroyed)
        await reserved`rollback`.catch(() => {});
      else if (!native) for (const socket of this.allSockets) socket.destroy();
      throw error;
    } finally {
      valid = false;
      clearTimeout(timer);
      if (native?.destroyed && !native.closed)
        await new Promise<void>((resolve) => native!.once("close", resolve));
      native?.removeListener("close", onClose);
      // onclose already returns a destroyed connection to the driver pool.
      // Never release an obsolete reserved handle into a later transaction.
      if (reserved && native && !native.destroyed) reserved.release();
      this.transactions.push(performance.now() - start);
      if (this.transactions.length > 20000) this.transactions.shift();
      release();
    }
  }
  async setup() {
    await this.sql.unsafe(
      await readFile(new URL("schema.sql", import.meta.url), "utf8"),
    );
  }
  async acquire(owner: string, ttl = 30_000): Promise<Owner | undefined> {
    const rows = await this.tx(
      0,
      performance.now() + 2000,
      async (sql) => sql`
      update coordinator set owner=${owner}, generation=generation+1,
        expires=clock_timestamp()+${ttl}*interval '1 millisecond'
      where singleton and expires<=clock_timestamp() returning generation`,
    );
    return rows.length
      ? { owner, generation: Number(rows[0].generation) }
      : undefined;
  }
  async renew(owner: Owner, ttl = 30_000) {
    const rows = await this.tx(
      0,
      performance.now() + 2000,
      async (sql) => sql`
      update coordinator set expires=clock_timestamp()+${ttl}*interval '1 millisecond'
      where owner=${owner.owner} and generation=${owner.generation} and expires>clock_timestamp() returning generation`,
    );
    if (!rows.length) throw new Error("Lease renewal fenced");
  }
  async release(owner: Owner) {
    await this.tx(
      0,
      performance.now() + 2000,
      async (sql) =>
        sql`update coordinator set expires='-infinity' where owner=${owner.owner} and generation=${owner.generation}`,
    );
  }
  async fence(sql: postgres.TransactionSql, owner: Owner) {
    await sql`select set_config('phase3.owner',${owner.owner},true),set_config('phase3.generation',${String(owner.generation)},true)`;
    const rows =
      await sql`select generation from coordinator where singleton and owner=${owner.owner} and generation=${owner.generation} and expires>clock_timestamp() for share`;
    if (!rows.length) throw new Error("Stale owner fenced");
  }
  async initialize(
    owner: Owner,
    account: string,
    path: string,
    epoch: string,
    next: number,
    end: number,
  ) {
    await this.tx(1, end, async (sql) => {
      await this.fence(sql, owner);
      await sql`insert into mailbox(account,path,epoch,fresh,history) values(${account},${path},${epoch},${next - 1},${next})
        on conflict(account) do update set epoch=excluded.epoch,fresh=excluded.fresh,history=excluded.history,
        reconcile=0,revision=mailbox.revision+1,fresh_due=now(),repair_due=now()
        where mailbox.path=excluded.path and mailbox.epoch<>excluded.epoch`;
      await this.fence(sql, owner);
    });
    const state = await this.state(account, end);
    if (state.path !== path)
      throw new Error("Experiment supports one bound mailbox per account");
    return state;
  }
  async state(account: string, end = performance.now() + 2000): Promise<State> {
    const rows = await this.tx(
      1,
      end,
      (sql) => sql`select * from mailbox where account=${account}`,
    );
    if (!rows.length) throw new Error("Mailbox not initialized");
    const r = rows[0];
    return {
      account: r.account,
      path: r.path,
      epoch: String(r.epoch),
      fresh: Number(r.fresh),
      history: Number(r.history),
      reconcile: Number(r.reconcile),
      revision: Number(r.revision),
      wake: Number(r.wake),
    };
  }
  async due(account: string, repair = false) {
    await this.tx(0, performance.now() + 2000, async (sql) =>
      repair
        ? sql`update mailbox set repair_due=now() where account=${account}`
        : sql`update mailbox set wake=wake+1,fresh_due=now() where account=${account}`,
    );
  }
  async commit(
    owner: Owner,
    before: State,
    kind: string,
    rows: RecordRow[],
    progress: number,
    absent: number[],
    end: number,
    guard: () => void,
    barrier = noBarrier,
  ) {
    guard();
    return await this.tx(kind === "history" ? 2 : 1, end, async (sql) => {
      await this.fence(sql, owner);
      const current =
        await sql`select epoch,revision from mailbox where account=${before.account} for update`;
      if (
        !current.length ||
        String(current[0].epoch) !== before.epoch ||
        Number(current[0].revision) !== before.revision
      )
        throw new Error("Epoch or operation revision fenced");
      await barrier("transaction-start");
      for (const [index, batch] of [
        rows.slice(0, 1),
        rows.slice(1),
      ].entries()) {
        if (!batch.length) continue;
        const values = batch.map((r) => ({
          account: before.account,
          epoch: before.epoch,
          uid: r.uid,
          message_id: r.messageId,
          subject: r.subject,
          size: r.size,
          flags: sql.json(r.flags),
        }));
        await sql`insert into placement ${sql(values, "account", "epoch", "uid", "message_id", "subject", "size", "flags")}
          on conflict(account,epoch,uid) do update set flags=excluded.flags,subject=excluded.subject,size=excluded.size,message_id=excluded.message_id`;
        if (index === 0) await barrier("during-insertion");
      }
      await barrier("after-insertion");
      if (absent.length)
        await sql`delete from placement where account=${before.account} and epoch=${before.epoch} and uid in ${sql(absent)}`;
      await barrier("before-frontier");
      if (kind === "history")
        await sql`update mailbox set history=${progress},revision=revision+1 where account=${before.account}`;
      else if (kind === "fresh")
        await sql`update mailbox set fresh=${progress},revision=revision+1,
        fresh_due=case when wake=${before.wake} then clock_timestamp()+interval '1 second' else fresh_due end where account=${before.account}`;
      else if (kind === "repair")
        await sql`update mailbox set reconcile=${progress},revision=revision+1,
        repair_due=case when ${progress}=0 then clock_timestamp()+interval '30 seconds' else repair_due end where account=${before.account}`;
      await barrier("during-frontier");
      guard();
      await this.fence(sql, owner);
      if (performance.now() >= end) throw new Error("DB completion deadline");
      await barrier("before-commit");
    });
  }
  async placements(account: string) {
    const rows = await this
      .sql`select * from current_placement where account=${account} order by uid`;
    return rows.map((r) => ({
      uid: Number(r.uid),
      messageId: r.message_id,
      subject: r.subject,
      size: r.size,
      flags: r.flags as string[],
    }));
  }
  async close() {
    await this.sql.end({ timeout: 1 });
  }
}
