import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlobLimitError } from "@/shared/application/blob-storage";
import { AttachmentUnavailableError } from "@/modules/mail/application/attachment-service";
const { access, status, prepare, download, upload, remove } = vi.hoisted(
  () => ({
    access: vi.fn(),
    status: vi.fn(),
    prepare: vi.fn(),
    download: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
  }),
);
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: access,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  attachmentService: {
    status,
    request: prepare,
    download,
    upload,
    removeStaged: remove,
  },
}));
import { GET, POST } from "@/app/api/attachments/[attachmentId]/route";
import { GET as downloadGet } from "@/app/api/attachments/[attachmentId]/download/route";
import { POST as uploadPost } from "@/app/api/attachments/staged/route";
import { DELETE } from "@/app/api/attachments/staged/[attachmentId]/route";
const id = "00000000-0000-4000-8000-000000000001",
  context = { params: Promise.resolve({ attachmentId: id }) };
const request = (method = "GET", body?: string) =>
  new Request(`http://localhost/api/attachments/${id}`, {
    method,
    ...(body !== undefined ? { body } : {}),
    headers: {
      Origin: "http://localhost",
      "X-Attachment-Filename": encodeURIComponent("Zażółć.pdf"),
      "Content-Type": "application/pdf",
    },
  });
describe("authenticated attachment endpoints", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    access.mockResolvedValue(null);
  });
  it.each([401, 403])(
    "blocks all operations before data access for owner/Origin rejection %s",
    async (code) => {
      access.mockResolvedValue(
        Response.json({ error: "Denied" }, { status: code }),
      );
      for (const run of [
        () => GET(request(), context),
        () => POST(request("POST"), context),
        () => downloadGet(request(), context),
        () => uploadPost(request("POST", "bytes")),
        () => DELETE(request("DELETE"), context),
      ])
        expect((await run()).status).toBe(code);
      for (const fn of [status, prepare, download, upload, remove])
        expect(fn).not.toHaveBeenCalled();
    },
  );
  it("applies Origin/CSRF protection to prepare, upload and remove", async () => {
    const req = request("POST");
    await POST(req, context);
    expect(access).toHaveBeenLastCalledWith(req);
    const file = request("POST", "bytes");
    upload.mockResolvedValue({ id, status: "ready" });
    await uploadPost(file);
    expect(access).toHaveBeenLastCalledWith(file);
    const removal = request("DELETE");
    await DELETE(removal, context);
    expect(access).toHaveBeenLastCalledWith(removal);
  });
  it("forces attachment download with safe Unicode headers and private/no-store isolation", async () => {
    download.mockResolvedValue({
      bytes: Buffer.from([0, 255]),
      filename: "Zażółć.pdf\r\nX-Evil: yes",
    });
    const req = request();
    const response = await downloadGet(req, context);
    expect(access).toHaveBeenLastCalledWith(req);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''Za%C5%BC",
    );
    expect(response.headers.has("X-Evil")).toBe(false);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0, 255]),
    );
  });
  it("does not disclose physical paths or keys on storage failures", async () => {
    download.mockRejectedValue(Error("/private/blob/key"));
    const response = await downloadGet(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/private|blob|key/);
    status.mockRejectedValue(new AttachmentUnavailableError("Unavailable"));
    expect((await GET(request(), context)).status).toBe(404);
  });
  it("uses streamed upload bytes rather than declared Content-Length and returns size-limit rejection", async () => {
    upload.mockImplementation(
      async (source: AsyncIterable<Uint8Array>, filename: string) => {
        let size = 0;
        for await (const chunk of source) size += chunk.length;
        expect(size).toBe(5);
        expect(filename).toBe("Zażółć.pdf");
        throw new BlobLimitError();
      },
    );
    const req = request("POST", "12345");
    req.headers.set("Content-Length", "1");
    expect((await uploadPost(req)).status).toBe(413);
  });
  it("rejects malformed identifiers and metadata safely", async () => {
    expect(
      (
        await GET(request(), {
          params: Promise.resolve({ attachmentId: "../blob" }),
        })
      ).status,
    ).toBe(400);
    expect(status).not.toHaveBeenCalled();
    const req = request("POST", "data");
    req.headers.set("X-Attachment-Filename", "%malformed");
    expect((await uploadPost(req)).status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });
});
