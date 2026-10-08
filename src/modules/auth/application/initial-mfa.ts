import { securityEvent } from "../../../shared/infrastructure/logging/security-events";
import { ownerPasswordSchema } from "../domain/password-policy";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { authorizeBootstrap, reserveSetupAttempt } from "./instance-auth";
import { getValidOwnerSession } from "./session-validation";
import { isInstanceReady } from "./instance-readiness";
import { withInitialMfaBoundary } from "../infrastructure/auth-factory";
import type { AppConfig } from "@/shared/infrastructure/config/config";
import type { Database } from "@/shared/infrastructure/database/database";
import {
  instanceState,
  mfaReplacement,
  session,
  twoFactor,
  user,
} from "@/shared/infrastructure/database/schema";

export class InitialMfaRejected extends Error {}
export const initialMfaStartSchema = z
  .object({
    bootstrapSecret: z.string().max(44),
    password: ownerPasswordSchema,
  })
  .strict();
export const initialMfaCompleteSchema = z
  .object({
    bootstrapSecret: z.string().max(44),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();

async function pendingState(tx: Database, ownerId: string) {
  if ((await tx.select().from(mfaReplacement)).length)
    throw new InitialMfaRejected();
  const states = await tx.select().from(instanceState);
  const owners = await tx.select().from(user).where(eq(user.id, ownerId));
  const factors = await tx.select().from(twoFactor);
  const state = states[0];
  if (
    states.length !== 1 ||
    state.id !== 1 ||
    !(state.initializedAt instanceof Date) ||
    !Number.isFinite(state.initializedAt.getTime()) ||
    state.ownerUserId !== ownerId ||
    owners.length !== 1 ||
    owners[0].twoFactorEnabled !== false ||
    factors.length > 1 ||
    factors.some(
      (factor) => factor.userId !== ownerId || factor.verified !== false,
    )
  ) {
    throw new InitialMfaRejected();
  }
  return factors[0];
}

export async function startInitialMfa(
  database: Database,
  config: AppConfig,
  headers: Headers,
  input: z.infer<typeof initialMfaStartSchema>,
) {
  await authorizeBootstrap(database, input.bootstrapSecret, "initial-mfa");
  // Persist admission independently: failed passwords/codes cannot roll it back.
  await reserveSetupAttempt(database, true, "initial-mfa");
  return withInitialMfaBoundary(config, database, async (auth, tx) => {
    const owner = await getValidOwnerSession(auth, headers);
    if (!owner) throw new InitialMfaRejected();
    const pending = await pendingState(tx, owner.user.id);
    await authorizeBootstrap(tx, input.bootstrapSecret, "initial-mfa");
    try {
      if (pending) {
        // Better Auth validates the password and decrypts its own pending secret.
        const result = await auth.api.getTOTPURI({
          headers,
          body: { password: input.password },
        });
        return { totpURI: result.totpURI, resumed: true };
      }
      const result = await auth.api.enableTwoFactor({
        headers,
        body: { password: input.password, method: "totp" },
      });
      if (result.method !== "totp") throw new InitialMfaRejected();
      const factor = await pendingState(tx, owner.user.id);
      if (!factor) throw new InitialMfaRejected();
      // Provisional recovery codes remain encrypted in DB. F2.3 must present
      // them through an equally controlled path; no acknowledgement is added.
      return { totpURI: result.totpURI, resumed: false };
    } catch (error) {
      if (error instanceof APIError) throw new InitialMfaRejected();
      throw error;
    }
  });
}

export async function completeInitialMfa(
  database: Database,
  config: AppConfig,
  headers: Headers,
  input: z.infer<typeof initialMfaCompleteSchema>,
) {
  await authorizeBootstrap(database, input.bootstrapSecret, "initial-mfa");
  await reserveSetupAttempt(database, true, "initial-mfa");
  return withInitialMfaBoundary(config, database, async (auth, tx) => {
    // Re-read authority AFTER the lock. A competing completion revokes it.
    const owner = await getValidOwnerSession(auth, headers);
    if (!owner) throw new InitialMfaRejected();
    const pending = await pendingState(tx, owner.user.id);
    if (!pending) throw new InitialMfaRejected();
    await authorizeBootstrap(tx, input.bootstrapSecret, "initial-mfa");
    try {
      // The installed plugin owns decryption/TOTP verification, user flag,
      // factor verification and temporary session rotation, all on this tx.
      await auth.api.verifyTOTP({ headers, body: { code: input.code } });
    } catch (error) {
      if (error instanceof APIError) throw new InitialMfaRejected();
      throw error;
    }
    await tx.delete(session).where(eq(session.userId, owner.user.id));
    // The setup proof survives owner creation only for initial enrollment.
    // Revoke it in the same transaction as verified MFA and session revocation.
    await tx
      .update(instanceState)
      .set({ bootstrapSecretDigest: null, bootstrapExpiresAt: null })
      .where(eq(instanceState.id, 1));
    if (
      (
        await tx
          .select({ id: session.id })
          .from(session)
          .where(eq(session.userId, owner.user.id))
      ).length !== 0 ||
      !(await isInstanceReady(tx, owner.user.id))
    )
      throw new Error("Initial MFA completion could not be confirmed.");
    // Server-only Better Auth API decrypts the ORIGINAL codes on this tx.
    // Authority was established before revocation; nothing leaves before commit.
    const { backupCodes } = await auth.api.viewBackupCodes({
      body: { userId: owner.user.id },
    });
    if (
      !Array.isArray(backupCodes) ||
      !backupCodes.every((code) => typeof code === "string")
    )
      throw new Error("Initial recovery codes could not be prepared.");
    // Discard all cookies returned by verifyTOTP, including its rotated session.
    const cleanup = await auth.api.clearInitialMfaCookies({
      headers,
      asResponse: true,
    });
    if (!cleanup.ok)
      throw new Error("Initial MFA cookie cleanup could not be prepared.");
    return Response.json(
      { completed: true, freshLoginRequired: true, recoveryCodes: backupCodes },
      { headers: cleanup.headers },
    );
  }).then((result) => {
    if (result instanceof Response && !result.ok) {
      securityEvent(
        result.status === 429 ? "admission_rejected" : "proof_rejected",
      );
      return result;
    }
    securityEvent("mfa_enrollment_completed");
    return result;
  });
}
