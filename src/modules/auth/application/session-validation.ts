import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { isSessionWithinLifetime } from "@/modules/auth/domain/session-policy";

export async function getValidOwnerSession(
  authInstance: ReturnType<typeof createAuth>,
  requestHeaders: Headers,
) {
  const session = await authInstance.api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true, disableCookieCache: true },
  });
  if (!session || !isSessionWithinLifetime(session.session)) return null;
  if (!(await authInstance.isInstanceOwner(session.user.id))) return null;
  // Only a still-valid session may enter Better Auth's normal refresh path.
  const refreshed = await authInstance.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  return refreshed &&
    refreshed.user.id === session.user.id &&
    isSessionWithinLifetime(refreshed.session)
    ? refreshed
    : null;
}

// Retain the existing identity reader for callers of the owner/session protocol.
export const getValidSession = getValidOwnerSession;

export async function getValidBusinessSession(
  authInstance: ReturnType<typeof createAuth>,
  requestHeaders: Headers,
) {
  const session = await getValidOwnerSession(authInstance, requestHeaders);
  if (
    !session ||
    !(await authInstance.isInstanceReady(session.user.id, session.session.id))
  )
    return null;
  // F2.2/F2.3 MUST revoke all existing owner sessions at first verification,
  // under a synchronization boundary that also excludes concurrent login.
  // READY alone cannot distinguish a pre-enrollment password-only session.
  return session;
}
