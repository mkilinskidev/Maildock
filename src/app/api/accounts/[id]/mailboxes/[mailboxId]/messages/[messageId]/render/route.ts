import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import {
  attachmentService,
  messageContentService,
} from "@/modules/accounts/infrastructure/accounts";
import { EmailRenderingService } from "@/modules/mail/application/email-rendering-service";
import { MessagePlacementNotFoundError } from "@/modules/mail/application/message-content-service";

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
    const options = z
      .object({
        loadImages: z.boolean().default(false),
        trustSender: z.boolean().default(false),
      })
      .parse(await request.json());
    const result = await new EmailRenderingService(
      db,
      messageContentService,
      attachmentService,
    ).render(
      z.uuid().parse(values.id),
      z.uuid().parse(values.mailboxId),
      z.uuid().parse(values.messageId),
      options,
    );
    return Response.json(result, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json(
      { error: "Email rendering is unavailable." },
      {
        status:
          error instanceof z.ZodError
            ? 400
            : error instanceof MessagePlacementNotFoundError
              ? 404
              : 503,
      },
    );
  }
}
