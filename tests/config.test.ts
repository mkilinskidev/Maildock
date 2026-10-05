import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  parseConfig,
} from "@/shared/infrastructure/config/config";

const validEnvironment = {
  MAILDOCK_ENV: "test",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://maildock:maildock@localhost:5432/maildock",
  AUTH_SECRET: Buffer.alloc(32, 1).toString("base64"),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  ATTACHMENTS_PATH:
    process.platform === "win32"
      ? "C:\\maildock-attachments"
      : "/tmp/maildock-attachments",
  LOG_LEVEL: "info",
} satisfies Record<string, string | undefined>;

describe("configuration", () => {
  it("requires canonical 32-byte base64 when bootstrap authorization is configured", () => {
    for (const secret of [
      "human password",
      Buffer.alloc(31).toString("base64"),
      Buffer.alloc(33).toString("base64"),
      Buffer.alloc(32).toString("base64").replace(/=$/, ""),
    ]) {
      expect(() =>
        parseConfig({ ...validEnvironment, MAILDOCK_BOOTSTRAP_SECRET: secret }),
      ).toThrow(/MAILDOCK_BOOTSTRAP_SECRET/);
      try {
        parseConfig({ ...validEnvironment, MAILDOCK_BOOTSTRAP_SECRET: secret });
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
    expect(parseConfig(validEnvironment).bootstrapSecretDigest).toBeUndefined();
    expect(
      parseConfig({ ...validEnvironment, MAILDOCK_BOOTSTRAP_SECRET: "" })
        .bootstrapSecretDigest,
    ).toBeUndefined();
  });
  it("accepts valid configuration without exposing secrets", () => {
    const config = parseConfig(validEnvironment);
    expect(config.environment).toBe("test");
    expect(config.databasePoolSize).toBe(10);
    expect(config.initialSyncDays).toBe(30);
    expect(config.messageFetchBatchSize).toBe(150);
    expect(config.backfillChunkSize).toBe(500);
    expect(config.messageSyncConcurrency).toBe(2);
  });

  it("validates recent synchronization bounds", () => {
    expect(() =>
      parseConfig({ ...validEnvironment, MAILDOCK_INITIAL_SYNC_DAYS: "0" }),
    ).toThrow(/MAILDOCK_INITIAL_SYNC_DAYS/);
    expect(() =>
      parseConfig({
        ...validEnvironment,
        MAILDOCK_MESSAGE_FETCH_BATCH_SIZE: "501",
      }),
    ).toThrow(/MAILDOCK_MESSAGE_FETCH_BATCH_SIZE/);
    expect(() =>
      parseConfig({
        ...validEnvironment,
        MAILDOCK_BACKFILL_CHUNK_SIZE: "5001",
      }),
    ).toThrow(/MAILDOCK_BACKFILL_CHUNK_SIZE/);
  });

  it("fails startup with useful field names when required configuration is invalid", () => {
    expect(() =>
      parseConfig({
        ...validEnvironment,
        AUTH_SECRET: "short",
        DATABASE_URL: "invalid",
      }),
    ).toThrow(ConfigurationError);
    try {
      parseConfig({
        ...validEnvironment,
        AUTH_SECRET: "super-secret-value",
        DATABASE_URL: "invalid",
      });
    } catch (error) {
      expect(String(error)).toContain("AUTH_SECRET");
      expect(String(error)).toContain("DATABASE_URL");
      expect(String(error)).not.toContain("super-secret-value");
    }
  });

  it("requires HTTPS for a production origin", () => {
    expect(() =>
      parseConfig({ ...validEnvironment, MAILDOCK_ENV: "production" }),
    ).toThrow(/HTTPS/);
  });

  it("fails startup when the credential master key is absent or malformed", () => {
    const withoutKey = {
      ...validEnvironment,
      CREDENTIALS_ENCRYPTION_KEY: undefined,
    };
    expect(() => parseConfig(withoutKey)).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    expect(() =>
      parseConfig({
        ...validEnvironment,
        CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64"),
      }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      parseConfig({
        ...validEnvironment,
        CREDENTIALS_ENCRYPTION_KEY_ID: "current",
      }),
    ).toThrow(/CREDENTIALS_ENCRYPTION_KEY_ID/);
  });

  it("accepts identified previous keys for controlled rotation", () => {
    const config = parseConfig({
      ...validEnvironment,
      CREDENTIALS_ENCRYPTION_KEY_ID: "v2",
      CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 5).toString("base64"),
      }),
    });
    expect(Object.keys(config.credentialsEncryption.keys)).toEqual([
      "v1",
      "v2",
    ]);
  });
});
