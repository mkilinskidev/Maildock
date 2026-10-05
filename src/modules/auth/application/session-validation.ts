import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { isSessionWithinLifetime } from "@/modules/auth/domain/session-policy";

export async function getValidSession(
  authInstance: ReturnType<typeof createAuth>,
  requestHeaders: Headers,
) {
  const session = await authInstance.api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true, disableCookieCache: true },
  });
  if (!session || !isSessionWithinLifetime(session.session)) return null;
  // Only a still-valid session may enter Better Auth's normal refresh path.
  const refreshed = await authInstance.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  return refreshed && isSessionWithinLifetime(refreshed.session)
    ? refreshed
    : null;
}
