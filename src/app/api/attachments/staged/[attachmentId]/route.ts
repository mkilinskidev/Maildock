import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { attachmentService } from "@/modules/accounts/infrastructure/accounts";
import { AttachmentUnavailableError } from "@/modules/mail/application/attachment-service";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    await attachmentService.removeStaged(
      z.uuid().parse((await params).attachmentId),
    );
    return Response.json({ removed: true });
  } catch (error) {
    return Response.json(
      { error: "Staged attachment is unavailable." },
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
