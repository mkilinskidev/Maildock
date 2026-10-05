import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { NotificationService } from "@/modules/mail/application/notification-service";

// Polling consumes a durable owner checkpoint, so it is a protected mutation.
export async function POST(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const unsupported = requireJsonMediaType(request);
  if (unsupported) return unsupported;
  const input = z
    .object({ action: z.enum(["start", "poll"]) })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json(
      { error: "Invalid notification request." },
      { status: 400 },
    );
  return Response.json(
    await new NotificationService(db).consume(input.data.action === "start"),
    { headers: { "Cache-Control": "no-store" } },
  );
}
