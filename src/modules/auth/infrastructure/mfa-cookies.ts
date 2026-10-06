import type { createAuth } from "./auth-factory";

// Cookie names/secure prefix come from the installed engine, not string guesses.
export async function withoutTrustedDevice(
  auth: ReturnType<typeof createAuth>,
  headers?: HeadersInit,
) {
  const context = await auth.$context;
  const result = new Headers(headers);
  const name = context.createAuthCookie("trust_device").name;
  result.set(
    "cookie",
    (result.get("cookie") ?? "")
      .split(";")
      .filter((cookie) => cookie.trim().split("=")[0] !== name)
      .join(";"),
  );
  return result;
}

export async function challengeHeaders(
  auth: ReturnType<typeof createAuth>,
  headers: Headers,
) {
  const context = await auth.$context;
  const allowed = new Set([
    context.createAuthCookie("two_factor").name,
    context.authCookies.dontRememberToken.name,
  ]);
  const result = new Headers(headers);
  // A session cookie must never select Better Auth's authenticated-session
  // branch: these wrappers accept ONLY a password-issued login challenge.
  result.set(
    "cookie",
    (headers.get("cookie") ?? "")
      .split(";")
      .filter((cookie) => allowed.has(cookie.trim().split("=")[0]))
      .join(";"),
  );
  result.delete("authorization");
  return result;
}

export function responseCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
