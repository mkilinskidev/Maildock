import { z, ZodError } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { messageContentService } from "@/modules/accounts/infrastructure/accounts";
import {
  MessageContentUnavailableError,
  MessagePlacementNotFoundError,
} from "@/modules/mail/application/message-content-service";

export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; mailboxId: string; messageId: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const values = await params;
    const scheduled = await messageContentService.request(
      z.uuid().parse(values.id),
      z.uuid().parse(values.mailboxId),
      z.uuid().parse(values.messageId),
    );
    return Response.json({ scheduled }, { status: 202 });
  } catch (error) {
    if (error instanceof MessagePlacementNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof MessageContentUnavailableError)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid message request." },
        { status: 400 },
      );
    return Response.json(
      { error: "Content fetch could not be scheduled." },
      { status: 500 },
    );
  }
}
