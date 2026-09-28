import { z, ZodError } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { messageContentService } from "@/modules/accounts/infrastructure/accounts";
import { MessagePlacementNotFoundError } from "@/modules/mail/application/message-content-service";

export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; mailboxId: string; messageId: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const values = await params;
    return Response.json(
      await messageContentService.detail(
        z.uuid().parse(values.id),
        z.uuid().parse(values.mailboxId),
        z.uuid().parse(values.messageId),
      ),
    );
  } catch (error) {
    if (error instanceof MessagePlacementNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid message request." },
        { status: 400 },
      );
    return Response.json(
      { error: "Message could not be loaded." },
      { status: 500 },
    );
  }
}
