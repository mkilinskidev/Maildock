import { toNextJsHandler } from "better-auth/next-js";

import {
  clearLoginFailures,
  getLoginDelaySeconds,
  recordLoginFailure,
} from "@/modules/auth/infrastructure/login-throttle";
import { auth } from "@/modules/auth/infrastructure/auth";

export const dynamic = "force-dynamic";

const handler = toNextJsHandler(auth);

export async function GET(request: Request) {
  if (!new URL(request.url).pathname.endsWith("/get-session")) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  return handler.GET(request);
}

export async function POST(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (
    !pathname.endsWith("/sign-in/username") &&
    !pathname.endsWith("/sign-out")
  ) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  if (pathname.endsWith("/sign-out")) {
    return handler.POST(request);
  }

  let username: string | undefined;
  try {
    const body = (await request.clone().json()) as { username?: unknown };
    if (typeof body.username === "string") username = body.username;
  } catch {
    // Better Auth returns the canonical validation response.
  }

  if (username) {
    const retryAfter = await getLoginDelaySeconds(username);
    if (retryAfter > 0) {
      return Response.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  const response = await handler.POST(request);
  if (username) {
    if (response.ok) await clearLoginFailures(username);
    else if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    ) {
      await recordLoginFailure(username);
    }
  }
  return response;
}
