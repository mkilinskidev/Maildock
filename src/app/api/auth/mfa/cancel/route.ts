import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import {
  cancelMfaSchema,
  cancelMfaLogin,
} from "@/modules/auth/application/mfa-login";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return routeBoundary(async () => {
    const config = getConfig();
    return initialMfaHttp(
      request,
      config,
      cancelMfaSchema,
      () => cancelMfaLogin(db, config, request.headers),
      "Sign in could not be completed.",
    );
  });
}
