import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  db: {},
}));
vi.mock("@/shared/infrastructure/config/config", () => ({
  getConfig: () => ({ logLevel: "fatal" }),
}));
vi.mock(
  "@/modules/diagnostics/application/application-event-service",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/diagnostics/application/application-event-service")
    >()),
    ApplicationEventService: class {
      list = mocks.list;
    },
  }),
);
import { GET } from "@/app/api/application-events/route";
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.list.mockReset().mockResolvedValue({ events: [], nextCursor: null });
});
it("requires owner access before querying events", async () => {
  mocks.access.mockResolvedValue(Response.json({}, { status: 401 }));
  expect(
    (await GET(new Request("http://localhost/api/application-events"))).status,
  ).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});
it("validates filters, bounds pagination and disables caching", async () => {
  const response = await GET(
    new Request(
      "http://localhost/api/application-events?level=error&area=sync&accountId=00000000-0000-4000-8000-000000000001&limit=2",
    ),
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mocks.list).toHaveBeenCalledWith({
    level: "error",
    area: "sync",
    accountId: "00000000-0000-4000-8000-000000000001",
    limit: 2,
  });
  for (const query of [
    "level=debug",
    "area=arbitrary",
    "accountId=no",
    "limit=101",
    "cursor=bad",
  ]) {
    expect(
      (
        await GET(
          new Request(`http://localhost/api/application-events?${query}`),
        )
      ).status,
    ).toBe(400);
  }
});
it("never exposes database exceptions", async () => {
  mocks.list.mockRejectedValue(Error("password=secret SQL parameters"));
  const response = await GET(
    new Request("http://localhost/api/application-events"),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secret");
});
