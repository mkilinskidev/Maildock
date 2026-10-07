import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createOTP } from "@better-auth/utils/otp";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import type { Database } from "../../../shared/infrastructure/database/database";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import * as schema from "../../../shared/infrastructure/database/schema";
import {
  RecoveryError,
  recoveryDigest,
  verifyRecoverySchema,
  verifyRecoveryState,
  verifyMaintenance,
} from "../../../shared/infrastructure/database/restore-verification";
import { verifyPassword } from "../infrastructure/password";
import {
  reserveAuthWork,
  managementProofDelay,
  recordManagementFailure,
} from "../infrastructure/auth-admission";

export const restoreReviewReason = "Restored operation requires owner review.";
export type RecoveryOperation = "maintain" | "resume-mfa" | "complete-mfa";
export type RecoveryProof = { password: string; code?: string };

// Caller has validated ordinary DB authority and stopped ALL writers. The
// same M lock/READ COMMITTED boundary as online MFA serializes every recheck.
export async function restoreSecurityState(
  db: Database,
  config: AppConfig,
  expectedOwner: string,
  operation: RecoveryOperation,
  proof?: RecoveryProof,
) {
  await verifyRecoverySchema(db);
  await verifyRecoveryState(db, config, expectedOwner);
  if (operation !== "maintain") await reserveAuthWork(db, "management");
  const result = await db.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Database;
      await tx.execute(sql`select pg_advisory_xact_lock(1296125023)`);
      const checked = await verifyRecoveryState(tx, config, expectedOwner);
      if (operation !== "maintain") {
        if (checked.status !== "pending_mfa")
          throw new RecoveryError("recovery_owner");
        // Continuation only follows committed restore fencing/token revocation.
        const [receipt] = await tx.select().from(schema.recoveryMaintenance);
        if (!receipt) throw new RecoveryError("recovery_incomplete");
        await verifyMaintenance(tx, config, expectedOwner, receipt.receiptId);
        if (
          (await managementProofDelay(tx, "password")) ||
          (await managementProofDelay(tx, "factor")) ||
          (checked.factor.lockedUntil &&
            checked.factor.lockedUntil.getTime() > Date.now())
        )
          return { refused: true as const };
        if (
          !proof?.password ||
          !(await verifyPassword({
            password: proof.password,
            hash: checked.credential.password!,
          }))
        ) {
          await recordManagementFailure(tx, "password");
          return { refused: true as const };
        }
        if (operation === "resume-mfa")
          return {
            status: "pending_mfa" as const,
            receiptId: receipt.receiptId,
            totpURI: createOTP(checked.secret, { digits: 6, period: 30 }).url(
              "Maildock",
              checked.owner.email,
            ),
            recoveryCodes: [],
          };
        if (
          !proof.code ||
          !/^\d{6}$/.test(proof.code) ||
          !(await createOTP(checked.secret, { digits: 6, period: 30 }).verify(
            proof.code,
          ))
        ) {
          await recordManagementFailure(tx, "factor");
          return { refused: true as const };
        }
        await tx
          .update(schema.twoFactor)
          .set({ verified: true })
          .where(eq(schema.twoFactor.id, checked.factor.id));
        await tx
          .update(schema.user)
          .set({ twoFactorEnabled: true })
          .where(eq(schema.user.id, expectedOwner));
        await tx
          .delete(schema.mfaReplacement)
          .where(eq(schema.mfaReplacement.ownerUserId, expectedOwner));
      }
      await tx.delete(schema.session);
      await tx.delete(schema.verification);
      await tx.delete(schema.oauthAuthorizationStates);
      await tx
        .update(schema.outgoingMessages)
        .set({ status: "uncertain", error: restoreReviewReason })
        .where(inArray(schema.outgoingMessages.status, ["queued", "sending"]));
      await tx
        .update(schema.outgoingMessages)
        .set({
          sentCopyStatus: "uncertain",
          sentCopyError: restoreReviewReason,
        })
        .where(
          inArray(schema.outgoingMessages.sentCopyStatus, [
            "pending",
            "saving",
          ]),
        );
      await tx
        .update(schema.messageCommands)
        .set({
          status: "failed",
          error: restoreReviewReason,
          completedAt: new Date(),
        })
        .where(
          inArray(schema.messageCommands.status, ["pending", "executing"]),
        );
      const status = operation === "complete-mfa" ? "verified" : checked.status;
      let ciphertext = checked.factor.backupCodes;
      let recoveryCodes: string[] = [];
      if (status === "verified") {
        // Installed Better Auth 1.7.5 encrypted format: ten random 5-5 codes.
        recoveryCodes = Array.from({ length: 10 }, () => {
          const value = generateRandomString(10, "a-z", "0-9", "A-Z");
          return `${value.slice(0, 5)}-${value.slice(5)}`;
        });
        ciphertext = await symmetricEncrypt({
          key: config.authSecret,
          data: JSON.stringify(recoveryCodes),
        });
        await tx
          .update(schema.twoFactor)
          .set({ backupCodes: ciphertext })
          .where(eq(schema.twoFactor.id, checked.factor.id));
      } else {
        await tx
          .update(schema.mfaReplacement)
          .set({
            tokenDigest: recoveryDigest(randomBytes(32).toString("base64url")),
            expiresAt: new Date(0),
          })
          .where(eq(schema.mfaReplacement.ownerUserId, expectedOwner));
      }
      const receiptId = randomUUID();
      const values = {
        id: 1,
        receiptId,
        ownerUserId: expectedOwner,
        factorId: checked.factor.id,
        recoveryCodesDigest: recoveryDigest(ciphertext),
        status,
        completedAt: new Date(),
      };
      await tx
        .insert(schema.recoveryMaintenance)
        .values(values)
        .onConflictDoUpdate({
          target: schema.recoveryMaintenance.id,
          set: values,
        });
      await verifyMaintenance(tx, config, expectedOwner, receiptId);
      return { status, receiptId, recoveryCodes };
    },
    { isolationLevel: "read committed" },
  );
  // Invalid proofs must commit their admission counters, then fail closed.
  if ("refused" in result) throw new RecoveryError("recovery_proof");
  return result;
}
