import path from "node:path";

import { z } from "zod";

const secretSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return Buffer.from(value, "base64").byteLength >= 32;
    } catch {
      return false;
    }
  }, "must be base64-encoded and decode to at least 32 bytes");

const encryptionKeySchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return Buffer.from(value, "base64").byteLength === 32;
    } catch {
      return false;
    }
  }, "must be base64-encoded and decode to exactly 32 bytes");

const schema = z
  .object({
    MAILDOCK_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_ORIGIN: z.url(),
    DATABASE_URL: z.string().min(1).startsWith("postgresql://"),
    AUTH_SECRET: secretSchema,
    CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
    ATTACHMENTS_PATH: z
      .string()
      .min(1)
      .refine(path.isAbsolute, "must be an absolute path"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  })
  .superRefine((value, context) => {
    const origin = new URL(value.APP_ORIGIN);
    if (
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message:
          "must be a canonical origin without credentials, path, query, or fragment",
      });
    }
    if (value.MAILDOCK_ENV === "production" && origin.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "must use HTTPS in production",
      });
    }
  });

export type AppConfig = Readonly<{
  environment: "development" | "test" | "production";
  appOrigin: string;
  databaseUrl: string;
  authSecret: string;
  credentialsEncryptionKey: string;
  attachmentsPath: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  databasePoolSize: number;
  workerConcurrency: number;
}>;

export class ConfigurationError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid Maildock configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    this.name = "ConfigurationError";
  }
}

export function parseConfig(
  environment: Record<string, string | undefined>,
): AppConfig {
  const result = schema.safeParse(environment);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      ),
    );
  }

  return Object.freeze({
    environment: result.data.MAILDOCK_ENV,
    appOrigin: new URL(result.data.APP_ORIGIN).origin,
    databaseUrl: result.data.DATABASE_URL,
    authSecret: result.data.AUTH_SECRET,
    credentialsEncryptionKey: result.data.CREDENTIALS_ENCRYPTION_KEY,
    attachmentsPath: result.data.ATTACHMENTS_PATH,
    logLevel: result.data.LOG_LEVEL,
    databasePoolSize: result.data.DATABASE_POOL_SIZE,
    workerConcurrency: result.data.WORKER_CONCURRENCY,
  });
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= parseConfig(process.env);
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
