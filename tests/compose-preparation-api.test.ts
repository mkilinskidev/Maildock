import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyUnavailableError } from "@/modules/mail/domain/reply-forward";
import { MessagePlacementNotFoundError } from "@/modules/mail/application/message-content-service";
const { access, prepare } = vi.hoisted(() => ({
  access: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  composePreparationService: { prepare },
}));
import { POST } from "@/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/prepare/route";
const id = "00000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ id, mailboxId: id, messageId: id });
const request = (mode = "reply") =>
  new Request(`http://localhost:3000/prepare?mode=${mode}`, {
    method: "POST",
    body: JSON.stringify({ from: "evil", references: "<evil@example.com>" }),
  });
describe("owner compose preparation API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    access.mockResolvedValue(null);
  });
  it.each(["reply", "reply_all", "forward"])(
    "passes only server source identifiers and mode %s",
    async (mode) => {
      prepare.mockResolvedValue({
        status: "ready",
        prefill: { subject: "Prepared" },
      });
      const req = request(mode);
      const response = await POST(req, { params });
      expect(response.status).toBe(200);
      expect(access).toHaveBeenCalledWith(req);
      expect(prepare).toHaveBeenCalledExactlyOnceWith({
        accountId: id,
        mailboxId: id,
        messageId: id,
        mode,
      });
    },
  );
  it("returns pending without quote data", async () => {
    prepare.mockResolvedValue({ status: "pending" });
    const response = await POST(request(), { params });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending" });
  });
  it.each([401, 403])("rejects denied access %s", async (status) => {
    access.mockResolvedValue(Response.json({ error: "Denied" }, { status }));
    expect((await POST(request(), { params })).status).toBe(status);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects invalid modes", async () => {
    expect((await POST(request("arbitrary"), { params })).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([
    [new ReplyUnavailableError("No usable reply recipient is available."), 409],
    [new MessagePlacementNotFoundError(), 404],
    [new Error("private data"), 500],
  ] as const)("returns appropriate errors", async (error, status) => {
    prepare.mockRejectedValue(error);
    const response = await POST(request(), { params });
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain("private data");
  });
});
