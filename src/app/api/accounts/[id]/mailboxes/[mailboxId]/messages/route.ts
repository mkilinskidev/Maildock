import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { z, ZodError } from "zod";

import {
  messageService,
  mailPublicationService,
} from "@/modules/accounts/infrastructure/accounts";
import { publicationRequest } from "@/modules/mail/application/publication-request";
import { MailboxNotFoundError } from "@/modules/mail/application/message-service";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; mailboxId: string }> },
) {
  return routeBoundary(async () => {
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
        url.searchParams.get("coherent") === "1"
          ? await mailPublicationService.snapshot({
              accountId,
              mailboxId,
              pageSize,
              cursor,
              ...publicationRequest(url),
            })
          : await messageService.list(accountId, mailboxId, pageSize, cursor),
        { headers: { "Cache-Control": "no-store" } },
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
  });
}
