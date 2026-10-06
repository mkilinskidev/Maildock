import { securityEvent } from "../../../shared/infrastructure/logging/security-events";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { withInitialMfaBoundary } from "../infrastructure/auth-factory";
import { reserveAuthWork } from "../infrastructure/auth-admission";
import {
  challengeHeaders,
  responseCookies,
} from "../infrastructure/mfa-cookies";
import { getValidBusinessSession } from "./session-validation";
import { isInstanceReady } from "./instance-readiness";
import type { Database } from "@/shared/infrastructure/database/database";
import type { AppConfig } from "@/shared/infrastructure/config/config";

export const totpLoginSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();
export const recoveryLoginSchema = z
  .object({ code: z.string().regex(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/) })
  .strict();
export const cancelMfaSchema = z.object({}).strict();

export async function verifyMfaLogin(
  database: Database,
  config: AppConfig,
  headers: Headers,
  code: string,
  method: "totp" | "recovery",
) {
  await reserveAuthWork(database, "mfa");
  return withInitialMfaBoundary(config, database, async (auth, tx) => {
    if (!(await isInstanceReady(tx)))
      return Response.json(
        { error: "Sign in could not be completed.", restart: true },
        { status: 401 },
      );
    const suppliedHeaders = await challengeHeaders(auth, headers);
    const response =
      method === "totp"
        ? await auth.api.verifyTOTP({
            headers: suppliedHeaders,
            body: { code },
            asResponse: true,
          })
        : await auth.api.verifyBackupCode({
            headers: suppliedHeaders,
            body: { code },
            asResponse: true,
          });
    // Expected failures are responses, so Better Auth's attempt/account writes
    // COMMIT. Throwing here would refund attempts and invalidate its controls.
    if (!response.ok) {
      const result = (await response.json()) as { code?: string };
      const restart =
        result.code === "INVALID_TWO_FACTOR_COOKIE" ||
        result.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE";
      const error = Response.json(
        { error: "Sign in could not be completed.", restart },
        { status: response.status === 429 ? 429 : 401 },
      );
      if (response.status === 429) {
        const rows = await tx.execute<{ retry: number }>(sql`
          select greatest(1, coalesce(ceil(extract(epoch from (max(locked_until) - clock_timestamp()))), 1))::integer as retry from two_factor
        `);
        error.headers.set("Retry-After", String(rows[0].retry));
      }
      if (restart) {
        const cleanup = await auth.api.clearMfaChallengeCookies({
          headers,
          asResponse: true,
        });
        for (const cookie of cleanup.headers.getSetCookie())
          error.headers.append("Set-Cookie", cookie);
      }
      return error;
    }
    // Authorize the exact new session on the same PostgreSQL transaction.
    // Any inconsistency rolls back issuance AND recovery-code consumption.
    if (
      !(await getValidBusinessSession(
        auth,
        new Headers({ cookie: responseCookies(response) }),
      ))
    )
      throw new Error("MFA session could not be authorized.");
    const result = Response.json({ authenticated: true });
    for (const cookie of response.headers.getSetCookie())
      result.headers.append("Set-Cookie", cookie);
    const cleanup = await auth.api.clearMfaChallengeCookies({
      headers,
      asResponse: true,
    });
    for (const cookie of cleanup.headers.getSetCookie())
      result.headers.append("Set-Cookie", cookie);
    return result;
  }).then((result) => {
    if (result instanceof Response && !result.ok) {
      securityEvent(
        result.status === 429 ? "admission_rejected" : "proof_rejected",
      );
      return result;
    }
    securityEvent("mfa_login_completed");
    if (method === "recovery") securityEvent("recovery_code_consumed");
    return result;
  });
}

export async function cancelMfaLogin(
  database: Database,
  config: AppConfig,
  headers: Headers,
) {
  await reserveAuthWork(database, "mfa");
  return withInitialMfaBoundary(config, database, async (auth) => {
    const cleanup = await auth.api.clearMfaChallengeCookies({
      headers,
      asResponse: true,
    });
    // No supported public challenge-deletion API: abandoned verification and
    // attempt rows expire within 600s; Better Auth lazily cleans expired rows.
    return Response.json({ cancelled: true }, { headers: cleanup.headers });
  });
}
