import { Readable } from "node:stream";
import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { attachmentService } from "@/modules/accounts/infrastructure/accounts";
import { AttachmentUnavailableError } from "@/modules/mail/application/attachment-service";
import { downloadDisposition } from "@/modules/mail/domain/attachments";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    try {
      const { stream, size, filename } = await attachmentService.downloadStream(
        z.uuid().parse((await params).attachmentId),
        request.signal,
      );
      return new Response(
        Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
            "Content-Disposition": downloadDisposition(filename),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    } catch (error) {
      return Response.json(
        { error: "Attachment is unavailable. Prepare it again." },
        {
          status:
            error instanceof z.ZodError
              ? 400
              : error instanceof AttachmentUnavailableError
                ? 409
                : 503,
        },
      );
    }
  });
}
