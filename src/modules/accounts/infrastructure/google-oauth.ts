import {
  withPerformance,
  measureStage,
  beginStage,
} from "../../../shared/infrastructure/logging/performance";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  OAuthAuthorizationError,
  type OAuthMailProvider,
} from "../domain/oauth-mail-provider";
import { accountCredentialContext } from "../domain/account";
import { OAuthProviderConfigs } from "./oauth-provider-configs";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  oauthAuthorizationStates,
} from "../../../shared/infrastructure/database/schema";
import type { SecretEncryption } from "../../../shared/application/secret-encryption";
import type { AppConfig } from "../../../shared/infrastructure/config/config";

export const googleScopes = ["https://mail.google.com/", "openid", "email"];
const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const identityEndpoint = "https://openidconnect.googleapis.com/v1/userinfo";
const stateContext = "maildock:google-oauth-state:v1";
const authorizationState = z.object({
  version: z.literal(1),
  subject: z.string().min(1).max(255),
  refreshToken: z.string().min(1).max(16384),
});
const tokenResponse = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().finite().gt(60),
  refresh_token: z.string().min(1).max(16384).optional(),
  scope: z.string().optional(),
});
const identityResponse = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(320),
  email_verified: z.literal(true),
});

export class GoogleAuthorizationError extends OAuthAuthorizationError {
  constructor(
    message = "Google authorization could not be completed. Try connecting again.",
  ) {
    super(message);
    this.name = "GoogleAuthorizationError";
  }
}
class GoogleReconnectRequired extends GoogleAuthorizationError {
  constructor() {
    super(
      "Google authorization expired or was revoked. Reconnect the account.",
    );
  }
}

