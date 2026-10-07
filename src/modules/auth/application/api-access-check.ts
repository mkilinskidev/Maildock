import { getValidSession } from "@/modules/auth/application/session-validation";
import { hasValidOrigin } from "@/modules/auth/application/origin";
import type { AppConfig } from "@/shared/infrastructure/config/config";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

export async function checkOwnerApiAccess(
  authInstance: ReturnType<typeof createAuth>,
  config: Pick<AppConfig, "appOrigin">,
  request: Request,
  mutation = false,
): Promise<Response | null> {
  if (!(await getValidSession(authInstance, request.headers))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (mutation && !hasValidOrigin(request, config)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return null;
}
