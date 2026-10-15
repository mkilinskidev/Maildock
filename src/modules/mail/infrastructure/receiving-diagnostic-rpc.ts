import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { SecretEncryption } from "../../../shared/application/secret-encryption";
import type { Database } from "../../../shared/infrastructure/database/database";
import type { ElectedReceivingCoordinator } from "../application/receiving-election";
import type {
  ProviderConnection,
  ProtocolConnectionResult,
} from "../../accounts/domain/mail-provider";
import type { ReceivingIdentity } from "../application/receiving-operation";

const LIMIT = 28 * 1024; // encrypted 16 KiB connection plus bounded envelope
const RESPONSE_LIMIT = 2048;
const context = "maildock:receiving-diagnostic-rpc:v1";
const version = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const id = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
const category = z.enum([
  "dns_or_host_unreachable",
  "connection_timeout",
  "tls_certificate_failure",
  "authentication_rejected",
  "starttls_unavailable",
  "verification_failed",
  "internal_error",
]);
const connection = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls"]),
  username: z.string().min(1).max(320),
  credential: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("password"),
      password: z.string().min(1).max(4096),
    }),
    z.strictObject({
      kind: z.literal("oauth2"),
      accessToken: z.string().min(1).max(16384),
    }),
  ]),
});
const wire = z.strictObject({
  requestId: id,
  expectedOwner: z.strictObject({ actor: z.uuid(), generation: version }),
  identity: z.union([
    z.strictObject({
      account: z.uuid(),
      configurationVersion: version,
      receivingLifecycleVersion: version,
      mailbox: z.uuid().optional(),
    }),
    z.strictObject({ ephemeral: id }),
  ]),
  expiresAt: z.number().int().positive(),
  budgetMs: z.number().int().min(1).max(10_000),
  connection: connection.optional(),
});
const outcome = z.strictObject({
  requestId: id,
  actor: z.uuid(),
  generation: version,
  result: z.union([
    z.strictObject({ success: z.literal(true) }),
    z.strictObject({ success: z.literal(false), category }),
  ]),
});

export type DiagnosticTarget = Readonly<{
  identity: ReceivingIdentity & { receivingLifecycleVersion?: bigint };
  connection?: ProviderConnection;
  signal?: AbortSignal;
}>;
export interface ImapDiagnostics {
  test(target: DiagnosticTarget): Promise<ProtocolConnectionResult>;
}
export const diagnosticUnavailable: ProtocolConnectionResult = Object.freeze({
  success: false,
  category: "internal_error",
  retryable: true,
  message: "Receiving owner unavailable. Retry the connection test.",
});
type Config = Readonly<{
  endpoint: string;
  authSecret: string;
  encryption: SecretEncryption;
}>;

/** AES-GCM protects ephemeral credentials even over the private HTTP network;
 * domain-separated HMAC authenticates the web process before decryption. */
export class DiagnosticCodec {
  constructor(private readonly config: Config) {}
  private mac(body: string, direction: string) {
    return createHmac("sha256", this.config.authSecret)
      .update(`${context}:${direction}\n`)
      .update(body)
      .digest("hex");
  }
  encode(value: unknown, direction: "request" | "response") {
    const body = JSON.stringify(
      this.config.encryption.encrypt(
        JSON.stringify(value),
        `${context}:${direction}`,
      ),
    );
    return { body, authentication: this.mac(body, direction) };
  }
  decode(
    body: string,
    authentication: string | undefined,
    direction: "request" | "response",
  ): unknown {
    if (
      !authentication ||
      !/^[a-f0-9]{64}$/.test(authentication) ||
      !timingSafeEqual(
        Buffer.from(authentication, "hex"),
        Buffer.from(this.mac(body, direction), "hex"),
      )
    )
      throw new Error("Unauthenticated diagnostic request");
    return JSON.parse(
      this.config.encryption.decrypt(
        JSON.parse(body),
        `${context}:${direction}`,
      ),
    );
  }
}

