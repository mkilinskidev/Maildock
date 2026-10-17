import {
  OAuthRefreshes,
  credentialLifetime,
  readOAuthJson,
  OAuthRefreshNotIssuedError,
  type CredentialBudget,
} from "./oauth-refresh";
import {
  OAuthAuthorizationError,
  type OAuthMailProvider,
} from "../domain/oauth-mail-provider";
import { OAuthProviderConfigs } from "./oauth-provider-configs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, and, eq, gt, lte } from "drizzle-orm";
import {
  ConfidentialClientApplication,
  CryptoProvider,
  type ICachePlugin,
} from "@azure/msal-node";

import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  oauthAuthorizationStates,
} from "../../../shared/infrastructure/database/schema";
import type { SecretEncryption } from "../../../shared/application/secret-encryption";
import { accountCredentialContext } from "../domain/account";
import type { AppConfig } from "../../../shared/infrastructure/config/config";

export const microsoftScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];
const authority = "https://login.microsoftonline.com/common";
const stateContext = "maildock:microsoft-oauth-state:v1";

export class MicrosoftAuthorizationError extends OAuthAuthorizationError {
  constructor(
    message = "Microsoft authorization expired or was revoked. Reconnect the account.",
  ) {
    super(message);
    this.name = "MicrosoftAuthorizationError";
  }
}

export class MicrosoftOAuthProvider implements OAuthMailProvider {
  readonly id = "microsoft";
  private readonly configurations: OAuthProviderConfigs;
  private readonly refreshes: OAuthRefreshes;
  constructor(
    private readonly database: Database,
    private readonly encryption: SecretEncryption,
    private readonly config: Pick<AppConfig, "appOrigin" | "microsoft">,
  ) {
    this.refreshes = new OAuthRefreshes(database, this.id);
    this.configurations = new OAuthProviderConfigs(
      database,
      encryption,
      config.appOrigin,
    );
  }

  getDefinition() {
    return {
      id: this.id,
      name: "Microsoft",
      description: "Outlook / Microsoft 365",
      authorizationPath: "/api/oauth/microsoft/start",
      callbackPath: "/api/oauth/microsoft/callback",
    };
  }
  getMailDefaults() {
    return {
      imapHost: "outlook.office365.com",
      imapPort: 993,
      imapSecurity: "tls" as const,
      smtpHost: "smtp.office365.com",
      smtpPort: 587,
      smtpSecurity: "starttls" as const,
    };
  }
  async bootstrap() {
    await this.configurations.bootstrap(this.id, this.config.microsoft);
  }
  async isConfigured() {
    await this.bootstrap();
    return (await this.configurations.view(this.getDefinition())).configured;
  }

  private redirectUri() {
    return `${this.config.appOrigin}/api/oauth/microsoft/callback`;
  }

  private async applicationCredentials() {
    await this.bootstrap();
    const credentials = await this.configurations.credentials(this.id);
    if (!credentials)
      throw new MicrosoftAuthorizationError(
        "Microsoft account connection is not configured.",
      );
    return credentials;
  }

