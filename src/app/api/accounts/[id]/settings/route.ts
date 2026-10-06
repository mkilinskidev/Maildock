import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import {
  accountsService,
  attachmentService,
} from "@/modules/accounts/infrastructure/accounts";
import { AccountSettingsService } from "@/modules/accounts/application/account-settings-service";
import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { MailboxRoleUnavailableError } from "@/modules/mail/application/mailbox-role-service";
import { OutgoingValidationError } from "@/modules/mail/application/outgoing-message-service";
import { db } from "@/shared/infrastructure/database/runtime-database";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const id = z.uuid().parse((await context.params).id);
      const account = await new AccountSettingsService(
        db,
        accountsService,
        attachmentService,
      ).saveGeneral(id, await request.json());
      return Response.json({ account });
    } catch (error) {
      if (error instanceof MailAccountNotFoundError)
        return Response.json({ error: error.message }, { status: 404 });
      if (
        error instanceof z.ZodError ||
        error instanceof MailboxRoleUnavailableError ||
        error instanceof OutgoingValidationError ||
        error instanceof SyntaxError
      )
        return Response.json(
          { error: "Check the account identity, folders and signatures." },
          { status: 400 },
        );
      return Response.json(
        { error: "Account settings could not be saved." },
        { status: 500 },
      );
    }
  });
}
