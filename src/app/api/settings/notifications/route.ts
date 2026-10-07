import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { NotificationService } from "@/modules/mail/application/notification-service";
import { notificationPreferencesSchema } from "@/modules/mail/domain/notifications";

export async function GET(request: Request) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  return Response.json(await new NotificationService(db).preferences(), {
    headers: { "Cache-Control": "no-store" },
  });
}
export async function PUT(request: Request) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  const input = notificationPreferencesSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!input.success)
    return Response.json(
      { error: "Invalid notification preferences." },
      { status: 400 },
    );
  await new NotificationService(db).setPreferences(input.data);
  return Response.json(input.data);
}
