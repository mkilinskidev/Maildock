import postgres from "postgres";
import { connect, type Socket } from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "./database";
import * as schema from "./schema";

export type ReceivingDatabase = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export class ReceivingUnresolvedError extends Error {
  constructor(
    readonly phase: "admission" | "transaction" | "commit",
    options?: ErrorOptions,
  ) {
    super(
      `Receiving ${phase} did not settle; reload under conflicting locks before retry`,
      options,
    );
  }
}

/** Unwired receiving-only admission. Each admitted turn owns a distinct client.
 * A retired client is never reconstructed/released for another turn. Owned Node
 * streams are destroyed and closed, but server ordering still requires DB locks.
 */
export class ReceivingExecutor {
  private active = 0;
  private stopped = false;
  private readonly controllers = new Set<AbortController>();
  private readonly waiting: (() => boolean)[] = [];

  constructor(
    private readonly url: string,
    readonly capacity: number,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16)
      throw new Error("Invalid receiving capacity");
  }

  async stop() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    for (const wake of this.waiting.splice(0)) wake();
    while (this.active)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  async transaction<T>(
    work: (db: ReceivingDatabase) => Promise<T>,
    options: { deadline: number; signal?: AbortSignal; lockTimeoutMs?: number },
  ): Promise<T> {
    options = { ...options };
    if (
      !Number.isFinite(options.deadline) ||
      options.deadline <= performance.now()
    )
      throw new ReceivingUnresolvedError("admission");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const remaining = () => Math.floor(options.deadline - performance.now());
    const timer = setTimeout(abort, Math.max(0, remaining()));
    let client: postgres.Sql | undefined;
    let reservation: Promise<postgres.ReservedSql> | undefined;
    let factoryReturned = false;
    let reconnectDenied = false;
    let observedClose!: () => void;
    const driverClosed = new Promise<void>(
      (resolve) => (observedClose = resolve),
    );
    let transportLive = true;
    const sockets = new Set<Socket>();
    const destroyTransport = () => {
      transportLive = false;
      for (const socket of sockets) socket.destroy();
    };
    let valid = true;
    let admitted = false;
    let phase: "admission" | "transaction" | "commit" = "admission";
    let inFlight = 0;
    const guard = () => {
      if (
        !valid ||
        controller.signal.aborted ||
        this.stopped ||
        remaining() <= 0
      )
        throw new ReceivingUnresolvedError(phase);
    };
    let fail!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => (fail = reject));
    const invalidate = () => {
      valid = false;
      destroyTransport();
      fail(new ReceivingUnresolvedError(phase));
      // Never call release/rollback from a cancelled scope. Backend ordering is
      // a separate database operation, not a claim about this end promise.
      // Do not call end here: postgres.js can attempt a TLS Terminate write
      // after the owned stream was destroyed, then remove its error listeners.
      // Finally orders public driver close observation before end instead.
    };
    controller.signal.addEventListener("abort", invalidate, { once: true });
    cancelled.catch(() => undefined);
    const bounded = <U>(pending: PromiseLike<U>) =>
      Promise.race([Promise.resolve(pending), cancelled]);
    this.controllers.add(controller);
    try {
      guard();
      if (this.active >= this.capacity) {
        if (this.waiting.length >= this.capacity)
          throw new ReceivingUnresolvedError("admission");
        let wake!: () => boolean;
        const available = new Promise<void>((resolve) => {
          wake = () => {
            // Reserve synchronously before resolving the waiter. A returning
            // borrower must not steal this slot during promise resumption.
            if (
              !valid ||
              controller.signal.aborted ||
              this.stopped ||
              remaining() <= 0
            ) {
              resolve();
              return false;
            }
            this.active++;
            admitted = true;
            resolve();
            return true;
          };
        });
        this.waiting.push(wake);
        try {
          await bounded(available);
        } finally {
          const index = this.waiting.indexOf(wake);
          if (index >= 0) this.waiting.splice(index, 1);
        }
      }
      guard();
      if (!admitted) {
        if (this.active >= this.capacity)
          throw new ReceivingUnresolvedError("admission");
        this.active++;
        admitted = true;
      }
      phase = "transaction";
      // Documented postgres.js custom socket API, with public Node stream
      // ownership only. No BackendKeyData parsing or private connection access.
      const connectionOptions = {
        max: 1,
        connect_timeout: Math.max(1, remaining() / 1000),
        idle_timeout: 0,
        max_lifetime: null,
        onnotice: () => undefined,
        onclose: () => observedClose(),
        connection: { application_name: "maildock-receiving-stage1" },
        socket: async (address: {
          host: string[];
          port: number[];
          path?: string;
        }) => {
          if (!transportLive || controller.signal.aborted || sockets.size) {
            reconnectDenied = true;
            throw new ReceivingUnresolvedError(phase);
          }
          const socket = address.path
            ? connect(address.path)
            : connect(address.port[0], address.host[0]);
          // Host metadata on the supplied stream preserves the driver's TLS SNI
          // and certificate hostname behavior for the documented socket adapter.
          Object.assign(socket, {
            host: address.host[0],
            port: address.port[0],
          });
          sockets.add(socket);
          const connectTimer = setTimeout(
            () => socket.destroy(),
            Math.max(1, remaining()),
          );
          try {
            await new Promise<void>((resolve, reject) => {
              socket.once("connect", resolve);
              socket.once("error", reject);
              socket.once("close", () =>
                reject(new ReceivingUnresolvedError(phase)),
              );
            });
            if (!transportLive || controller.signal.aborted) {
              socket.destroy();
              throw new ReceivingUnresolvedError(phase);
            }
            factoryReturned = true;
            return socket;
          } finally {
            clearTimeout(connectTimer);
          }
        },
      };
      client = postgres(this.url, connectionOptions);
      reservation = client.reserve();
      const reserved = await bounded(reservation);
      guard();
      await bounded(reserved`begin isolation level read committed`);
      const timeout = String(Math.max(1, remaining()));
      await bounded(
        reserved`select set_config('statement_timeout', ${timeout}, true), set_config('lock_timeout', ${String(Math.max(1, Math.min(remaining(), options.lockTimeoutMs ?? remaining())))}, true), set_config('idle_in_transaction_session_timeout', ${timeout}, true)`,
      );

      // Drizzle uses only unsafe().values()/then() for its public query APIs.
      // Construct a minimal adapter, not a proxy exposing a reserved client.
      const unsafe = (query: string, params: unknown[] = []) => {
        guard();
        if (
          !/^\s*(select|insert|update|delete|with)\b/i.test(query) ||
          /;|\bset_config\s*\(/i.test(query)
        )
          throw new Error(
            "Receiving business transaction control is prohibited",
          );
        const lazy = (values: boolean): unknown => ({
          values: () => {
            guard();
            return lazy(true);
          },
          then: (
            resolve: (rows: unknown) => unknown,
            reject: (error: unknown) => unknown,
          ) => {
            try {
              guard();
              inFlight++;
              const pending = reserved.unsafe(
                query,
                params as postgres.ParameterOrJSON<never>[],
              );
              const result = values ? pending.values() : pending;
              return Promise.resolve(result)
                .finally(() => {
                  inFlight--;
                })
                .then(resolve, reject);
            } catch (error) {
              return Promise.reject(error).then(resolve, reject);
            }
          },
        });
        return lazy(false);
      };
      const driver = {
        unsafe,
        options: {
          parsers: client.options.parsers,
          serializers: client.options.serializers,
        },
      } as unknown as postgres.Sql;
      const db = drizzle(driver, { schema });
      const scoped = Object.freeze(
        Object.fromEntries(
          ["select", "insert", "update", "delete", "execute"].map((key) => [
            key,
            (...args: unknown[]) => {
              guard();
              return Reflect.apply(Reflect.get(db, key), db, args);
            },
          ]),
        ),
      ) as ReceivingDatabase;
      let value: T;
      try {
        value = await bounded(
          Promise.resolve().then(() => {
            guard();
            return work(scoped);
          }),
        );
        guard();
        if (inFlight) throw new Error("Detached receiving SQL is prohibited");
      } catch (error) {
        valid = false;
        if (controller.signal.aborted) throw error;
        try {
          await bounded(reserved`rollback`);
        } catch (cause) {
          throw new ReceivingUnresolvedError(phase, { cause });
        }
        throw error;
      }
      // Revocation precedes commit: an old prepared builder cannot race COMMIT.
      valid = false;
      phase = "commit";
      try {
        await bounded(reserved`commit`);
      } catch (cause) {
        // Even a server rejection is conservatively recovered from durable state.
        throw new ReceivingUnresolvedError("commit", { cause });
      }
      return value;
    } finally {
      valid = false;
      destroyTransport();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", invalidate);
      // TLS may remove listeners from the underlying stream. Observe its public
      // closed property instead of relying on an application close listener.
      while ([...sockets].some((socket) => !socket.closed))
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      // Startup has no acquired reservation yet. Closing can make the public
      // reserve promise reject through a denied reconnect: no new socket is
      // allowed in that lifetime. Otherwise onclose proves the driver observed
      // its stream closure (not that the server transaction has disappeared).
      await reservation?.catch(() => undefined);
      if (factoryReturned && !reconnectDenied) await driverClosed;
      if (client) await client.end({ timeout: 0 });
      this.controllers.delete(controller);
      if (admitted) {
        this.active--;
        // Skip cancelled/expired waiters without consuming the returned slot.
        while (this.waiting.length) if (this.waiting.shift()!()) break;
      }
    }
  }
}
