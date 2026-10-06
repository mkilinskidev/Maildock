import { eq, sql } from "drizzle-orm";
import type { Database } from "@/shared/infrastructure/database/database";
import { authAdmission } from "@/shared/infrastructure/database/schema";

// Fixed keys deliberately exploit immutable single-owner binding. Neither
// submitted names, sessions, challenge IDs nor client addresses partition them.
const workLimits = { password: 12, mfa: 30, management: 12 } as const;
export class AuthThrottledError extends Error {
  constructor(readonly retryAfter: number) {
    super("Authentication temporarily throttled.");
  }
}
export function authThrottleResponse(retryAfter: number) {
  return Response.json(
    { error: "Authentication could not be completed. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
      },
    },
  );
}

// Always called on the independent root DB before M. Even a rollback or process
// crash spends an admitted reservation. Denials saturate without extending expiry.
// EXCLUDED carries one DB-clock instant for consistent count/expiry transitions.
export async function reserveAuthWork(
  database: Database,
  kind: keyof typeof workLimits,
) {
  const key = `work:${kind}`;
  const max = workLimits[kind];
  const rows = await database.execute<{ count: number; retry: number }>(sql`
    insert into auth_admission (key, count, expires_at)
    values (${key}, 1, clock_timestamp() + interval '60 seconds')
    on conflict (key) do update set
      count = case when auth_admission.expires_at <= excluded.expires_at - interval '60 seconds' then 1
        else least(auth_admission.count + 1, ${max + 1}) end,
      expires_at = case when auth_admission.expires_at <= excluded.expires_at - interval '60 seconds'
        then excluded.expires_at else auth_admission.expires_at end
    returning count, greatest(1, ceil(extract(epoch from (expires_at - clock_timestamp()))))::integer as retry
  `);
  if (rows[0].count > max) throw new AuthThrottledError(rows[0].retry);
}

type ManagementStage = "password" | "factor";
// These three helpers require M. Five failed proofs per stage in a fixed 900s
// window. Password success resets only password; factor success only factor.
export async function managementProofDelay(
  tx: Database,
  stage: ManagementStage,
) {
  const rows = await tx.execute<{ retry: number }>(sql`
    select greatest(0, ceil(extract(epoch from (expires_at - clock_timestamp()))))::integer as retry
    from auth_admission where key = ${`manage:${stage}`} and count >= 5
  `);
  return rows[0]?.retry ?? 0;
}
export async function recordManagementFailure(
  tx: Database,
  stage: ManagementStage,
) {
  const key = `manage:${stage}`;
  await tx.execute(sql`
    insert into auth_admission (key, count, expires_at)
    values (${key}, 1, clock_timestamp() + interval '900 seconds')
    on conflict (key) do update set
      count = case when auth_admission.expires_at <= excluded.expires_at - interval '900 seconds' then 1
        else least(auth_admission.count + 1, 5) end,
      expires_at = case when auth_admission.expires_at <= excluded.expires_at - interval '900 seconds'
        then excluded.expires_at else auth_admission.expires_at end
  `);
}
export async function clearManagementFailures(
  tx: Database,
  stage: ManagementStage,
) {
  await tx
    .delete(authAdmission)
    .where(eq(authAdmission.key, `manage:${stage}`));
}
