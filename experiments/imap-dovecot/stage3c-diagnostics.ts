/** Passive, process-local harness instrumentation; restored after diagnosis. */
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import type { ImapFlowOptions } from "imapflow";
import type { ReceivingAdmission } from "../../src/modules/mail/application/receiving-scheduler";
import {
  ReceivingExecutor,
  type ReceivingDatabase,
} from "../../src/shared/infrastructure/database/receiving-executor";

type Event = { phase: string; at: number; detail?: unknown };
export type Trace = {
  id: number;
  user: string;
  kind: string;
  admission: number;
  schedulerWaitMs: number;
  eligibleWaitMs: number;
  deadline: number;
  events: Event[];
  transactions: number;
  finished: boolean;
};

export class FailureDiagnostics {
  readonly traces: Trace[] = [];
  private readonly context = new AsyncLocalStorage<Trace>();
  private readonly current = new Map<string, Trace>();
  private readonly eligible = new Map<string, number>();
  private readonly restoreSockets: () => void;
  private sockets = 0;
  maxPgSockets = 0;
  private pgSockets = 0;

  constructor(
    private readonly pgPort: number,
    private readonly imapPort: number,
  ) {
    const originalNet = net.connect;
    const originalTls = tls.connect;
    const observe = (socket: net.Socket, args: unknown[], secure: boolean) => {
      const trace = this.context.getStore();
      const options = args[0] as { port?: number } | number;
      const port = typeof options === "number" ? options : options?.port;
      if (!trace || trace.finished || (port !== pgPort && port !== imapPort))
        return;
      const role = port === pgPort ? "postgres" : "imap";
      const id = ++this.sockets;
      if (role === "postgres")
        this.maxPgSockets = Math.max(this.maxPgSockets, ++this.pgSockets);
      this.event(trace, `${role}.socket-created`, { id });
      socket.once("connect", () =>
        this.event(trace, `${role}.tcp-connected`, { id }),
      );
      if (secure)
        socket.once("secureConnect", () =>
          this.event(trace, `${role}.tls-secure`, { id }),
        );
      socket.once("error", (error) =>
        this.event(trace, `${role}.socket-error`, { id, error: String(error) }),
      );
      socket.once("close", () => {
        if (role === "postgres") this.pgSockets--;
        this.event(trace, `${role}.native-close`, { id });
      });
    };
    net.connect = ((...args: unknown[]) => {
      const socket = Reflect.apply(originalNet, net, args);
      observe(socket, args, false);
      return socket;
    }) as typeof net.connect;
    tls.connect = ((...args: unknown[]) => {
      const socket = Reflect.apply(originalTls, tls, args);
      observe(socket, args, true);
      return socket;
    }) as typeof tls.connect;
    syncBuiltinESMExports();
    this.restoreSockets = () => {
      net.connect = originalNet;
      tls.connect = originalTls;
      syncBuiltinESMExports();
    };
  }

