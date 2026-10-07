import { beforeEach, expect, it, vi } from "vitest";
import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
const mocks = vi.hoisted(() => ({ access: vi.fn(), move: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  accountsService: { move: mocks.move },
}));
import { PATCH } from "@/app/api/accounts/[id]/order/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (body = '{"direction":"down"}') =>
  new Request(`http://localhost/api/accounts/${id}/order`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.move.mockReset().mockResolvedValue([{ id, sortOrder: 2 }]);
});
it.each([401, 403])(
  "enforces owner and mutation Origin access before reading the body (%s)",
  async (status) => {
    const incoming = request("invalid json");
    mocks.access.mockResolvedValue(Response.json({}, { status }));
    expect((await PATCH(incoming, context)).status).toBe(status);
    expect(mocks.access).toHaveBeenCalledWith(incoming);
    expect(mocks.move).not.toHaveBeenCalled();
  },
);
it.each([
  '{"direction":"left"}',
  '{"sortOrder":1}',
  '{"direction":"up","email":"changed@test"}',
  "invalid json",
])("rejects invalid or extra configuration (%s)", async (body) => {
  expect((await PATCH(request(body), context)).status).toBe(400);
  expect(mocks.move).not.toHaveBeenCalled();
});
it("validates account IDs and returns the authoritative persisted order", async () => {
  expect(
    (await PATCH(request(), { params: Promise.resolve({ id: "invalid" }) }))
      .status,
  ).toBe(400);
  expect(mocks.move).not.toHaveBeenCalled();
  const response = await PATCH(request(), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ accounts: [{ id, sortOrder: 2 }] });
  expect(mocks.move).toHaveBeenCalledWith(id, "down");
});
it("reports deleted accounts and sanitizes internal failures", async () => {
  mocks.move.mockRejectedValue(new MailAccountNotFoundError());
  expect((await PATCH(request(), context)).status).toBe(404);
  mocks.move.mockRejectedValue(Error("password=private token=private"));
  const response = await PATCH(request(), context);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private");
});
