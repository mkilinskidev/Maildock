import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { ConversationService } from "@/modules/mail/application/conversation-service";

export async function GET(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  return Response.json({
    enabled: await new ConversationService(db).enabled(),
  });
}

export async function PUT(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const unsupported = requireJsonMediaType(request);
  if (unsupported) return unsupported;
  const input = z
    .object({ enabled: z.boolean() })
    .safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json(
      { error: "Invalid conversation view setting." },
      { status: 400 },
    );
  await new ConversationService(db).setEnabled(input.data.enabled);
  return Response.json(input.data);
}
