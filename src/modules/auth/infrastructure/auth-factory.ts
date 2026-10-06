import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor, username } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { logoutCookies } from "@/modules/auth/infrastructure/logout-cookies";
import { withoutTrustedDevice } from "./mfa-cookies";
import { initialMfaHttp } from "../application/initial-mfa-http";
import {
  ownerPasswordSchema,
  passwordMinLength,
  passwordMaxLength,
} from "../domain/password-policy";
import { reserveAuthWork, authThrottleResponse } from "./auth-admission";
import {
  getLoginDelaySeconds,
  recordLoginFailure,
  clearLoginFailures,
} from "./login-throttle";
import { isInstanceOwner } from "@/modules/auth/application/owner-binding";
import {
  isSessionWithinLifetime,
  sessionAbsoluteMs,
  sessionInactivitySeconds,
} from "@/modules/auth/domain/session-policy";

import {
  isOwnerUsername,
  normalizeOwnerUsername,
  ownerUsernameMaxLength,
  ownerUsernameMinLength,
} from "@/modules/auth/domain/owner-username";

import type { AppConfig } from "@/shared/infrastructure/config/config";
import type { Database } from "@/shared/infrastructure/database/database";
import * as authSchema from "@/shared/infrastructure/database/schema";
import {
  hashPassword,
  verifyPassword,
} from "@/modules/auth/infrastructure/password";

