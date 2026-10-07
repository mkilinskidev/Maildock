import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { Database } from "@/shared/infrastructure/database/database";
import { loginThrottle } from "@/shared/infrastructure/database/schema";

function throttleKey(username: string): string {
  return createHash("sha256")
    .update(username.trim().toLowerCase())
    .digest("hex");
}

export async function getLoginDelaySeconds(
  db: Database,
  username: string,
): Promise<number> {
  // M serializes cleanup/check/verification/failure. Expire idle state without
  // deleting an active delay; 15 minutes exceeds every configured backoff.
  await db.execute(
    sql`delete from login_throttle where updated_at <= clock_timestamp() - interval '15 minutes' and (blocked_until is null or blocked_until <= clock_timestamp())`,
  );
  const rows = await db.execute<{ retry: number }>(sql`
    select greatest(0, ceil(extract(epoch from (blocked_until - clock_timestamp()))))::integer as retry
    from login_throttle where key = ${throttleKey(username)}
  `);
  return rows[0]?.retry ?? 0;
}

export async function recordLoginFailure(
  db: Database,
  username: string,
): Promise<void> {
  const key = throttleKey(username);
  await db
    .insert(loginThrottle)
    .values({
      key,
      failureCount: 1,
      blockedUntil: sql`clock_timestamp() + interval '1 second'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        failureCount: sql`least(${loginThrottle.failureCount} + 1, 14)`,
        blockedUntil: sql`clock_timestamp() + make_interval(secs => least(900, power(2, least(${loginThrottle.failureCount}, 10))::integer))`,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

export async function clearLoginFailures(
  db: Database,
  username: string,
): Promise<void> {
  await db
    .delete(loginThrottle)
    .where(eq(loginThrottle.key, throttleKey(username)));
}
