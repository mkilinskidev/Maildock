import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { initialMfaHttp } from "@/modules/auth/application/initial-mfa-http";
import {
  initialMfaStartSchema,
  startInitialMfa,
} from "@/modules/auth/application/initial-mfa";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return routeBoundary(async () => {
    const config = getConfig();
    return initialMfaHttp(request, config, initialMfaStartSchema, (input) =>
      startInitialMfa(db, config, request.headers, input),
    );
  });
}
