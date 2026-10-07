import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { z, ZodError } from "zod";

import { messageService } from "@/modules/accounts/infrastructure/accounts";
import {
  MailboxNotFoundError,
  MailboxNotSynchronizableError,
} from "@/modules/mail/application/message-service";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; mailboxId: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    try {
      const values = await params;
      const scheduled = await messageService.requestSync(
        z.uuid().parse(values.id),
        z.uuid().parse(values.mailboxId),
      );
      return Response.json({ scheduled }, { status: 202 });
    } catch (error) {
      if (error instanceof MailboxNotFoundError)
        return Response.json({ error: error.message }, { status: 404 });
      if (error instanceof MailboxNotSynchronizableError)
        return Response.json({ error: error.message }, { status: 409 });
      if (error instanceof ZodError)
        return Response.json(
          { error: "Invalid mailbox request." },
          { status: 400 },
        );
      return Response.json(
        { error: "Synchronization could not be scheduled." },
        { status: 500 },
      );
    }
  });
}
