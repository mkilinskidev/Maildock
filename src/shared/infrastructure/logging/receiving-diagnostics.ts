import { bestEffortDiagnostic } from "./diagnostics";
import { createLogger } from "./logger";

let logger: Pick<ReturnType<typeof createLogger>, "info"> = createLogger({
  logLevel: "info",
});
export function configureReceivingDiagnostics(configured: typeof logger) {
  logger = configured;
}
const lastBlocked = new Map<string, number>();

/** Deliberate field allowlist. Never pass dependency errors or provider text. */
export function receivingDiagnostic(fields: {
  event:
    | "oauth.refresh"
    | "receiving.credentials"
    | "receiving.operation"
    | "receiving.publication"
    | "receiving.account";
  operation?: string;
  correlation?: string;
  stage: string;
  phase?: string;
  category: string;
  disposition?: "retry" | "reconnect" | "continue" | "recover";
  issued?: boolean;
  elapsedMs?: number;
}) {
  if (
    fields.event === "receiving.credentials" ||
    fields.stage === "before_claim"
  ) {
    const key = `${fields.event}:${fields.operation}:${fields.category}`;
    const now = performance.now();
    if (now - (lastBlocked.get(key) ?? -Infinity) < 30_000) return;
    if (lastBlocked.size >= 128)
      lastBlocked.delete(lastBlocked.keys().next().value!);
    lastBlocked.set(key, now);
  }
  bestEffortDiagnostic(() =>
    logger.info(
      {
        event: fields.event,
        operation: fields.operation,
        correlation: fields.correlation,
        stage: fields.stage,
        phase: fields.phase,
        category: fields.category,
        disposition: fields.disposition,
        issued: fields.issued,
        elapsedMs: fields.elapsedMs,
      },
      "Receiving lifecycle",
    ),
  );
}