export class GoogleOAuthProvider implements OAuthMailProvider {
  readonly id = "google";
  private readonly configurations: OAuthProviderConfigs;
  constructor(
    private readonly database: Database,
    private readonly encryption: SecretEncryption,
    private readonly config: Pick<AppConfig, "appOrigin">,
  ) {
    this.configurations = new OAuthProviderConfigs(
      database,
      encryption,
      config.appOrigin,
    );
  }
  getDefinition() {
    return {
      id: this.id,
      name: "Google",
      description: "Gmail / Google Workspace",
      authorizationPath: "/api/oauth/google/start",
      callbackPath: "/api/oauth/google/callback",
    };
  }
  getMailDefaults() {
    return {
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapSecurity: "tls" as const,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls" as const,
    };
  }
  async isConfigured() {
    return (await this.configurations.view(this.getDefinition())).configured;
  }
  private redirectUri() {
    return `${this.config.appOrigin}${this.getDefinition().callbackPath}`;
  }
  private async credentials() {
    const credentials = await this.configurations.credentials(this.id);
    if (!credentials)
      throw new GoogleAuthorizationError(
        "Google account connection is not configured.",
      );
    return credentials;
  }
  private readAuthorization(
    accountId: string,
    encrypted: Parameters<SecretEncryption["decrypt"]>[0],
  ) {
    try {
      return authorizationState.parse(
        JSON.parse(
          this.encryption.decrypt(
            encrypted,
            accountCredentialContext(accountId, "oauth-cache"),
          ),
        ),
      );
    } catch {
      throw new GoogleReconnectRequired();
    }
  }
  private encryptAuthorization(
    accountId: string,
    subject: string,
    refreshToken: string,
  ) {
    return this.encryption.encrypt(
      JSON.stringify({ version: 1, subject, refreshToken }),
      accountCredentialContext(accountId, "oauth-cache"),
    );
  }
  private async requestToken(parameters: Record<string, string>) {
    // Never let fetch/JSON/Google errors (which can contain credentials) escape.
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        cache: "no-store",
      });
      body = await response.json();
    } catch {
      throw new GoogleAuthorizationError(
        "Google token service is temporarily unavailable. Try again.",
      );
    }
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(body);
      if (
        response.status === 400 &&
        failure.success &&
        failure.data.error === "invalid_grant"
      )
        throw new GoogleReconnectRequired();
      throw new GoogleAuthorizationError(
        "Google token renewal failed. Check provider configuration or try again.",
      );
    }
    const parsed = tokenResponse.safeParse(body);
    if (!parsed.success)
      throw new GoogleAuthorizationError(
        "Google did not return a usable access token. Try again.",
      );
    if (
      parsed.data.scope &&
      !parsed.data.scope.split(/\s+/).includes(googleScopes[0])
    )
      throw new GoogleReconnectRequired();
    return parsed.data;
  }
  private async identity(accessToken: string) {
    try {
      const response = await fetch(identityEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      return identityResponse.parse(await response.json());
    } catch {
      throw new GoogleAuthorizationError(
        "Google did not return a verified mailbox identity. Try connecting again.",
      );
    }
  }
  async begin(sessionId: string, accountId?: string): Promise<string> {
    const credentials = await this.credentials();
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
        throw new GoogleAuthorizationError("Google account was not found.");
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    await this.database.insert(oauthAuthorizationStates).values({
      providerId: this.id,
      stateHash: createHash("sha256").update(state).digest("hex"),
      sessionId,
      codeVerifier: this.encryption.encrypt(verifier, stateContext),
      accountId: accountId ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: googleScopes.join(" "),
      access_type: "offline",
      // Consent is intentional on both connect and reconnect: background access
      // requires a durable grant, including after a revoked refresh token.
      prompt: "consent select_account",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }
  async complete(
    sessionId: string,
    state: string,
    code?: string,
    providerError?: string,
  ): Promise<string> {
    if (!state || state.length > 512)
      throw new GoogleAuthorizationError("Invalid Google authorization state.");
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
      throw new GoogleAuthorizationError(
        "Invalid or expired Google authorization state.",
      );
    if (providerError)
      throw new GoogleAuthorizationError(
        providerError === "access_denied"
          ? "Google consent was denied. Try connecting again and grant the requested mail permissions."
          : "Google sign-in could not be completed. Try connecting again.",
      );
    if (!code || code.length > 16384)
      throw new GoogleAuthorizationError(
        "Google did not return a valid authorization code.",
      );
    const credentials = await this.credentials();
    const tokens = await this.requestToken({
      ...{
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      },
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: this.encryption.decrypt(
        pending.codeVerifier,
        stateContext,
      ),
    });
    const identity = await this.identity(tokens.access_token);
    const email = identity.email.toLowerCase();
    const id = pending.accountId ?? randomUUID();
    if (pending.accountId) {
      // Serialize against background refresh; compare trusted subject before any
      // credential replacement. Email can change on a Workspace account.
      await this.database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.id, id),
              eq(mailAccounts.authMethod, "oauth2"),
              eq(mailAccounts.oauthProviderId, this.id),
            ),
          )
          .for("update");
        if (!current?.oauthCache)
          throw new GoogleAuthorizationError("Google account was not found.");
        const previous = this.readAuthorization(id, current.oauthCache);
        if (previous.subject !== identity.sub)
          throw new GoogleAuthorizationError(
            "Reconnect using the same Google account.",
          );
        let refreshToken = tokens.refresh_token ?? previous.refreshToken;
        // A missing new refresh token must not erase the old one. Validate its
        // continued usability before treating reconnect as successful.
        if (!tokens.refresh_token) {
          const renewed = await this.requestToken({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          });
          refreshToken = renewed.refresh_token ?? refreshToken;
        }
        await tx
          .update(mailAccounts)
          .set({
            email,
            smtpUsername: email,
            workRevision: sql`${mailAccounts.workRevision} + 1`,
            oauthCache: this.encryptAuthorization(
              id,
              identity.sub,
              refreshToken,
            ),
            oauthStatus: "connected",
            connectionStatus: "unverified",
            imapStatus: "untested",
            smtpStatus: "untested",
            imapError: null,
            smtpError: null,
            updatedAt: new Date(),
          })
          .where(eq(mailAccounts.id, id));
      });
    } else {
      if (!tokens.refresh_token)
        throw new GoogleAuthorizationError(
          "Google did not grant offline access. Connect again and grant consent.",
        );
      await this.database.insert(mailAccounts).values({
        id,
        displayName: email,
        senderDisplayName: email,
        email,
        enabled: true,
        providerType: "gmail_smtp",
        authMethod: "oauth2",
        oauthProviderId: this.id,
        oauthCache: this.encryptAuthorization(
          id,
          identity.sub,
          tokens.refresh_token,
        ),
        oauthStatus: "connected",
        ...this.getMailDefaults(),
        imapHost: null,
        imapPort: null,
        imapSecurity: null,
        imapUsername: null,
        oauthHomeAccountId: identity.sub,
        imapPassword: null,
        smtpUsesImapCredentials: false,
        smtpUsername: email,
        smtpPassword: null,
      });
    }
    return id;
  }
  async accessToken(accountId: string): Promise<string> {
    return withPerformance("google_credentials", () =>
      this.accessTokenImpl(accountId),
    );
  }
  private async accessTokenImpl(accountId: string): Promise<string> {
    const credentials = await this.credentials();
    const finishLock = beginStage("oauth_lock");
    let lockMeasured = false;
    const result = await this.database
      .transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.id, accountId),
              eq(mailAccounts.authMethod, "oauth2"),
              eq(mailAccounts.oauthProviderId, this.id),
            ),
          )
          .for("update");
        finishLock();
        lockMeasured = true;
        if (!row) throw new GoogleReconnectRequired();
        try {
          if (!row.oauthCache || row.oauthStatus !== "connected")
            throw new GoogleReconnectRequired();
          const stored = this.readAuthorization(accountId, row.oauthCache);
          // No persisted access-token cache: every acquisition returns a freshly
          // issued token and restart/expiry cannot leave a stale token behind.
          const tokens = await measureStage("oauth_http", () =>
            this.requestToken({
              client_id: credentials.clientId,
              client_secret: credentials.clientSecret,
              grant_type: "refresh_token",
              refresh_token: stored.refreshToken,
            }),
          );
          if (tokens.refresh_token)
            await tx
              .update(mailAccounts)
              .set({
                oauthCache: this.encryptAuthorization(
                  accountId,
                  stored.subject,
                  tokens.refresh_token,
                ),
                updatedAt: new Date(),
              })
              .where(eq(mailAccounts.id, accountId));
          return tokens.access_token;
        } catch (error) {
          if (!(error instanceof GoogleReconnectRequired)) throw error;
          // Commit revocation while holding the same row lock as refresh and
          // reconnect, so a stale failure cannot revoke a newly replaced grant.
          await tx
            .update(mailAccounts)
            .set({
              oauthStatus: "reconnect_required",
              workRevision: sql`${mailAccounts.workRevision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(mailAccounts.id, accountId),
                eq(mailAccounts.authMethod, "oauth2"),
                eq(mailAccounts.oauthProviderId, this.id),
              ),
            );
          return error;
        }
      })
      .finally(() => {
        if (!lockMeasured) finishLock(true);
      });
    if (result instanceof GoogleReconnectRequired) throw result;
    return result;
  }
}
