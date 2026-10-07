import type { Logger } from "pino";
import type { Job } from "pg-boss";
import { ConfigurationError } from "../config/config";
import { DatabaseAuthorityError } from "../database/database-authority";

export type FailureOperation =
  | "runtime"
  | "startup"
  | "shutdown"
  | "migration"
  | "request"
  | "render"
  | "mailbox-discovery"
  | "recent-sync"
  | "delta-sync"
  | "backfill-sync"
  | "message-content"
  | "attachment"
  | "message-command"
  | "outgoing"
  | "sent-copy";
export type FailureComponent = "jobs" | "worker" | "database" | "web";

// This is an allowlist, NOT an Error/string sanitizer. Never copy properties,
// message, stack, cause or dependency codes from the supplied failure.
export function failureDiagnostic(
  error: unknown,
  component: FailureComponent,
  operation: FailureOperation,
) {
  return {
    event: `${component}.${operation}_failed`,
    component,
    operation,
    category:
      error instanceof ConfigurationError
        ? "configuration"
        : error instanceof DatabaseAuthorityError
          ? error.category
          : "internal_error",
    ...(error instanceof ConfigurationError
      ? {
          configurationField: error.problems.some((problem) =>
            problem.startsWith("APP_ORIGIN:"),
          )
            ? "APP_ORIGIN"
            : "environment",
        }
      : {}),
  };
}

// Logging must never alter an authorization decision or transaction outcome.
export function bestEffortDiagnostic(work: () => void): void {
  try {
    work();
  } catch {
    /* Output failure has no authority over application state. */
  }
}

export function logFailure(
  logger: Pick<Logger, "error" | "fatal">,
  error: unknown,
  component: FailureComponent,
  operation: FailureOperation,
  level: "error" | "fatal" = "error",
) {
  bestEffortDiagnostic(() =>
    logger[level](
      failureDiagnostic(error, component, operation),
      "Maildock operation failed",
    ),
  );
}

export class SafeJobFailure extends Error {
  readonly category = "internal_error";
  constructor(readonly operation: FailureOperation) {
    super(`Maildock job failed: ${operation}`);
    this.name = "SafeJobFailure";
    // pg-boss serialize-error copies stack. There is no original error/cause,
    // and even our generated call-site stack is unnecessary durable output.
    this.stack = undefined;
  }
}

export function safeJobHandler<R>(
  operation: FailureOperation,
  handler: (batch: Job<unknown>[]) => Promise<R>,
): (batch: Job<unknown>[]) => Promise<R> {
  return async (batch) => {
    try {
      return await handler(batch);
    } catch {
      throw new SafeJobFailure(operation);
    }
  };
}
