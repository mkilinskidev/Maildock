import type { createAuth } from "../infrastructure/auth-factory";
import { getValidOwnerSession } from "./session-validation";

export async function ownerLanding(
  auth: ReturnType<typeof createAuth>,
  headers: Headers,
): Promise<"/" | "/initial-mfa" | "/login" | "/replace-authenticator"> {
  if (await auth.isMfaReplacementPending()) return "/replace-authenticator";
  const owner = await getValidOwnerSession(auth, headers);
  if (!owner) return "/login";
  return (await auth.isInstanceReady(owner.user.id, owner.session.id))
    ? "/"
    : "/initial-mfa";
}
