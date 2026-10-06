import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import {
  totpLoginSchema,
  verifyMfaLogin,
} from "@/modules/auth/application/mfa-login";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const config = getConfig();
  return initialMfaHttp(
    request,
    config,
    totpLoginSchema,
    (input) => verifyMfaLogin(db, config, request.headers, input.code, "totp"),
    "Sign in could not be completed.",
  );
}
