import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  messageService: { listAllInboxes: mocks.list },
}));
import { GET } from "@/app/api/mail/all-inboxes/route";
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.list.mockReset().mockResolvedValue({ items: [], nextCursor: null });
});
it("guards the local inbox query before execution", async () => {
  mocks.access.mockResolvedValue(Response.json({}, { status: 401 }));
  expect(
    (await GET(new Request("http://localhost/api/mail/all-inboxes"))).status,
  ).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});
it("validates pagination and prevents caching", async () => {
  expect(
    (
      await GET(
        new Request("http://localhost/api/mail/all-inboxes?pageSize=101"),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await GET(
        new Request(
          `http://localhost/api/mail/all-inboxes?cursor=${"x".repeat(513)}`,
        ),
      )
    ).status,
  ).toBe(400);
  expect(mocks.list).not.toHaveBeenCalled();
  const response = await GET(
    new Request(
      "http://localhost/api/mail/all-inboxes?pageSize=20&cursor=page",
    ),
  );
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(20, "page");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("maps invalid cursors and sanitizes failures", async () => {
  mocks.list.mockRejectedValue(Error("Invalid cursor."));
  expect(
    (
      await GET(
        new Request("http://localhost/api/mail/all-inboxes?cursor=broken"),
      )
    ).status,
  ).toBe(400);
  mocks.list.mockRejectedValue(Error("database password=secret"));
  const response = await GET(
    new Request("http://localhost/api/mail/all-inboxes"),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secret");
});
