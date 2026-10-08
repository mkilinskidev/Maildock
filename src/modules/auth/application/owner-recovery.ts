import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../shared/infrastructure/database/database";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import * as s from "../../../shared/infrastructure/database/schema";
import { securityEvent } from "../../../shared/infrastructure/logging/security-events";
import { ownerPasswordSchema } from "../domain/password-policy";
import { normalizeOwnerUsername } from "../domain/owner-username";
import { hashPassword, verifyPassword } from "../infrastructure/password";
import { createAuth } from "../infrastructure/auth-factory";
import {
  preparePendingFactor,
  pendingFactorURI,
  verifyPendingFactor,
  markFactorVerified,
} from "../infrastructure/mfa-enrollment";
import {
  reserveAuthWork,
  managementProofDelay,
  recordManagementFailure,
  clearManagementFailures,
  authThrottleResponse,
} from "../infrastructure/auth-admission";
import {
  inspectOwnerRecovery,
  lockOwnerRecovery,
  OwnerRecoveryRejected,
} from "./owner-recovery-state";

export {
  inspectOwnerRecovery,
  OwnerRecoveryRejected,
} from "./owner-recovery-state";
export const recoveryCookie = "maildock.owner_recovery";
export const recoveryTokenSeconds = 600;
export const recoveryCompleteSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();
export const recoveryEmptySchema = z.object({}).strict();
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const refused = () =>
  Response.json(
    { error: "Sign in could not be completed." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
export function recoveryAuthorityCookie(config: AppConfig, token = "") {
  return `${recoveryCookie}=${token}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${token ? recoveryTokenSeconds : 0}${config.environment === "production" ? "; Secure" : ""}`;
}

export async function recoverOwner(
  database: Database,
  config: AppConfig,
  expected: { id: string; username: string },
  password: string,
  restartPending = false,
) {
  ownerPasswordSchema.parse(password);
  const passwordHash = await hashPassword(password);
  await database.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Database;
      await lockOwnerRecovery(tx);
      const checked = await inspectOwnerRecovery(tx, config);
      if (
        checked.owner.id !== expected.id ||
        checked.owner.username !== expected.username ||
        (checked.status === "recovery") !== restartPending
      )
        throw new OwnerRecoveryRejected(
          checked.status === "recovery"
            ? "owner_recovery_pending"
            : "owner_recovery_refused",
        );
      const factor = await preparePendingFactor(config, checked.owner.id);
      await tx
        .update(s.account)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(eq(s.account.id, checked.credential.id));
      await tx.delete(s.session);
      await tx.delete(s.verification);
      await tx.delete(s.mfaReplacement);
      await tx.delete(s.ownerRecovery);
      await tx.delete(s.twoFactor);
      await tx.insert(s.twoFactor).values(factor);
      await tx
        .update(s.user)
        .set({ twoFactorEnabled: false, updatedAt: new Date() })
        .where(eq(s.user.id, checked.owner.id));
      await tx
        .update(s.instanceState)
        .set({ bootstrapSecretDigest: null, bootstrapExpiresAt: null })
        .where(eq(s.instanceState.id, 1));
      await tx.insert(s.ownerRecovery).values({
        id: 1,
        ownerUserId: checked.owner.id,
        generationId: randomUUID(),
        factorId: factor.id,
      });
      const after = await inspectOwnerRecovery(tx, config);
      if (
        after.status !== "recovery" ||
        (await tx.select().from(s.session)).length ||
        (await tx.select().from(s.verification)).length
      )
        throw new OwnerRecoveryRejected();
    },
    { isolationLevel: "read committed" },
  );
  securityEvent(
    restartPending ? "owner_recovery_restarted" : "owner_recovery_started",
  );
}

