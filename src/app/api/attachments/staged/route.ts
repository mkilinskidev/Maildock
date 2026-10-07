import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { attachmentService } from "@/modules/accounts/infrastructure/accounts";
import { BlobLimitError } from "@/shared/application/blob-storage";
import { z } from "zod";
import { AttachmentUnavailableError } from "@/modules/mail/application/attachment-service";

/** Raw single-file request avoids buffering multipart FormData before limits. */
export async function POST(request: Request) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  if (!request.body)
    return Response.json({ error: "A file is required." }, { status: 400 });
  try {
    const filename = decodeURIComponent(
      request.headers.get("X-Attachment-Filename") ?? "Attachment",
    );
    const stream = Readable.fromWeb(
      request.body as NodeReadableStream<Uint8Array>,
    );
    return Response.json(
      await attachmentService.upload(
        stream,
        filename,
        request.headers.get("Content-Type"),
        request.headers.has("X-Draft-Id")
          ? z.uuid().parse(request.headers.get("X-Draft-Id"))
          : undefined,
        request.headers.get("X-Attachment-Disposition") === "inline",
      ),
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof BlobLimitError
            ? error.message
            : error instanceof AttachmentUnavailableError
              ? error.message
              : "Attachment upload failed.",
      },
      {
        status:
          error instanceof BlobLimitError
            ? 413
            : error instanceof URIError ||
                error instanceof z.ZodError ||
                error instanceof AttachmentUnavailableError
              ? 400
              : 500,
      },
    );
  }
}
