import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@/shared/infrastructure/database/database";
import {
  instanceState,
  twoFactor,
  user,
} from "@/shared/infrastructure/database/schema";

// Synthetic READY state for pre-existing business-boundary regression tests.
// Call AFTER password login. This deliberately bypasses real enrollment and
// session revocation; only mfa-foundation tests characterize that transition.
export async function setReadyFixture(
  database: Pick<Database, "select" | "insert" | "update">,
) {
  const [state] = await database.select().from(instanceState);
  const ownerId = state.ownerUserId!;
  await database
    .insert(twoFactor)
    .values({
      id: randomUUID(),
      userId: ownerId,
      secret: "synthetic-test-secret",
      backupCodes: "synthetic-test-backup-codes",
      verified: true,
    })
    .onConflictDoNothing();
  await database
    .update(user)
    .set({ twoFactorEnabled: true })
    .where(eq(user.id, ownerId));
}
