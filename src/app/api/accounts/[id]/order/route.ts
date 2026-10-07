import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z, ZodError } from "zod";
import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const { direction } = z
        .object({ direction: z.enum(["up", "down"]) })
        .strict()
        .parse(await request.json());
      const accounts = await accountsService.move(
        z.uuid().parse((await params).id),
        direction,
      );
      return Response.json(
        { accounts },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof MailAccountNotFoundError)
        return Response.json({ error: error.message }, { status: 404 });
      if (error instanceof ZodError || error instanceof SyntaxError)
        return Response.json(
          { error: "Invalid account order request." },
          { status: 400 },
        );
      return Response.json(
        { error: "The account order could not be saved." },
        { status: 500 },
      );
    }
  });
}
