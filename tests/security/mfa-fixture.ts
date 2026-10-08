import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { initializeOwner } from "@/modules/auth/application/instance-auth";

import type { Database } from "@/shared/infrastructure/database/database";
import {
  instanceState,
  twoFactor,
  user,
} from "@/shared/infrastructure/database/schema";

// Test-only provisioning state. No deterministic credential/configuration path
// exists in production; HTTP/bootstrap regressions seed this explicitly.
export async function seedBootstrapFixture(
  database: Database,
  secret = Buffer.alloc(32, 7).toString("base64"),
) {
  await database
    .update(instanceState)
    .set({
      bootstrapSecretDigest: createHash("sha256").update(secret).digest("hex"),
      bootstrapExpiresAt: sql`clock_timestamp() + interval '1 hour'`,
    })
    .where(
      and(
        eq(instanceState.id, 1),
        isNull(instanceState.initializedAt),
        isNull(instanceState.ownerUserId),
        isNull(instanceState.bootstrapSecretDigest),
      ),
    );
}

export async function initializeOwnerFixture(
  database: Database,
  input: unknown,
) {
  const secret =
    input &&
    typeof input === "object" &&
    "bootstrapSecret" in input &&
    typeof input.bootstrapSecret === "string"
      ? input.bootstrapSecret
      : undefined;
  await seedBootstrapFixture(database, secret);
  return initializeOwner(database, input);
}

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
  // Mirror real initial MFA completion: READY instances retain no setup proof.
  await database
    .update(instanceState)
    .set({
      bootstrapSecretDigest: null,
      bootstrapExpiresAt: null,
    })
    .where(eq(instanceState.id, 1));
}
