import { z, ZodError } from "zod";

import { messageService } from "@/modules/accounts/infrastructure/accounts";
import { MailboxNotFoundError } from "@/modules/mail/application/message-service";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; mailboxId: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const values = await params;
    const accountId = z.uuid().parse(values.id);
    const mailboxId = z.uuid().parse(values.mailboxId);
    const url = new URL(request.url);
    const pageSize = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .parse(url.searchParams.get("pageSize") ?? undefined);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    return Response.json(
      await messageService.list(accountId, mailboxId, pageSize, cursor),
    );
  } catch (error) {
    if (error instanceof MailboxNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (
      error instanceof ZodError ||
      (error instanceof Error && error.message === "Invalid cursor.")
    )
      return Response.json(
        { error: "Invalid message list request." },
        { status: 400 },
      );
    return Response.json(
      { error: "Messages could not be listed." },
      { status: 500 },
    );
  }
}
