import type { OAuthMailProvider } from "../domain/oauth-mail-provider";
export class OAuthProviderRegistry {
  private readonly providers = new Map<string, OAuthMailProvider>();
  constructor(providers: readonly OAuthMailProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id))
        throw new Error("Duplicate OAuth provider.");
      this.providers.set(provider.id, provider);
    }
  }
  get(id: string | null): OAuthMailProvider {
    const provider = id ? this.providers.get(id) : undefined;
    if (!provider) throw new Error("OAuth provider is unavailable.");
    return provider;
  }
  list(): readonly OAuthMailProvider[] {
    return [...this.providers.values()];
  }
}
