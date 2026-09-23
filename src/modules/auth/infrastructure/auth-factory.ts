import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";

import type { AppConfig } from "@/shared/infrastructure/config/config";
import type { Database } from "@/shared/infrastructure/database/database";
import * as authSchema from "@/shared/infrastructure/database/schema";
import {
  hashPassword,
  verifyPassword,
} from "@/modules/auth/infrastructure/password";

const twelveHours = 60 * 60 * 12;
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

export function createAuth(config: AppConfig, database: Database) {
  return betterAuth({
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
      expiresIn: twelveHours,
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
              absoluteExpiresAt: new Date(Date.now() + thirtyDaysMs),
            },
          }),
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
      username({
        minUsernameLength: 3,
        maxUsernameLength: 64,
        immutableUsername: true,
        displayUsername: true,
      }),
    ],
    experimental: {
      instrumentation: { enabled: false },
    },
  });
}
