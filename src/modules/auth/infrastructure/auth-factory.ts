import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor, username } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { logoutCookies } from "@/modules/auth/infrastructure/logout-cookies";
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
  auth.handler = (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    // Match the catch-all's suffix allowlist, including router trailing slashes.
    // Logout and session reads retain their existing transaction semantics.
    if (
      request.method === "POST" &&
      sessionIssuingPaths.some((endpoint) => path.endsWith(endpoint))
    ) {
      return withInitialMfaBoundary(config, database, (scoped) =>
        scoped.handler(request),
      );
    }
    return handler(request);
  };
  // Direct server API calls must participate too; HTTP uses scoped raw engines.
  for (const name of sessionIssuingMethods) {
    const original = auth.api[name];
    const wrapped = Object.assign(
      ((input: unknown) =>
        withInitialMfaBoundary(
          config,
          database,
          (scoped) =>
            Reflect.apply(scoped.api[name], undefined, [
              input,
            ]) as Promise<unknown>,
        )) as typeof original,
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
      minPasswordLength: 12,
      maxPasswordLength: 128,
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
          before: async (session) => ({
            data: {
              ...session,
              // Better Auth 1.7.5 hardcodes 24h for rememberMe:false. Its
              // supported database hook corrects expiry without changing cookies.
              expiresAt: new Date(
                session.createdAt.getTime() + sessionInactivitySeconds * 1_000,
              ),
              absoluteExpiresAt: new Date(
                session.createdAt.getTime() + sessionAbsoluteMs,
              ),
            },
          }),
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
    isInstanceOwner: (userId: string) => isInstanceOwner(database, userId),
    isInstanceReady: (userId: string, sessionId?: string) =>
      isInstanceReady(database, userId, sessionId),
  });
}
