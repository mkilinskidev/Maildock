import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import {
  oauthProviders,
  oauthProviderConfigs,
} from "@/modules/accounts/infrastructure/accounts";
import { providerConfigInput } from "@/modules/accounts/infrastructure/oauth-provider-configs";
import { z } from "zod";
export const dynamic = "force-dynamic";
const inputSchema = providerConfigInput.extend({
  providerId: z.string().min(1).max(64),
});
export async function GET(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    try {
      const providers = await Promise.all(
        oauthProviders.list().map(async (provider) => {
          await provider.isConfigured();
          return oauthProviderConfigs.view(provider.getDefinition());
        }),
      );
      return Response.json(
        { providers },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return Response.json(
        { error: "OAuth provider configuration could not be loaded." },
        { status: 500 },
      );
    }
  });
}
export async function PUT(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    const input = inputSchema.safeParse(await request.json().catch(() => null));
    if (!input.success)
      return Response.json(
        {
          error:
            "Enter a client ID (up to 256 characters) and a valid client secret.",
        },
        { status: 400 },
      );
    let provider;
    try {
      provider = oauthProviders.get(input.data.providerId);
    } catch {
      return Response.json(
        { error: "OAuth provider is unavailable." },
        { status: 400 },
      );
    }
    try {
      await provider.isConfigured();
      const { providerId, ...configuration } = input.data;
      await oauthProviderConfigs.save(providerId, configuration);
      return Response.json(
        await oauthProviderConfigs.view(provider.getDefinition()),
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return Response.json(
        { error: "OAuth provider configuration could not be saved." },
        { status: 500 },
      );
    }
  });
}
