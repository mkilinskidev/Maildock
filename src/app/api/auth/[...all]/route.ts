import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/modules/auth/infrastructure/auth";
import { logoutCurrentSession } from "@/modules/auth/application/logout";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";
import { createLogger } from "@/shared/infrastructure/logging/logger";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { hasValidOrigin } from "@/modules/auth/application/origin";

export const dynamic = "force-dynamic";

const handler = toNextJsHandler(auth);

// Login adds bounded JSON/work admission in createAuth; Better Auth 1.7.7
// also enforces Origin/CSRF (trustedOrigins = [APP_ORIGIN], neither disabled).
// Its login/session protocol must not pass through the owner-session guard.

export async function GET(request: Request) {
  return routeBoundary(async () => {
    if (!new URL(request.url).pathname.endsWith("/get-session")) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handler.GET(request);
  });
}

export async function POST(request: Request) {
  return routeBoundary(async () => {
    const pathname = new URL(request.url).pathname;
    if (
      !pathname.endsWith("/sign-in/username") &&
      !pathname.endsWith("/sign-out")
    ) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    if (pathname.endsWith("/sign-out")) {
      const config = getConfig();
      const logger = createLogger(config);
      if (!hasValidOrigin(request, config))
        return Response.json(
          { error: "Invalid request origin." },
          { status: 403 },
        );
      // Preserve the existing JSON protocol; bodyless logout is also supported.
      if (request.body !== null) {
        const unsupported = requireJsonMediaType(request);
        if (unsupported) return unsupported;
      }
      return logoutCurrentSession(request, auth, db, config, logger);
    }

    return handler.POST(request);
  });
}
