import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { z, ZodError } from "zod";
import {
  messageService,
  mailPublicationService,
} from "@/modules/accounts/infrastructure/accounts";
import { publicationRequest } from "@/modules/mail/application/publication-request";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function GET(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    try {
      const url = new URL(request.url);
      const pageSize = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .parse(url.searchParams.get("pageSize") ?? undefined);
      const cursor = z
        .string()
        .max(512)
        .optional()
        .parse(url.searchParams.get("cursor") ?? undefined);
      return Response.json(
        url.searchParams.get("coherent") === "1"
          ? await mailPublicationService.snapshot({
              pageSize,
              cursor,
              ...publicationRequest(url),
            })
          : await messageService.listAllInboxes(pageSize, cursor),
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
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
