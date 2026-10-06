import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { MailPreferencesService } from "@/modules/mail/application/mail-preferences-service";
import { autoReadSchema } from "@/modules/mail/domain/mail-interactions";

export async function GET(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    return Response.json(await new MailPreferencesService(db).autoRead());
  });
}

export async function PUT(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    const input = autoReadSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!input.success)
      return Response.json(
        { error: "Invalid automatic read preference." },
        { status: 400 },
      );
    await new MailPreferencesService(db).setAutoRead(input.data);
    return Response.json(input.data);
  });
}
