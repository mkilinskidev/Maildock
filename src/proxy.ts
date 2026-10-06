import { createContentSecurityPolicy } from "@/shared/infrastructure/security/content-security-policy";
import { randomBytes } from "node:crypto";
import { createLogger } from "@/shared/infrastructure/logging/logger";
import { logFailure } from "@/shared/infrastructure/logging/diagnostics";

import { NextRequest, NextResponse } from "next/server";

import { getValidBusinessSession } from "@/modules/auth/application/session-validation";
import { auth } from "@/modules/auth/infrastructure/auth";

const publicPaths = [
  "/setup",
  "/login",
  "/initial-mfa",
  "/replace-authenticator",
  "/api/setup",
  "/api/auth",
];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/api/health/live" || pathname === "/api/health/ready")
    return true;
  return publicPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function continueWithCsp(
  request: NextRequest,
  nonce: string,
  contentSecurityPolicy: string,
): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

function addCsp(response: NextResponse, contentSecurityPolicy: string) {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export async function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const contentSecurityPolicy = createContentSecurityPolicy(nonce);

  if (isPublicPath(request.nextUrl.pathname)) {
    return continueWithCsp(request, nonce, contentSecurityPolicy);
  }

  let session;
  try {
    session = await getValidBusinessSession(auth, request.headers);
  } catch (error) {
    logFailure(createLogger({ logLevel: "info" }), error, "web", "request");
    return addCsp(
      NextResponse.json(
        { error: "Request could not be completed." },
        { status: 503 },
      ),
      contentSecurityPolicy,
    );
  }
  if (session) return continueWithCsp(request, nonce, contentSecurityPolicy);

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return addCsp(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
      contentSecurityPolicy,
    );
  }

  return addCsp(
    NextResponse.redirect(new URL("/login", request.url)),
    contentSecurityPolicy,
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
