import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { ZodError } from "zod";

import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    return Response.json(
      { accounts: await accountsService.list() },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

export async function POST(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const account = await accountsService.create(await request.json());
      return Response.json({ account }, { status: 201 });
    } catch (error) {
      if (error instanceof ZodError) {
        return Response.json(
          { error: "Check the account settings and required credentials." },
          { status: 400 },
        );
      }
      return Response.json(
        { error: "The mail account could not be saved." },
        { status: 500 },
      );
    }
  });
}
