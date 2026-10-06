import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import {
  replacementResumeSchema,
  resumeAuthenticatorReplacement,
} from "@/modules/auth/application/mfa-management";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const config = getConfig();
  return initialMfaHttp(
    request,
    config,
    replacementResumeSchema,
    () => resumeAuthenticatorReplacement(db, config, request.headers),
    "MFA management could not be completed.",
  );
}
