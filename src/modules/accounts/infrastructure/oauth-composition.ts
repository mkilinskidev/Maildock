import type { Database } from "../../../shared/infrastructure/database/database";
import type { SecretEncryption } from "../../../shared/application/secret-encryption";
import type { AppConfig } from "../../../shared/infrastructure/config/config";
import { MicrosoftOAuthProvider } from "./microsoft-oauth";
import { OAuthProviderRegistry } from "../application/oauth-provider-registry";
import { OAuthProviderConfigs } from "./oauth-provider-configs";
export function createOAuthComposition(
  database: Database,
  encryption: SecretEncryption,
  config: Pick<AppConfig, "appOrigin" | "microsoft">,
) {
  const microsoft = new MicrosoftOAuthProvider(database, encryption, config);
  return {
    microsoft,
    registry: new OAuthProviderRegistry([microsoft]),
    configurations: new OAuthProviderConfigs(
      database,
      encryption,
      config.appOrigin,
    ),
  };
}
