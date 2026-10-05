import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { RemoteContentSenderService } from "@/modules/mail/application/remote-content-sender-service";
export async function GET(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  return Response.json(await new RemoteContentSenderService(db).list(), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
export async function DELETE(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const unsupported = requireJsonMediaType(request);
  if (unsupported) return unsupported;
  const input = z
    .object({ address: z.string().min(1).max(320) })
    .safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json({ error: "Invalid sender." }, { status: 400 });
  await new RemoteContentSenderService(db).remove(
    input.data.address.trim().toLowerCase(),
  );
  return Response.json({ removed: true });
}
