import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { outgoingMessageService } from "@/modules/accounts/infrastructure/accounts";
import { OutgoingValidationError } from "@/modules/mail/application/outgoing-message-service";

export async function POST(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      // Bound the request before parsing, including requests without Content-Length.
      const reader = request.body?.getReader();
      if (!reader)
        return Response.json(
          { error: "Invalid compose request." },
          { status: 400 },
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 3_100_000) {
            await reader.cancel();
            return Response.json(
              { error: "Message is too large." },
              { status: 413 },
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return Response.json(await outgoingMessageService.create(input), {
        status: 202,
      });
    } catch (error) {
      if (
        error instanceof OutgoingValidationError ||
        error instanceof SyntaxError
      )
        return Response.json(
          {
            error:
              error instanceof OutgoingValidationError
                ? error.message
                : "Invalid compose request.",
          },
          { status: 400 },
        );
      return Response.json(
        { error: "Message could not be queued." },
        { status: 500 },
      );
    }
  });
}
