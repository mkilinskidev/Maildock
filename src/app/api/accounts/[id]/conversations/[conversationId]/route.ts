import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { ConversationService } from "@/modules/mail/application/conversation-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; conversationId: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const input = z
      .object({ id: z.uuid(), conversationId: z.uuid() })
      .safeParse(await params);
    if (!input.success)
      return Response.json({ error: "Invalid conversation." }, { status: 400 });
    const url = new URL(request.url);
    const options = z
      .object({
        metadataOnly: z.enum(["true", "false"]).default("false"),
        mailboxId: z.uuid().optional(),
      })
      .safeParse({
        metadataOnly: url.searchParams.get("metadataOnly") ?? undefined,
        mailboxId: url.searchParams.get("mailboxId") ?? undefined,
      });
    if (!options.success)
      return Response.json(
        { error: "Invalid conversation request." },
        { status: 400 },
      );
    const items = await new ConversationService(db).open(
      input.data.id,
      input.data.conversationId,
      options.data.metadataOnly === "true",
      options.data.mailboxId,
    );
    if (!items.length)
      return Response.json(
        { error: "Conversation not found." },
        { status: 404 },
      );
    return Response.json({ items });
  });
}
