import { z, ZodError } from "zod";

import {
  accountsService,
  mailboxService,
  mailboxRoleService,
} from "@/modules/accounts/infrastructure/accounts";
import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const accountId = z.uuid().parse((await params).id);
    await accountsService.get(accountId);
    const [mailboxes, roles] = await Promise.all([
      mailboxService.listForAccount(accountId),
      mailboxRoleService.list(accountId),
    ]);
    return Response.json({ mailboxes, roles });
  } catch (error) {
    if (error instanceof MailAccountNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof ZodError)
      return Response.json({ error: "Invalid account ID." }, { status: 400 });
    return Response.json(
      { error: "Mailboxes could not be listed." },
      { status: 500 },
    );
  }
}
