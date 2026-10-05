import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraftConflictError,
  draftCreate,
  draftUpdate,
} from "@/modules/mail/domain/draft";
import { OutgoingValidationError } from "@/modules/mail/application/outgoing-message-service";
const { access, create, list, get, update, discard, outgoing } = vi.hoisted(
  () => ({
    access: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    discard: vi.fn(),
    outgoing: vi.fn(),
  }),
);
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  draftService: { create, list, get, update, discard },
  outgoingMessageService: { create: outgoing },
}));
import { GET as LIST, POST } from "@/app/api/drafts/route";
import { GET, PATCH, DELETE } from "@/app/api/drafts/[id]/route";
import { POST as SEND } from "@/app/api/drafts/[id]/send/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (method = "GET", body?: string) =>
  new Request(`http://localhost/api/drafts/${id}`, {
    method,
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    ...(body ? { body } : {}),
  });
describe("local draft API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    access.mockResolvedValue(null);
  });
  it.each([401, 403])(
    "checks owner/Origin before every operation for rejection %s",
    async (status) => {
      access.mockResolvedValue(Response.json({ error: "Denied" }, { status }));
      for (const run of [
        () => LIST(request()),
        () => POST(request("POST", "{}")),
        () => GET(request(), context),
        () => PATCH(request("PATCH", "{}"), context),
        () => DELETE(request("DELETE", "{}"), context),
        () => SEND(request("POST", "{}"), context),
      ])
        expect((await run()).status).toBe(status);
      for (const fn of [create, list, get, update, discard, outgoing])
        expect(fn).not.toHaveBeenCalled();
    },
  );
  it("uses permissive draft validation and rejects source/header injection on updates", () => {
    const fields = { accountId: id, to: "jan@", subject: "", plainText: "" };
    expect(draftCreate.parse({ ...fields, id })).toMatchObject(fields);
    expect(draftUpdate.parse({ ...fields, expectedRevision: 5 })).toMatchObject(
      fields,
    );
    expect(() =>
      draftUpdate.parse({
        ...fields,
        expectedRevision: 5,
        source: { accountId: id, messageId: id, mailboxId: id, mode: "reply" },
      }),
    ).toThrow();
    expect(() =>
      draftCreate.parse({ ...fields, id, inReplyTo: "browser-value" }),
    ).toThrow();
    expect(() =>
      draftCreate.parse({ ...fields, id, references: [] }),
    ).toThrow();
  });
  it("creates, lists and restores private non-cacheable drafts", async () => {
    create.mockResolvedValue({ id, revision: 1 });
    list.mockResolvedValue([{ id }]);
    get.mockResolvedValue({ id, revision: 1 });
    const req = request("POST", JSON.stringify({ id, to: "jan@" }));
    expect((await POST(req)).status).toBe(201);
    expect(access).toHaveBeenLastCalledWith(req);
    expect((await LIST(request())).headers.get("Cache-Control")).toContain(
      "no-store",
    );
    expect(
      (await GET(request(), context)).headers.get("Cache-Control"),
    ).toContain("no-store");
  });
  it("passes expected revisions to update, discard and the existing OutgoingMessageService", async () => {
    update.mockResolvedValue({ id, revision: 6 });
    outgoing.mockResolvedValue({ id: "outgoing", status: "queued" });
    const patch = request(
      "PATCH",
      JSON.stringify({ expectedRevision: 5, to: "jan@" }),
    );
    expect((await PATCH(patch, context)).status).toBe(200);
    expect(update).toHaveBeenCalledWith(id, {
      expectedRevision: 5,
      to: "jan@",
    });
    expect(
      (await DELETE(request("DELETE", '{"expectedRevision":6}'), context))
        .status,
    ).toBe(204);
    expect(discard).toHaveBeenCalledWith(id, 6);
    const send = request("POST", '{"expectedRevision":6}');
    expect((await SEND(send, context)).status).toBe(202);
    expect(outgoing).toHaveBeenCalledExactlyOnceWith(undefined, {
      id,
      expectedRevision: 6,
    });
    expect(access).toHaveBeenLastCalledWith(send);
  });
  it("reports safe 409/400/500 errors and bounds bodies before service calls", async () => {
    update.mockRejectedValue(new DraftConflictError());
    expect((await PATCH(request("PATCH", "{}"), context)).status).toBe(409);
    outgoing.mockRejectedValue(
      new OutgoingValidationError("Invalid recipient."),
    );
    expect(
      (await SEND(request("POST", '{"expectedRevision":1}'), context)).status,
    ).toBe(400);
    create.mockRejectedValue(Error("secret/password"));
    expect(await (await POST(request("POST", "{}"))).json()).toEqual({
      error: "Draft operation failed. Please retry.",
    });
    create.mockClear();
    expect((await POST(request("POST", "a".repeat(3100001)))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect((await POST(request("POST", "broken"))).status).toBe(400);
    outgoing.mockClear();
    expect(
      (await SEND(request("POST", '{"expectedRevision":0}'), context)).status,
    ).toBe(400);
    expect(outgoing).not.toHaveBeenCalled();
  });
});
