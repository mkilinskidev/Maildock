export type OAuthProviderDefinition = Readonly<{
  id: string;
  name: string;
  description: string;
  authorizationPath: string;
  callbackPath: string;
}>;
export type OAuthMailDefaults = Readonly<{
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
}>;
// Authorization completion persists the provider-owned credentials and returns
// the local account ID. No MSAL identity/cache crosses this boundary.
export interface OAuthMailProvider {
  readonly id: string;
  getDefinition(): OAuthProviderDefinition;
  isConfigured(): Promise<boolean>;
  begin(sessionId: string, accountId?: string): Promise<string>;
  complete(
    sessionId: string,
    state: string,
    code?: string,
    providerError?: string,
  ): Promise<string>;
  accessToken(accountId: string): Promise<string>;
  getMailDefaults(): OAuthMailDefaults;
}

// Providers may expose only fixed owner-safe messages through this error type.
export class OAuthAuthorizationError extends Error {
  constructor(
    message = "Account authorization expired or was revoked. Reconnect the account.",
  ) {
    super(message);
    this.name = "OAuthAuthorizationError";
  }
}
