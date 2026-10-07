import { beforeEach, expect, it, vi } from "vitest";
import { GoogleAuthorizationError } from "@/modules/accounts/infrastructure/google-oauth";

const runtime = vi.hoisted(() => ({
  session: vi.fn(),
  configured: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  discovery: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/modules/auth/application/session", () => ({
  getCurrentSession: runtime.session,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  oauthProviders: { get: runtime.get },
  accountsService: { requestMailboxDiscovery: runtime.discovery },
}));
vi.mock("@/shared/infrastructure/config/config", () => ({
  getConfig: () => ({ appOrigin: "https://mail.example.com" }),
}));
import { GET as start } from "@/app/api/oauth/google/start/route";
import { GET as callback } from "@/app/api/oauth/google/callback/route";

beforeEach(() => {
  vi.resetAllMocks();
  runtime.session.mockResolvedValue({ session: { id: "owner-session" } });
  runtime.get.mockReturnValue({
    isConfigured: runtime.configured,
    begin: runtime.begin,
    complete: runtime.complete,
  });
  runtime.configured.mockResolvedValue(true);
  runtime.begin.mockResolvedValue(
    "https://accounts.google.com/o/oauth2/v2/auth?state=pending",
  );
  runtime.complete.mockResolvedValue("local-account");
});
it("requires owner auth on both Google routes before provider access", async () => {
  runtime.session.mockResolvedValue(null);
  for (const route of [start, callback]) {
    const response = await route(
      new Request("https://evil.example/api/oauth/google/callback?code=secret"),
    );
    expect(response.headers.get("location")).toBe(
      "https://mail.example.com/login",
    );
  }
  expect(runtime.get).not.toHaveBeenCalled();
});
it("sends an unconfigured provider to trusted configuration guidance", async () => {
  runtime.configured.mockResolvedValue(false);
  const response = await start(
    new Request("https://evil.example/api/oauth/google/start"),
  );
  expect(response.headers.get("location")).toBe(
    "https://mail.example.com/accounts?oauth_error=configuration",
  );
  expect(runtime.begin).not.toHaveBeenCalled();
});
it("starts registered Google with the authenticated session and reconnect target", async () => {
  const response = await start(
    new Request(
      "https://mail.example.com/api/oauth/google/start?accountId=existing",
    ),
  );
  expect(runtime.get).toHaveBeenCalledWith("google");
  expect(runtime.begin).toHaveBeenCalledWith("owner-session", "existing");
  expect(response.headers.get("location")).toMatch(
    /^https:\/\/accounts.google.com\//,
  );
});
it("completes server-side, ignores callback account/redirect injection and schedules generic discovery", async () => {
  const response = await callback(
    new Request(
      "https://evil.example/api/oauth/google/callback?state=pending&code=code-private&accountId=attacker&redirect_uri=https://evil.example",
    ),
  );
  expect(runtime.complete).toHaveBeenCalledWith(
    "owner-session",
    "pending",
    "code-private",
    undefined,
  );
  expect(runtime.discovery).toHaveBeenCalledWith("local-account");
  expect(response.headers.get("location")).toBe(
    "https://mail.example.com/accounts?oauth=connected&account=local-account",
  );
  expect(await response.text()).not.toMatch(/code-private|pending|token/);
});
it.each([
  ["Invalid or expired Google authorization state.", "state"],
  ["Google consent was denied.", "denied"],
  ["Reconnect using the same Google account.", "identity"],
])(
  "rejects failed callback without discovery or reflected payload (%s)",
  async (message, reason) => {
    runtime.complete.mockRejectedValue(new GoogleAuthorizationError(message));
    const response = await callback(
      new Request(
        "https://mail.example.com/api/oauth/google/callback?state=secret-state&code=secret-code",
      ),
    );
    expect(response.headers.get("location")).toBe(
      `https://mail.example.com/accounts?oauth_error=${reason}`,
    );
    expect(runtime.discovery).not.toHaveBeenCalled();
  },
);
it("never reflects raw token/provider exceptions", async () => {
  runtime.complete.mockRejectedValue(
    new Error("access-private refresh-private client-private"),
  );
  const response = await callback(
    new Request(
      "https://mail.example.com/api/oauth/google/callback?state=pending&error=private-error",
    ),
  );
  expect(response.headers.get("location")).toBe(
    "https://mail.example.com/accounts?oauth_error=authorization",
  );
  expect(await response.text()).not.toContain("private");
});
