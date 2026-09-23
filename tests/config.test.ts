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
  it("accepts valid configuration without exposing secrets", () => {
    const config = parseConfig(validEnvironment);
    expect(config.environment).toBe("test");
    expect(config.databasePoolSize).toBe(10);
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
});
