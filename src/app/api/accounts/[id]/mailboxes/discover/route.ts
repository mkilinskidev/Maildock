import { z, ZodError } from "zod";

import {
  DisabledMailAccountError,
  MailAccountNotFoundError,
} from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const account = await accountsService.requestMailboxDiscovery(
      z.uuid().parse((await params).id),
    );
    return Response.json({ account }, { status: 202 });
  } catch (error) {
    if (error instanceof MailAccountNotFoundError)
      return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof DisabledMailAccountError)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError)
      return Response.json({ error: "Invalid account ID." }, { status: 400 });
    return Response.json(
      { error: "Mailbox discovery could not be scheduled." },
      { status: 500 },
    );
  }
}
