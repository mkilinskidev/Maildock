import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  instanceState,
  user,
} from "../../../shared/infrastructure/database/schema";

// One web process renews a database lease; workers never issue credentials.
// Only a digest survives the intentional startup message. On lease loss/crash,
// a web process replaces it after at most 60 seconds plus the polling interval.
export async function maintainBootstrap(
  database: Database,
  heldDigest?: string,
): Promise<{ pending: boolean; digest?: string }> {
  const issued = await database.transaction(async (tx) => {
    const [state] = await tx
      .select({
        initializedAt: instanceState.initializedAt,
        ownerUserId: instanceState.ownerUserId,
        digest: instanceState.bootstrapSecretDigest,
        active: sql<boolean>`${instanceState.bootstrapExpiresAt} > clock_timestamp()`,
      })
      .from(instanceState)
      .where(eq(instanceState.id, 1))
      .for("update")
      .limit(1);
    // Fail closed for missing/partial state and orphaned users, just like setup.
    if (
      !state ||
      state.initializedAt !== null ||
      state.ownerUserId !== null ||
      (await tx.select({ id: user.id }).from(user).limit(1)).length
    ) {
      return { pending: false };
    }
    if (state.active && state.digest !== heldDigest) return { pending: true };
    const secret = state.active
      ? undefined
      : randomBytes(32).toString("base64");
    const digest = secret
      ? createHash("sha256").update(secret).digest("hex")
      : state.digest!;
    await tx
      .update(instanceState)
      .set({
        bootstrapSecretDigest: digest,
        bootstrapExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .where(eq(instanceState.id, 1));
    return { pending: true, digest, secret };
  });
  if (issued.secret) {
    // Re-lock AFTER commit: never announce a rolled-back credential or print
    // after owner creation. Publication and provisioning exclude each other.
    await database.transaction(async (tx) => {
      const [state] = await tx
        .select({
          digest: instanceState.bootstrapSecretDigest,
          initializedAt: instanceState.initializedAt,
          ownerUserId: instanceState.ownerUserId,
          active: sql<boolean>`${instanceState.bootstrapExpiresAt} > clock_timestamp()`,
        })
        .from(instanceState)
        .where(eq(instanceState.id, 1))
        .for("update")
        .limit(1);
      if (
        state?.digest === issued.digest &&
        state.active &&
        state.initializedAt === null &&
        state.ownerUserId === null
      ) {
        // Deliberate exception to structured diagnostics; never pass this
        // object/plaintext to a logger, config, error or HTTP response.
        process.stdout.write(
          `Maildock first-time setup\nSetup secret: ${issued.secret}\nOpen Maildock and use this secret to create the owner account.\n`,
        );
      }
    });
  }
  return { pending: issued.pending, digest: issued.digest };
}

export async function startBootstrapLifecycle(
  database: Database,
  onFailure: (error: unknown) => void,
  onComplete: () => Promise<void>,
) {
  let state = await maintainBootstrap(database);
  if (!state.pending) {
    await onComplete();
    return;
  }
  if (!state.digest)
    process.stdout.write(
      "Maildock first-time setup: use the setup secret in the active web container's logs; waiting to take over if it stops.\n",
    );
  const poll = () => {
    const timer = setTimeout(async () => {
      try {
        state = await maintainBootstrap(database, state.digest);
        if (state.pending) poll();
        else await onComplete();
      } catch (error) {
        // Stop renewal. Another web process can take over after lease expiry.
        onFailure(error);
        try {
          await onComplete();
        } catch (cleanupError) {
          onFailure(cleanupError);
        }
      }
    }, 10_000);
    timer.unref();
  };
  poll();
}
