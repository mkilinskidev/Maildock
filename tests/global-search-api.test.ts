import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), search: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  db: {},
}));
vi.mock("@/modules/mail/application/search-service", () => ({
  MAX_SEARCH_QUERY_LENGTH: 256,
  SearchService: class {
    search = mocks.search;
  },
}));
import { GET } from "@/app/api/search/route";
describe("owner-only global search API", () => {
  beforeEach(() => {
    mocks.access.mockReset().mockResolvedValue(null);
    mocks.search.mockReset().mockResolvedValue({ items: [], hasMore: false });
  });
  it("denies unauthenticated access before search", async () => {
    mocks.access.mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    expect(
      (await GET(new Request("http://localhost/api/search?q=mail"))).status,
    ).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("bounds input and ignores account/mailbox parameters", async () => {
    expect(
      (
        await GET(
          new Request(`http://localhost/api/search?q=${"x".repeat(257)}`),
        )
      ).status,
    ).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
    const response = await GET(
      new Request("http://localhost/api/search?q=mail&accountId=a&mailboxId=b"),
    );
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith("mail");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("never returns raw database errors", async () => {
    mocks.search.mockRejectedValue(Error("password=secret internal SQL"));
    const response = await GET(
      new Request("http://localhost/api/search?q=mail"),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
  it("rejects PostgreSQL-incompatible NUL text before database execution", async () => {
    expect(
      (await GET(new Request("http://localhost/api/search?q=mail%00text")))
        .status,
    ).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
