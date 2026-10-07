import { auth } from "@/modules/auth/infrastructure/auth";
import { getConfig } from "@/shared/infrastructure/config/config";
import { checkOwnerApiAccess } from "@/modules/auth/application/api-access-check";

export async function requireOwnerApiAccess(
  request: Request,
  mutation = false,
): Promise<Response | null> {
  return checkOwnerApiAccess(auth, getConfig(), request, mutation);
}
