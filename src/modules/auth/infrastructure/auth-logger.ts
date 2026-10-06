import type { Logger } from "pino";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";

// Supported Better Auth 1.7.5 logger callback replaces its console sink.
// Discard ALL dependency message/argument content, including Error getters.
const sharedIpWarning =
  "Rate limiting could not determine a client IP and is falling back to a single shared per-path bucket. Ensure your runtime forwards a trusted client IP header, then set `advanced.ipAddress.ipAddressHeaders` or `advanced.ipAddress.trustedProxies` so the address can be resolved.";

export function betterAuthLogger(
  logger: Pick<Logger, "warn" | "error" | "info">,
) {
  return {
    level: "warn" as const,
    log(level: "debug" | "info" | "warn" | "error", message?: unknown) {
      if (level !== "warn" && level !== "error") return;
      // Exact equality with the installed static warning, never string parsing.
      // Do not repeat dependency advice that would weaken the intentional F9 policy.
      if (level === "warn" && message === sharedIpWarning) {
        bestEffortDiagnostic(() =>
          logger.info(
            {
              event: "auth.shared_path_limiter",
              component: "better_auth",
              category: "policy",
            },
            "V1 intentionally uses shared path limiting without trusted client IP",
          ),
        );
        return;
      }
      bestEffortDiagnostic(() =>
        logger[level](
          {
            event:
              level === "error"
                ? "auth.dependency_error"
                : "auth.dependency_warning",
            component: "better_auth",
            category: "dependency",
          },
          "Authentication dependency diagnostic",
        ),
      );
    },
  };
}
