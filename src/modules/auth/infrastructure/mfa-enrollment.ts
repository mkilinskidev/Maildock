import { randomUUID } from "node:crypto";
import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import {
  twoFactor,
  user,
} from "../../../shared/infrastructure/database/schema";

// Better Auth 1.7.7 defaults. Use public primitives, never private dist imports.
export async function prepareRecoveryCodes(authSecret: string) {
  const recoveryCodes = Array.from({ length: 10 }, () => {
    const value = generateRandomString(10, "a-z", "0-9", "A-Z");
    return `${value.slice(0, 5)}-${value.slice(5)}`;
  });
  return {
    recoveryCodes,
    ciphertext: await symmetricEncrypt({
      key: authSecret,
      data: JSON.stringify(recoveryCodes),
    }),
  };
}

export async function preparePendingFactor(config: AppConfig, ownerId: string) {
  const secret = generateRandomString(32);
  const { ciphertext } = await prepareRecoveryCodes(config.authSecret);
  return {
    id: randomUUID(),
    userId: ownerId,
    secret: await symmetricEncrypt({ key: config.authSecret, data: secret }),
    backupCodes: ciphertext,
    verified: false,
    failedVerificationCount: 0,
    lockedUntil: null,
  };
}

export async function pendingFactorURI(
  config: AppConfig,
  factor: typeof twoFactor.$inferSelect,
  email: string,
) {
  const secret = await symmetricDecrypt({
    key: config.authSecret,
    data: factor.secret,
  });
  return createOTP(secret, { digits: 6, period: 30 }).url("Maildock", email);
}

export async function verifyPendingFactor(
  config: AppConfig,
  factor: typeof twoFactor.$inferSelect,
  code: string,
) {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = await symmetricDecrypt({
    key: config.authSecret,
    data: factor.secret,
  });
  return createOTP(secret, { digits: 6, period: 30 }).verify(code);
}

export async function markFactorVerified(
  tx: Database,
  factor: typeof twoFactor.$inferSelect,
) {
  await tx
    .update(twoFactor)
    .set({ verified: true })
    .where(eq(twoFactor.id, factor.id));
  await tx
    .update(user)
    .set({ twoFactorEnabled: true })
    .where(eq(user.id, factor.userId));
}