// The whole password operation must join the boundary BEFORE its user read.
// A create.before hook ends before INSERT and cannot hold a transaction lock.
// Binding the public Drizzle adapter to tx also keeps the temporary MFA session
// invisible until the plugin's after hook has deleted it.
export async function withInitialMfaBoundary<T>(
  config: AppConfig,
  database: Database,
  operation: (
    auth: ReturnType<typeof createAuthEngine>,
    tx: Database,
  ) => Promise<T>,
): Promise<T> {
  return database.transaction(
    async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(1296125023)`);
      const tx = transaction as unknown as Database;
      return operation(createAuthEngine(config, tx), tx);
    },
    { isolationLevel: "read committed" },
  );
}

export function createAuth(config: AppConfig, database: Database) {
  const auth = createAuthEngine(config, database);
  // Extend the installed plugin's protocol instead of maintaining a second
  // username route schema. Grammar/normalization remain owned by that plugin.
  const loginSchema = auth.api.signInUsername.options.body
    .extend({
      password: ownerPasswordSchema,
    })
    .strict();
  const sessionIssuingMethods = [
    "signInUsername",
    "signInEmail",
    "enableTwoFactor",
    "disableTwoFactor",
    "verifyTOTP",
    "verifyBackupCode",
    "verifyTwoFactorOTP",
    "changePassword",
  ] as const;
  const sessionIssuingPaths = sessionIssuingMethods.map(
    (name) => auth.api[name].path,
  );
  const handler = auth.handler;
  auth.handler = async (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (
      request.method === "POST" &&
      path.endsWith(auth.api.signInUsername.path)
    ) {
      return initialMfaHttp(
        request,
        config,
        loginSchema,
        async (input) => {
          await reserveAuthWork(database, "password");
          return withInitialMfaBoundary(
            config,
            database,
            async (scoped, tx) => {
              // Recheck after acquiring M, immediately before the credential read.
              // Queued requests observe the previous committed failure at READ COMMITTED.
              const retry = await getLoginDelaySeconds(tx, input.username);
              if (retry) return authThrottleResponse(retry);
              const response = await scoped.handler(
                new Request(request.url, {
                  method: "POST",
                  headers: await withoutTrustedDevice(scoped, request.headers),
                  body: JSON.stringify(input),
                }),
              );
              if (response.ok) await clearLoginFailures(tx, input.username);
              else if ([400, 401, 403].includes(response.status))
                await recordLoginFailure(tx, input.username);
              const retryHeader = response.headers.get("X-Retry-After");
              if (retryHeader) response.headers.set("Retry-After", retryHeader);
              return response;
            },
          );
        },
        "Sign in could not be completed.",
      );
    }
    // Match the catch-all's suffix allowlist, including router trailing slashes.
    // Logout and session reads retain their existing transaction semantics.
    if (
      request.method === "POST" &&
      sessionIssuingPaths.some((endpoint) => path.endsWith(endpoint))
    ) {
      return withInitialMfaBoundary(config, database, async (scoped) =>
        scoped.handler(
          new Request(request, {
            headers: await withoutTrustedDevice(scoped, request.headers),
          }),
        ),
      );
    }
    return handler(request);
  };
  // Direct server API calls must participate too; HTTP uses scoped raw engines.
  for (const name of sessionIssuingMethods) {
    const original = auth.api[name];
    const wrapped = Object.assign(
      ((input: unknown) =>
        withInitialMfaBoundary(config, database, async (scoped) => {
          const supplied = input as { headers?: HeadersInit };
          return Reflect.apply(scoped.api[name], undefined, [
            {
              ...supplied,
              headers: await withoutTrustedDevice(scoped, supplied?.headers),
            },
          ]) as Promise<unknown>;
        })) as typeof original,
      { path: original.path, options: original.options },
    );
    Object.assign(auth.api, { [name]: wrapped });
  }
  return auth;
}

function createAuthEngine(config: AppConfig, database: Database) {
  const auth = betterAuth({
    appName: "Maildock",
    baseURL: config.appOrigin,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: passwordMinLength,
      maxPasswordLength: passwordMaxLength,
      autoSignIn: false,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
    },
    session: {
      expiresIn: sessionInactivitySeconds,
      updateAge: 15 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        absoluteExpiresAt: {
          type: "date",
          required: true,
          input: false,
          returned: true,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // Includes pending and expired ceremonies. Password login must not
            // create a session that could bypass the replacement authority.
            if (
              (
                await database
                  .select()
                  .from(authSchema.mfaReplacement)
                  .where(
                    eq(authSchema.mfaReplacement.ownerUserId, session.userId),
                  )
              ).length
            )
              return false;
            return {
              data: {
                ...session,
                // Better Auth 1.7.5 hardcodes 24h for rememberMe:false. Its
                // supported database hook corrects expiry without changing cookies.
                expiresAt: new Date(
                  session.createdAt.getTime() +
                    sessionInactivitySeconds * 1_000,
                ),
                absoluteExpiresAt: new Date(
                  session.createdAt.getTime() + sessionAbsoluteMs,
                ),
              },
            };
          },
        },
        update: {
          before: async (update, context) => {
            // get-session supplies the authoritative, pre-refresh database row.
            // Reject before writing: the public protocol must not revive an old
            // overlong session, even when the dont_remember cookie is omitted.
            const previous = context?.context.session?.session;
            const now = Date.now();
            if (!previous || !isSessionWithinLifetime(previous, now))
              return false;
            return {
              data: {
                ...update,
                createdAt: previous.createdAt,
                absoluteExpiresAt: previous.absoluteExpiresAt,
                updatedAt: new Date(now),
                expiresAt: new Date(
                  Math.min(
                    now + sessionInactivitySeconds * 1_000,
                    (previous.absoluteExpiresAt as Date).getTime(),
                    previous.createdAt.getTime() + sessionAbsoluteMs,
                  ),
                ),
              },
            };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 60, max: 10 },
      },
    },
    advanced: {
      // V1 does not require authoritative client IP. Ignore all caller-supplied
      // address headers; retain database HTTP limiting in a shared per-path
      // bucket in production. Do not disableIpTracking: it bypasses that limiter.
      ipAddress: { ipAddressHeaders: [] },
      // Keep the auth protocol's own CSRF boundary enabled in every runtime,
      // including tests (Better Auth otherwise disables Origin checks there).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: "maildock",
      useSecureCookies: config.environment === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.environment === "production",
        path: "/",
      },
    },
    plugins: [
      logoutCookies,
      twoFactor({
        issuer: "Maildock",
        skipVerificationOnEnable: false,
        allowPasswordless: false,
        twoFactorCookieMaxAge: 600,
        // No sendOTP: email/SMS OTP is unavailable. All two-factor endpoints
        // remain private behind the existing HTTP allowlist in F2.1.
      }),
      username({
        minUsernameLength: ownerUsernameMinLength,
        maxUsernameLength: ownerUsernameMaxLength,
        usernameValidator: isOwnerUsername,
        usernameNormalization: normalizeOwnerUsername,
        immutableUsername: true,
        displayUsername: true,
      }),
    ],
    experimental: {
      instrumentation: { enabled: false },
    },
  });
  // Bind the authorization reader to the same database as Better Auth.
  return Object.assign(auth, {
    isMfaReplacementPending: async () =>
      (await database.select().from(authSchema.mfaReplacement)).length > 0,
    isInstanceOwner: (userId: string) => isInstanceOwner(database, userId),
    isInstanceReady: (userId: string, sessionId?: string) =>
      isInstanceReady(database, userId, sessionId),
  });
}
