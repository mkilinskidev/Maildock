import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger";

type Stage =
  | "credentials"
  | "connect_auth"
  | "mailbox_selection"
  | "new_uids"
  | "changed_flags"
  | "uid_presence"
  | "status"
  | "persistence"
  | "teardown"
  | "mime_discovery"
  | "content_fetch"
  | "sanitization"
  | "oauth_lock"
  | "oauth_http";
type Operation = "delta" | "content" | "google_credentials";
type Trace = {
  stages: Partial<Record<Stage, { durationMs: number; calls: number }>>;
  failedStage?: Stage;
  lastStage?: Stage;
  errorCode?: string;
  localUids?: number;
  returnedUids?: number;
  condstore?: boolean;
};
const storage = new AsyncLocalStorage<Trace>();
const logger = createLogger({ logLevel: "info" });

export function recordPerformanceError(error: unknown) {
  const trace = storage.getStore();
  if (trace) trace.failedStage ??= trace.lastStage;
  const code = (error as { code?: unknown })?.code;
  if (
    trace &&
    typeof code === "string" &&
    [
      "CONNECT_TIMEOUT",
      "GREETING_TIMEOUT",
      "UPGRADE_TIMEOUT",
      "ETIMEOUT",
      "ETIMEDOUT",
      "EAUTH",
      "ECONNRESET",
      "EPIPE",
      "ABORT_ERR",
      "ECANCELLED",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(code.toUpperCase())
  )
    trace.errorCode ??= code.toUpperCase();
}
export function beginStage(stage: Stage) {
  const trace = storage.getStore();
  const start = performance.now();
  if (trace) trace.lastStage = stage;
  return (failed = false) => {
    if (!trace) return;
    const entry = (trace.stages[stage] ??= { durationMs: 0, calls: 0 });
    entry.durationMs += performance.now() - start;
    entry.calls++;
    if (failed && !trace.failedStage) trace.failedStage = stage;
  };
}
export async function measureStage<T>(
  stage: Stage,
  work: () => Promise<T>,
): Promise<T> {
  const finish = beginStage(stage);
  try {
    const result = await work();
    finish();
    return result;
  } catch (error) {
    recordPerformanceError(error);
    finish(true);
    throw error;
  }
}
export function reconciliationMetrics(
  localUids: number,
  returnedUids: number,
  condstore: boolean,
) {
  const trace = storage.getStore();
  if (trace) Object.assign(trace, { localUids, returnedUids, condstore });
}
export async function withPerformance<T>(
  operation: Operation,
  work: () => Promise<T>,
  attempt?: number,
  queue?: { eligibilityDelayMs: number; originalQueueAgeMs: number },
): Promise<T> {
  if (storage.getStore()) return work();
  const trace: Trace = { stages: {} };
  const start = performance.now();
  let success = false;
  let category = "internal_error";
  return storage.run(trace, async () => {
    try {
      const result = await work();
      success = true;
      return result;
    } catch (error) {
      const value = (error as { category?: unknown })?.category;
      if (
        typeof value === "string" &&
        /^(connection_timeout|socket_timeout|provider_disconnected|cancelled|authentication_rejected|tls_certificate_failure|starttls_unavailable|dns_or_host_unreachable|verification_failed)$/.test(
          value,
        )
      )
        category = value;
      throw error;
    } finally {
      // Telemetry is best effort and never participates in operation outcomes.
      try {
        logger.info(
          {
            event: "mail.performance",
            operation,
            correlationId: randomUUID(),
            attempt,
            queue,
            success,
            category: success ? undefined : category,
            durationMs: performance.now() - start,
            ...trace,
          },
          "Mail operation stage summary",
        );
      } catch {
        /* best effort */
      }
    }
  });
}

/** Protocol promises and drained FETCH generators retain their original behavior. */
export function instrumentImap<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        let stage: Stage | undefined;
        if (key === "connect") stage = "connect_auth";
        if (key === "mailboxOpen") stage = "mailbox_selection";
        if (key === "status") stage = "status";
        if (["mailboxClose", "logout", "close"].includes(String(key)))
          stage = "teardown";
        if (key === "search")
          stage = String((args[0] as { uid?: string })?.uid ?? "*").includes(
            "*",
          )
            ? "new_uids"
            : "uid_presence";
        if (key === "fetch")
          stage = (args[1] as { envelope?: boolean })?.envelope
            ? "new_uids"
            : (args[1] as { flags?: boolean })?.flags
              ? "changed_flags"
              : "uid_presence";
        if (!stage) return Reflect.apply(value, target, args);
        const finish = beginStage(stage);
        try {
          const result: unknown = Reflect.apply(value, target, args);
          if (
            result &&
            typeof result === "object" &&
            Symbol.asyncIterator in result
          ) {
            return (async function* () {
              let failed = false;
              try {
                return yield* result as AsyncIterable<unknown>;
              } catch (error) {
                recordPerformanceError(error);
                failed = true;
                throw error;
              } finally {
                finish(failed);
              }
            })();
          }
          if (result instanceof Promise)
            return result.then(
              (answer) => {
                finish();
                return answer;
              },
              (error) => {
                recordPerformanceError(error);
                finish(true);
                throw error;
              },
            );
          finish();
          return result;
        } catch (error) {
          finish(true);
          throw error;
        }
      };
    },
  });
}
