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
        accountId: "account-id",
        accountName: "Hotmail",
        accountEmail: "owner@example.test",
        mailboxId: "mailbox-id",
        mailboxPath: "INBOX",
        password: "password-secret",
        req: {
          headers: { authorization: "auth-secret", cookie: "cookie-secret" },
        },
        credentialsEncryption: { keys: "envelope-secret" },
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        clientSecret: "client-secret",
        code: "code-secret",
        nested: { accessToken: "nested-access-secret" },
      },
      "OAuth event",
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      accountName: "Hotmail",
      accountEmail: "owner@example.test",
      mailboxPath: "INBOX",
      accountId: "account-id",
      mailboxId: "mailbox-id",
    });
    expect(lines[0]).toContain("[REDACTED]");
    expect(lines.join("\n")).not.toMatch(
      /access-secret|refresh-secret|client-secret|code-secret|password-secret|auth-secret|cookie-secret|envelope-secret/,
    );
  });
});
