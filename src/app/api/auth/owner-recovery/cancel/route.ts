import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import {
  ownerRecoveryCeremony,
  recoveryEmptySchema,
} from "@/modules/auth/application/owner-recovery";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return routeBoundary(async () => {
    const config = getConfig();
    return initialMfaHttp(
      request,
      config,
      recoveryEmptySchema,
      () => ownerRecoveryCeremony(db, config, request.headers, "cancel"),
      "Recovery enrollment could not be completed.",
    );
  });
}
