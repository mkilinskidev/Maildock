import { z, ZodError } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { mailboxRoleService } from "@/modules/accounts/infrastructure/accounts";
import { MailboxRoleUnavailableError } from "@/modules/mail/application/mailbox-role-service";

const paramsSchema = z.object({
  id: z.uuid(),
  role: z.enum(["archive", "trash", "sent", "drafts", "junk"]),
});
type Context = { params: Promise<{ id: string; role: string }> };

export async function PUT(request: Request, { params }: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const { id, role } = paramsSchema.parse(await params);
    const { mailboxId } = z
      .object({ mailboxId: z.uuid() })
      .strict()
      .parse(await request.json());
    await mailboxRoleService.setManual(id, role, mailboxId);
    return Response.json({ roles: await mailboxRoleService.list(id) });
  } catch (error) {
    if (error instanceof MailboxRoleUnavailableError)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid system folder mapping." },
        { status: 400 },
      );
    return Response.json(
      { error: "System folder mapping could not be saved." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const { id, role } = paramsSchema.parse(await params);
    await mailboxRoleService.clearManual(id, role);
    return Response.json({ roles: await mailboxRoleService.list(id) });
  } catch (error) {
    if (error instanceof MailboxRoleUnavailableError)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid system folder mapping." },
        { status: 400 },
      );
    return Response.json(
      { error: "System folder mapping could not be cleared." },
      { status: 500 },
    );
  }
}
