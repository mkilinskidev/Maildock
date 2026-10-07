import { ZodError } from "zod";

import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";

export async function POST(request: Request) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
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
}
