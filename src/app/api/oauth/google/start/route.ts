import { getCurrentSession } from "@/modules/auth/application/session";
import { oauthProviders } from "@/modules/accounts/infrastructure/accounts";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";

// Protocol navigation: begin creates session-bound, expiring state and S256 PKCE;
// it does not connect an account until the validated callback completes.

export async function GET(request: Request) {
  const origin = getConfig().appOrigin;
  const session = await getCurrentSession();
  if (!session) return Response.redirect(new URL("/login", origin));
  try {
    const provider = oauthProviders.get("google");
    if (!(await provider.isConfigured()))
      return Response.redirect(
        new URL("/accounts?oauth_error=configuration", origin),
      );
    const accountId =
      new URL(request.url).searchParams.get("accountId") ?? undefined;
    return Response.redirect(
      await provider.begin(session.session.id, accountId),
    );
  } catch {
    return Response.redirect(new URL("/accounts?oauth_error=start", origin));
  }
}
