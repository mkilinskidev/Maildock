import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import {
  replacementCompleteSchema,
  completeAuthenticatorReplacement,
} from "@/modules/auth/application/mfa-management";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const config = getConfig();
  return initialMfaHttp(
    request,
    config,
    replacementCompleteSchema,
    (input) =>
      completeAuthenticatorReplacement(db, config, request.headers, input.code),
    "MFA management could not be completed.",
  );
}
