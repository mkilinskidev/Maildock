import { z, ZodError } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { messageCommandService } from "@/modules/accounts/infrastructure/accounts";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    const accountId = z.uuid().parse((await params).id);
    const ids = z
      .array(z.uuid())
      .max(50)
      .parse(new URL(request.url).searchParams.getAll("id"));
    return Response.json({
      commands: await messageCommandService.status(accountId, ids),
    });
  } catch (error) {
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid command request." },
        { status: 400 },
      );
    return Response.json(
      { error: "Command status could not be loaded." },
      { status: 500 },
    );
  }
}