export class ReceivingDiagnosticServer {
  private readonly codec: DiagnosticCodec;
  private server?: Server;
  private active = 0;
  private readonly requests = new Map<string, number>();
  private readonly controllers = new Set<AbortController>();
  constructor(
    private readonly config: Config,
    private readonly owner: () => ElectedReceivingCoordinator | undefined,
  ) {
    this.codec = new DiagnosticCodec(config);
  }
  async start() {
    const endpoint = new URL(this.config.endpoint);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error("Invalid diagnostic endpoint");
    const server = createServer({ maxHeaderSize: 2048 }, (req, res) => {
      if (req.method !== "POST" || req.url !== "/diagnose") {
        res.writeHead(404).end();
        return;
      }
      if (
        !/^[a-f0-9]{64}$/.test(String(req.headers["x-maildock-auth"] ?? ""))
      ) {
        res.writeHead(401).end();
        return;
      }
      if (this.active >= 16) {
        res.writeHead(503).end();
        return;
      }
      if (Number(req.headers["content-length"]) > LIMIT) {
        res.writeHead(413).end();
        return;
      }
      this.active++;
      const controller = new AbortController();
      this.controllers.add(controller);
      const cancel = () => controller.abort();
      req.once("aborted", cancel);
      res.once("close", cancel);
      const timeout = setTimeout(cancel, 10_000);
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const abortTransport = () => {
        if (!res.writableEnded) res.destroy();
      };
      controller.signal.addEventListener("abort", abortTransport, {
        once: true,
      });
      void (async () => {
        try {
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > LIMIT) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          let decoded: unknown;
          try {
            decoded = this.codec.decode(
              Buffer.concat(chunks).toString("utf8"),
              String(req.headers["x-maildock-auth"]),
              "request",
            );
          } catch {
            res.writeHead(401).end();
            return;
          }
          const parsed = wire.safeParse(decoded);
          if (!parsed.success) {
            res.writeHead(400).end();
            return;
          }
          const input = parsed.data;
          if (input.expiresAt > Date.now() + 10_000) {
            res.writeHead(400).end();
            return;
          }
          const remaining = Math.min(
            input.budgetMs,
            input.expiresAt - Date.now(),
            10_000,
          );
          if (remaining <= 0 || controller.signal.aborted) {
            res.writeHead(408).end();
            return;
          }
          expiry = setTimeout(cancel, remaining);
          for (const [key, expires] of this.requests)
            if (expires <= Date.now()) this.requests.delete(key);
          if (this.requests.has(input.requestId) || this.requests.size >= 128) {
            res.writeHead(409).end();
            return;
          }
          this.requests.set(
            input.requestId,
            Math.min(input.expiresAt, Date.now() + 10_000),
          );
          const coordinator = this.owner();
          if (!coordinator) {
            res.writeHead(503).end();
            return;
          }
          const identity =
            "account" in input.identity
              ? {
                  account: input.identity.account,
                  configurationVersion: BigInt(
                    input.identity.configurationVersion,
                  ),
                  receivingLifecycleVersion: BigInt(
                    input.identity.receivingLifecycleVersion,
                  ),
                  mailbox: input.identity.mailbox,
                }
              : input.identity;
          const result = await coordinator.diagnose({
            requestId: input.requestId,
            expectedOwner: {
              actor: input.expectedOwner.actor,
              generation: BigInt(input.expectedOwner.generation),
            },
            identity,
            connection: input.connection,
            signal: controller.signal,
            deadline: performance.now() + remaining,
          });
          if (controller.signal.aborted) return;
          if (!result) throw new Error("Diagnostic executor returned no result");
          const response = this.codec.encode(
            outcome.parse({
              ...input.expectedOwner,
              requestId: input.requestId,
              result,
            }),
            "response",
          );
          if (Buffer.byteLength(response.body) > RESPONSE_LIMIT)
            throw new Error("Diagnostic response too large");
          res
            .writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
              "x-maildock-auth": response.authentication,
            })
            .end(response.body);
        } catch {
          if (!res.headersSent && !res.destroyed) res.writeHead(503).end();
        } finally {
          clearTimeout(timeout);
          clearTimeout(expiry);
          req.removeListener("aborted", cancel);
          res.removeListener("close", cancel);
          controller.signal.removeEventListener("abort", abortTransport);
          this.controllers.delete(controller);
          this.active--;
        }
      })();
    });
    server.maxConnections = 32;
    server.headersTimeout = 5000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 1;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(endpoint.port), endpoint.hostname, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
  }
  async stop() {
    for (const controller of this.controllers) controller.abort();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    // Handler ownership remains held until coordinator/provider settlement.
    while (this.active)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export class ReceivingDiagnosticClient implements ImapDiagnostics {
  private readonly codec: DiagnosticCodec;
  private active = 0;
  constructor(
    private readonly database: Database,
    private readonly config: Config,
  ) {
    this.codec = new DiagnosticCodec(config);
  }
  async test(target: DiagnosticTarget): Promise<ProtocolConnectionResult> {
    if (this.active >= 16 || target.signal?.aborted)
      return diagnosticUnavailable;
    this.active++;
    const started = performance.now();
    const expiresAt = Date.now() + 10_000;
    const signal = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(target.signal ? [target.signal] : []),
    ]);
    try {
      const [route] = await this.database
        .execute(sql`select owner, generation, diagnostic_endpoint from receiving_coordinator
        where singleton and expires_at>clock_timestamp() and diagnostic_endpoint is not null`);
      if (
        !route ||
        route.diagnostic_endpoint !== this.config.endpoint ||
        signal.aborted
      )
        return diagnosticUnavailable;
      const requestId = randomUUID();
      const expectedOwner = {
        actor: String(route.owner),
        generation: String(route.generation),
      };
      const identity =
        "account" in target.identity
          ? {
              ...target.identity,
              configurationVersion: String(
                target.identity.configurationVersion,
              ),
              receivingLifecycleVersion: String(
                target.identity.receivingLifecycleVersion,
              ),
            }
          : target.identity;
      const payload = wire.parse({
        requestId,
        expectedOwner,
        identity,
        connection: target.connection,
        expiresAt,
        budgetMs: Math.max(
          1,
          Math.floor(10_000 - (performance.now() - started)),
        ),
      });
      const encoded = this.codec.encode(payload, "request");
      if (Buffer.byteLength(encoded.body) > LIMIT) return diagnosticUnavailable;
      // Node HTTP has no retries/redirects. Loss never replays credentials.
      const response = await new Promise<{ body: string; auth?: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            new URL("/diagnose", this.config.endpoint),
            {
              method: "POST",
              signal,
              agent: false,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(encoded.body),
                "x-maildock-auth": encoded.authentication,
              },
            },
            (res) => {
              if (res.statusCode !== 200) {
                res.resume();
                reject(new Error("Diagnostic unavailable"));
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              res.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > RESPONSE_LIMIT)
                  res.destroy(new Error("Response too large"));
                else chunks.push(chunk);
              });
              res.once("error", reject);
              res.once("end", () =>
                resolve({
                  body: Buffer.concat(chunks).toString("utf8"),
                  auth: res.headers["x-maildock-auth"] as string | undefined,
                }),
              );
            },
          );
          req.once("error", reject);
          req.end(encoded.body);
        },
      );
      const parsed = outcome.parse(
        this.codec.decode(response.body, response.auth, "response"),
      );
      if (
        signal.aborted ||
        parsed.requestId !== requestId ||
        parsed.actor !== expectedOwner.actor ||
        parsed.generation !== expectedOwner.generation
      )
        return diagnosticUnavailable;
      return parsed.result.success
        ? parsed.result
        : { ...parsed.result, message: "IMAP connection test failed." };
    } catch {
      return diagnosticUnavailable;
    } finally {
      this.active--;
    }
  }
}
