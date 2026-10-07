import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { outgoingMessageService } from "@/modules/accounts/infrastructure/accounts";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const id = z.uuid().safeParse((await params).id);
    if (!id.success)
      return Response.json(
        { error: "Invalid outgoing message." },
        { status: 400 },
      );
    try {
      const result = await outgoingMessageService.status(id.data);
      return result
        ? Response.json(result, { headers: { "Cache-Control": "no-store" } })
        : Response.json(
            { error: "Outgoing message not found." },
            { status: 404 },
          );
    } catch {
      return Response.json(
        { error: "Send status could not be loaded." },
        { status: 500 },
      );
    }
  });
}
