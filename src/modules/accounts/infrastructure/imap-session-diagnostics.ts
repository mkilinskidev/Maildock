import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ImapFlowOptions } from "imapflow";
import { createLogger } from "../../../shared/infrastructure/logging/logger";

export type ImapDiagnosticContext = Readonly<{
  accountId?: string;
  operation:
    | "append"
    | "sent_copy_lookup"
    | "message_command"
    | "connection_test"
    | "discovery"
    | "recent_sync"
    | "backfill_sync"
    | "delta_sync"
    | "attachment"
    | "message_content"
    | "idle";
}>;

const commands = new Set([
  "CAPABILITY",
  "ID",
  "STARTTLS",
  "AUTHENTICATE",
  "LOGIN",
  "NAMESPACE",
  "COMPRESS",
  "ENABLE",
  "SELECT",
  "EXAMINE",
  "LIST",
  "LSUB",
  "STATUS",
  "SEARCH",
  "ESEARCH",
  "FETCH",
  "STORE",
  "COPY",
  "MOVE",
  "APPEND",
  "EXPUNGE",
  "CLOSE",
  "UNSELECT",
  "NOOP",
  "IDLE",
  "LOGOUT",
  "UID",
]);
const timeouts = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
]);
const sessions = new Map<string, number>();
const failureSessions = new WeakMap<object, string>();
const logger = createLogger({ logLevel: "info" });

export function imapFailureSessionId(error: unknown): string | undefined {
  return error !== null && typeof error === "object"
    ? failureSessions.get(error)
    : undefined;
}

/** Discards protocol text immediately; only fixed tokens and timings survive. */
export function createImapSessionDiagnostics(
  context: ImapDiagnosticContext,
  options: Pick<
    ImapFlowOptions,
    "connectionTimeout" | "greetingTimeout" | "socketTimeout"
  >,
  write: (entry: Record<string, unknown>) => void = (entry) =>
    logger.warn(entry, "IMAP session timed out"),
  now: () => number = () => performance.now(),
) {
  const sessionId = randomUUID();
  const started = now();
  let lastSent: number | undefined;
  let lastReceived: number | undefined;
  let pending: { tag: string; command: string; started: number } | undefined;
  let completed: { command: string; durationMs: number } | undefined;
  let tlsEstablished = false;
  let authenticated = false;
  let compressionEnabled = false;
  let reported = false;
  let released = false;
  const key = context.accountId;
  if (key) sessions.set(key, (sessions.get(key) ?? 0) + 1);
  const elapsed = (from: number | undefined, at: number) =>
    from === undefined ? undefined : Math.max(0, Math.round(at - from));

  function close() {
    if (released) return;
    released = true;
    if (!key) return;
    const remaining = (sessions.get(key) ?? 1) - 1;
    if (remaining > 0) sessions.set(key, remaining);
    else sessions.delete(key);
  }

  function failure(error: unknown) {
    try {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !timeouts.has(code)) return;
      if (error !== null && typeof error === "object")
        failureSessions.set(error, sessionId);
      if (reported) return;
      reported = true;
      const at = now();
      write({
        event: "mail.imap_session_timeout",
        ...context,
        imapSessionId: sessionId,
        errorCode: code,
        sessionDurationMs: elapsed(started, at),
        pendingCommand: pending?.command,
        commandDurationMs: elapsed(pending?.started, at),
        lastCompletedCommand: completed?.command,
        lastCompletedCommandDurationMs: completed?.durationMs,
        sinceLastSendMs: elapsed(lastSent, at),
        sinceLastReceiveMs: elapsed(lastReceived, at),
        tlsEstablished,
        authenticated,
        compressionEnabled,
        activeAccountSessionsInProcess: key
          ? (sessions.get(key) ?? 0)
          : undefined,
        connectionTimeoutMs: options.connectionTimeout,
        greetingTimeoutMs: options.greetingTimeout,
        socketTimeoutMs: options.socketTimeout,
      });
    } catch {
      // Diagnostics must never change a protocol result or its teardown.
    }
  }

  function observe(value: unknown) {
    try {
      if (!value || typeof value !== "object") return;
      const entry = value as Record<string, unknown>;
      const at = now();
      if (entry.src === "c") {
        lastSent = at;
        if (typeof entry.msg === "string") {
          const match = /^([a-zA-Z0-9]+) ([A-Z]+)(?:\s|$)/.exec(entry.msg);
          if (match && commands.has(match[2])) {
            // UID is a prefix, never log its arguments (UIDs, paths or searches).
            const command =
              match[2] === "UID"
                ? (/^\w+ UID (SEARCH|FETCH|STORE|COPY|MOVE|EXPUNGE)(?:\s|$)/.exec(
                    entry.msg,
                  )?.[1] ?? "UID")
                : match[2];
            pending = { tag: match[1], command, started: at };
          }
        }
      } else if (entry.src === "s") {
        lastReceived = at;
        if (pending && typeof entry.msg === "string") {
          const match = /^([a-zA-Z0-9]+) (OK|NO|BAD)(?:\s|$)/.exec(entry.msg);
          if (match?.[1] === pending.tag) {
            if (pending.command === "COMPRESS" && match[2] === "OK")
              compressionEnabled = true;
            completed = {
              command: pending.command,
              durationMs: elapsed(pending.started, at)!,
            };
            pending = undefined;
          }
        }
      }
      if (entry.src === "connection" && entry.secure === true)
        tlsEstablished = true;
      if (entry.src === "auth" && entry.msg === "User authenticated")
        authenticated = true;
      if (entry.msg === "Socket timeout") failure({ code: "ETIMEOUT" });
      if (entry.err) failure(entry.err);
      if (entry.msg === "Connection closed") close();
    } catch {
      // Raw library entries are neither forwarded nor retained.
    }
  }

  return {
    logger: {
      trace: observe,
      debug: observe,
      info: observe,
      warn: observe,
      error: observe,
      fatal: observe,
    },
    failure,
    close,
  };
}
