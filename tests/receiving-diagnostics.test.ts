import { beforeEach, describe, expect, it, vi } from "vitest";
const { lines, write } = vi.hoisted(() => {
  const lines: unknown[] = [];
  return { lines, write: vi.fn((fields: unknown) => lines.push(fields)) };
});
vi.mock("@/shared/infrastructure/logging/logger", () => ({
  createLogger: () => ({ info: write }),
}));
import { receivingDiagnostic } from "@/shared/infrastructure/logging/receiving-diagnostics";
import { credentialAvailability } from "@/modules/accounts/domain/credential-availability";
describe("safe OAuth/receiving diagnostics", () => {
  beforeEach(() => {
    lines.length = 0;
    write.mockClear();
  });
  it("emits only allowlisted fields and drops raw errors, credentials and mail", () => {
    const fields = {
      event: "oauth.refresh" as const,
      correlation: "fixture-operation",
      stage: "failure",
      category: "exchange_unknown",
      issued: true,
      disposition: "reconnect" as const,
      accessToken: "private-access",
      refreshToken: "private-refresh",
      error: new Error("private-message"),
      subject: "private-subject",
      body: "private-body",
    };
    receivingDiagnostic(fields);
    expect(lines[0]).toMatchObject({
      event: "oauth.refresh",
      category: "exchange_unknown",
      issued: true,
    });
    expect(JSON.stringify(lines)).not.toMatch(
      /private-|subject|body|error|accessToken|refreshToken/,
    );
  });
  it("coalesces repeated blocked diagnostics", () => {
    for (let i = 0; i < 20; i++)
      receivingDiagnostic({
        event: "receiving.credentials",
        operation: "content-slice",
        stage: "before_claim",
        category: "unavailable",
      });
    expect(lines).toHaveLength(1);
  });
  it("logging failure cannot change refresh/receiving outcome", () => {
    write.mockImplementationOnce(() => {
      throw new Error("unavailable sink");
    });
    expect(() =>
      receivingDiagnostic({
        event: "oauth.refresh",
        stage: "finish",
        category: "success",
      }),
    ).not.toThrow();
  });
  it("surfaces an unresolved connected refresh without claiming a revoked grant", () => {
    const pending = credentialAvailability({
      authMethod: "oauth2",
      oauthStatus: "connected",
      oauthRefreshAttempt: "fixture-claim",
    });
    expect(pending?.state).toBe("temporary");
    expect(pending?.message).toContain("renewal has not completed");
    expect(pending?.message).not.toMatch(/revoked|rejected/);
    expect(
      credentialAvailability({
        authMethod: "oauth2",
        oauthStatus: "connected",
        oauthRefreshAttempt: null,
      }),
    ).toBeNull();
  });
  it("does not claim temporary or uncertain authorization was revoked, and clears after reconnect", () => {
    expect(
      credentialAvailability({
        authMethod: "oauth2",
        oauthStatus: "connected",
        oauthFailureCategory: "temporary",
      })?.message,
    ).not.toMatch(/revoked|rejected/);
    expect(
      credentialAvailability({
        authMethod: "oauth2",
        oauthStatus: "reconnect_required",
        oauthFailureCategory: "exchange_unknown",
      })?.message,
    ).toContain("unknown");
    expect(
      credentialAvailability({
        authMethod: "oauth2",
        oauthStatus: "connected",
        oauthFailureCategory: null,
      }),
    ).toBeNull();
  });
});
