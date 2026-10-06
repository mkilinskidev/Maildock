import { securityEvent } from "../../../shared/infrastructure/logging/security-events";
import { z } from "zod";
import { hasValidOrigin } from "./origin";
import { requireJsonMediaType } from "./json-media-type";
import {
  BootstrapAuthorizationError,
  SetupThrottledError,
} from "./instance-auth";
import { InitialMfaRejected } from "./initial-mfa";
import type { AppConfig } from "@/shared/infrastructure/config/config";
import {
  AuthThrottledError,
  authThrottleResponse,
} from "../infrastructure/auth-admission";

class BodyRejected extends Error {}
export async function initialMfaHttp<T>(
  request: Request,
  config: AppConfig,
  schema: z.ZodType<T>,
  operation: (input: T) => Promise<Response | object>,
  errorMessage = "Initial MFA enrollment could not be completed.",
) {
  const sensitive = { "Cache-Control": "no-store" };
  const error = (status: number) =>
    Response.json({ error: errorMessage }, { status, headers: sensitive });
  try {
    if (!hasValidOrigin(request, config)) return error(403);
    if (requireJsonMediaType(request)) return error(415);
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > 4096)
    )
      return error(413);
    if (!request.body) return error(400);
    const reader = request.body.getReader();
    const bytes = new Uint8Array(4096);
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (size + chunk.value.length > bytes.length)
              throw new BodyRejected();
            bytes.set(chunk.value, size);
            size += chunk.value.length;
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => {});
            reject(new BodyRejected());
          }, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
    let input: T;
    try {
      input = schema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, size),
          ),
        ),
      );
    } catch {
      return error(400);
    }
    const result = await operation(input);
    if (result instanceof Response) {
      result.headers.set("Cache-Control", "no-store");
      return result;
    }
    return Response.json(result, { headers: sensitive });
  } catch (cause) {
    if (cause instanceof AuthThrottledError)
      return authThrottleResponse(cause.retryAfter);
    if (cause instanceof BodyRejected) return error(413);
    if (
      cause instanceof InitialMfaRejected ||
      cause instanceof BootstrapAuthorizationError
    ) {
      securityEvent("proof_rejected");
      return error(403);
    }
    if (cause instanceof SetupThrottledError) {
      securityEvent("admission_rejected");
      const response = error(429);
      response.headers.set("Retry-After", "60");
      return response;
    }
    return error(503);
  }
}