// Called inside the existing password boundary BEFORE Better Auth can issue a session.
export async function recoveryPasswordLogin(
  tx: Database,
  config: AppConfig,
  username: string,
  password: string,
): Promise<Response | undefined> {
  if (!(await tx.select().from(s.ownerRecovery)).length) return undefined;
  const checked = await inspectOwnerRecovery(tx, config);
  const retry = await managementProofDelay(tx, "password");
  if (retry) return authThrottleResponse(retry);
  if (
    normalizeOwnerUsername(username) !== checked.owner.username ||
    !(await verifyPassword({ hash: checked.credential.password!, password }))
  ) {
    await recordManagementFailure(tx, "password");
    return refused();
  }
  await clearManagementFailures(tx, "password");
  const token = randomBytes(32).toString("base64url");
  await tx
    .update(s.ownerRecovery)
    .set({
      tokenDigest: digest(token),
      expiresAt: sql`clock_timestamp() + interval '600 seconds'`,
      failedAttempts: 0,
    })
    .where(eq(s.ownerRecovery.id, 1));
  const response = Response.json(
    { ownerRecoveryRequired: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.headers.append("Set-Cookie", recoveryAuthorityCookie(config, token));
  return response;
}

async function authorizeRecovery(
  tx: Database,
  config: AppConfig,
  headers: Headers,
) {
  const matches = (headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${recoveryCookie}=`));
  const token = matches[0]?.slice(recoveryCookie.length + 1);
  if (matches.length !== 1 || !token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new OwnerRecoveryRejected();
  const checked = await inspectOwnerRecovery(tx, config);
  const record = checked.recovery;
  const [active] = await tx
    .select({
      valid: sql<boolean>`${s.ownerRecovery.expiresAt} > clock_timestamp()`,
    })
    .from(s.ownerRecovery);
  if (
    !record ||
    record.tokenDigest !== digest(token) ||
    !active?.valid ||
    record.failedAttempts >= 5 ||
    !checked.factor
  )
    throw new OwnerRecoveryRejected();
  return { ...checked, record, factor: checked.factor };
}

// The factory's password branch never invokes this ceremony or issues a session.
export async function ownerRecoveryCeremony(
  database: Database,
  config: AppConfig,
  headers: Headers,
  operation: "resume" | "complete" | "cancel",
  code?: string,
) {
  await reserveAuthWork(database, "mfa");
  try {
    const response = await database.transaction(
      async (transaction) => {
        const tx = transaction as unknown as Database;
        await tx.execute(sql`select pg_advisory_xact_lock(1296125023)`);
        const checked = await authorizeRecovery(tx, config, headers);
        const cleanup = await createAuth(config, tx).api.clearInitialMfaCookies(
          { headers, asResponse: true },
        );
        if (!cleanup.ok) throw new OwnerRecoveryRejected();
        if (operation === "cancel") {
          await tx
            .update(s.ownerRecovery)
            .set({ tokenDigest: null, expiresAt: null })
            .where(eq(s.ownerRecovery.id, 1));
          cleanup.headers.append("Set-Cookie", recoveryAuthorityCookie(config));
          return Response.json(
            { cancelled: true },
            { headers: cleanup.headers },
          );
        }
        if (operation === "resume")
          return Response.json({
            totpURI: await pendingFactorURI(
              config,
              checked.factor,
              checked.owner.email,
            ),
          });
        const retry = await managementProofDelay(tx, "factor");
        if (retry) return authThrottleResponse(retry);
        if (!(await verifyPendingFactor(config, checked.factor, code ?? ""))) {
          await recordManagementFailure(tx, "factor");
          await tx
            .update(s.ownerRecovery)
            .set({ failedAttempts: checked.record.failedAttempts + 1 })
            .where(eq(s.ownerRecovery.id, 1));
          return refused();
        }
        await clearManagementFailures(tx, "factor");
        await markFactorVerified(tx, checked.factor);
        await tx.delete(s.ownerRecovery);
        await tx.delete(s.session);
        await tx.delete(s.verification);
        const after = await inspectOwnerRecovery(tx, config);
        if (
          after.status !== "ready" ||
          (await tx.select().from(s.session)).length
        )
          throw new OwnerRecoveryRejected();
        // Same encrypted format as the plugin; no provisional code leaves before verification.
        const { symmetricDecrypt } = await import("better-auth/crypto");
        const recoveryCodes: unknown = JSON.parse(
          await symmetricDecrypt({
            key: config.authSecret,
            data: checked.factor.backupCodes,
          }),
        );
        if (
          !Array.isArray(recoveryCodes) ||
          recoveryCodes.length !== 10 ||
          !recoveryCodes.every(
            (value) =>
              typeof value === "string" &&
              /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(value),
          )
        )
          throw new OwnerRecoveryRejected();
        cleanup.headers.append("Set-Cookie", recoveryAuthorityCookie(config));
        return Response.json(
          { completed: true, freshLoginRequired: true, recoveryCodes },
          { headers: cleanup.headers },
        );
      },
      { isolationLevel: "read committed" },
    );
    response.headers.set("Cache-Control", "no-store");
    if (response.ok && operation === "complete")
      securityEvent("owner_recovery_completed");
    if (!response.ok) securityEvent("proof_rejected");
    return response;
  } catch (error) {
    if (!(error instanceof OwnerRecoveryRejected)) throw error;
    securityEvent("proof_rejected");
    const response = refused();
    response.headers.append("Set-Cookie", recoveryAuthorityCookie(config));
    return response;
  }
}
