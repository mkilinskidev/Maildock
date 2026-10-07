import { z, ZodError } from "zod";

import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .parse(await request.json());
    return Response.json({
      account: await accountsService.setEnabled(
        z.uuid().parse((await params).id),
        enabled,
      ),
    });
  } catch (error) {
    if (error instanceof MailAccountNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid enabled state." },
        { status: 400 },
      );
    return Response.json(
      { error: "The mail account could not be updated." },
      { status: 500 },
    );
  }
}
