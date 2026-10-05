import { beforeEach, describe, expect, it, vi } from "vitest";
const { access, render, list, remove } = vi.hoisted(() => ({
  access: vi.fn(),
  render: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: access,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  db: {},
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  attachmentService: {},
  messageContentService: {},
}));
vi.mock("@/modules/mail/application/email-rendering-service", () => ({
  EmailRenderingService: class {
    render = render;
  },
}));
vi.mock("@/modules/mail/application/remote-content-sender-service", () => ({
  RemoteContentSenderService: class {
    list = list;
    remove = remove;
  },
}));
import { POST } from "@/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/render/route";
import { GET, DELETE } from "@/app/api/settings/remote-content-senders/route";
import { MessagePlacementNotFoundError } from "@/modules/mail/application/message-content-service";
const id = "00000000-0000-4000-8000-000000000001";
const context = {
  params: Promise.resolve({ id, mailboxId: id, messageId: id }),
};
function request(method: string, body: object = {}) {
  return new Request("https://maildock.test/api", {
    method,
    ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
    headers: {
      Origin: "https://maildock.test",
      "Content-Type": "application/json",
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  access.mockResolvedValue(null);
  list.mockResolvedValue([]);
  render.mockResolvedValue({ document: "<p>body</p>" });
});
describe("owner-only rendering and sender preference API", () => {
  it.each([401, 403])(
    "rejects unauthenticated or invalid-Origin requests before resource access %s",
    async (code) => {
      access.mockResolvedValue(new Response(null, { status: code }));
      expect((await POST(request("POST"), context)).status).toBe(code);
      expect((await GET(request("GET"))).status).toBe(code);
      expect(
        (await DELETE(request("DELETE", { address: "sender@example.test" })))
          .status,
      ).toBe(code);
      expect(render).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it("validates only opaque IDs and checks Origin for resource preparation and trust mutations", async () => {
    const req = request("POST", {
      loadImages: true,
      trustSender: false,
      blobPath: "malicious",
    });
    const response = await POST(req, context);
    expect(access).toHaveBeenCalledWith(req);
    expect(render).toHaveBeenCalledWith(id, id, id, {
      loadImages: true,
      trustSender: false,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(
      (
        await POST(request("POST"), {
          params: Promise.resolve({
            id: "storage/key",
            mailboxId: id,
            messageId: id,
          }),
        })
      ).status,
    ).toBe(400);
  });
  it("fails safely without leaking resource paths", async () => {
    render.mockRejectedValue(Error("private/blob/path"));
    const response = await POST(request("POST"), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("blob");
    render.mockRejectedValue(new MessagePlacementNotFoundError());
    expect((await POST(request("POST"), context)).status).toBe(404);
  });
  it("sender removals are normalized, authenticated mutations", async () => {
    const req = request("DELETE", { address: " Sender@Example.Test " });
    expect((await DELETE(req)).status).toBe(200);
    expect(access).toHaveBeenCalledWith(req);
    expect(remove).toHaveBeenCalledWith("sender@example.test");
  });
});