  private async client(
    cachePlugin?: ICachePlugin,
    applicationCredentials?: { clientId: string; clientSecret: string },
    signal?: AbortSignal,
    onNoIssuance?: () => void,
  ) {
    signal ??= credentialLifetime().signal;
    const credentials =
      applicationCredentials ?? (await this.applicationCredentials());
    let grantSent = false;
    return new ConfidentialClientApplication({
      auth: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        authority,
      },
      cache: { cachePlugin },
      system: {
        ...(signal
          ? {
              networkClient: {
                sendGetRequestAsync: async <T>(
                  url: string,
                  options?: { headers?: Record<string, string> },
                ) => this.network<T>(url, "GET", signal, options),
                sendPostRequestAsync: async <T>(
                  url: string,
                  options?: { headers?: Record<string, string>; body?: string },
                ) => {
                  if (grantSent)
                    throw new MicrosoftAuthorizationError(
                      "Token renewal outcome uncertain. Reconnect the account.",
                    );
                  grantSent = true;
                  return this.network<T>(
                    url,
                    "POST",
                    signal,
                    options,
                    onNoIssuance,
                  );
                },
              },
            }
          : {}),
        loggerOptions: {
          piiLoggingEnabled: false,
          loggerCallback: () => undefined,
        },
      },
    });
  }

  private async network<T>(
    url: string,
    method: string,
    signal: AbortSignal,
    options?: { headers?: Record<string, string>; body?: string },
    onNoIssuance?: () => void,
  ) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method,
      headers: options?.headers,
      body: options?.body,
      signal,
      redirect: "error",
      cache: "no-store",
    });
    const body = (await readOAuthJson(response)) as T;
    signal.throwIfAborted();
    if (
      method === "POST" &&
      !response.ok &&
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error !== "invalid_grant" &&
      !("access_token" in body)
    ) {
      onNoIssuance?.();
      throw new OAuthRefreshNotIssuedError(
        "Microsoft token renewal failed. Check provider configuration or try again.",
      );
    }
    return {
      headers: Object.fromEntries(response.headers),
      status: response.status,
      body,
    };
  }

  async begin(sessionId: string, accountId?: string): Promise<string> {
    await this.database
      .delete(oauthAuthorizationStates)
      .where(lte(oauthAuthorizationStates.expiresAt, new Date()));
    if (accountId) {
      const [account] = await this.database
        .select({ id: mailAccounts.id })
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.id, accountId),
            eq(mailAccounts.authMethod, "oauth2"),
            eq(mailAccounts.oauthProviderId, this.id),
          ),
        );
      if (!account)
        throw new MicrosoftAuthorizationError(
          "Microsoft account was not found.",
        );
    }
    const state = randomBytes(32).toString("base64url");
    const pkce = await new CryptoProvider().generatePkceCodes();
    await this.database.insert(oauthAuthorizationStates).values({
      providerId: this.id,
      stateHash: createHash("sha256").update(state).digest("hex"),
      sessionId,
      codeVerifier: this.encryption.encrypt(pkce.verifier, stateContext),
      accountId: accountId ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return (await this.client()).getAuthCodeUrl({
      scopes: microsoftScopes,
      redirectUri: this.redirectUri(),
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      responseMode: "query",
      prompt: "select_account",
    });
  }

  async complete(
    sessionId: string,
    state: string,
    code?: string,
    providerError?: string,
  ): Promise<string> {
    if (!state || state.length > 512)
      throw new MicrosoftAuthorizationError(
        "Invalid Microsoft authorization state.",
      );
    const [pending] = await this.database
      .delete(oauthAuthorizationStates)
      .where(
        and(
          eq(
            oauthAuthorizationStates.stateHash,
            createHash("sha256").update(state).digest("hex"),
          ),
          eq(oauthAuthorizationStates.sessionId, sessionId),
          eq(oauthAuthorizationStates.providerId, this.id),
          gt(oauthAuthorizationStates.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!pending)
      throw new MicrosoftAuthorizationError(
        "Invalid or expired Microsoft authorization state.",
      );
    if (providerError)
      throw new MicrosoftAuthorizationError(
        providerError === "access_denied"
          ? "Microsoft consent was denied. Try connecting again and grant the requested mail permissions."
          : "Microsoft sign-in could not be completed. Check the account or tenant policy and try again.",
      );
    if (!code)
      throw new MicrosoftAuthorizationError(
        "Microsoft did not return an authorization code.",
      );
    let serialized = "";
    const client = await this.client({
      beforeCacheAccess: async () => undefined,
      afterCacheAccess: async (context) => {
        if (context.cacheHasChanged)
          serialized = context.tokenCache.serialize();
      },
    });
    let result;
    try {
      result = await client.acquireTokenByCode({
        code,
        scopes: microsoftScopes,
        redirectUri: this.redirectUri(),
        codeVerifier: this.encryption.decrypt(
          pending.codeVerifier,
          stateContext,
        ),
      });
    } catch {
      throw new MicrosoftAuthorizationError(
        "Microsoft sign-in failed. Check consent, app registration, and tenant policy.",
      );
    }
    const email = result.account?.username?.toLowerCase();
    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !result.account?.homeAccountId ||
      !serialized
    ) {
      throw new MicrosoftAuthorizationError(
        "Microsoft did not return a usable mailbox identity.",
      );
    }
    const id = pending.accountId ?? randomUUID();
    const encrypted = this.encryption.encrypt(
      serialized,
      accountCredentialContext(id, "oauth-cache"),
    );
    if (pending.accountId) {
      const [current] = await this.database
        .select({ homeAccountId: mailAccounts.oauthHomeAccountId })
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.id, id),
            eq(mailAccounts.authMethod, "oauth2"),
            eq(mailAccounts.oauthProviderId, this.id),
          ),
        );
      if (!current || current.homeAccountId !== result.account.homeAccountId) {
        throw new MicrosoftAuthorizationError(
          "Reconnect using the same Microsoft account.",
        );
      }
      const [updated] = await this.database
        .update(mailAccounts)
        .set({
          oauthRefreshAttempt: null,
          configurationVersion: sql`${mailAccounts.configurationVersion}+1`,
          email,
          imapUsername: email,
          oauthCache: encrypted,
          oauthHomeAccountId: result.account.homeAccountId,
          oauthStatus: "connected",
          oauthFailureCategory: null,
          connectionStatus: "unverified",
          imapStatus: "untested",
          smtpStatus: "untested",
          imapError: null,
          smtpError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mailAccounts.id, id),
            eq(mailAccounts.authMethod, "oauth2"),
            eq(mailAccounts.oauthProviderId, this.id),
          ),
        )
        .returning({ id: mailAccounts.id });
      if (!updated)
        throw new MicrosoftAuthorizationError(
          "Microsoft account was not found.",
        );
    } else {
      await this.database.insert(mailAccounts).values({
        id,
        displayName: result.account.name || email,
        senderDisplayName: result.account.name || email,
        email,
        enabled: true,
        providerType: "imap_smtp",
        authMethod: "oauth2",
        oauthProviderId: this.id,
        oauthCache: encrypted,
        oauthHomeAccountId: result.account.homeAccountId,
        oauthStatus: "connected",
        oauthFailureCategory: null,
        ...this.getMailDefaults(),
        imapUsername: email,
        imapPassword: null,
        smtpUsesImapCredentials: true,
        smtpUsername: null,
        smtpPassword: null,
      });
    }
    return id;
  }

  async accessToken(
    accountId: string,
    budget?: CredentialBudget,
  ): Promise<string> {
    const credentials = await this.applicationCredentials();
    return this.refreshes.resolve(accountId, budget, async (row, lifetime) => {
      lifetime.check();
      if (!row.oauthCache || !row.oauthHomeAccountId)
        throw new MicrosoftAuthorizationError();
      let cache = this.encryption.decrypt(
        row.oauthCache,
        accountCredentialContext(accountId, "oauth-cache"),
      );
      let rejected = false;
      const client = await this.client(
        {
          beforeCacheAccess: async (context) =>
            context.tokenCache.deserialize(cache),
          afterCacheAccess: async (context) => {
            if (context.cacheHasChanged) cache = context.tokenCache.serialize();
          },
        },
        credentials,
        lifetime.signal,
        () => {
          rejected = true;
        },
      );
      try {
        const accounts = await client.getTokenCache().getAllAccounts();
        const account = accounts.find(
          (item) => item.homeAccountId === row.oauthHomeAccountId,
        );
        if (!account) throw new MicrosoftAuthorizationError();
        lifetime.check();
        const result = await client.acquireTokenSilent({
          account,
          scopes: microsoftScopes,
        });
        lifetime.check();
        if (!result?.accessToken) throw new MicrosoftAuthorizationError();
        return {
          token: result.accessToken,
          cache: this.encryption.encrypt(
            cache,
            accountCredentialContext(accountId, "oauth-cache"),
          ),
        };
      } catch (error) {
        if (rejected || error instanceof OAuthRefreshNotIssuedError)
          throw new OAuthRefreshNotIssuedError(
            "Microsoft token renewal failed. Check provider configuration or try again.",
          );
        throw new MicrosoftAuthorizationError();
      }
    });
  }
}
