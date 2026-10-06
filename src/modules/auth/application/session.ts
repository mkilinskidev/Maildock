import { headers } from "next/headers";

import { auth } from "@/modules/auth/infrastructure/auth";
import { getValidBusinessSession } from "@/modules/auth/application/session-validation";

export async function getCurrentSession() {
  return getValidBusinessSession(auth, await headers());
}
