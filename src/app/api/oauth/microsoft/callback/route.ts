import { getCurrentSession } from "@/modules/auth/application/session";
import {
  accountsService,
  microsoftOAuth,
} from "@/modules/accounts/infrastructure/accounts";
import { MicrosoftAuthorizationError } from "@/modules/accounts/infrastructure/microsoft-oauth";
import { getConfig } from "@/shared/infrastructure/config/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = getConfig().appOrigin;
  const session = await getCurrentSession();
  if (!session) return Response.redirect(new URL("/login", origin));
  const query = new URL(request.url).searchParams;
  try {
    const id = await microsoftOAuth.complete(
      session.session.id,
      query.get("state") ?? "",
      query.get("code") ?? undefined,
      query.get("error") ?? undefined,
    );
    await accountsService.requestMailboxDiscovery(id);
    return Response.redirect(new URL("/accounts?oauth=connected", origin));
  } catch (error) {
    const reason =
      error instanceof MicrosoftAuthorizationError
        ? error.message.includes("state")
          ? "state"
          : error.message.includes("denied")
            ? "denied"
            : error.message.includes("same Microsoft account")
              ? "identity"
              : "authorization"
        : "authorization";
    return Response.redirect(
      new URL(`/accounts?oauth_error=${reason}`, origin),
    );
  }
}