  ready(users: string[]) {
    const at = performance.now();
    for (const user of users) this.eligible.set(user, at);
  }
  admit(user: string, a: ReceivingAdmission) {
    const trace: Trace = {
      id: this.traces.length + 1,
      user,
      kind: a.kind,
      admission: a.at,
      schedulerWaitMs: a.waitMs,
      eligibleWaitMs: Math.max(0, a.at - (this.eligible.get(user) ?? a.at)),
      deadline: a.at + 4000,
      events: [],
      transactions: 0,
      finished: false,
    };
    this.traces.push(trace);
    this.current.set(user, trace);
    this.event(trace, "scheduler.admission", { active: a.active });
  }
  assertCurrent(user: string) {
    const trace = this.current.get(user);
    if (!trace) return;
    if (!trace.events.some((e) => e.phase === "execution.start"))
      this.event(trace, "execution.start");
    this.context.enterWith(trace);
  }
  event(trace: Trace, phase: string, detail?: unknown) {
    trace.events.push({
      phase,
      at: performance.now(),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  mark(user: string, phase: string, detail?: unknown) {
    const trace = this.current.get(user);
    if (trace) this.event(trace, phase, detail);
  }
  finish(user: string, retry?: number) {
    const trace = this.current.get(user);
    if (!trace) return;
    this.event(trace, "scheduler.slot-released", {
      outcome: retry === undefined ? "success" : "error",
      retry,
    });
    trace.finished = true;
    this.eligible.set(user, performance.now() + (retry ?? 5000));
  }
  settleCancelled() {
    for (const trace of this.traces.filter((t) => !t.finished)) {
      this.event(trace, "scheduler.drained-on-stop");
      trace.finished = true;
    }
  }
  restore() {
    this.restoreSockets();
  }
  resources() {
    return { maxPgSockets: this.maxPgSockets, livePgSockets: this.pgSockets };
  }

  imapOptions(user: string, options: ImapFlowOptions): ImapFlowOptions {
    const logger = options.logger as Exclude<
      ImapFlowOptions["logger"],
      boolean | undefined
    >;
    return {
      ...options,
      logger: {
        ...logger,
        debug: (entry: { src?: string; msg?: string }) => {
          if (entry.src === "c") {
            // Record only verbs/tags, never AUTHENTICATE payloads or credentials.
            const match =
              /^(\S+) (UID SEARCH|UID FETCH|AUTHENTICATE|SELECT|EXAMINE|ID|CAPABILITY|NAMESPACE|ENABLE|LIST|LSUB)\b/.exec(
                entry.msg ?? "",
              );
            if (match)
              this.mark(user, `imap.${match[2]}.sent`, { tag: match[1] });
          }
          logger?.debug?.(entry);
        },
      },
      receivingBytes: (count) => {
        this.mark(user, "imap.bytes", { count });
        return options.receivingBytes?.(count);
      },
      receivingResponse: (response, request) => {
        if (
          response.tag !== "*" &&
          request?.sent &&
          response.tag === request.tag
        )
          this.mark(user, `imap.${request.command}.reply`, {
            status: response.command,
            tag: response.tag,
          });
        else if (!request)
          this.mark(user, "imap.greeting-or-unsolicited", {
            command: response.command,
          });
        return options.receivingResponse?.(response, request);
      },
    };
  }

  executor(url: string) {
    const context = this.context;
    const event = this.event.bind(this);
    return new (class extends ReceivingExecutor {
      async transaction<T>(
        work: (db: ReceivingDatabase) => Promise<T>,
        options: Parameters<ReceivingExecutor["transaction"]>[1],
      ): Promise<T> {
        const trace = context.getStore();
        if (!trace || trace.finished) return super.transaction(work, options);
        const ordinal = ++trace.transactions;
        const phase =
          ordinal === 1 ? "lease" : ordinal === 2 ? "recovery" : "persistence";
        event(trace, `postgres.${phase}.request`, {
          ordinal,
          deadline: options.deadline,
        });
        try {
          return await super.transaction(async (db) => {
            event(trace, `postgres.${phase}.admitted-work-start`, {
              ordinal,
            });
            try {
              return await work(db);
            } finally {
              event(trace, `postgres.${phase}.work-end`, {
                ordinal,
              });
            }
          }, options);
        } catch (error) {
          event(trace, `postgres.${phase}.error`, {
            ordinal,
            error: String(error),
          });
          throw error;
        } finally {
          // super settles after COMMIT/ROLLBACK and owned driver/socket retirement,
          // with its executor allocation released; do not equate work-end to commit.
          event(trace, `postgres.${phase}.settled-slot-released`, {
            ordinal,
          });
        }
      }
    })(url, 2);
  }
}

export function checkDiagnostics() {
  const originalNet = net.connect,
    originalTls = tls.connect;
  const diagnostic = new FailureDiagnostics(54321, 54322);
  try {
    const at = performance.now();
    diagnostic.ready(["fixture"]);
    diagnostic.admit("fixture", {
      account: "fixture",
      kind: "fresh",
      active: 1,
      at,
      waitMs: 0,
      protectedHistory: false,
    });
    diagnostic.assertCurrent("fixture");
    const observed = diagnostic.imapOptions("fixture", {
      host: "fixture.invalid",
      port: 54322,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    const logger = observed.logger as {
      debug: (entry: { src: string; msg: string }) => void;
    };
    logger.debug({
      src: "c",
      msg: "A1 AUTHENTICATE PLAIN secret-fixture-payload",
    });
    diagnostic.finish("fixture", 200);
    const trace = diagnostic.traces[0];
    assert.equal(trace.deadline, at + 4000);
    assert(trace.events.some((e) => e.phase === "execution.start"));
    assert(trace.events.some((e) => e.phase === "imap.AUTHENTICATE.sent"));
    assert(trace.events.some((e) => e.phase === "scheduler.slot-released"));
    assert(!JSON.stringify(trace).includes("secret-fixture-payload"));
  } finally {
    diagnostic.restore();
  }
  assert.equal(net.connect, originalNet);
  assert.equal(tls.connect, originalTls);
  console.log(
    "Diagnostic preflight PASS: attribution, deadline, command redaction and observer restoration",
  );
}
