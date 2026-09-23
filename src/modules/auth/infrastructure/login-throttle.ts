import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { db } from "@/shared/infrastructure/database/runtime-database";
import { loginThrottle } from "@/shared/infrastructure/database/schema";

function throttleKey(username: string): string {
  return createHash("sha256")
    .update(username.trim().toLowerCase())
    .digest("hex");
}

export async function getLoginDelaySeconds(username: string): Promise<number> {
  const [entry] = await db
    .select({ blockedUntil: loginThrottle.blockedUntil })
    .from(loginThrottle)
    .where(eq(loginThrottle.key, throttleKey(username)))
    .limit(1);
  if (!entry?.blockedUntil) return 0;
  return Math.max(
    0,
    Math.ceil((entry.blockedUntil.getTime() - Date.now()) / 1_000),
  );
}

export async function recordLoginFailure(username: string): Promise<void> {
  const key = throttleKey(username);
  await db
    .insert(loginThrottle)
    .values({
      key,
      failureCount: 1,
      blockedUntil: new Date(Date.now() + 1_000),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        failureCount: sql`least(${loginThrottle.failureCount} + 1, 14)`,
        blockedUntil: sql`now() + make_interval(secs => least(900, power(2, least(${loginThrottle.failureCount}, 10))::integer))`,
        updatedAt: new Date(),
      },
    });
}

export async function clearLoginFailures(username: string): Promise<void> {
  await db
    .delete(loginThrottle)
    .where(eq(loginThrottle.key, throttleKey(username)));
}
