import { headers } from "next/headers";

import { auth } from "@/modules/auth/infrastructure/auth";
import { getValidSession } from "@/modules/auth/application/session-validation";

export async function getCurrentSession() {
  return getValidSession(auth, await headers());
}
