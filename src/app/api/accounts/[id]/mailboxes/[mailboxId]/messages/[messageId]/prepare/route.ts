import { ZodError } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { composePreparationService } from "@/modules/accounts/infrastructure/accounts";
import { ReplyUnavailableError } from "@/modules/mail/domain/reply-forward";
import {
  MessageContentUnavailableError,
  MessagePlacementNotFoundError,
} from "@/modules/mail/application/message-content-service";
import { composeMode } from "@/modules/mail/domain/compose-source";

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; mailboxId: string; messageId: string }>;
  },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const { id, mailboxId, messageId } = await params;
    const mode = composeMode.parse(
      new URL(request.url).searchParams.get("mode"),
    );
    const result = await composePreparationService.prepare({
      accountId: id,
      mailboxId,
      messageId,
      mode,
    });
    return Response.json(result, {
      status: result.status === "pending" ? 202 : 200,
    });
  } catch (error) {
    if (error instanceof MessagePlacementNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (
      error instanceof ReplyUnavailableError ||
      error instanceof MessageContentUnavailableError
    )
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid preparation request." },
        { status: 400 },
      );
    return Response.json(
      { error: "Message could not be prepared." },
      { status: 500 },
    );
  }
}
