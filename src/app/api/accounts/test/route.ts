import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { ZodError } from "zod";

import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";

export async function POST(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      return Response.json({
        result: await accountsService.testUnsaved(await request.json()),
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return Response.json(
          { error: "Check the account settings and required credentials." },
          { status: 400 },
        );
      }
      return Response.json(
        { error: "The connection test could not be completed." },
        { status: 500 },
      );
    }
  });
}
