import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

export async function getValidSession(
  authInstance: ReturnType<typeof createAuth>,
  requestHeaders: Headers,
) {
  const session = await authInstance.api.getSession({
    headers: requestHeaders,
  });
  if (!session) return null;
  if (new Date(session.session.absoluteExpiresAt) <= new Date()) return null;
  return session;
}
