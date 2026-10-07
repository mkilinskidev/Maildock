import { eq } from "drizzle-orm";
import type { Database } from "@/shared/infrastructure/database/database";
import { instanceState, user } from "@/shared/infrastructure/database/schema";

export async function isInstanceOwner(database: Database, userId: string) {
  // Never infer or repair ownership at runtime. The join also rejects a
  // dangling reference if constraints were bypassed by a database operator.
  const [state] = await database
    .select({
      initializedAt: instanceState.initializedAt,
      ownerUserId: instanceState.ownerUserId,
    })
    .from(instanceState)
    .innerJoin(user, eq(instanceState.ownerUserId, user.id))
    .where(eq(instanceState.id, 1))
    .limit(1);
  return !!(
    state?.initializedAt &&
    state.ownerUserId &&
    state.ownerUserId.trim() === state.ownerUserId &&
    state.ownerUserId === userId
  );
}
