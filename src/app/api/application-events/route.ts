import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import {
  ApplicationEventService,
  parseEventCursor,
} from "@/modules/diagnostics/application/application-event-service";
import { eventQuerySchema } from "@/modules/diagnostics/domain/application-event";
export async function GET(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  const parsed = eventQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success)
    return Response.json(
      { error: "Invalid diagnostic filters." },
      { status: 400, headers },
    );
  try {
    if (parsed.data.cursor) parseEventCursor(parsed.data.cursor);
  } catch {
    return Response.json(
      { error: "Invalid diagnostic cursor." },
      { status: 400, headers },
    );
  }
  try {
    return Response.json(
      await new ApplicationEventService(db).list(parsed.data),
      { headers },
    );
  } catch {
    return Response.json(
      { error: "Application logs could not be loaded." },
      { status: 500, headers },
    );
  }
}
