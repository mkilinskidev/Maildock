import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  db: {},
}));
vi.mock("@/shared/infrastructure/config/config", () => ({
  getConfig: () => ({ logLevel: "fatal", mailPollIntervalSeconds: 60 }),
}));
vi.mock("@/modules/mail/infrastructure/read-sync-observability", () => ({
  readSyncObservability: mocks.read,
}));
import { GET } from "@/app/api/accounts/[id]/sync-diagnostics/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = (account = id) => ({
  params: Promise.resolve({ id: account }),
});
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.read
    .mockReset()
    .mockResolvedValue({ sampledAt: "2026-10-11T08:00:00Z" });
});
it("requires owner access before reading any account diagnostics", async () => {
  mocks.access.mockResolvedValue(Response.json({}, { status: 401 }));
  expect(
    (await GET(new Request("http://localhost/api"), context())).status,
  ).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled();
});
it("validates account identifiers, handles missing accounts and disables caching", async () => {
  expect(
    (await GET(new Request("http://localhost/api"), context("bad"))).status,
  ).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
  const response = await GET(new Request("http://localhost/api"), context());
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  mocks.read.mockResolvedValue(null);
  expect(
    (await GET(new Request("http://localhost/api"), context())).status,
  ).toBe(404);
});
it("does not expose SQL parameters or private database errors", async () => {
  mocks.read.mockRejectedValue(new Error("password=secret SQL parameters"));
  const response = await GET(new Request("http://localhost/api"), context());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
});
