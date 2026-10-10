import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), test: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  accountsService: { testExisting: mocks.test },
}));
import { POST } from "@/app/api/accounts/[id]/test/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const url = `http://localhost/api/accounts/${id}/test`;
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.test.mockReset().mockResolvedValue({
    imap: { success: true },
    smtp: {
      success: false,
      category: "verification_failed",
      message: "SMTP failed.",
    },
  });
});
it.each([
  undefined,
  "",
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  }),
])(
  "accepts genuinely empty POSTs even when Next exposes a body stream",
  async (body) => {
    const incoming = new Request(url, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    const result = await POST(incoming, context);
    expect(result.status).toBe(200);
    expect(mocks.test).toHaveBeenCalledExactlyOnceWith(id, undefined);
    expect(await result.json()).toMatchObject({
      result: { imap: { success: true }, smtp: { success: false } },
    });
  },
);
it("requires JSON for nonempty overrides and preserves validation and owner checks", async () => {
  expect(
    (await POST(new Request(url, { method: "POST", body: "{}" }), context))
      .status,
  ).toBe(415);
  expect(mocks.test).not.toHaveBeenCalled();
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: "{}",
        }),
        context,
      )
    ).status,
  ).toBe(200);
  expect(mocks.test).toHaveBeenCalledWith(id, {});
  mocks.access.mockResolvedValue(Response.json({}, { status: 403 }));
  expect(
    (await POST(new Request(url, { method: "POST", body: "" }), context))
      .status,
  ).toBe(403);
});
