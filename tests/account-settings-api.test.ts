import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
const mocks = vi.hoisted(() => ({ access: vi.fn(), save: vi.fn() }));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  accountsService: {},
  attachmentService: {},
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  db: {},
}));
vi.mock("@/modules/accounts/application/account-settings-service", () => ({
  AccountSettingsService: class {
    saveGeneral = mocks.save;
  },
}));
import { PUT } from "@/app/api/accounts/[id]/settings/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = () =>
  new Request(`http://localhost/api/accounts/${id}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: {
        displayName: "Local",
        senderDisplayName: "Sender",
        email: "owner@example.com",
      },
      folders: {},
      signatures: { new: null, reply: null, forward: null },
    }),
  });
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.save.mockReset().mockResolvedValue({
    id,
    displayName: "Local",
    senderDisplayName: "Sender",
  });
});
it.each([401, 403])(
  "honors owner and mutation Origin denial before reading or saving settings (%s)",
  async (status) => {
    const incoming = request();
    mocks.access.mockResolvedValue(Response.json({}, { status }));
    expect((await PUT(incoming, context)).status).toBe(status);
    expect(mocks.access).toHaveBeenCalledWith(incoming, true);
    expect(mocks.save).not.toHaveBeenCalled();
  },
);
it("validates account IDs and keeps account scope in the save", async () => {
  expect(
    (await PUT(request(), { params: Promise.resolve({ id: "invalid" }) }))
      .status,
  ).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
  expect((await PUT(request(), context)).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(
    id,
    expect.objectContaining({
      identity: expect.objectContaining({ senderDisplayName: "Sender" }),
    }),
  );
});
it("sanitizes internal failures and reports validation without returning credential data", async () => {
  mocks.save.mockRejectedValue(Error("oauth token=private; password=private"));
  const failed = await PUT(request(), context);
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private");
  mocks.save.mockRejectedValue(new z.ZodError([]));
  expect((await PUT(request(), context)).status).toBe(400);
});
