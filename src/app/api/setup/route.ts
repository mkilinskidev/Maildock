import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { ZodError } from "zod";
import {
  initializeOwner,
  InstanceAlreadyInitializedError,
  isInstanceInitialized,
  BootstrapAuthorizationError,
  SetupThrottledError,
} from "@/modules/auth/application/instance-auth";
import { hasValidOrigin } from "@/modules/auth/application/origin";
import { getConfig } from "@/shared/infrastructure/config/config";
import { db } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export async function GET() {
  return routeBoundary(async () => {
    try {
      return Response.json(
        { initialized: await isInstanceInitialized(db) },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return Response.json(
        { error: "Setup could not be completed." },
        { status: 503 },
      );
    }
  });
}

class InvalidSetupRequest extends Error {}
class SetupBodyTooLarge extends Error {}

// Bound streamed bytes, including chunked bodies and dishonest Content-Length.
async function readSetupBody(request: Request): Promise<ArrayBuffer> {
  const limit = 4096;
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    throw new SetupBodyTooLarge();
  }
  if (!request.body) throw new InvalidSetupRequest();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new InvalidSetupRequest());
    }, 10_000);
  });
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (size + chunk.value.byteLength > limit)
            throw new SetupBodyTooLarge();
          bytes.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
        return bytes.buffer.slice(0, size);
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export async function POST(request: Request) {
  return routeBoundary(async () => {
    try {
      if (await isInstanceInitialized(db))
        throw new InstanceAlreadyInitializedError();
      const config = getConfig();
      if (!hasValidOrigin(request, config)) {
        return Response.json(
          { error: "Invalid request origin." },
          { status: 403 },
        );
      }
      const contentType = request.headers.get("content-type") ?? "";
      const submittedAsForm =
        contentType.startsWith("application/x-www-form-urlencoded") ||
        contentType.startsWith("multipart/form-data");
      if (!submittedAsForm && !contentType.startsWith("application/json"))
        throw new InvalidSetupRequest();
      const body = await readSetupBody(request);
      const boundedRequest = new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
      });
      let rawInput: unknown;
      try {
        rawInput = submittedAsForm
          ? Object.fromEntries(await boundedRequest.formData())
          : await boundedRequest.json();
      } catch {
        throw new InvalidSetupRequest();
      }
      await initializeOwner(db, rawInput, config);
      if (submittedAsForm)
        return Response.redirect(new URL("/login", config.appOrigin), 303);
      return Response.json({ initialized: true }, { status: 201 });
    } catch (error) {
      if (error instanceof InstanceAlreadyInitializedError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof BootstrapAuthorizationError) {
        return Response.json(
          { error: "Setup authorization failed." },
          { status: 403 },
        );
      }
      if (error instanceof SetupThrottledError) {
        return Response.json(
          { error: "Setup is busy. Please try again later." },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      if (error instanceof SetupBodyTooLarge) {
        return Response.json(
          { error: "Setup request is too large." },
          { status: 413 },
        );
      }
      if (error instanceof InvalidSetupRequest) {
        return Response.json(
          { error: "Invalid setup request." },
          { status: 400 },
        );
      }
      if (error instanceof ZodError) {
        return Response.json(
          { error: "Username or password does not meet the requirements." },
          { status: 400 },
        );
      }
      return Response.json(
        { error: "Setup could not be completed." },
        { status: 500 },
      );
    }
  });
}
