import { describe, it, expect, vi } from "vitest";
import {
  GmailClient,
  GmailApiError,
  decodeBase64Url,
  GMAIL_QUOTA_COST,
} from "@/modules/accounts/infrastructure/gmail-client";
import {
  gmailDisplay,
  gmailStructure,
} from "@/modules/mail/infrastructure/gmail-mime";

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });
const profile = { historyId: "90071992547409931234567890", messagesTotal: 0 };
function client(
  fetcher: typeof fetch,
  extra: Partial<ConstructorParameters<typeof GmailClient>[0]> = {},
) {
  return new GmailClient({
    token: async () => "synthetic-token",
    reserve: async () => undefined,
    fetcher,
    sleep: async () => undefined,
    ...extra,
  });
}
describe("native Gmail bounded HTTP", () => {
  it("accepts long opaque attachment handles in metadata, full MIME and attachment GET", async () => {
    const handle = "A".repeat(404);
    const message = {
      id: "long-handle",
      historyId: "1",
      internalDate: "1",
      payload: {
        partId: "",
        mimeType: "text/plain",
        body: { attachmentId: handle, size: 5 },
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        json(
          new URL(String(url)).pathname.includes("/attachments/")
            ? { data: Buffer.from("hello").toString("base64url"), size: 5 }
            : message,
        ),
      );
    const api = client(fetcher);
    expect((await api.message(message.id)).payload?.body?.attachmentId).toBe(
      handle,
    );
    const full = await api.message(message.id, true);
    expect(await gmailDisplay(api, full, 100)).toEqual({
      plainText: "hello",
      html: null,
    });
    expect(String(fetcher.mock.calls[2][0])).toContain(
      `/attachments/${handle}`,
    );
    expect(() => api.attachment(message.id, "A".repeat(4097))).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("uses trusted origin, users/me, string histories and rejects redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(profile));
    expect(await client(fetcher).profile()).toEqual(profile);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    expect(options).toMatchObject({ redirect: "error", cache: "no-store" });
    await expect(
      client(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.test" },
          }),
        ),
      ).profile(),
    ).rejects.toMatchObject({ category: "invalid_response" });
  });
  it.each([
    [403, "accessNotConfigured", "api_disabled"],
    [403, "forbidden", "access_denied"],
    [403, "rateLimitExceeded", "quota"],
    [404, "notFound", "not_found"],
    [429, "userRateLimitExceeded", "quota"],
    [500, "backendError", "network"],
  ])(
    "classifies HTTP %s/%s without leaking error body",
    async (status, reason, category) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          json(
            { error: { errors: [{ reason }], message: "secret-mail-content" } },
            Number(status),
          ),
        );
      try {
        await client(fetcher, { retries: 0 }).profile();
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GmailApiError);
        expect(error).toMatchObject({ category });
        expect(String(error)).not.toContain("secret-mail");
      }
    },
  );
  it("refreshes token once after 401 and charges every attempt", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("expired")
      .mockResolvedValue("renewed");
    const reserve = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(profile));
    await client(fetcher, { token, reserve }).profile();
    expect(token).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer renewed",
    });
  });
  it("limits revoked token refresh", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({}, 401));
    await expect(client(fetcher).profile()).rejects.toMatchObject({
      category: "authentication",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("honors Retry-After and exponential bounded retries", async () => {
    const sleep = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { "Retry-After": "3" }))
      .mockResolvedValueOnce(json(profile));
    await client(fetcher, { sleep }).profile();
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(3000);
    const long = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({}, 429, { "Retry-After": "180" }));
    await expect(client(long).profile()).rejects.toMatchObject({
      retryAfterMs: 180000,
    });
    expect(long).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed JSON, oversized streaming bodies, and oversized declared bodies", async () => {
    for (const response of [
      new Response("{"),
      new Response("x".repeat(100)),
      new Response("{}", { headers: { "content-length": "1000" } }),
    ])
      await expect(
        client(vi.fn<typeof fetch>().mockResolvedValue(response), {
          maxBytes: 30,
        }).profile(),
      ).rejects.toMatchObject({ category: "invalid_response" });
  });
  it("bounds a hung transport and cancellation", async () => {
    await expect(
      client(
        vi
          .fn<typeof fetch>()
          .mockImplementation(() => new Promise(() => undefined)),
        { timeoutMs: 5, retries: 0 },
      ).profile(),
    ).rejects.toMatchObject({ category: "network" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client(vi.fn(), { signal: controller.signal }).profile(),
    ).rejects.toThrow();
  });
  it("distinguishes expired history from missing messages", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({}, 404));
    await expect(client(fetcher).history("123")).rejects.toMatchObject({
      category: "history_expired",
    });
    await expect(client(fetcher).message("opaque")).rejects.toMatchObject({
      category: "not_found",
    });
  });
  it("reserves actual endpoint units, refuses requests after quota exhaustion", async () => {
    const reserve = vi
      .fn()
      .mockRejectedValue(new GmailApiError("quota", 120000));
    const fetcher = vi.fn();
    await expect(
      client(fetcher, { reserve }).message("native"),
    ).rejects.toMatchObject({ category: "quota" });
    expect(reserve).toHaveBeenCalledWith(20);
    expect(fetcher).not.toHaveBeenCalled();
    expect(GMAIL_QUOTA_COST["history.list"]).toBe(2);
    expect(GMAIL_QUOTA_COST["messages.modify"]).toBe(5);
  });
  it("excludes all nested body data from metadata field masks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        id: "x",
        historyId: "1",
        internalDate: "1",
        payload: { partId: "", mimeType: "text/plain" },
      }),
    );
    await client(fetcher).message("x");
    const fields = new URL(String(fetcher.mock.calls[0][0])).searchParams.get(
      "fields",
    )!;
    expect(fields).not.toContain("data");
    expect(fields).toContain("body(size,attachmentId)");
  });
});
describe("Gmail MIME and bounded decoding", () => {
  it.each(["A", "***", "AAAAA", "a/b+", "A="])(
    "rejects malformed base64url %s",
    (value) => expect(() => decodeBase64Url(value, 100)).toThrow(),
  );
  it("accepts unpadded/padded URL encoding and limits decoded bytes", () => {
    const data = Buffer.from([255, 254, 253]);
    expect(decodeBase64Url(data.toString("base64url"), 3)).toEqual(data);
    expect(() => decodeBase64Url(data.toString("base64url"), 2)).toThrow();
  });
  it("walks nested alternatives, preserves CID metadata and skips attached message bodies", async () => {
    const remote = {
      id: "a",
      historyId: "2",
      labelIds: [],
      internalDate: "1",
      sizeEstimate: 1,
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        parts: [
          {
            partId: "0",
            mimeType: "multipart/alternative",
            parts: [
              {
                partId: "0.0",
                mimeType: "text/plain",
                body: { data: Buffer.from("hello").toString("base64url") },
              },
              {
                partId: "0.1",
                mimeType: "text/html",
                body: {
                  data: Buffer.from('<p>hello<img src="cid:x"></p>').toString(
                    "base64url",
                  ),
                },
              },
            ],
          },
          {
            partId: "1",
            mimeType: "image/png",
            headers: [{ name: "Content-ID", value: "<x>" }],
            body: { attachmentId: "part", size: 3 },
          },
          {
            partId: "2",
            mimeType: "text/plain",
            filename: "hidden.txt",
            body: { data: Buffer.from("never display").toString("base64url") },
          },
        ],
      },
    };
    const result = await gmailDisplay(client(vi.fn()), remote, 1000);
    expect(result.plainText).toBe("hello");
    expect(result.html).toContain("cid:x");
    expect(gmailStructure(remote.payload)?.children[1].contentId).toBe("x");
  });
  it("decodes non-UTF8 charsets and detached text bodies", async () => {
    const remote = {
      id: "a",
      historyId: "1",
      labelIds: [],
      internalDate: "1",
      sizeEstimate: 1,
      payload: {
        partId: "",
        mimeType: "text/plain",
        headers: [
          { name: "Content-Type", value: "text/plain; charset=windows-1250" },
        ],
        body: { attachmentId: "detached", size: 1 },
      },
    };
    expect(
      (
        await gmailDisplay(
          client(
            vi
              .fn<typeof fetch>()
              .mockResolvedValue(
                json({ data: Buffer.from([0xb9]).toString("base64url") }),
              ),
          ),
          remote,
          100,
        )
      ).plainText,
    ).toBe("ą");
  });
});
