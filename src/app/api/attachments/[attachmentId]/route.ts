import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { attachmentService } from "@/modules/accounts/infrastructure/accounts";
import { AttachmentUnavailableError } from "@/modules/mail/application/attachment-service";

type Context = { params: Promise<{ attachmentId: string }> };
export async function GET(request: Request, { params }: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    return Response.json(
      await attachmentService.status(
        z.uuid().parse((await params).attachmentId),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: "Attachment is unavailable." },
      {
        status:
          error instanceof z.ZodError
            ? 400
            : error instanceof AttachmentUnavailableError
              ? 404
              : 500,
      },
    );
  }
}
export async function POST(request: Request, { params }: Context) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    await attachmentService.request(
      z.uuid().parse((await params).attachmentId),
    );
    return Response.json({ status: "preparing" }, { status: 202 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof AttachmentUnavailableError
            ? error.message
            : "Attachment could not be prepared.",
      },
      {
        status:
          error instanceof z.ZodError
            ? 400
            : error instanceof AttachmentUnavailableError
              ? 409
              : 500,
      },
    );
  }
}
