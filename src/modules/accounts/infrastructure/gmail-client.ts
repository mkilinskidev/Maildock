import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

const id = z.string().min(1).max(256);
// Attachment handles are opaque and longer than message/label identifiers.
const attachmentHandle = z.string().min(1).max(4096);
const historyId = z.string().regex(/^\d+$/).max(128);
const page = { nextPageToken: z.string().min(1).max(4096).optional() };
const header = z.object({
  name: z.string().max(256),
  value: z.string().max(65536),
});
export type GmailPart = {
  partId: string;
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
const part: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().max(256),
    mimeType: z.string().max(256),
    filename: z.string().max(4096).optional(),
    headers: z.array(header).max(1000).optional(),
    body: z
      .object({
        size: z.number().int().nonnegative().optional(),
        data: z.string().optional(),
        attachmentId: attachmentHandle.optional(),
      })
      .optional(),
    parts: z.array(part).max(1000).optional(),
  }),
);
export const gmailMessageSchema = z.object({
  id,
  threadId: id.optional(),
  historyId,
  labelIds: z.array(id).max(1000).default([]),
  internalDate: z.string().regex(/^\d+$/),
  sizeEstimate: z.number().int().nonnegative().default(0),
  payload: part.optional(),
  raw: z.string().optional(),
});
export type GmailMessage = z.infer<typeof gmailMessageSchema>;
const labelSchema = z.object({
  id,
  name: z.string().min(1).max(4096),
  type: z.enum(["system", "user"]).optional(),
  messagesTotal: z.number().int().nonnegative().optional(),
  messagesUnread: z.number().int().nonnegative().optional(),
});
export type GmailLabel = z.infer<typeof labelSchema>;
const reference = z.object({ id });
const change = z.object({ message: reference });
const historySchema = z.object({
  ...page,
  historyId,
  history: z
    .array(
      z.object({
        id: historyId,
        messages: z.array(reference).default([]),
        messagesAdded: z.array(change).default([]),
        messagesDeleted: z.array(change).default([]),
        labelsAdded: z.array(change).default([]),
        labelsRemoved: z.array(change).default([]),
      }),
    )
    .max(500)
    .default([]),
});

/** Published endpoint costs, verified 2026-10-10. Each retry is charged. */
export const GMAIL_QUOTA_COST = {
  profile: 1,
  "labels.list": 1,
  "labels.get": 1,
  "messages.list": 5,
  "messages.get": 20,
  "messages.modify": 5,
  "messages.trash": 20,
  "attachments.get": 20,
  "history.list": 2,
} as const;
export type GmailEndpoint = keyof typeof GMAIL_QUOTA_COST;
export type GmailFailure =
  | "authentication"
  | "api_disabled"
  | "access_denied"
  | "not_found"
  | "history_expired"
  | "cursor_expired"
  | "quota"
  | "network"
  | "invalid_response"
  | "cancelled";
