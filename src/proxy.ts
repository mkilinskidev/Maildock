import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getValidSession } from "@/modules/auth/application/session-validation";
import { auth } from "@/modules/auth/infrastructure/auth";

const publicPaths = ["/setup", "/login", "/api/setup", "/api/auth"];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/api/health/live" || pathname === "/api/health/ready")
    return true;
  return publicPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function createContentSecurityPolicy(nonce: string): string {
  const developmentScriptPolicy =
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScriptPolicy}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join("; ");
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

  const session = await getValidSession(auth, request.headers);
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
