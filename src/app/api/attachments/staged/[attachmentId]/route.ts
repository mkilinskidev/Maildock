import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { attachmentService } from "@/modules/accounts/infrastructure/accounts";
import { AttachmentUnavailableError } from "@/modules/mail/application/attachment-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const resource = await attachmentService.composeResource(
      z.uuid().parse(new URL(request.url).searchParams.get("draftId")),
      z.uuid().parse((await params).attachmentId),
    );
    return new Response(new Uint8Array(resource.bytes), {
      headers: {
        "Content-Type": resource.type,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return Response.json(
      { error: "Inline image is unavailable." },
      { status: 404 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
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
