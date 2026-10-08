import { createLogger } from "./logger";
import { bestEffortDiagnostic } from "./diagnostics";

export type SecurityEvent =
  | "owner_recovery_started"
  | "owner_recovery_restarted"
  | "owner_recovery_completed"
  | "setup_completed"
  | "mfa_login_completed"
  | "mfa_enrollment_completed"
  | "recovery_code_consumed"
  | "authenticator_replacement_started"
  | "authenticator_replacement_completed"
  | "recovery_codes_regenerated"
  | "admission_rejected"
  | "proof_rejected"
  | "session_failed"
  | "invariant_rejected";

// Finite, instance-wide slots: no caller-controlled keys, timers or payloads.
// Public failure signals coalesce per event/process/minute. Existing admission
// still exclusively controls work; this only bounds best-effort output volume.
const lastFailure = new Map<SecurityEvent, number>();
const failures = new Set<SecurityEvent>([
  "admission_rejected",
  "proof_rejected",
  "session_failed",
  "invariant_rejected",
]);
let logger: ReturnType<typeof createLogger> | undefined;
export function securityEvent(event: SecurityEvent) {
  bestEffortDiagnostic(() => {
    const failure = failures.has(event);
    if (failure) {
      const now = Date.now();
      if (now - (lastFailure.get(event) ?? -Infinity) < 60_000) return;
      lastFailure.set(event, now);
    }
    // Configuration is intentionally not read here: audit output must also be
    // safe during configuration failure and cannot break committed ceremonies.
    logger ??= createLogger({ logLevel: "info" });
    logger[failure ? "warn" : "info"](
      {
        event: `security.${event}`,
        component: "auth",
        category: "security",
        outcome: failure ? "rejected" : "completed",
      },
      "Maildock security event",
    );
  });
}