export class GmailApiError extends Error {
  constructor(
    readonly category: GmailFailure,
    readonly retryAfterMs = 0,
    readonly status?: number,
  ) {
    super(`Gmail API: ${category}.`);
    this.name = "GmailApiError";
  }
}
export function decodeBase64Url(data: string, maxBytes: number): Buffer {
  if (
    data.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(data) ||
    data.replace(/=+$/, "").length % 4 === 1
  )
    throw new GmailApiError("invalid_response");
  const bytes = Buffer.from(data, "base64url");
  if (
    bytes.length > maxBytes ||
    bytes.toString("base64url") !== data.replace(/=+$/, "")
  )
    throw new GmailApiError("invalid_response");
  return bytes;
}
async function boundedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) {
    await response.body?.cancel();
    throw new GmailApiError("invalid_response");
  }
  if (!response.body) throw new GmailApiError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new GmailApiError("invalid_response");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export class GmailClient {
  constructor(
    private readonly options: {
      token: () => Promise<string>;
      reserve: (units: number) => Promise<void>;
      fetcher?: typeof fetch;
      signal?: AbortSignal;
      maxBytes?: number;
      timeoutMs?: number;
      retries?: number;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
      deferAuthenticationRefresh?: boolean;
      diagnostic?: (event: {
        endpoint: GmailEndpoint;
        status?: number;
        category?: GmailFailure;
        units: number;
      }) => void;
    },
  ) {}
  private async request<T>(
    endpoint: GmailEndpoint,
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    );
    url.search = new URLSearchParams(query).toString();
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    if (
      url.toString().length > 16384 ||
      (requestBody && Buffer.byteLength(requestBody) > 65536)
    )
      throw new GmailApiError("invalid_response");
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      this.options.signal?.throwIfAborted();
      const token = await this.options.token();
      if (!token || token.length > 16384 || /\s/.test(token))
        throw new GmailApiError("authentication");
      await this.options.reserve(GMAIL_QUOTA_COST[endpoint]);
      const controller = new AbortController();
      let rejectCancellation: ((error: GmailApiError) => void) | undefined;
      const cancel = () => {
        controller.abort();
        rejectCancellation?.(new GmailApiError("cancelled"));
      };
      this.options.signal?.addEventListener("abort", cancel, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let status: number | undefined;
      let failure: GmailApiError | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new GmailApiError("network"));
          }, this.options.timeoutMs ?? 15000);
        });
        const cancellation = new Promise<never>((_, reject) => {
          rejectCancellation = reject;
        });
        const call = async () => {
          const response = await (this.options.fetcher ?? fetch)(url, {
            method: body === undefined ? "GET" : "POST",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(requestBody === undefined ? {} : { body: requestBody }),
          });
          status = response.status;
          if (status >= 300 && status < 400) {
            await response.body?.cancel();
            throw new GmailApiError("invalid_response", 0, status);
          }
          const text =
            !response.ok && !response.body
              ? "{}"
              : await boundedBody(
                  response,
                  response.ok
                    ? (this.options.maxBytes ?? 32 * 1024 * 1024)
                    : 65536,
                );
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            if (response.ok)
              throw new GmailApiError("invalid_response", 0, status);
            json = {};
          }
          if (!response.ok) {
            const reason = z
              .object({
                error: z.object({
                  errors: z.array(z.object({ reason: z.string() })).optional(),
                  details: z
                    .array(z.object({ reason: z.string().optional() }))
                    .optional(),
                  status: z.string().optional(),
                }),
              })
              .safeParse(json);
            const reasons = reason.success
              ? [
                  ...(reason.data.error.errors?.map((e) => e.reason) ?? []),
                  ...(reason.data.error.details?.flatMap((e) =>
                    e.reason ? [e.reason] : [],
                  ) ?? []),
                ]
              : [];
            const rate =
              status === 429 ||
              reasons.some((r) =>
                [
                  "rateLimitExceeded",
                  "userRateLimitExceeded",
                  "quotaExceeded",
                  "dailyLimitExceeded",
                ].includes(r),
              );
            const retryHeader = response.headers.get("retry-after");
            const seconds =
              retryHeader && /^\d+(\.\d+)?$/.test(retryHeader)
                ? Number(retryHeader) * 1000
                : Date.parse(retryHeader ?? "") - Date.now();
            throw new GmailApiError(
              rate
                ? "quota"
                : status === 401
                  ? "authentication"
                  : status === 403
                    ? reasons.includes("accessNotConfigured") ||
                      reasons.includes("serviceDisabled") ||
                      reasons.includes("SERVICE_DISABLED")
                      ? "api_disabled"
                      : "access_denied"
                    : status === 404
                      ? endpoint === "history.list"
                        ? "history_expired"
                        : "not_found"
                      : status === 400 && query.pageToken
                        ? "cursor_expired"
                        : status >= 500
                          ? "network"
                          : "invalid_response",
              Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
              status,
            );
          }
          let parsed;
          try {
            parsed = schema.safeParse(json);
          } catch {
            throw new GmailApiError("invalid_response", 0, status);
          }
          if (!parsed.success)
            throw new GmailApiError("invalid_response", 0, status);
          return parsed.data;
        };
        return await Promise.race([call(), timeout, cancellation]);
      } catch (error) {
        failure = this.options.signal?.aborted
          ? new GmailApiError("cancelled")
          : error instanceof GmailApiError
            ? error
            : new GmailApiError("network");
      } finally {
        clearTimeout(timer);
        controller.abort();
        this.options.signal?.removeEventListener("abort", cancel);
        this.options.diagnostic?.({
          endpoint,
          status,
          category: failure?.category,
          units: GMAIL_QUOTA_COST[endpoint],
        });
      }
      if (
        failure.category === "authentication" &&
        !renewed &&
        !this.options.deferAuthenticationRefresh
      ) {
        renewed = true;
        continue;
      }
      if (
        !["quota", "network"].includes(failure.category) ||
        attempt >= (this.options.retries ?? 2) ||
        failure.retryAfterMs > 30000
      )
        throw failure;
      const wait = Math.max(
        failure.retryAfterMs,
        Math.min(30000, 1000 * 2 ** attempt + Math.floor(Math.random() * 1000)),
      );
      await (
        this.options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
      )(wait, this.options.signal);
    }
  }
  profile() {
    return this.request(
      "profile",
      "profile",
      z.object({ historyId, messagesTotal: z.number().int().nonnegative() }),
    );
  }
  labels() {
    return this.request(
      "labels.list",
      "labels",
      z.object({ labels: z.array(labelSchema).max(10000).default([]) }),
    );
  }
  label(labelId: string) {
    return this.request(
      "labels.get",
      `labels/${encodeURIComponent(id.parse(labelId))}`,
      labelSchema,
    );
  }
  messages(query?: string, pageToken?: string) {
    return this.request(
      "messages.list",
      "messages",
      z.object({ ...page, messages: z.array(reference).max(500).default([]) }),
      {
        maxResults: "100",
        includeSpamTrash: "true",
        ...(query ? { q: query } : {}),
        ...(pageToken ? { pageToken } : {}),
      },
    );
  }
  message(messageId: string, content = false) {
    let structure = "partId,mimeType,filename,headers,body(size,attachmentId)";
    for (let depth = 0; depth < 30; depth++)
      structure = `partId,mimeType,filename,headers,body(size,attachmentId),parts(${structure})`;
    return this.request(
      "messages.get",
      `messages/${encodeURIComponent(id.parse(messageId))}`,
      gmailMessageSchema,
      {
        format: "full",
        ...(content
          ? {}
          : {
              fields: `id,threadId,historyId,labelIds,internalDate,sizeEstimate,payload(${structure})`,
            }),
      },
    );
  }
  history(start: string, pageToken?: string) {
    return this.request("history.list", "history", historySchema, {
      startHistoryId: historyId.parse(start),
      maxResults: "100",
      ...(pageToken ? { pageToken } : {}),
    });
  }
  modify(messageId: string, addLabelIds: string[], removeLabelIds: string[]) {
    return this.request(
      "messages.modify",
      `messages/${encodeURIComponent(id.parse(messageId))}/modify`,
      z.object({ id }),
      {},
      {
        addLabelIds: addLabelIds.map((v) => id.parse(v)),
        removeLabelIds: removeLabelIds.map((v) => id.parse(v)),
      },
    );
  }
  trash(messageId: string) {
    return this.request(
      "messages.trash",
      `messages/${encodeURIComponent(id.parse(messageId))}/trash`,
      z.object({ id }),
      {},
      {},
    );
  }
  attachment(messageId: string, attachmentId: string) {
    return this.request(
      "attachments.get",
      `messages/${encodeURIComponent(id.parse(messageId))}/attachments/${encodeURIComponent(attachmentHandle.parse(attachmentId))}`,
      z.object({
        data: z.string(),
        size: z.number().int().nonnegative().optional(),
      }),
    );
  }
}
