import { ZodError } from "zod";

import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  return Response.json(
    { accounts: await accountsService.list() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
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
}
