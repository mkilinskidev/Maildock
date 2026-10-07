import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutgoingValidationError } from "@/modules/mail/application/outgoing-message-service";

const { access, create, status } = vi.hoisted(() => ({
  access: vi.fn(),
  create: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  outgoingMessageService: { create, status },
}));
import { POST } from "@/app/api/outgoing/route";
import { GET } from "@/app/api/outgoing/[id]/route";

const id = "00000000-0000-4000-8000-000000000001";
describe("owner outgoing API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    access.mockResolvedValue(null);
  });
  const request = (body: string) =>
    new Request("http://localhost:3000/api/outgoing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body,
    });
  it("returns 202 with only the durable identifier and applies mutation Origin protection", async () => {
    const input = {
      accountId: id,
      to: "to@example.com",
      subject: "Subject",
      plainText: "Body",
    };
    create.mockResolvedValue({ id, status: "queued" });
    const req = request(JSON.stringify(input));
    const response = await POST(req);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id, status: "queued" });
    expect(access).toHaveBeenCalledExactlyOnceWith(req);
    expect(create).toHaveBeenCalledExactlyOnceWith(input);
  });
  it.each([401, 403])(
    "does not create a message when owner/Origin access returns %s",
    async (code) => {
      access.mockResolvedValue(
        Response.json({ error: "Denied" }, { status: code }),
      );
      expect((await POST(request("{}"))).status).toBe(code);
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("returns safe validation errors and suppresses internal failures", async () => {
    create.mockRejectedValueOnce(
      new OutgoingValidationError("Select a sending account."),
    );
    expect(await (await POST(request("{}"))).json()).toEqual({
      error: "Select a sending account.",
    });
    create.mockRejectedValueOnce(Error("secret/password"));
    expect(await (await POST(request("{}"))).json()).toEqual({
      error: "Message could not be queued.",
    });
    expect((await POST(request("broken JSON"))).status).toBe(400);
  });
  it("rejects oversized request data before persistence", async () => {
    expect((await POST(request("a".repeat(3_100_001)))).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
  it("authenticates status access and returns a non-cacheable safe projection", async () => {
    status.mockResolvedValue({
      id,
      accountId: id,
      status: "uncertain",
      error: "Maildock could not confirm whether this message was sent.",
      smtpAcceptedAt: null,
      rejectedCount: null,
    });
    const req = new Request(`http://localhost:3000/api/outgoing/${id}`);
    const response = await GET(req, { params: Promise.resolve({ id }) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("mimeBase64");
    expect(access).toHaveBeenCalledExactlyOnceWith(req);
    status.mockResolvedValue(null);
    expect((await GET(req, { params: Promise.resolve({ id }) })).status).toBe(
      404,
    );
  });
});
