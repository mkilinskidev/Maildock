import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z, ZodError } from "zod";

import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

type Context = { params: Promise<{ id: string }> };
const accountId = z.uuid();

function accountError(error: unknown): Response {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? cause.code
      : undefined;
  if (code === "23503")
    return Response.json(
      {
        error:
          "Remove retained drafts and outgoing messages before removing this account.",
      },
      { status: 409 },
    );
  if (code === "55000")
    return Response.json(
      { error: "Account removal is in progress." },
      { status: 409 },
    );
  if (code === "55P03" || code === "57014")
    return Response.json(
      { error: "Account operation is busy. Retry shortly." },
      { status: 503 },
    );
  if (error instanceof MailAccountNotFoundError || code === "P0002") {
    return Response.json({ error: "Mail account not found." }, { status: 404 });
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
  return routeBoundary(async () => {
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
  });
}

export async function PUT(request: Request, context: Context) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const account = await accountsService.update(
        accountId.parse((await context.params).id),
        await request.json(),
      );
      return Response.json({ account });
    } catch (error) {
      return accountError(error);
    }
  });
}

export async function DELETE(request: Request, context: Context) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    try {
      const result = await accountsService.delete(
        accountId.parse((await context.params).id),
      );
      if (result?.status === "removing")
        return Response.json({ status: "removing" }, { status: 202 });
      return new Response(null, { status: 204 });
    } catch (error) {
      return accountError(error);
    }
  });
}
