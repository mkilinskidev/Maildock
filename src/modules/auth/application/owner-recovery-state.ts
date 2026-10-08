import { eq, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import * as s from "../../../shared/infrastructure/database/schema";
import {
  isOwnerUsername,
  normalizeOwnerUsername,
} from "../domain/owner-username";
import { argon2idParameters } from "../infrastructure/password";
import { symmetricDecrypt } from "better-auth/crypto";
import type { AppConfig } from "../../../shared/infrastructure/config/config";

export class OwnerRecoveryRejected extends Error {
  constructor(readonly category = "owner_recovery_refused") {
    super("Owner recovery refused; inspect the instance state.");
    this.stack = undefined;
  }
}

// Caller holds M. Never repair binding or infer ownership from the first user.
export async function inspectOwnerRecovery(tx: Database, config: AppConfig) {
  const states = await tx.select().from(s.instanceState);
  const users = await tx.select().from(s.user);
  const accounts = await tx.select().from(s.account);
  const factors = await tx.select().from(s.twoFactor);
  const replacements = await tx.select().from(s.mfaReplacement);
  const recoveries = await tx.select().from(s.ownerRecovery);
  const state = states[0],
    owner = users[0],
    credential = accounts[0],
    factor = factors[0],
    replacement = replacements[0],
    recovery = recoveries[0];
  if (
    states.length === 1 &&
    state.id === 1 &&
    state.initializedAt === null &&
    state.ownerUserId === null &&
    !users.length &&
    !accounts.length &&
    !factors.length &&
    !replacements.length &&
    !recoveries.length
  )
    throw new OwnerRecoveryRejected("owner_recovery_uninitialized");
  if (
    states.length !== 1 ||
    state.id !== 1 ||
    !(state.initializedAt instanceof Date) ||
    !Number.isFinite(state.initializedAt.getTime()) ||
    users.length !== 1 ||
    state.ownerUserId !== owner.id ||
    !owner.id ||
    owner.id.trim() !== owner.id ||
    !owner.username ||
    !isOwnerUsername(owner.username) ||
    normalizeOwnerUsername(owner.username) !== owner.username ||
    accounts.length !== 1 ||
    credential.userId !== owner.id ||
    credential.accountId !== owner.id ||
    credential.providerId !== "credential" ||
    !credential.password ||
    [
      credential.accessToken,
      credential.refreshToken,
      credential.idToken,
      credential.accessTokenExpiresAt,
      credential.refreshTokenExpiresAt,
      credential.scope,
    ].some((value) => value !== null) ||
    !/^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(
      credential.password,
    ) ||
    state.passwordAlgorithm !== "argon2id" ||
    !state.passwordParameters ||
    ["memoryCost", "timeCost", "parallelism", "outputLen"].some(
      (key) =>
        state.passwordParameters?.[key] !==
        argon2idParameters[key as keyof typeof argon2idParameters],
    ) ||
    factors.length > 1 ||
    factors.some(
      (row) => row.userId !== owner.id || row.failedVerificationCount < 0,
    ) ||
    replacements.length > 1 ||
    recoveries.length > 1 ||
    (replacement && recovery)
  )
    throw new OwnerRecoveryRejected();
  let status: "ready" | "initial" | "replacement" | "recovery";
  if (recovery) {
    if (
      recovery.id !== 1 ||
      recovery.ownerUserId !== owner.id ||
      !factor ||
      recovery.factorId !== factor.id ||
      owner.twoFactorEnabled ||
      factor.verified ||
      state.bootstrapSecretDigest !== null ||
      state.bootstrapExpiresAt !== null
    )
      throw new OwnerRecoveryRejected();
    status = "recovery";
  } else if (replacement) {
    if (
      replacement.ownerUserId !== owner.id ||
      !factor ||
      replacement.factorId !== factor.id ||
      owner.twoFactorEnabled ||
      factor.verified ||
      state.bootstrapSecretDigest !== null
    )
      throw new OwnerRecoveryRejected();
    status = "replacement";
  } else if (
    owner.twoFactorEnabled &&
    factor?.verified &&
    state.bootstrapSecretDigest === null &&
    state.bootstrapExpiresAt === null
  ) {
    status = "ready";
  } else if (
    !owner.twoFactorEnabled &&
    (!factor || !factor.verified) &&
    /^[0-9a-f]{64}$/.test(state.bootstrapSecretDigest ?? "") &&
    state.bootstrapExpiresAt === null
  ) {
    status = "initial";
  } else throw new OwnerRecoveryRejected();
  if (
    (status === "replacement" || status === "recovery") &&
    (await tx.select({ id: s.session.id }).from(s.session)).length
  )
    throw new OwnerRecoveryRejected();
  if (factor) {
    try {
      const secret = await symmetricDecrypt({
        key: config.authSecret,
        data: factor.secret,
      });
      const codes: unknown = JSON.parse(
        await symmetricDecrypt({
          key: config.authSecret,
          data: factor.backupCodes,
        }),
      );
      if (
        !/^[A-Za-z0-9_-]{16,128}$/.test(secret) ||
        !Array.isArray(codes) ||
        codes.length > 10 ||
        !codes.every(
          (value) =>
            typeof value === "string" &&
            /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(value),
        ) ||
        new Set(codes).size !== codes.length
      )
        throw new Error();
    } catch {
      throw new OwnerRecoveryRejected("owner_recovery_keys");
    }
  }
  return { state, owner, credential, factor, replacement, recovery, status };
}

export async function lockOwnerRecovery(tx: Database) {
  await tx.execute(sql`select pg_advisory_xact_lock(1296125023)`);
  await tx
    .select({ id: s.instanceState.id })
    .from(s.instanceState)
    .where(eq(s.instanceState.id, 1))
    .for("update");
}
