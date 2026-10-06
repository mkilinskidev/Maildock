import type { createAuth } from "../infrastructure/auth-factory";
import { getValidOwnerSession } from "./session-validation";

export async function ownerLanding(
  auth: ReturnType<typeof createAuth>,
  headers: Headers,
): Promise<"/" | "/initial-mfa" | "/login"> {
  const owner = await getValidOwnerSession(auth, headers);
  if (!owner) return "/login";
  return (await auth.isInstanceReady(owner.user.id, owner.session.id))
    ? "/"
    : "/initial-mfa";
}
