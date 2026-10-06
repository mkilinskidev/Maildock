import { eq } from "drizzle-orm";
import { getValidSession } from "@/modules/auth/application/session-validation";
import { hasValidOrigin } from "@/modules/auth/application/origin";
import type { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import type { AppConfig } from "@/shared/infrastructure/config/config";
import type { Database } from "@/shared/infrastructure/database/database";
import { session } from "@/shared/infrastructure/database/schema";
import type { Logger } from "pino";

export async function logoutCurrentSession(
  request: Request,
  auth: ReturnType<typeof createAuth>,
  database: Database,
  config: Pick<AppConfig, "appOrigin">,
  logger: Pick<Logger, "error">,
) {
  // Check before authentication or cookie cleanup, including on DB failures.
  if (!hasValidOrigin(request, config))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });

  let status = 500;
  try {
    const current = await getValidSession(auth, request.headers);
    if (!current) {
      status = 401;
    } else {
      const exactSession = eq(session.id, current.session.id);
      await database.delete(session).where(exactSession);
      // A no-op delete (including a trigger suppressing deletion) is not proof.
      const remaining = await database
        .select({ id: session.id })
        .from(session)
        .where(exactSession)
        .limit(1);
      if (remaining.length) throw new Error("Revocation unconfirmed");
      status = 200;
    }
  } catch {
    // Do not log raw DB errors: they may contain credentials or session tokens.
    logger.error(
      { event: "logout_revocation_failed" },
      "Logout could not be confirmed.",
    );
  }

  const response = Response.json(
    status === 200
      ? { success: true }
      : {
          error:
            "Sign out could not be confirmed. Your session may still be active.",
        },
    { status, headers: { "Cache-Control": "no-store" } },
  );
  try {
    const cleanup = await auth.api.clearLogoutCookies({
      headers: request.headers,
      asResponse: true,
    });
    if (!cleanup.ok) throw new Error("Cookie cleanup failed");
    for (const cookie of cleanup.headers.getSetCookie())
      response.headers.append("Set-Cookie", cookie);
  } catch {
    logger.error(
      { event: "logout_cookie_cleanup_failed" },
      "Logout cookie cleanup failed.",
    );
    // Revocation, if confirmed, remains authoritative despite cleanup failure.
  }
  return response;
}
