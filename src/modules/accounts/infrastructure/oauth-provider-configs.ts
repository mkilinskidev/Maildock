import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../shared/infrastructure/database/database";
import { oauthProviderConfigs } from "../../../shared/infrastructure/database/schema";
import type { SecretEncryption } from "../../../shared/application/secret-encryption";
import type { OAuthProviderDefinition } from "../domain/oauth-mail-provider";

export const providerConfigInput = z
  .object({
    clientId: z.string().trim().min(1).max(256),
    clientSecret: z.string().max(16384).default(""),
    enabled: z.boolean().default(true),
  })
  .strict();
export type OAuthProviderConfigView = OAuthProviderDefinition & {
  enabled: boolean;
  configured: boolean;
  clientId: string;
  hasClientSecret: boolean;
  redirectUri: string;
};
export function providerSecretContext(id: string) {
  return `maildock:oauth-provider:${id}:client-secret:v1`;
}
export class OAuthProviderConfigs {
  constructor(
    private readonly database: Database,
    private readonly encryption: SecretEncryption,
    private readonly appOrigin: string,
  ) {}
  async bootstrap(
    id: string,
    credentials: { clientId: string; clientSecret: string },
  ) {
    if (!credentials.clientId || !credentials.clientSecret) return;
    const existing = await this.row(id);
    if (existing) return;
    await this.database
      .insert(oauthProviderConfigs)
      .values({
        providerId: id,
        clientId: credentials.clientId,
        encryptedClientSecret: this.encryption.encrypt(
          credentials.clientSecret,
          providerSecretContext(id),
        ),
      })
      .onConflictDoNothing();
  }
  private async row(id: string) {
    const [row] = await this.database
      .select()
      .from(oauthProviderConfigs)
      .where(eq(oauthProviderConfigs.providerId, id));
    return row;
  }
  async credentials(id: string) {
    const row = await this.row(id);
    if (!row?.enabled || !row.clientId || !row.encryptedClientSecret)
      return null;
    return {
      clientId: row.clientId,
      clientSecret: this.encryption.decrypt(
        row.encryptedClientSecret,
        providerSecretContext(id),
      ),
    };
  }
  async view(
    definition: OAuthProviderDefinition,
  ): Promise<OAuthProviderConfigView> {
    const row = await this.row(definition.id);
    return {
      ...definition,
      enabled: row?.enabled ?? true,
      configured: Boolean(
        row?.enabled && row.clientId && row.encryptedClientSecret,
      ),
      clientId: row?.clientId ?? "",
      hasClientSecret: Boolean(row?.encryptedClientSecret),
      redirectUri: `${this.appOrigin}${definition.callbackPath}`,
    };
  }
  async save(id: string, input: z.input<typeof providerConfigInput>) {
    const parsed = providerConfigInput.parse(input);
    const secret = parsed.clientSecret
      ? this.encryption.encrypt(parsed.clientSecret, providerSecretContext(id))
      : undefined;
    await this.database
      .insert(oauthProviderConfigs)
      .values({
        providerId: id,
        clientId: parsed.clientId,
        enabled: parsed.enabled,
        encryptedClientSecret: secret ?? null,
      })
      .onConflictDoUpdate({
        target: oauthProviderConfigs.providerId,
        set: {
          clientId: parsed.clientId,
          enabled: parsed.enabled,
          updatedAt: new Date(),
          ...(secret ? { encryptedClientSecret: secret } : {}),
        },
      });
  }
}
