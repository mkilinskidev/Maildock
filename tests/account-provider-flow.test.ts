import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  configured: vi.fn(),
  redirect: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  discover: vi.fn(),
  access: vi.fn(),
  create: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/auth/application/session", () => ({
  getCurrentSession: mocks.session,
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  microsoftOAuth: {
    isConfigured: mocks.configured,
    begin: mocks.begin,
    complete: mocks.complete,
  },
  accountsService: {
    requestMailboxDiscovery: mocks.discover,
    create: mocks.create,
  },
}));
vi.mock("@/shared/infrastructure/config/config", () => ({
  getConfig: () => ({ appOrigin: "https://mail.example.com" }),
}));

import NewAccountPage from "@/app/accounts/new/page";
import { GET as start } from "@/app/api/oauth/microsoft/start/route";
import { GET as callback } from "@/app/api/oauth/microsoft/callback/route";
import { POST as create } from "@/app/api/accounts/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ session: { id: "owner-session" } });
  mocks.configured.mockResolvedValue(true);
  mocks.redirect.mockImplementation((url) => {
    throw Error(`redirect:${url}`);
  });
  mocks.begin.mockResolvedValue("https://login.microsoftonline.com/authorize");
  mocks.complete.mockResolvedValue("new-account");
  mocks.access.mockResolvedValue(null);
});

it("redirects the legacy page into Settings onboarding and preserves authentication", async () => {
  await expect(NewAccountPage()).rejects.toThrow("redirect:/accounts?add=1");
  mocks.session.mockResolvedValue(null);
  await expect(NewAccountPage()).rejects.toThrow("redirect:/login");
});

it("uses the existing session-bound Microsoft flow and opens the connected account", async () => {
  expect(
    (
      await start(
        new Request("https://mail.example.com/api/oauth/microsoft/start"),
      )
    ).headers.get("location"),
  ).toBe("https://login.microsoftonline.com/authorize");
  expect(mocks.begin).toHaveBeenCalledWith("owner-session", undefined);
  const response = await callback(
    new Request(
      "https://mail.example.com/api/oauth/microsoft/callback?state=opaque&code=private-code",
    ),
  );
  expect(mocks.complete).toHaveBeenCalledWith(
    "owner-session",
    "opaque",
    "private-code",
    undefined,
  );
  expect(mocks.discover).toHaveBeenCalledWith("new-account");
  expect(response.headers.get("location")).toBe(
    "https://mail.example.com/accounts?oauth=connected&account=new-account",
  );
  expect(await response.text()).not.toContain("private-code");
});

it.each([401, 403])(
  "keeps the owner/Origin creation guard (%s)",
  async (status) => {
    mocks.access.mockResolvedValue(Response.json({}, { status }));
    const request = new Request("https://mail.example.com/api/accounts", {
      method: "POST",
      body: "{}",
    });
    expect((await create(request)).status).toBe(status);
    expect(mocks.access).toHaveBeenCalledWith(request);
    expect(mocks.create).not.toHaveBeenCalled();
  },
);

it("does not disclose credential errors during creation", async () => {
  mocks.create.mockRejectedValue(Error("password=private; token=private"));
  const response = await create(
    new Request("https://mail.example.com/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private");
});

it("keeps providers vertical and shares the create/edit field and payload infrastructure", () => {
  const css = readFileSync("src/app/styles.css", "utf8");
  expect(css).toMatch(
    /\.account-provider-list\s*\{[^}]*display: flex;[^}]*flex-direction: column;/,
  );
  for (const component of ["account-form", "account-settings"]) {
    const source = readFileSync(`src/components/${component}.tsx`, "utf8");
    for (const shared of [
      "AccountIdentityFields",
      "AccountConnectionFields",
      "accountConnectionPayload",
    ])
      expect(source).toContain(shared);
  }
  for (const component of ["mail-client", "account-list"]) {
    const source = readFileSync(`src/components/${component}.tsx`, "utf8");
    expect(source).not.toContain('href="/accounts/new"');
    expect(source).toContain('href="/accounts?add=1"');
    expect(source).not.toContain("Connect Microsoft account");
  }
});

it("keeps unconfigured Microsoft onboarding out of authorization", async () => {
  mocks.configured.mockResolvedValue(false);
  const response = await start(
    new Request("https://mail.example.com/api/oauth/microsoft/start"),
  );
  expect(response.headers.get("location")).toBe(
    "https://mail.example.com/accounts?oauth_error=configuration",
  );
  expect(mocks.begin).not.toHaveBeenCalled();
});
it("requires an owner session for Microsoft start and callback", async () => {
  mocks.session.mockResolvedValue(null);
  for (const route of [start, callback]) {
    const response = await route(
      new Request("https://mail.example.com/api/oauth/microsoft/start"),
    );
    expect(response.headers.get("location")).toBe(
      "https://mail.example.com/login",
    );
  }
  expect(mocks.begin).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});
