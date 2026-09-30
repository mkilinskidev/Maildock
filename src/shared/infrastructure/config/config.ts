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

const keyIdSchema = z
  .string()
  .regex(/^v[1-9][0-9]*$/, "must look like v1 or v2");

const encryptionKeySchema = z.string().refine((value) => {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value;
}, "must be canonical base64 encoding of exactly 32 bytes");

const previousKeysSchema = z
  .string()
  .default("{}")
  .transform((value, context): Record<string, string> => {
    try {
      const parsed = z
        .record(keyIdSchema, encryptionKeySchema)
        .parse(JSON.parse(value));
      return parsed;
    } catch {
      context.addIssue({
        code: "custom",
        message: "must be a JSON object of key IDs to base64 32-byte keys",
      });
      return z.NEVER;
    }
  });

const schema = z
  .object({
    MAILDOCK_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_ORIGIN: z.url(),
    DATABASE_URL: z.string().min(1).startsWith("postgresql://"),
    AUTH_SECRET: secretSchema,
    CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
    CREDENTIALS_ENCRYPTION_KEY_ID: keyIdSchema.default("v1"),
    CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS: previousKeysSchema,
    ATTACHMENTS_PATH: z
      .string()
      .min(1)
      .refine(path.isAbsolute, "must be an absolute path"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    MAILDOCK_INITIAL_SYNC_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    MAILDOCK_MESSAGE_FETCH_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(10)
      .max(500)
      .default(150),
    MAILDOCK_MESSAGE_SYNC_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2),
    MAILDOCK_MAIL_POLL_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3600)
      .default(300),
    MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(20 * 1024 * 1024)
      .default(5 * 1024 * 1024),
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
  credentialsEncryption: Readonly<{
    activeKeyId: string;
    keys: Readonly<Record<string, string>>;
  }>;
  attachmentsPath: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  databasePoolSize: number;
  workerConcurrency: number;
  initialSyncDays: number;
  messageFetchBatchSize: number;
  messageSyncConcurrency: number;
  mailPollIntervalSeconds: number;
  maxMessageTextPartBytes: number;
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
    credentialsEncryption: Object.freeze({
      activeKeyId: result.data.CREDENTIALS_ENCRYPTION_KEY_ID,
      keys: Object.freeze({
        ...result.data.CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS,
        [result.data.CREDENTIALS_ENCRYPTION_KEY_ID]:
          result.data.CREDENTIALS_ENCRYPTION_KEY,
      }),
    }),
    attachmentsPath: result.data.ATTACHMENTS_PATH,
    logLevel: result.data.LOG_LEVEL,
    databasePoolSize: result.data.DATABASE_POOL_SIZE,
    workerConcurrency: result.data.WORKER_CONCURRENCY,
    initialSyncDays: result.data.MAILDOCK_INITIAL_SYNC_DAYS,
    messageFetchBatchSize: result.data.MAILDOCK_MESSAGE_FETCH_BATCH_SIZE,
    messageSyncConcurrency: result.data.MAILDOCK_MESSAGE_SYNC_CONCURRENCY,
    mailPollIntervalSeconds: result.data.MAILDOCK_MAIL_POLL_INTERVAL_SECONDS,
    maxMessageTextPartBytes: result.data.MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES,
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
