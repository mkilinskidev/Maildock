import { z } from "zod";
import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { getConfig } from "@/shared/infrastructure/config/config";
import { readSyncObservability } from "@/modules/mail/infrastructure/read-sync-observability";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const headers = { "Cache-Control": "no-store" };
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success)
      return Response.json(
        { error: "Invalid account." },
        { status: 400, headers },
      );
    const diagnostics = await readSyncObservability(
      db,
      id,
      getConfig().mailPollIntervalSeconds,
    );
    return diagnostics
      ? Response.json(diagnostics, { headers })
      : Response.json(
          { error: "Account not found." },
          { status: 404, headers },
        );
  });
}
