import { checkReadiness } from "@/modules/platform/infrastructure/readiness";
import { getConfig } from "@/shared/infrastructure/config/config";
import { sqlClient } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export async function GET() {
  const ready = await checkReadiness({ config: getConfig(), query: sqlClient });
  return Response.json(
    { status: ready ? "ready" : "unavailable" },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
