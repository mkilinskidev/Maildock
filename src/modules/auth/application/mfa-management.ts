import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { withInitialMfaBoundary } from "../infrastructure/auth-factory";
import { getValidBusinessSession } from "./session-validation";
import { isInstanceReady } from "./instance-readiness";
import { isInstanceOwner } from "./owner-binding";
import { InitialMfaRejected } from "./initial-mfa";
import type { Database } from "@/shared/infrastructure/database/database";
import type { AppConfig } from "@/shared/infrastructure/config/config";
import {
  mfaReplacement,
  session,
  twoFactor,
  user,
  verification,
} from "@/shared/infrastructure/database/schema";

export const managementSchema = z.discriminatedUnion("proofType", [
  z
    .object({
      password: z.string().min(12).max(128),
      proofType: z.literal("totp"),
      proofCode: z.string().regex(/^\d{6}$/),
    })
    .strict(),
  z
    .object({
      password: z.string().min(12).max(128),
      proofType: z.literal("recovery"),
      proofCode: z.string().regex(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/),
    })
    .strict(),
]);
export const replacementCompleteSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();
export const replacementResumeSchema = z.object({}).strict();
export const replacementPath = "/api/auth/mfa/manage/authenticator";
export const replacementCookie = "maildock.mfa_replacement";
export const replacementLifetimeSeconds = 600;
type ScopedAuth = Parameters<Parameters<typeof withInitialMfaBoundary>[2]>[0];
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const rejected = () => new InitialMfaRejected();
const genericError = () =>
  Response.json(
    { error: "MFA management could not be completed." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );

function authorityCookie(config: AppConfig, token: string, maxAge: number) {
  return `${replacementCookie}=${token}; Path=${replacementPath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.environment === "production" ? "; Secure" : ""}`;
}

async function authorize(
  auth: ScopedAuth,
  headers: Headers,
  input: z.infer<typeof managementSchema>,
) {
  const owner = await getValidBusinessSession(auth, headers);
  if (!owner) throw rejected();
  const context = await auth.$context;
  const credential = await context.internalAdapter.findCredentialAccount(
    owner.user.id,
  );
  if (
    !credential?.password ||
    !(await context.password.verify({
      hash: credential.password,
      password: input.password,
    }))
  )
    throw rejected();
  try {
    // Authenticated verified-factor paths do NOT issue a session or challenge.
    // disableSession does not make the recovery path safe for anonymous users;
    // the authoritative business session above is mandatory.
    if (input.proofType === "totp")
      await auth.api.verifyTOTP({ headers, body: { code: input.proofCode } });
    else
      await auth.api.verifyBackupCode({
        headers,
        body: { code: input.proofCode, disableSession: true },
      });
  } catch (error) {
    if (error instanceof APIError) throw rejected();
    throw error;
  }
  return owner;
}

export async function regenerateRecoveryCodes(
  database: Database,
  config: AppConfig,
  headers: Headers,
  input: z.infer<typeof managementSchema>,
) {
  return withInitialMfaBoundary(config, database, async (auth, tx) => {
    const owner = await authorize(auth, headers, input);
    const result = await auth.api.generateBackupCodes({
      headers,
      body: { password: input.password },
    });
    if (!(await isInstanceReady(tx, owner.user.id, owner.session.id)))
      throw rejected();
    // The enclosing promise resolves after COMMIT. No cookies/API tokens leak.
    return { recoveryCodes: result.backupCodes };
  });
}

export async function startAuthenticatorReplacement(
  database: Database,
  config: AppConfig,
  headers: Headers,
  input: z.infer<typeof managementSchema>,
) {
  return withInitialMfaBoundary(config, database, async (auth, tx) => {
    const owner = await authorize(auth, headers, input);
    if ((await tx.select().from(mfaReplacement)).length) throw rejected();
    await tx.delete(twoFactor).where(eq(twoFactor.userId, owner.user.id));
    // enableTwoFactor owns new secret + encrypted recovery generation. Default
    // skipVerificationOnEnable:false neither rotates nor creates a session.
    await auth.api.enableTwoFactor({
      headers,
      body: { password: input.password, method: "totp" },
    });
    const [factor] = await tx
      .select()
      .from(twoFactor)
      .where(eq(twoFactor.userId, owner.user.id));
    if (!factor || factor.verified !== false) throw rejected();
    await tx
      .update(user)
      .set({ twoFactorEnabled: false })
      .where(eq(user.id, owner.user.id));
    const token = randomBytes(32).toString("base64url");
    await tx.insert(mfaReplacement).values({
      ownerUserId: owner.user.id,
      factorId: factor.id,
      tokenDigest: digest(token),
      expiresAt: new Date(Date.now() + replacementLifetimeSeconds * 1000),
    });
    await tx.delete(session).where(eq(session.userId, owner.user.id));
    // Invalidate pre-replacement login challenges too: after completion an old
    // password challenge must not authorize a login against the new factor.
    const challenges = await tx
      .select()
      .from(verification)
      .where(eq(verification.value, owner.user.id));
    if (challenges.length)
      await tx.delete(verification).where(
        inArray(
          verification.identifier,
          challenges.flatMap((row) => [
            row.identifier,
            `2fa-attempts-${row.identifier}`,
          ]),
        ),
      );
    if (
      (await tx.select().from(session).where(eq(session.userId, owner.user.id)))
        .length ||
      (await isInstanceReady(tx))
    )
      throw new Error("Replacement revocation could not be confirmed.");
    const cleanup = await auth.api.clearInitialMfaCookies({
      headers,
      asResponse: true,
    });
    if (!cleanup.ok) throw rejected();
    const response = Response.json(
      { replacementStarted: true },
      { headers: cleanup.headers },
    );
    response.headers.append(
      "Set-Cookie",
      authorityCookie(config, token, replacementLifetimeSeconds),
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}

async function pendingReplacement(tx: Database, headers: Headers) {
  const cookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${replacementCookie}=`));
  if (cookies.length !== 1) throw rejected();
  const token = cookies[0].slice(replacementCookie.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw rejected();
  const records = await tx
    .select()
    .from(mfaReplacement)
    .where(eq(mfaReplacement.tokenDigest, digest(token)));
  const record = records[0];
  if (
    records.length !== 1 ||
    record.expiresAt.getTime() <= Date.now() ||
    record.failedAttempts >= 5 ||
    !(await isInstanceOwner(tx, record.ownerUserId))
  )
    throw rejected();
  const owners = await tx
    .select()
    .from(user)
    .where(eq(user.id, record.ownerUserId));
  const factors = await tx.select().from(twoFactor);
  if (
    owners.length !== 1 ||
    owners[0].twoFactorEnabled !== false ||
    factors.length !== 1 ||
    factors[0].id !== record.factorId ||
    factors[0].userId !== record.ownerUserId ||
    factors[0].verified !== false ||
    (
      await tx
        .select()
        .from(session)
        .where(eq(session.userId, record.ownerUserId))
    ).length
  )
    throw rejected();
  return { record, owner: owners[0], factor: factors[0] };
}

async function replacementOperation<T>(
  database: Database,
  config: AppConfig,
  headers: Headers,
  operation: (
    auth: ScopedAuth,
    tx: Database,
    pending: Awaited<ReturnType<typeof pendingReplacement>>,
  ) => Promise<T>,
) {
  try {
    return await withInitialMfaBoundary(config, database, async (auth, tx) =>
      operation(auth, tx, await pendingReplacement(tx, headers)),
    );
  } catch (error) {
    if (!(error instanceof InitialMfaRejected)) throw error;
    const response = genericError();
    response.headers.append("Set-Cookie", authorityCookie(config, "", 0));
    return response;
  }
}

export async function resumeAuthenticatorReplacement(
  database: Database,
  config: AppConfig,
  headers: Headers,
) {
  return replacementOperation(
    database,
    config,
    headers,
    async (auth, _tx, { factor, owner }) => {
      const context = await auth.$context;
      const secret = await symmetricDecrypt({
        key: context.secretConfig,
        data: factor.secret,
      });
      // The exact installed primitive/options used by Better Auth 1.7.5.
      return {
        totpURI: createOTP(secret, { digits: 6, period: 30 }).url(
          "Maildock",
          owner.email,
        ),
      };
    },
  );
}

export async function completeAuthenticatorReplacement(
  database: Database,
  config: AppConfig,
  headers: Headers,
  code: string,
) {
  return replacementOperation(
    database,
    config,
    headers,
    async (auth, tx, { factor, record }) => {
      const context = await auth.$context;
      const secret = await symmetricDecrypt({
        key: context.secretConfig,
        data: factor.secret,
      });
      if (!(await createOTP(secret, { digits: 6, period: 30 }).verify(code))) {
        // Return instead of throwing: the bounded ceremony budget must COMMIT.
        await tx
          .update(mfaReplacement)
          .set({ failedAttempts: record.failedAttempts + 1 })
          .where(eq(mfaReplacement.ownerUserId, record.ownerUserId));
        const response = genericError();
        if (record.failedAttempts + 1 >= 5)
          response.headers.append("Set-Cookie", authorityCookie(config, "", 0));
        return response;
      }
      // No verifyTOTP endpoint here: for an unverified factor it rotates a
      // session. This narrow composition verifies via its installed primitive.
      await tx
        .update(twoFactor)
        .set({ verified: true })
        .where(
          and(
            eq(twoFactor.id, factor.id),
            eq(twoFactor.userId, record.ownerUserId),
          ),
        );
      await tx
        .update(user)
        .set({ twoFactorEnabled: true })
        .where(eq(user.id, record.ownerUserId));
      await tx
        .delete(mfaReplacement)
        .where(eq(mfaReplacement.ownerUserId, record.ownerUserId));
      if (
        !(await isInstanceReady(tx, record.ownerUserId)) ||
        (
          await tx
            .select()
            .from(session)
            .where(eq(session.userId, record.ownerUserId))
        ).length
      )
        throw rejected();
      const result = await auth.api.viewBackupCodes({
        body: { userId: record.ownerUserId },
      });
      const cleanup = await auth.api.clearInitialMfaCookies({
        headers,
        asResponse: true,
      });
      if (!cleanup.ok) throw rejected();
      const response = Response.json(
        {
          completed: true,
          freshLoginRequired: true,
          recoveryCodes: result.backupCodes,
        },
        { headers: cleanup.headers },
      );
      response.headers.append("Set-Cookie", authorityCookie(config, "", 0));
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  );
}
