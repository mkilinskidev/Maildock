import { z, ZodError } from "zod";

import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

type Context = { params: Promise<{ id: string }> };
const accountId = z.uuid();

function accountError(error: unknown): Response {
  if (error instanceof MailAccountNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ZodError) {
    return Response.json(
      { error: "Check the account settings and required credentials." },
      { status: 400 },
    );
  }
  return Response.json(
    { error: "The mail account operation failed." },
    { status: 500 },
  );
}

export async function GET(request: Request, context: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    return Response.json({
      account: await accountsService.get(
        accountId.parse((await context.params).id),
      ),
    });
  } catch (error) {
    return accountError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const account = await accountsService.update(
      accountId.parse((await context.params).id),
      await request.json(),
    );
    return Response.json({ account });
  } catch (error) {
    return accountError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    await accountsService.delete(accountId.parse((await context.params).id));
    return new Response(null, { status: 204 });
  } catch (error) {
    return accountError(error);
  }
}
