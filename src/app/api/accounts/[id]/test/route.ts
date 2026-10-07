import { z, ZodError } from "zod";

import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { OAuthAuthorizationError } from "@/modules/accounts/domain/oauth-mail-provider";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const text = await request.text();
    const input = text ? JSON.parse(text) : undefined;
    return Response.json({
      result: await accountsService.testExisting(
        z.uuid().parse((await params).id),
        input,
      ),
    });
  } catch (error) {
    if (error instanceof OAuthAuthorizationError)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof MailAccountNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "Check the account settings." },
        { status: 400 },
      );
    }
    return Response.json(
      { error: "The connection test could not be completed." },
      { status: 500 },
    );
  }
}
