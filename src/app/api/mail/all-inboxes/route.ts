import { z, ZodError } from "zod";
import { messageService } from "@/modules/accounts/infrastructure/accounts";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function GET(request: Request) {
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
      await messageService.listAllInboxes(pageSize, cursor),
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
}
