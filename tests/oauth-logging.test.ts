import { describe, expect, it } from "vitest";
import { createLogger } from "@/shared/infrastructure/logging/logger";

describe("OAuth log redaction", () => {
  it("does not emit token, authorization code, or client secret fields", () => {
    const lines: string[] = [];
    const stream = {
      write: (line: string) => {
        lines.push(line);
      },
    };
    const safeLogger = createLogger({ logLevel: "info" }, stream);
    safeLogger.info(
      {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        clientSecret: "client-secret",
        code: "code-secret",
        nested: { accessToken: "nested-access-secret" },
      },
      "OAuth event",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[REDACTED]");
    expect(lines.join("\n")).not.toMatch(
      /access-secret|refresh-secret|client-secret|code-secret/,
    );
  });
});
