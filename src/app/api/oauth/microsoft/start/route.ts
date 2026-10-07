import { getCurrentSession } from "@/modules/auth/application/session";
import { microsoftOAuth } from "@/modules/accounts/infrastructure/accounts";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = getConfig().appOrigin;
  const session = await getCurrentSession();
  if (!session) return Response.redirect(new URL("/login", origin));
  if (!microsoftOAuth.configured)
    return Response.redirect(
      new URL("/accounts?oauth_error=configuration", origin),
    );
  const accountId =
    new URL(request.url).searchParams.get("accountId") ?? undefined;
  try {
    const url = await microsoftOAuth.begin(session.session.id, accountId);
    return Response.redirect(url);
  } catch {
    return Response.redirect(new URL("/accounts?oauth_error=start", origin));
  }
}
