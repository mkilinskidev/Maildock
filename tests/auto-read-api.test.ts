import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: mocks.access,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  db: {},
}));
vi.mock("@/modules/mail/application/mail-preferences-service", () => ({
  MailPreferencesService: class {
    autoRead = mocks.read;
    setAutoRead = mocks.save;
  },
}));
import { GET, PUT } from "@/app/api/settings/auto-read/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(null);
  mocks.read.mockResolvedValue({ mode: "after", seconds: 2 });
  mocks.save.mockResolvedValue(undefined);
});
const request = (value: unknown) =>
  new Request("https://mail.example.com/api/settings/auto-read", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
it.each([401, 403])(
  "honors owner and mutation Origin denial (%s)",
  async (status) => {
    const incoming = request({ mode: "after", seconds: 2 });
    mocks.access.mockResolvedValue(Response.json({}, { status }));
    expect((await PUT(incoming)).status).toBe(status);
    expect(mocks.access).toHaveBeenCalledWith(incoming);
    expect(mocks.save).not.toHaveBeenCalled();
    expect((await GET(new Request(incoming.url))).status).toBe(status);
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
it.each(["immediately", "after", "manually"])(
  "saves validated %s preferences through application settings",
  async (mode) => {
    const value = { mode, seconds: 7 };
    expect((await PUT(request(value))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(value);
  },
);
it.each([
  { mode: "after", seconds: 0 },
  { mode: "after", seconds: 3601 },
  { mode: "after", seconds: 1.5 },
  { mode: "other", seconds: 2 },
  { mode: "after", seconds: "2" },
  null,
])("rejects invalid preferences %s", async (value) => {
  expect((await PUT(request(value))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("reads the persisted preference", async () => {
  expect(
    await (
      await GET(new Request("https://mail.example.com/api/settings/auto-read"))
    ).json(),
  ).toEqual({ mode: "after", seconds: 2 });
});
