import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { z, ZodError } from "zod";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { messageCommandService } from "@/modules/accounts/infrastructure/accounts";
import { MessageCommandUnavailableError } from "@/modules/mail/application/message-command-service";

export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; mailboxId: string; messageId: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const values = await params;
      const body = z
        .object({
          action: z.enum([
            "mark_read",
            "mark_unread",
            "flag",
            "unflag",
            "archive",
            "trash",
            "move",
          ]),
          destinationMailboxId: z.uuid().optional(),
        })
        .strict()
        .refine(
          (body) =>
            body.action === "move"
              ? !!body.destinationMailboxId
              : !body.destinationMailboxId,
          { message: "A destination is required only for a move." },
        )
        .parse(await request.json());
      const commandArgs: [string, string, string, typeof body.action, string?] =
        [
          z.uuid().parse(values.id),
          z.uuid().parse(values.mailboxId),
          z.uuid().parse(values.messageId),
          body.action,
        ];
      if (body.destinationMailboxId)
        commandArgs.push(body.destinationMailboxId);
      const command = await messageCommandService.create(...commandArgs);
      return Response.json(command, { status: 202 });
    } catch (error) {
      if (error instanceof MessageCommandUnavailableError)
        return Response.json({ error: error.message }, { status: 409 });
      if (error instanceof ZodError)
        return Response.json(
          { error: "Invalid message action." },
          { status: 400 },
        );
      return Response.json(
        { error: "Message action could not be queued." },
        { status: 500 },
      );
    }
  });
}
